import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, FileUploadBuilder, LabelBuilder,
  MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder,
  TextInputStyle, type ButtonInteraction, type ChatInputCommandInteraction, type MessageCreateOptions
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { EligibleRegearCharacter, RegearContent, createRegearRepository } from "../db/regearRepository.js";
import { completeFeedbackPrompt, editPrivatePanel, feedbackMessage } from "../discord/feedbackMessages.js";
import { getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import { replyEntryState } from "../services/entryPanels/access.js";
import { entryPanelId, parseEntryPanelId, type EntryInteraction, type EntryPanelContext, type EntrySelection } from "../services/entryPanels/types.js";
import { formatLongDate, formatUtcTime, sanitizeUserText } from "../services/regears/rendering.js";
import { INFO_COLOR, truncateChoiceName } from "./configurationHelpers.js";
import { sendRegearHistory, submissionOptions, submitRegearRequest } from "./regear.js";

const PREFIX = "regear-entry:";
const EXPIRY_MS = 15 * 60_000;
const mentions = { parse: [] as never[], users: [], roles: [], repliedUser: false };
type Row = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;
function card(text: string, rows: Row[] = []) {
  return {
    components: [new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(...rows.map(row => row.toJSON()))],
    flags: MessageFlags.IsComponentsV2 as const, allowedMentions: mentions
  };
}
function ordered(contents: readonly RegearContent[]) {
  return contents.filter(c => c.state === "open").slice().sort((a, b) =>
    b.contentDate.localeCompare(a.contentDate)
    || (b.contentAt?.getTime() ?? 0) - (a.contentAt?.getTime() ?? 0)
    || a.name.localeCompare(b.name) || a.regearContentId.localeCompare(b.regearContentId));
}
function contentLine(c: RegearContent) {
  return `- ${sanitizeUserText(c.name)} • ${getAlbionServerLabel(c.albionServer)} • ${formatLongDate(c.contentDate)}${c.contentAt ? ` • ${formatUtcTime(c.contentAt)}` : ""}`;
}
export function buildRegearPanel(contents: readonly RegearContent[], generation: string): MessageCreateOptions {
  const available = ordered(contents);
  const heading = "# Re-gears\n\nSubmit a re-gear request for your Albion Online character.";
  let text = `${heading}\n\n${available.length ? `**Open Content (${available.length})**` : "No content is open for re-gear requests."}`;
  let shown = 0;
  for (const c of available) {
    const line = contentLine(c);
    if (text.length + line.length + 40 > 3800) break;
    text += `\n${line}`;
    shown++;
  }
  if (shown < available.length) text += `\n… and ${available.length - shown} more.`;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(entryPanelId("regears", generation, "submit")).setLabel("REGEAR ME").setStyle(ButtonStyle.Primary).setDisabled(!available.length),
    new ButtonBuilder().setCustomId(entryPanelId("regears", generation, "history")).setLabel("My Re-gears").setStyle(ButtonStyle.Secondary)
  );
  if (shown < available.length) row.addComponents(new ButtonBuilder().setCustomId(entryPanelId("regears", generation, "list")).setLabel("View All Content").setStyle(ButtonStyle.Secondary));
  return card(text, [row]);
}

async function update(i: Extract<EntryInteraction, { update: unknown }>, payload: MessageCreateOptions) {
  await editPrivatePanel(i, payload);
}

interface Draft extends EntrySelection {
  id: string; guild: string; owner: string; origin: string; expires: number;
  busy?: boolean; form: number;
  state: "setup" | "form" | "submitting" | "done";
  kind: "submit" | "list"; server?: AlbionServer; contentId?: string; characterId?: string; page: number;
  frozen?: Readonly<{ server: AlbionServer; contentId: string; characterId: string }>;
}
export interface RegearPanelDependencies {
  repository: ReturnType<typeof createRegearRepository>;
  entries: EntryPanelContext;
  now?: () => number;
}
export function createRegearPanelInteractions({ repository, entries, now = Date.now }: RegearPanelDependencies) {
  const drafts = new Map<string, Draft>();
  const alive = (d: Draft) => drafts.get(d.id) === d && d.expires > now();
  const button = (d: Draft, action: string, label: string, disabled = false) => new ButtonBuilder()
    .setCustomId(`${PREFIX}${d.id}:${action}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  async function stale(i: EntryInteraction) {
    await replyEntryState(i, "Start Again", "This control is no longer current. Open the latest entry panel and start again.");
  }
  async function validSubmission(i: EntryInteraction, d: Draft) {
    if (!alive(d)) { await stale(i); return false; }
    if (!await entries.checkAccess(i, "regears", { mutation: true, expected: d })) return false;
    if (!alive(d)) { await stale(i); return false; }
    return true;
  }
  function remember(i: EntryInteraction, selection: EntrySelection, kind: Draft["kind"]): Draft {
    for (const [id, draft] of drafts) if (!alive(draft)) drafts.delete(id);
    const d: Draft = { ...selection, id: randomUUID(), guild: i.guildId!, owner: i.user.id, origin: i.channelId!, expires: now() + EXPIRY_MS, state: "setup", kind, page: 0, form: 0 };
    drafts.set(d.id, d);
    return d;
  }
  async function choices(d: Draft) {
    const options = await submissionOptions(repository, d.guild, d.owner, d.server);
    if (!alive(d) || d.state !== "setup") return undefined;
    if (!d.server && options.servers.length === 1) d.server = options.servers[0];
    const contents = ordered(options.contents.filter(c => c.albionServer === d.server));
    const characters = options.characters.filter(c => c.albionServer === d.server);
    if (!contents.some(c => c.regearContentId === d.contentId)) d.contentId = contents.length === 1 ? contents[0].regearContentId : undefined;
    if (!characters.some(c => c.albionCharacterId === d.characterId)) d.characterId = characters.length === 1 ? characters[0].albionCharacterId : undefined;
    return { ...options, contents, characters };
  }
  const empty = () => feedbackMessage({ text: "No re-gear content available. You need a registered Albion Online character with active member-group membership on an Albion Online server that has open re-gear content." });
  function setup(d: Draft, options: NonNullable<Awaited<ReturnType<typeof choices>>>) {
    if (!options.servers.length) return empty();
    if (!d.server) return card("# Choose Re-gear Server\n\nChoose the Albion Online server for this request.", [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:server`).setPlaceholder("Albion Online Server").addOptions(options.servers.map(server => ({ label: getAlbionServerLabel(server), value: server })))),
      new ActionRowBuilder<ButtonBuilder>().addComponents(button(d, "cancel", "Cancel"))
    ]);
    if (!options.contents.length || !options.characters.length) return empty();
    return card("# Re-gear Request\n\nSelect the content and your Albion Online character.", [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:content`).setPlaceholder("Content").addOptions(options.contents.map(c => ({
        label: truncateChoiceName(c.name), description: truncateChoiceName(`${getAlbionServerLabel(c.albionServer)} • ${formatLongDate(c.contentDate)}${c.contentAt ? ` • ${formatUtcTime(c.contentAt)}` : ""}`), value: c.regearContentId, default: c.regearContentId === d.contentId
      })))),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:character`).setPlaceholder("Character").addOptions(options.characters.map(c => ({ label: truncateChoiceName(c.characterName), description: getAlbionServerLabel(c.albionServer), value: c.albionCharacterId, default: c.albionCharacterId === d.characterId })))),
      new ActionRowBuilder<ButtonBuilder>().addComponents(button(d, "continue", "Continue", !d.contentId || !d.characterId), button(d, "cancel", "Cancel"))
    ]);
  }
  async function list(d: Draft) {
    const contents = ordered(await repository.listContents(d.guild, undefined, "open"));
    const pages = Math.max(1, Math.ceil(contents.length / 10));
    d.page = Math.max(0, Math.min(d.page, pages - 1));
    return card(`# Re-gears\n\n**Open Content (${contents.length})**\n${contents.slice(d.page * 10, d.page * 10 + 10).map(contentLine).join("\n") || "No content is open for re-gear requests."}\n\nPage ${d.page + 1} of ${pages}`, [
      new ActionRowBuilder<ButtonBuilder>().addComponents(button(d, "previous", "Previous", !d.page), button(d, "next", "Next", d.page === pages - 1))
    ]);
  }
  async function startSubmission(i: ButtonInteraction | ChatInputCommandInteraction, generation?: string) {
    if (!i.deferred) await i.deferReply({ flags: MessageFlags.Ephemeral });
    const access = await entries.checkAccess(i, "regears", { mutation: true, generation });
    if (!access) return;
    const d = remember(i, access, "submit");
    const options = await choices(d);
    if (!options || !await entries.checkAccess(i, "regears", { mutation: true, expected: d })) return;
    await editPrivatePanel(i, setup(d, options));
  }
  async function handleInteraction(i: EntryInteraction): Promise<boolean> {
    if (i.isChatInputCommand()) {
      if (i.commandName !== "regearme") return false;
      await startSubmission(i);
      return true;
    }
    const publicId = parseEntryPanelId(i.customId);
    if (publicId?.feature === "regears" && i.isButton()) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (publicId.action === "submit") await startSubmission(i, publicId.generation);
      else {
        const access = await entries.checkAccess(i, "regears", { generation: publicId.generation });
        if (!access) return true;
        if (publicId.action === "history") await sendRegearHistory(i, repository, 0);
        else if (publicId.action === "list") await i.editReply(await list(remember(i, access, "list")));
        else await stale(i);
      }
      return true;
    }
    if (!i.customId.startsWith(PREFIX)) return false;
    const [, id, action, form] = i.customId.split(":");
    const d = drafts.get(id);
    if (!d || !alive(d) || d.guild !== i.guildId || d.owner !== i.user.id || d.origin !== i.channelId || !i.inCachedGuild()) { await stale(i); return true; }
    if (i.isModalSubmit()) await i.deferReply({ flags: MessageFlags.Ephemeral });
    else if (i.isStringSelectMenu() || (i.isButton() && action !== "continue")) await i.deferUpdate();
    if (!await entries.checkAccess(i, "regears", { mutation: d.kind === "submit" && action !== "cancel", expected: d })) return true;
    if (!alive(d)) { await stale(i); return true; }
    if (i.isModalSubmit()) {
      if (action !== "submit" || form !== String(d.form) || d.state !== "form" || !d.frozen) { await stale(i); return true; }
      d.state = "submitting";
      await entries.runExclusive(d.guild, async () => {
        const access = await entries.checkAccess(i, "regears", { mutation: true, expected: d });
        if (!access) return;
        if (!alive(d)) { await stale(i); return; }
        await submitRegearRequest(i, repository, d.frozen!, access.channel, () => validSubmission(i, d));
      });
      d.state = "done";
      await entries.refresh(i.guild);
      return true;
    }
    if (i.isButton() && action === "cancel" && (d.state === "setup" || d.state === "form")) {
      drafts.delete(d.id);
      await completeFeedbackPrompt(i, { text: "Cancelled. No changes were made." });
      return true;
    }
    if (i.isButton() && action === "continue" && d.state === "form") {
      d.state = "setup";
      d.frozen = undefined;
    }
    if (d.state !== "setup") { await stale(i); return true; }
    if (d.kind === "list" && i.isButton() && (action === "previous" || action === "next")) {
      d.page += action === "next" ? 1 : -1;
      await update(i, await list(d));
      return true;
    }
    if (i.isStringSelectMenu() && action === "server") {
      const options = await submissionOptions(repository, d.guild, d.owner);
      if (!alive(d) || d.state !== "setup") { await stale(i); return true; }
      const server = i.values[0];
      if (!isAlbionServer(server) || !options.servers.includes(server)) { await stale(i); return true; }
      d.server = server; d.characterId = undefined; d.contentId = undefined;
    }
    const options = await choices(d);
    if (!options) { await stale(i); return true; }
    if (i.isStringSelectMenu()) {
      if (action === "content") {
        const content = options.contents.find(c => c.regearContentId === i.values[0]);
        if (!content) { await stale(i); return true; }
        d.contentId = content.regearContentId;
        if (!options.characters.some(c => c.albionCharacterId === d.characterId && c.albionServer === content.albionServer)) d.characterId = undefined;
      } else if (action === "character") {
        if (!options.characters.some(c => c.albionCharacterId === i.values[0])) { await stale(i); return true; }
        d.characterId = i.values[0];
      } else if (action !== "server") { await stale(i); return true; }
      await update(i, setup(d, options));
      return true;
    }
    if (i.isButton() && action === "continue") {
      const content = options.contents.find(c => c.regearContentId === d.contentId);
      const character = options.characters.find(c => c.albionCharacterId === d.characterId);
      if (!content || !character || !d.server) { await update(i, setup(d, options)); return true; }
      if (!await entries.checkAccess(i, "regears", { mutation: true, expected: d }) || !alive(d) || d.state !== "setup") return true;
      d.frozen = Object.freeze({ server: d.server, contentId: content.regearContentId, characterId: character.albionCharacterId });
      d.state = "form";
      d.form++;
      await i.showModal(buildRegearEntryModal(`${PREFIX}${d.id}:submit:${d.form}`, content, character));
    } else await stale(i);
    return true;
  }
  return {
    startSubmission,
    invalidateGuild(guildId: string) { for (const [id, d] of drafts) if (d.guild === guildId) drafts.delete(id); },
    stop() { drafts.clear(); },
    async handle(i: EntryInteraction): Promise<boolean> {
      const draft = "customId" in i && i.customId.startsWith(PREFIX) ? drafts.get(i.customId.split(":")[1]) : undefined;
      if (draft?.busy) { await stale(i); return true; }
      if (draft) draft.busy = true;
      try { return await handleInteraction(i); }
      finally { if (draft) draft.busy = false; }
    }
  };
}
export function buildRegearEntryModal(id: string, content: RegearContent, character: EligibleRegearCharacter): ModalBuilder {
  return new ModalBuilder().setCustomId(id).setTitle("Submit Re-Gear Request")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Content**\n${sanitizeUserText(content.name)} • ${formatLongDate(content.contentDate)}${content.contentAt ? ` • ${formatUtcTime(content.contentAt)}` : ""}\n**Character**\n${sanitizeUserText(character.characterName)} • ${getAlbionServerLabel(character.albionServer)}`))
    .addLabelComponents(
      new LabelBuilder().setLabel("Requested Amount").setDescription("Enter a positive amount in whole silver.").setTextInputComponent(new TextInputBuilder().setCustomId("regear-amount").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)),
      new LabelBuilder().setLabel("Evidence 1").setDescription("Upload the first evidence screenshot.").setFileUploadComponent(new FileUploadBuilder().setCustomId("regear-evidence-1").setMinValues(1).setMaxValues(1).setRequired(true)),
      new LabelBuilder().setLabel("Evidence 2").setDescription("Upload the second evidence screenshot.").setFileUploadComponent(new FileUploadBuilder().setCustomId("regear-evidence-2").setMinValues(1).setMaxValues(1).setRequired(true))
    );
}
