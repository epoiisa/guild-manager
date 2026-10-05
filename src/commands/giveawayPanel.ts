import type { MessageCreateOptions } from "discord.js";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, FileUploadBuilder,
  LabelBuilder, MessageFlags, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown,
  type Attachment, type ButtonInteraction, type ModalSubmitInteraction,
  type RoleSelectMenuInteraction, type StringSelectMenuInteraction
} from "discord.js";
import { createHash, randomUUID } from "node:crypto";
import type { GiveawayRecord, GiveawayWinner, createGiveawayRepository } from "../db/giveawayRepository.js";
import { completeFeedbackPrompt, editFeedback, editPrivatePanel, feedbackMessage, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import type { Logger } from "../logging/logger.js";
import { entryPanelId, parseEntryPanelId, type EntryInteraction, type EntryPanelContext, type EntrySelection } from "../services/entryPanels/types.js";
import { GiveawayPublicationError, publishGiveaway } from "../services/giveaways/hosting.js";
import { buildGiveawayCreatedEmbed, escapeMarkdownLinkText } from "../services/giveaways/rendering.js";
import { createGiveawayService } from "../services/giveaways/service.js";
import { buildNextUtcDateChoices, parseUtcDateTime } from "../services/scheduling.js";
import { INFO_COLOR } from "./configurationHelpers.js";
import { invalidateGiveawayDrafts } from "./giveaway.js";

const PREFIX = "giveaway-panel:";
const TTL = 15 * 60_000;
const TEXT_LIMIT = 3800;
const mentions = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };
const START_AGAIN = "# Start Again\n\nThis control is no longer current. Open the latest entry panel and start again.";
type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<RoleSelectMenuBuilder>;
type PanelInteraction = ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction;

function card(text: string, rows: Row[] = []) {
  return {
    components: [new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(...rows.map((row) => row.toJSON()))],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: mentions
  };
}
function button(id: string, action: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(`${PREFIX}${id}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
}
function url(g: GiveawayRecord) { return `https://discord.com/channels/${g.discordGuildId}/${g.channelId}/${g.originalMessageId}`; }
function timestamp(date: Date) { const t = Math.floor(date.getTime() / 1000); return `<t:${t}:F> (<t:${t}:R>)`; }
function stateLabel(g: GiveawayRecord) { return g.state === "open" ? "Open" : g.state === "drawn" ? "Drawn" : "Cancelled"; }
function orderedOpen(records: readonly GiveawayRecord[]) {
  return records.filter((g) => g.state === "open").sort((a, b) => a.drawAt.getTime() - b.drawAt.getTime() || a.giveawayId.localeCompare(b.giveawayId));
}
export function giveawayPanelRows(records: readonly GiveawayRecord[]): string[] {
  return orderedOpen(records).map((g) => `- [${escapeMarkdown(g.title.replace(/\s+/g, " ").trim())}](${url(g)}) • draws <t:${Math.floor(g.drawAt.getTime() / 1000)}:R> • ${g.winnerCount} ${g.winnerCount === 1 ? "winner" : "winners"} • <@${g.creatorDiscordUserId}>`);
}
function listText(rows: string[], total: number) {
  return total
    ? `# Giveaways\n\nOpen a giveaway below and react with 🎁 to enter.\n\n**Open Giveaways (${total})**\n${rows.join("\n")}`
    : "# Giveaways\n\nNo giveaways are open for entries.";
}

/** The caller supplies the configured channel's records. */
export function buildGiveawayPanel(records: readonly GiveawayRecord[], generation: string) {
  const rows = giveawayPanelRows(records);
  let shown = rows.length;
  const text = (count: number) => `${listText(rows.slice(0, count), rows.length)}${count < rows.length ? `\n\n… and ${rows.length - count} more.` : ""}`;
  while (shown && text(shown).length > TEXT_LIMIT) shown--;
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(entryPanelId("giveaways", generation, "host")).setLabel("Host Giveaway").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(entryPanelId("giveaways", generation, "mine")).setLabel("My Giveaways").setStyle(ButtonStyle.Secondary)
  );
  if (shown < rows.length) controls.addComponents(new ButtonBuilder().setCustomId(entryPanelId("giveaways", generation, "all")).setLabel("View All Giveaways").setStyle(ButtonStyle.Secondary));
  const payload = { ...card(text(shown), [controls]), flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications };
  return { payload, hash: createHash("sha256").update(JSON.stringify(payload.components[0].toJSON())).digest("hex"), overflow: rows.length - shown };
}

interface Draft extends EntrySelection {
  id: string;
  guild: string;
  owner: string;
  expires: number;
  kind: "host" | "mine" | "all";
  page: number;
  screen: number;
  busy?: boolean;
  state: "setup" | "form" | "submitting" | "done";
  date: string;
  winnerCount: number;
  notificationRoleId?: string;
  form: number;
  selection?: Readonly<{ date: string; winnerCount: number; notificationRoleId?: string }>;
  giveawayId?: string;
  winnerId?: string;
  confirmation?: Readonly<{ action: "draw" | "cancel"; giveawayId: string }>;
}
export interface GiveawayPanelDependencies {
  repository: ReturnType<typeof createGiveawayRepository>;
  entries: EntryPanelContext;
  logger: Logger;
  now?: () => number;
  service?: ReturnType<typeof createGiveawayService>;
}

export function buildGiveawayHostModal(customId: string, selection: Readonly<{ date: string; winnerCount: number; notificationRoleId?: string }>) {
  return new ModalBuilder().setCustomId(customId).setTitle("Create Giveaway")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `**Draw Date (UTC)**\n${selection.date}\n\n**Winners**\n${selection.winnerCount}\n\n**Notification Role**\n${selection.notificationRoleId ? `<@&${selection.notificationRoleId}>` : "None"}`
    ))
    .addLabelComponents(
      new LabelBuilder().setLabel("Title").setDescription("Name the giveaway.").setTextInputComponent(new TextInputBuilder().setCustomId("title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new LabelBuilder().setLabel("Description").setDescription("Describe the prize and any participation instructions.").setTextInputComponent(new TextInputBuilder().setCustomId("description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
      new LabelBuilder().setLabel("Draw Time (UTC)").setDescription("Enter H, HH, H:MM, or HH:MM in UTC. 24:00 means the end of the selected date.").setTextInputComponent(new TextInputBuilder().setCustomId("time").setStyle(TextInputStyle.Short).setRequired(true)),
      new LabelBuilder().setLabel("Image").setDescription("Optionally upload one giveaway image.").setFileUploadComponent(new FileUploadBuilder().setCustomId("image").setRequired(false).setMinValues(1).setMaxValues(1))
    );
}

export function createGiveawayPanelInteractions({ repository, entries, logger, now = Date.now, service = createGiveawayService(repository, logger) }: GiveawayPanelDependencies) {
  const drafts = new Map<string, Draft>();
  let stopped = false;
  let epoch = 0;
  const guildEpochs = new Map<string, number>();
  const live = (d: Draft) => !stopped && drafts.get(d.id) === d && d.expires > now();
  function find(i: PanelInteraction) {
    const d = drafts.get(i.customId.split(":")[1]);
    return d && live(d) && d.guild === i.guildId && d.owner === i.user.id ? d : undefined;
  }
  async function reject(i: PanelInteraction, text = START_AGAIN, rows: Row[] = []) {
    const parts = /^# ([^\n]+)\n\n([\s\S]+)$/u.exec(text);
    const options = { ...(parts ? { cards: [{ title: parts[1], description: parts[2] }] } : { text }), actionRows: rows, allowedMentions: mentions };
    if (i.replied || i.deferred) await editFeedback(i, options, "context");
    else await i.reply(feedbackReply({ ...options, flags: MessageFlags.Ephemeral }, "context"));
  }
  async function access(i: PanelInteraction, d: Draft, mutation = false) {
    if (!live(d)) { await reject(i); return undefined; }
    const a = await entries.checkAccess(i, "giveaways", { expected: d, mutation });
    if (!a) return undefined;
    if (!live(d)) { await reject(i); return undefined; }
    if (!live(d)) { await reject(i); return undefined; }
    return a;
  }
  function draftButton(d: Draft, action: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, disabled = false) {
    return button(d.id, d.kind === "host" ? action : `${action}:${d.screen}`, label, style, disabled);
  }
  function setup(d: Draft) {
    const roles = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:role`).setPlaceholder("Notification Role").setMinValues(0).setMaxValues(1);
    if (d.notificationRoleId) roles.setDefaultRoles(d.notificationRoleId);
    return card("# Host Giveaway\n\nChoose the draw date, number of winners, and optional notification role.", [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:date`).setPlaceholder("Draw Date (UTC)").addOptions(buildNextUtcDateChoices(new Date(now())).map((c) => ({ label: c.name, value: c.value, default: d.date === c.value })))),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:winners`).setPlaceholder("Winners").addOptions([1, 2, 3, 4, 5].map((value) => ({ label: String(value), value: String(value), default: value === d.winnerCount })))),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roles),
      new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "continue", "Continue", ButtonStyle.Primary, !d.date), draftButton(d, "cancel", "Cancel"))
    ]);
  }
  function paging(d: Draft, page: number, pages: number) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      draftButton(d, "previous", "Previous", ButtonStyle.Secondary, page === 0),
      draftButton(d, "next", "Next", ButtonStyle.Secondary, page === pages - 1)
    );
  }
  async function list(d: Draft) {
    d.screen++;
    d.giveawayId = undefined;
    d.winnerId = undefined;
    d.confirmation = undefined;
    if (d.kind === "all") {
      const rows = giveawayPanelRows((await repository.listOpen(d.guild)).filter((g) => g.channelId === d.discordChannelId));
      const pages: string[][] = [[]];
      for (const row of rows) {
        if (pages.at(-1)!.join("\n").length + row.length > TEXT_LIMIT - 250) pages.push([]);
        pages.at(-1)!.push(row);
      }
      d.page = Math.max(0, Math.min(d.page, pages.length - 1));
      return card(`${listText(pages[d.page], rows.length)}${pages.length > 1 ? `\n\nPage ${d.page + 1} of ${pages.length}` : ""}`, pages.length > 1 ? [paging(d, d.page, pages.length)] : []);
    }
    const records = await repository.listHostHistory(d.guild, d.owner);
    if (records.length === 0) return card("# My Giveaways\n\nYou have not hosted any giveaways.");
    const pages = Math.ceil(records.length / 25);
    d.page = Math.max(0, Math.min(d.page, pages - 1));
    const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:giveaway:${d.screen}`).setPlaceholder("Giveaway").addOptions(records.slice(d.page * 25, d.page * 25 + 25).map((g) => {
      const suffix = ` • ${stateLabel(g)} • ${g.drawAt.toISOString().slice(0, 10)}`;
      const title = g.title.length + suffix.length <= 100 ? g.title : `${g.title.slice(0, 99 - suffix.length)}…`;
      return { label: `${title}${suffix}`, value: g.giveawayId };
    }));
    return card(`# My Giveaways\n\nSelect one of your giveaways to manage it.${pages > 1 ? `\n\nPage ${d.page + 1} of ${pages}` : ""}`, [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), ...(pages > 1 ? [paging(d, d.page, pages)] : [])]);
  }
  async function owned(d: Draft) {
    const g = d.giveawayId ? await repository.getById(d.guild, d.giveawayId) : undefined;
    return g?.creatorDiscordUserId === d.owner ? g : undefined;
  }
  async function detail(d: Draft, g: GiveawayRecord) {
    d.screen++;
    d.giveawayId = g.giveawayId;
    d.confirmation = undefined;
    d.winnerId = undefined;
    const winners = g.state === "drawn" ? (await repository.listWinners(d.guild, g.giveawayId)).filter((w) => w.status === "current") : [];
    const timeLabel = g.state === "open" ? "Draws" : stateLabel(g);
    const at = g.state === "drawn" ? g.drawnAt ?? g.drawAt : g.state === "cancelled" ? g.cancelledAt ?? g.drawAt : g.drawAt;
    const winnerText = g.state === "open" ? String(g.winnerCount) : g.state === "cancelled" ? "No winners were drawn." : winners.map((w) => `<@${w.discordUserId}>`).join(" ") || "No eligible winners.";
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open Giveaway").setURL(url(g)));
    if (g.state === "open") controls.addComponents(draftButton(d, "draw", "Draw Now", ButtonStyle.Primary), draftButton(d, "cancel-giveaway", "Cancel Giveaway", ButtonStyle.Danger));
    if (g.state === "drawn") controls.addComponents(draftButton(d, "reroll", "Reroll Winner"));
    controls.addComponents(draftButton(d, "back", "Back"));
    return card(`# My Giveaways\n## [${escapeMarkdownLinkText(g.title)}](${url(g)})\n\n**Status**\n${stateLabel(g)}\n\n**${timeLabel}**\n${timestamp(at)}\n\n**Winners**\n${winnerText}`, [controls]);
  }
  async function rerollSetup(i: PanelInteraction, d: Draft, g: GiveawayRecord) {
    d.screen++;
    const winners = (await repository.listWinners(d.guild, g.giveawayId)).filter((w) => w.status === "current");
    if (d.winnerId && !winners.some((w) => w.discordUserId === d.winnerId)) d.winnerId = undefined;
    const rows: Row[] = [];
    if (winners.length) rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:winner:${d.screen}`).setPlaceholder("Winner").addOptions(winners.map((w) => ({
      label: (i.guild?.members.cache.get(w.discordUserId)?.displayName ?? i.client.users.cache.get(w.discordUserId)?.username ?? w.discordUserId).slice(0, 100),
      value: w.discordUserId,
      default: d.winnerId === w.discordUserId
    })))));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "reroll-confirm", "Reroll Winner", ButtonStyle.Secondary, !d.winnerId), draftButton(d, "detail", "Back")));
    return card("# Reroll Winner\n\nSelect the winner to replace.", rows);
  }
  async function show(i: PanelInteraction, d: Draft, payload: MessageCreateOptions) {
    if (live(d)) await editPrivatePanel(i, payload); else await reject(i);
  }
  async function refresh(i: PanelInteraction) {
    if (i.guild) await entries.refresh(i.guild).catch((error) => logger.warn("giveaway panel refresh failed", { guildId: i.guildId, error: error instanceof Error ? error.message : String(error) }));
  }
  async function handleButton(i: ButtonInteraction): Promise<boolean> {
    const publicId = parseEntryPanelId(i.customId);
    if (publicId?.feature === "giveaways") {
      const openingEpoch = epoch;
      const guildEpoch = guildEpochs.get(i.guildId!) ?? 0;
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (stopped || !["host", "mine", "all"].includes(publicId.action)) { await reject(i); return true; }
      const a = await entries.checkAccess(i, "giveaways", { generation: publicId.generation, mutation: publicId.action === "host" });
      if (!a) return true;
      if (stopped || openingEpoch !== epoch || guildEpoch !== (guildEpochs.get(i.guildId!) ?? 0)) { await reject(i); return true; }
      for (const [id, d] of drafts) if (d.expires <= now()) drafts.delete(id);
      const d: Draft = { id: randomUUID().slice(0, 18), guild: i.guildId!, owner: i.user.id, discordChannelId: a.discordChannelId, configurationRevision: a.configurationRevision, expires: now() + TTL, kind: publicId.action as Draft["kind"], state: "setup", page: 0, screen: 0, date: "", winnerCount: 1, form: 0 };
      drafts.set(d.id, d);
      await show(i, d, d.kind === "host" ? setup(d) : await list(d));
      return true;
    }
    if (!i.customId.startsWith(PREFIX)) {
      if (i.customId.startsWith("entry-panel:giveaways:")) { await reject(i); return true; }
      return false;
    }
    const d = find(i);
    const action = i.customId.split(":")[2];
    if (!d || (d.kind !== "host" && i.customId.split(":")[3] !== String(d.screen)) || d.state === "submitting" || d.state === "done") { await reject(i); return true; }
    if (d.kind === "host" && action === "continue") {
      if (!await access(i, d, true)) return true;
      if (!d.date || !buildNextUtcDateChoices(new Date(now())).some((c) => c.value === d.date)) { await reject(i); return true; }
      d.form++;
      d.state = "form";
      d.selection = Object.freeze({ date: d.date, winnerCount: d.winnerCount, notificationRoleId: d.notificationRoleId });
      await i.showModal(buildGiveawayHostModal(`${PREFIX}${d.id}:submit:${d.form}`, d.selection));
      return true;
    }
    await i.deferUpdate();
    if (!await access(i, d, ["draw", "cancel-giveaway", "draw-confirm", "cancel-confirm", "reroll-confirm"].includes(action))) return true;
    if (d.kind === "host") {
      if (action === "cancel") { drafts.delete(d.id); await completeFeedbackPrompt(i, { text: "Cancelled. No changes were made." }); }
      else await reject(i);
      return true;
    }
    if (action === "next" || action === "previous" || action === "back") {
      if (action !== "back") d.page = Math.max(0, d.page + (action === "next" ? 1 : -1));
      await show(i, d, await list(d));
      return true;
    }
    if (d.kind !== "mine") { await reject(i); return true; }
    const g = await owned(d);
    if (!g || !live(d)) { await reject(i); return true; }
    if (action === "detail" || action === "keep") { await show(i, d, await detail(d, g)); return true; }
    if (action === "draw" || action === "cancel-giveaway") {
      if (g.state !== "open") { await show(i, d, await detail(d, g)); return true; }
      const drawing = action === "draw";
      d.screen++;
      d.confirmation = Object.freeze({ action: drawing ? "draw" : "cancel", giveawayId: g.giveawayId });
      await show(i, d, card(drawing ? `# Draw Giveaway\n\nDraw “${g.title}” now? This closes entries and selects the winners.` : `# Cancel Giveaway\n\nCancel “${g.title}”? No winners will be drawn.`, [new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, drawing ? "draw-confirm" : "cancel-confirm", drawing ? "Draw Now" : "Cancel Giveaway", drawing ? ButtonStyle.Primary : ButtonStyle.Danger), draftButton(d, "keep", "Keep Giveaway"))]));
      return true;
    }
    if (action === "reroll") {
      if (g.state !== "drawn") { await show(i, d, await detail(d, g)); return true; }
      d.winnerId = undefined;
      await show(i, d, await rerollSetup(i, d, g));
      return true;
    }
    if (!["draw-confirm", "cancel-confirm", "reroll-confirm"].includes(action)) { await reject(i); return true; }
    if (action !== "reroll-confirm" && (d.confirmation?.giveawayId !== g.giveawayId || `${d.confirmation.action}-confirm` !== action)) { await reject(i); return true; }
    const winnerId = d.winnerId;
    if (action === "reroll-confirm" && !winnerId) { await reject(i); return true; }
    d.confirmation = undefined;
    d.winnerId = undefined;
    d.state = "submitting";
    let changed = false;
    await entries.runExclusive(d.guild, async () => {
      if (!await access(i, d, true)) return;
      const current = await owned(d);
      if (!current || !live(d)) { await reject(i); return; }
      if (action === "reroll-confirm") {
        if (current.state !== "drawn") { d.state = "setup"; await show(i, d, await detail(d, current)); return; }
        const result = await service.reroll(i.guild!, current, winnerId!, i.user.id);
        changed = Boolean(result);
        d.state = "setup";
        if (result === "" || result === undefined) {
          await show(i, d, card(result === "" ? "# No Replacement Available\n\nNo eligible participant remains who has not already won." : "# Winner Not Found\n\nChoose a current winner.", [new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "detail", "Back"))]));
          return;
        }
        if (!result.notificationPublished) {
          await show(i, d, card(`# Winner Redrawn; Notification Not Posted\n\n<@${result.replacementDiscordUserId}> replaced <@${winnerId}>, but Guild Manager could not post the public notification.`, [new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "detail", "Back"))]));
          return;
        }
      } else if (current.state === "open") {
        if (action === "draw-confirm") {
          const result = await service.draw(i.guild!, current, i.user.id);
          changed = result !== "already_closed";
          if (result === "message_missing") {
            d.state = "setup";
            d.screen++;
            await show(i, d, card("# Giveaway Not Drawn\n\nThe giveaway message is missing or the giveaway was already closed.", [new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "detail", "Back"))]));
            return;
          }
        }
        else {
          const result = await service.cancel(i.guild!, current, i.user.id);
          changed = result !== "already_closed";
          if (result === "message_close_failed" || result === "message_missing") {
            d.state = "setup";
            await show(i, d, feedbackMessage({ text: "The giveaway was cancelled, but Guild Manager could not close its public message.", actionRows: [new ActionRowBuilder<ButtonBuilder>().addComponents(draftButton(d, "detail", "Back"))], allowActionRows: true, allowedMentions: mentions }));
            return;
          }
        }
      }
      d.state = "setup";
      const fresh = await owned(d);
      if (fresh) await show(i, d, await detail(d, fresh)); else await reject(i);
    });
    if (changed) await refresh(i);
    return true;
  }
  async function handleSelect(i: StringSelectMenuInteraction | RoleSelectMenuInteraction): Promise<boolean> {
    if (!i.customId.startsWith(PREFIX)) return false;
    await i.deferUpdate();
    const d = find(i);
    if (d && d.kind !== "host" && i.customId.split(":")[3] !== String(d.screen)) { await reject(i); return true; }
    if (!d || d.state !== "setup" || !await access(i, d, d.kind === "host")) { if (!d || d.state !== "setup") await reject(i); return true; }
    const action = i.customId.split(":")[2];
    if (d.kind === "host") {
      if (action === "date" && buildNextUtcDateChoices(new Date(now())).some((c) => c.value === i.values[0])) d.date = i.values[0];
      else if (action === "winners" && /^[1-5]$/.test(i.values[0])) d.winnerCount = Number(i.values[0]);
      else if (action === "role" && i.isRoleSelectMenu() && i.values.length <= 1) d.notificationRoleId = i.values[0];
      else { await reject(i); return true; }
      await show(i, d, setup(d));
      return true;
    }
    if (d.kind !== "mine") { await reject(i); return true; }
    if (action === "giveaway") {
      const g = await repository.getById(d.guild, i.values[0]);
      if (!g || g.creatorDiscordUserId !== d.owner || !live(d)) { await reject(i); return true; }
      d.giveawayId = g.giveawayId;
      await show(i, d, await detail(d, g));
    } else if (action === "winner") {
      const g = await owned(d);
      const winners: GiveawayWinner[] = g ? await repository.listWinners(d.guild, g.giveawayId) : [];
      if (!g || g.state !== "drawn" || !winners.some((w) => w.status === "current" && w.discordUserId === i.values[0]) || !live(d)) { await reject(i); return true; }
      d.winnerId = i.values[0];
      await show(i, d, await rerollSetup(i, d, g));
    } else await reject(i);
    return true;
  }
  async function handleModal(i: ModalSubmitInteraction): Promise<boolean> {
    if (!i.customId.startsWith(PREFIX)) return false;
    const d = find(i);
    const match = /^giveaway-panel:[a-z0-9-]+:submit:([1-9][0-9]*)$/.exec(i.customId);
    if (!d || d.kind !== "host" || d.state !== "form" || !match || String(d.form) !== match[1] || !d.selection) { await reject(i); return true; }
    const selection = d.selection;
    d.state = "submitting";
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let created = false;
    await entries.runExclusive(d.guild, async () => {
      const a = await access(i, d, true);
      if (!a) return;
      const drawAt = parseUtcDateTime(selection.date, i.fields.getTextInputValue("time"));
      const images: Attachment[] = [...(i.fields.getUploadedFiles("image", false)?.values() ?? [])];
      if (!drawAt || drawAt.getTime() <= now()) {
        drafts.delete(d.id);
        await reject(i, "# Invalid Draw Time\n\nChoose a future UTC draw time.");
        return;
      }
      if (images.length > 1) {
        drafts.delete(d.id);
        await reject(i, "# Invalid Giveaway Image\n\nThe giveaway attachment must be one image.");
        return;
      }
      try {
        const result = await publishGiveaway({ guild: i.guild!, channel: a.channel, creatorDiscordUserId: d.owner, title: i.fields.getTextInputValue("title").trim(), description: i.fields.getTextInputValue("description").trim(), drawAt, winnerCount: selection.winnerCount, image: images[0], notificationRoleId: selection.notificationRoleId, repository, logger, now, validate: async () => Boolean(await access(i, d, true)) });
        if (!result) return;
        created = true;
        d.state = "done";
        await i.editReply(v2Edit({ cards: [buildGiveawayCreatedEmbed({ ...result.giveaway, messageUrl: result.messageUrl })], actionRows: [], allowedMentions: mentions }));
      } catch (error) {
        d.state = "done";
        if (!(error instanceof GiveawayPublicationError)) throw error;
        await reject(i, `# ${error.title}\n\n${error.message}`);
      }
    });
    if (created) await refresh(i);
    return true;
  }
  return {
    async handle(i: EntryInteraction): Promise<boolean> {
      if (!i.isButton() && !i.isStringSelectMenu() && !i.isRoleSelectMenu() && !i.isModalSubmit()) return false;
      const d = i.customId.startsWith(PREFIX) ? find(i) : undefined;
      if (d?.busy) { await reject(i); return true; }
      if (d) d.busy = true;
      try {
        if (i.isButton()) return await handleButton(i);
        if (i.isStringSelectMenu() || i.isRoleSelectMenu()) return await handleSelect(i);
        if (i.isModalSubmit()) return await handleModal(i);
        return false;
      } finally {
        if (d) d.busy = false;
      }
    },
    invalidateGuild(guildId: string) { invalidateGiveawayDrafts(guildId); guildEpochs.set(guildId, (guildEpochs.get(guildId) ?? 0) + 1); for (const [id, d] of drafts) if (d.guild === guildId) drafts.delete(id); },
    stop() { invalidateGiveawayDrafts(); epoch++; stopped = true; drafts.clear(); },
    start() { stopped = false; }
  };
}
