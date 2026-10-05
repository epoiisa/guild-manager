import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  EmbedBuilder, LabelBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder,
  type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { AccountOperationError, type AccountRef, type CharacterAccount, type createAccountRepository } from "../db/accountRepository.js";
import { completeFeedbackPrompt, editFeedback, editPrivatePanel, feedbackMessage, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { entryPanelId, parseEntryPanelId, type EntryInteraction, type EntryPanelContext, type EntrySelection } from "../services/entryPanels/types.js";
import { accountOperationErrorMessage, buildStatementText, formatAccountAmount } from "./account.js";
import { INFO_COLOR, INVALID_COLOR, REPORT_COLOR, SUCCESS_COLOR } from "./configurationHelpers.js";
import { buildBalanceFeedback } from "./selfService.js";

const PREFIX = "account-entry:";
const PAGE_SIZE = 25;
const START_AGAIN = "This control is no longer current. Open the latest entry panel and start again.";
const mentions = { parse: [] as never[], users: [], roles: [], repliedUser: false };
type AccountAction = "give" | "statement" | "credit" | "debit" | "transfer";
type Field = "character" | "from" | "to";
type PrivateInteraction = ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction;
type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<UserSelectMenuBuilder>;
interface Choice { ref: Readonly<AccountRef>; label: string }
interface Snapshot { character?: Choice; from?: Choice; to?: Choice; recipient?: string }
interface Draft {
  id: string;
  guild: string;
  owner: string;
  selection: EntrySelection;
  expires: number;
  action: AccountAction;
  step: "from" | "to";
  selected: Partial<Record<Field, string>>;
  recipient?: string;
  query: Record<Field, string>;
  page: Record<Field, number>;
  state: "setup" | "form" | "submitting" | "done";
  version: number;
  form: number;
  snapshot?: Readonly<Snapshot>;
  search?: { field: Field; form: number };
}

export function buildAccountsPanel(generation: string) {
  const control = (action: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(entryPanelId("accounts", generation, action)).setLabel(label).setStyle(style);
  return {
    components: [new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Accounts\n\nGive account funds and view your balances and statements.\n\n**Everyone**"))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(control("give", "Give", ButtonStyle.Primary), control("balance", "Balance"), control("statement", "Statement")))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Managers**"))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(control("credit", "Credit"), control("debit", "Debit"), control("transfer", "Transfer")))],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: mentions,
  };
}

function card(text: string, rows: Row[] = []) {
  return {
    components: [new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(...rows.map((row) => row.toJSON()))],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: mentions,
  };
}

export function parseAccountFormAmount(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!/^\d{1,19}$/.test(trimmed)) return undefined;
  const amount = BigInt(trimmed);
  return amount > 0n && amount <= 9223372036854775807n ? amount : undefined;
}

export function createAccountPanelInteractions({ repository, entries, now = Date.now }: {
  repository: ReturnType<typeof createAccountRepository>;
  entries: EntryPanelContext;
  now?: () => number;
}) {
  const drafts = new Map<string, Draft>();
  const busy = new Set<string>();
  let stopped = false;
  let epoch = 0;
  const guildEpochs = new Map<string, number>();
  const live = (d: Draft) => !stopped && drafts.get(d.id) === d && d.expires > now();
  const manager = (action: string) => ["credit", "debit", "transfer"].includes(action);
  const mutation = (action: string) => action !== "balance" && action !== "statement";
  const key = (a: AccountRef) => `${a.albionServer}:${a.albionCharacterId}`;
  const label = (a: CharacterAccount) => `${a.characterName} • ${getAlbionServerLabel(a.albionServer)}`;
  function fence(guildId: string | null) {
    const capturedEpoch = epoch;
    const capturedGuild = guildId ? guildEpochs.get(guildId) : undefined;
    return () => !stopped && epoch === capturedEpoch && (!guildId || guildEpochs.get(guildId) === capturedGuild);
  }
  function find(i: PrivateInteraction) {
    const d = drafts.get(i.customId.split(":")[1]);
    return d && live(d) && d.guild === i.guildId && d.owner === i.user.id && d.selection.discordChannelId === i.channelId ? d : undefined;
  }
  function button(d: Draft, action: string, text: string, disabled = false) {
    return new ButtonBuilder().setCustomId(`${PREFIX}${d.id}:${action}`).setLabel(text).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  }
  async function reject(i: EntryInteraction, title = "Start Again", text = START_AGAIN) {
    const options = { cards: [{ title, description: text }], allowedMentions: mentions };
    if (i.deferred || i.replied) await editFeedback(i, options, "context");
    else await i.reply(feedbackReply({ ...options, flags: MessageFlags.Ephemeral }, "context"));
  }
  async function authorized(i: PrivateInteraction, d: Draft) {
    if (!live(d)) { await reject(i); return false; }
    if (!(await entries.checkAccess(i, "accounts", { expected: d.selection, mutation: mutation(d.action) }))) return false;
    if (manager(d.action) && !(await entries.requireRole(i, "accounts_manager"))) return false;
    if (!live(d)) { await reject(i); return false; }
    return true;
  }
  async function choices(d: Draft, field: Field): Promise<CharacterAccount[]> {
    let accounts: CharacterAccount[];
    if (d.action === "statement" || (d.action === "give" && field === "from")) accounts = await repository.listAccountsForUser(d.guild, d.owner);
    else if (d.action === "give") accounts = d.recipient ? await repository.listAccountsForUser(d.guild, d.recipient) : [];
    else accounts = await repository.listAccounts(d.guild);
    return accounts.filter((a) => a.discordGuildId === d.guild && (d.action === "statement" ? a.status !== "closed" : a.status === "open")
      && (d.action !== "statement" || a.discordUserId === d.owner)
      && (d.action !== "give" || a.discordUserId === (field === "from" ? d.owner : d.recipient))
      && !(d.action === "transfer" && field === "to" && key(a) === d.selected.from));
  }
  async function directory(d: Draft, field: Field, name: string) {
    const eligible = await choices(d, field);
    if (!live(d)) return undefined;
    if (d.selected[field] && !eligible.some((a) => key(a) === d.selected[field])) delete d.selected[field];
    if (!d.selected[field] && eligible.length === 1 && (d.action === "statement" || d.action === "give")) d.selected[field] = key(eligible[0]);
    const filtered = eligible.filter((a) => a.characterName.toLocaleLowerCase().includes(d.query[field].toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    d.page[field] = Math.max(0, Math.min(d.page[field], pages - 1));
    const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:select:${field}`).setPlaceholder(name);
    if (filtered.length) select.addOptions(...filtered.slice(d.page[field] * PAGE_SIZE, (d.page[field] + 1) * PAGE_SIZE).map((a) => ({ label: label(a), value: key(a), default: d.selected[field] === key(a) })));
    else select.addOptions({ label: "No accounts.", value: "unavailable" }).setDisabled(true);
    const rows: Row[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
    const searchable = eligible.length > PAGE_SIZE || Boolean(d.query[field]);
    if (searchable) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(d, `search:${field}`, "Search"), button(d, `previous:${field}`, "Previous", d.page[field] === 0), button(d, `next:${field}`, "Next", d.page[field] === pages - 1),
    ));
    const selected = eligible.find((a) => key(a) === d.selected[field]);
    return { rows, eligible, selected, text: [
      ...(selected ? [`**${name}** ${label(selected)}`] : []),
      ...(searchable ? [`Page ${d.page[field] + 1} of ${pages}`] : []),
      ...(eligible.length > 0 && filtered.length === 0 ? ["No matching accounts."] : []),
    ].join("\n") };
  }
  async function setup(d: Draft) {
    const rows: Row[] = [];
    const lines: string[] = [];
    let complete = false;
    if (d.action === "give") {
      lines.push("# Give", "Choose the accounts to transfer between.");
      const from = await directory(d, "from", "From");
      const to = await directory(d, "to", "To");
      if (!from || !to) return card(`# Start Again\n\n${START_AGAIN}`);
      if (!from.eligible.length) return feedbackMessage({ text: "You have no open accounts to give from." });
      rows.push(...from.rows, new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        new UserSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:recipient`).setPlaceholder("Recipient").setMinValues(1).setMaxValues(1)
          .setDefaultUsers(...(d.recipient ? [d.recipient] : [])),
      ), ...to.rows);
      lines.push(from.text, to.text);
      if (d.recipient && !to.eligible.length) lines.push("That member has no open character accounts. Choose another member.");
      complete = Boolean(from.selected && to.selected && d.recipient);
    } else {
      const field: Field = d.action === "transfer" ? d.step : "character";
      const heading = d.action === "statement" ? "Statement" : d.action === "credit" ? "Credit" : d.action === "debit" ? "Debit" : "Transfer";
      const instruction = d.action === "statement" ? "Choose your Albion Online character account." : d.action === "credit" ? "Choose the Albion Online character account to credit." : d.action === "debit" ? "Choose the Albion Online character account to debit." : d.step === "from" ? "Choose the source Albion Online character account." : "Choose the destination Albion Online character account.";
      lines.push(`# ${heading}`, instruction);
      const directoryView = await directory(d, field, field === "character" ? "Character" : field === "from" ? "From" : "To");
      if (!directoryView) return card(`# Start Again\n\n${START_AGAIN}`);
      rows.push(...directoryView.rows);
      lines.push(directoryView.text);
      if (!directoryView.eligible.length) lines.push(d.action === "statement" ? "No accounts." : "No open accounts are available.");
      complete = Boolean(directoryView.selected);
    }
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(d, "continue", d.action === "statement" ? "View Statement" : "Continue", !complete),
      ...(d.action === "transfer" && d.step === "to" ? [button(d, "back", "Back")] : []),
      button(d, "cancel", "Cancel"),
    ));
    return card(lines.filter(Boolean).join("\n\n"), rows);
  }
  async function snapshot(d: Draft): Promise<Readonly<Snapshot> | undefined> {
    const fields: Field[] = d.action === "give" || d.action === "transfer" ? ["from", "to"] : ["character"];
    const result: Snapshot = { recipient: d.recipient };
    for (const field of fields) {
      const account = (await choices(d, field)).find((a) => key(a) === d.selected[field]);
      if (!account || !live(d)) return undefined;
      result[field] = Object.freeze({ ref: Object.freeze({ discordGuildId: d.guild, albionServer: account.albionServer, albionCharacterId: account.albionCharacterId }), label: label(account) });
    }
    return Object.freeze(result);
  }
  function moneyModal(d: Draft, selected: Readonly<Snapshot>) {
    const title = d.action === "give" ? "Give Account Funds" : d.action === "transfer" ? "Transfer Account Funds" : d.action === "credit" ? "Credit Account" : "Debit Account";
    const context = selected.character ? `**Character** ${selected.character.label}` : `**From** ${selected.from!.label}\n**To** ${selected.to!.label}`;
    return new ModalBuilder().setCustomId(`${PREFIX}${d.id}:submit:${d.form}`).setTitle(title)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(context))
      .addLabelComponents(
        new LabelBuilder().setLabel("Amount").setDescription("Enter a positive amount in whole silver.")
          .setTextInputComponent(new TextInputBuilder().setCustomId("amount").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(19)),
        new LabelBuilder().setLabel("Description").setDescription("Optional transaction description, up to 200 characters.")
          .setTextInputComponent(new TextInputBuilder().setCustomId("description").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200)),
      );
  }
  async function publicEntry(i: ButtonInteraction, generation: string, action: string) {
    const current = fence(i.guildId);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (!["give", "balance", "statement", "credit", "debit", "transfer"].includes(action) || !current()) { await reject(i); return; }
    const access = await entries.checkAccess(i, "accounts", { generation, mutation: mutation(action) });
    if (!access || (manager(action) && !(await entries.requireRole(i, "accounts_manager")))) return;
    if (!current()) { await reject(i); return; }
    if (action === "balance") {
      const accounts = await repository.listAccountsForUser(i.guildId!, i.user.id);
      if (!current()) { await reject(i); return; }
      await editFeedback(i, { ...buildBalanceFeedback(accounts.filter((a) => a.discordUserId === i.user.id && a.discordGuildId === i.guildId)), allowedMentions: mentions });
      return;
    }
    for (const [id, d] of drafts) if (!live(d)) drafts.delete(id);
    const d: Draft = {
      id: randomUUID().slice(0, 18), guild: i.guildId!, owner: i.user.id,
      selection: { discordChannelId: access.discordChannelId, configurationRevision: access.configurationRevision },
      expires: now() + 15 * 60000, action: action as AccountAction, step: "from", selected: {},
      query: { character: "", from: "", to: "" }, page: { character: 0, from: 0, to: 0 }, state: "setup", version: 0, form: 0,
    };
    drafts.set(d.id, d);
    await editPrivatePanel(i, await setup(d));
  }
  async function handleButton(i: ButtonInteraction) {
    const publicId = parseEntryPanelId(i.customId);
    if (publicId?.feature === "accounts") { await publicEntry(i, publicId.generation, publicId.action); return; }
    const d = find(i);
    const [, , action, field] = i.customId.split(":");
    if (!d || !["setup", "form"].includes(d.state)) { await reject(i); return; }
    if (action === "cancel") {
      if (!(await entries.checkAccess(i, "accounts", { expected: d.selection }))) return;
      if (!live(d)) { await reject(i); return; }
      drafts.delete(d.id);
      await completeFeedbackPrompt(i, { text: "Cancelled. No changes were made." });
      return;
    }
    if (action === "search") {
      if (!isField(field) || (d.action === "transfer" && field !== d.step)) { await reject(i); return; }
      if (!(await authorized(i, d))) return;
      d.form++;
      d.state = "setup";
      d.search = { field, form: d.form };
      d.version++;
      await i.showModal(new ModalBuilder().setTitle("Search Accounts").setCustomId(`${PREFIX}${d.id}:search-submit:${d.form}`)
        .addLabelComponents(new LabelBuilder().setLabel("Albion Online Character").setDescription("Enter a character name, or leave blank to show all eligible accounts.")
          .setTextInputComponent(new TextInputBuilder().setCustomId("query").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setValue(d.query[field]))));
      return;
    }
    if (action === "continue") {
      if (!(await authorized(i, d))) return;
      const version = d.version;
      if (d.action === "transfer" && d.step === "from") {
        const available = await choices(d, "from");
        if (!live(d) || version !== d.version || !available.some((a) => key(a) === d.selected.from)) { await reject(i); return; }
        d.step = "to"; d.state = "setup"; d.form++; d.version++;
        await i.update(await setup(d));
        return;
      }
      const selected = await snapshot(d);
      if (!selected || version !== d.version) { await reject(i); return; }
      if (d.action === "statement") {
        d.state = "submitting";
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        if (!(await authorized(i, d))) return;
        const account = await repository.getAccount(selected.character!.ref);
        if (!account || account.discordUserId !== d.owner || account.status === "closed") { drafts.delete(d.id); await reject(i); return; }
        const transactions = await repository.listTransactions(account.accountId);
        const content = await buildStatementText(i.guild, i.guild?.name ?? "Unknown Server", account, transactions);
        const currentAccount = await repository.getAccount(selected.character!.ref);
        if (!live(d) || !currentAccount || currentAccount.discordUserId !== d.owner || currentAccount.status === "closed") { await reject(i); return; }
        if (!(await authorized(i, d))) return;
        d.state = "done";
        await i.editReply(v2Edit({ accentColor: REPORT_COLOR, files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: "statement.txt" })], allowedMentions: mentions }));
        return;
      }
      d.form++; d.version++; d.state = "form"; d.snapshot = selected; d.search = undefined;
      try { await i.showModal(moneyModal(d, selected)); }
      catch (error) { if (live(d) && d.state === "form") d.state = "setup"; throw error; }
      return;
    }
    if (action !== "back" && action !== "previous" && action !== "next") { await reject(i); return; }
    await i.deferUpdate();
    if (!(await authorized(i, d))) return;
    if (action === "back") {
      if (d.action !== "transfer" || d.step !== "to") { await reject(i); return; }
      d.step = "from";
    } else {
      if (!isField(field) || (d.action === "transfer" && field !== d.step)) { await reject(i); return; }
      d.page[field] += action === "next" ? 1 : -1;
    }
    d.state = "setup"; d.form++; d.version++;
    await editPrivatePanel(i, await setup(d));
  }
  async function handleSelect(i: StringSelectMenuInteraction | UserSelectMenuInteraction) {
    await i.deferUpdate();
    const d = find(i);
    const [, , action, field] = i.customId.split(":");
    if (!d || !["setup", "form"].includes(d.state)) { await reject(i); return; }
    if (!(await authorized(i, d))) return;
    const version = d.version;
    if (action === "recipient" && d.action === "give" && i.isUserSelectMenu()) {
      const recipient = i.values[0];
      const member = await i.guild?.members.fetch({ user: recipient, force: true }).catch(() => undefined);
      if (!live(d) || version !== d.version) { await reject(i); return; }
      if (!member || member.user.bot || recipient === d.owner) { await reject(i, "Invalid Recipient", "Choose another current Discord member."); return; }
      d.recipient = recipient;
      delete d.selected.to;
      d.query.to = ""; d.page.to = 0;
    } else if (action === "select" && isField(field) && !i.isUserSelectMenu()) {
      if ((d.action === "transfer" && field !== d.step) || (d.action === "give" ? field === "character" : d.action !== "transfer" && field !== "character")) { await reject(i); return; }
      const available = await choices(d, field);
      if (!live(d) || version !== d.version || !available.some((a) => key(a) === i.values[0])) { await reject(i); return; }
      d.selected[field] = i.values[0];
      if (field === "from" && d.selected.from === d.selected.to) delete d.selected.to;
    } else { await reject(i); return; }
    d.state = "setup"; d.form++; d.version++; d.search = undefined;
    await editPrivatePanel(i, await setup(d));
  }
  async function handleModal(i: ModalSubmitInteraction) {
    const d = find(i);
    const [, , action, form] = i.customId.split(":");
    if (!d) { await reject(i); return; }
    if (action === "search-submit") {
      if (d.state !== "setup" || !d.search || String(d.search.form) !== form || String(d.form) !== form) { await reject(i); return; }
      const field = d.search.field;
      await i.deferUpdate();
      if (!(await authorized(i, d)) || String(d.form) !== form) return;
      d.query[field] = i.fields.getTextInputValue("query").trim().slice(0, 100); d.page[field] = 0; d.search = undefined; d.version++;
      await editPrivatePanel(i, await setup(d));
      return;
    }
    if (action !== "submit" || d.state !== "form" || String(d.form) !== form || !d.snapshot) { await reject(i); return; }
    const selected = d.snapshot;
    d.state = "submitting";
    d.version++;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await entries.runExclusive(d.guild, async () => {
      if (d.state !== "submitting") { await reject(i); return; }
      if (!(await authorized(i, d))) { drafts.delete(d.id); return; }
      const amount = parseAccountFormAmount(i.fields.getTextInputValue("amount"));
      const description = i.fields.getTextInputValue("description").trim();
      if (amount === undefined || description.length > 200) {
        d.state = "setup";
        await reject(i, amount === undefined ? "Invalid Amount" : "Invalid Description", amount === undefined ? "Enter a positive amount in whole silver." : "Optional transaction description, up to 200 characters.");
        return;
      }
      try {
        let title: string;
        let text: string;
        if (d.action === "give" || d.action === "transfer") {
          if (d.action === "give") {
            const recipient = await i.guild?.members.fetch({ user: selected.recipient!, force: true }).catch(() => undefined);
            if (!recipient || recipient.user.bot || selected.recipient === d.owner) throw new AccountOperationError("ownership_changed");
          }
          if (!live(d)) { await reject(i); return; }
          const result = await repository.transfer(selected.from!.ref, selected.to!.ref, amount, d.owner, description || undefined,
            d.action === "give" ? { fromDiscordUserId: d.owner, toDiscordUserId: selected.recipient! } : undefined);
          title = d.action === "give" ? "Funds Given" : "Funds Transferred";
          text = `${formatAccountAmount(amount)} transferred from ${result.from.characterName} to ${result.to.characterName}.`;
        } else {
          const action = d.action as "credit" | "debit";
          const account = await repository.adjust(selected.character!.ref, action, action === "debit" ? -amount : amount, d.owner, description || undefined);
          title = action === "credit" ? "Account Credited" : "Account Debited";
          text = `${account.characterName}'s account was ${action === "credit" ? "credited" : "debited"}; its balance is now ${formatAccountAmount(account.balance)}.`;
        }
        // A receipt failure must never make this draft spend funds twice.
        d.state = "done";
        await editFeedback(i, { cards: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle(title).setDescription(text)], allowedMentions: mentions });
      } catch (error) {
        if (d.state === "done") throw error;
        d.state = "done";
        if (!(error instanceof AccountOperationError)) throw error;
        await editFeedback(i, { cards: [new EmbedBuilder().setColor(INVALID_COLOR).setTitle("Account Unchanged").setDescription(accountOperationErrorMessage(error))], allowedMentions: mentions }, "context");
      }
    });
  }
  return {
    async handle(i: EntryInteraction): Promise<boolean> {
      if (!("customId" in i) || (!i.customId.startsWith(PREFIX) && !i.customId.startsWith("entry-panel:accounts:"))) return false;
      if (stopped) { await reject(i); return true; }
      const d = i.customId.startsWith(PREFIX) ? find(i as PrivateInteraction) : undefined;
      if (d && busy.has(d.id)) { await reject(i); return true; }
      if (d) busy.add(d.id);
      try {
        if (i.isButton()) await handleButton(i);
        else if (i.isStringSelectMenu() || i.isUserSelectMenu()) await handleSelect(i);
        else if (i.isModalSubmit()) await handleModal(i);
        else await reject(i);
      } finally { if (d) busy.delete(d.id); }
      return true;
    },
    invalidateGuild(guildId: string) {
      guildEpochs.set(guildId, (guildEpochs.get(guildId) ?? 0) + 1);
      for (const [id, d] of drafts) if (d.guild === guildId) { drafts.delete(id); busy.delete(id); }
    },
    start() { stopped = false; },
    stop() { stopped = true; epoch++; drafts.clear(); busy.clear(); },
  };
}

function isField(field: string): field is Field { return field === "character" || field === "from" || field === "to"; }
