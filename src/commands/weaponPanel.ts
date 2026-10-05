import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, FileUploadBuilder, LabelBuilder,
  MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder,
  type MessageCreateOptions
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import type { ReviewerRepository } from "../db/reviewerRepository.js";
import type { EligibleSpecialisationCharacter, SpecialisationRepository } from "../db/specialisationRepository.js";
import { completeFeedbackPrompt, editFeedback, editPrivatePanel, feedbackMessage } from "../discord/feedbackMessages.js";
import type { Logger } from "../logging/logger.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { replyEntryState } from "../services/entryPanels/access.js";
import { entryPanelId, parseEntryPanelId, type EntryInteraction, type EntryPanelContext, type EntrySelection } from "../services/entryPanels/types.js";
import { sanitizeUserText } from "../services/regears/rendering.js";
import { SPECIALISATION_CATALOGUE, catalogueByKey, type CatalogueEntry } from "../services/specialisations/catalogue.js";
import { formatSpecialisationCharacterReference } from "../services/specialisations/domain.js";
import { INFO_COLOR, truncateChoiceName } from "./configurationHelpers.js";
import { sendPendingSpecialisationReport, sendWeaponsReport, submitWeaponRequest, unavailableSubmissionTargetKeys } from "./weapon.js";

const PREFIX = "weapon-entry:";
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
export function buildWeaponPanel(generation: string): MessageCreateOptions {
  const button = (action: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(entryPanelId("specialisation", generation, action)).setLabel(label).setStyle(style);
  return {
    components: [new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Weapon Specialisation\n\nSubmit screenshot proof of a weapon at 100 or a weapon tree at 800, or view your confirmed specialisations.\n\n**Everyone**"))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button("weapon", "Weapon 100", ButtonStyle.Primary), button("tree", "Tree 800", ButtonStyle.Primary), button("history", "My Specialisations")))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Managers**"))
      .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button("pending", "Pending Requests")))],
    flags: MessageFlags.IsComponentsV2, allowedMentions: mentions
  };
}
async function update(i: Extract<EntryInteraction, { update: unknown }>, payload: MessageCreateOptions) {
  await editPrivatePanel(i, payload);
}

interface Draft extends EntrySelection {
  id: string; guild: string; owner: string; origin: string; expires: number;
  busy?: boolean; form: number;
  kind: CatalogueEntry["kind"]; state: "setup" | "form" | "submitting" | "done";
  character?: string; tree?: string; weapon?: string;
  frozen?: Readonly<{ characterReference: string; targetKey: string; kind: CatalogueEntry["kind"] }>;
}
export interface WeaponPanelDependencies {
  repository: SpecialisationRepository;
  membershipRepository: ReturnType<typeof createMembershipRepository>;
  reviewerRepository: ReviewerRepository;
  logger: Logger;
  entries: EntryPanelContext;
  now?: () => number;
}
export function createWeaponPanelInteractions({ repository, membershipRepository, reviewerRepository, logger, entries, now = Date.now }: WeaponPanelDependencies) {
  const drafts = new Map<string, Draft>();
  const alive = (d: Draft) => drafts.get(d.id) === d && d.expires > now();
  const button = (d: Draft, action: string, label: string, disabled = false) => new ButtonBuilder().setCustomId(`${PREFIX}${d.id}:${action}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
  async function stale(i: EntryInteraction) {
    await replyEntryState(i, "Start Again", "This control is no longer current. Open the latest entry panel and start again.");
  }
  async function validSubmission(i: EntryInteraction, d: Draft) {
    if (!alive(d)) { await stale(i); return false; }
    if (!await entries.checkAccess(i, "specialisation", { mutation: true, expected: d })) return false;
    if (!alive(d)) { await stale(i); return false; }
    return true;
  }
  function remember(i: EntryInteraction, selection: EntrySelection, kind: Draft["kind"]): Draft {
    for (const [id, draft] of drafts) if (!alive(draft)) drafts.delete(id);
    const d: Draft = { ...selection, id: randomUUID(), guild: i.guildId!, owner: i.user.id, origin: i.channelId!, expires: now() + EXPIRY_MS, state: "setup", kind, form: 0 };
    drafts.set(d.id, d);
    return d;
  }
  async function choices(d: Draft) {
    const characters = await repository.listEligibleCharacters(d.guild, d.owner);
    if (!alive(d) || d.state !== "setup") return undefined;
    if (!characters.some(c => formatSpecialisationCharacterReference(c) === d.character)) {
      d.character = characters.length === 1 ? formatSpecialisationCharacterReference(characters[0]) : undefined;
      d.tree = undefined; d.weapon = undefined;
    }
    const character = characters.find(c => formatSpecialisationCharacterReference(c) === d.character);
    const [excluded, active, pending] = await Promise.all([
      repository.exclusionKeys(d.guild),
      character ? repository.listSpecialisations(d.guild, { albionServer: character.albionServer, albionCharacterId: character.albionCharacterId }) : [],
      character ? repository.listRequests(d.guild, { state: "pending", albionServer: character.albionServer, albionCharacterId: character.albionCharacterId }) : []
    ]);
    if (!alive(d) || d.state !== "setup") return undefined;
    const unavailable = unavailableSubmissionTargetKeys(d.kind, active, pending);
    const targets = SPECIALISATION_CATALOGUE.filter(e => e.kind === d.kind && !excluded.has(e.key) && !unavailable.has(e.key));
    const trees = d.kind === "tree" ? targets : SPECIALISATION_CATALOGUE.filter(e => e.kind === "tree" && targets.some(t => t.treeKey === e.key));
    if (!trees.some(t => t.key === d.tree)) { d.tree = undefined; d.weapon = undefined; }
    const weapons = d.kind === "weapon" ? targets.filter(t => t.treeKey === d.tree) : [];
    if (!weapons.some(w => w.key === d.weapon)) d.weapon = undefined;
    return { characters, character, targets, trees, weapons };
  }
  function menu(d: Draft, action: string, label: string, options: { label: string; value: string; description?: string }[], selected: string | undefined, disabled = false) {
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`${PREFIX}${d.id}:${action}`).setPlaceholder(label).setDisabled(disabled || !options.length)
      .addOptions((options.length ? options : [{ label, value: "unavailable" }]).map(o => ({ ...o, label: truncateChoiceName(o.label), default: o.value === selected }))));
  }
  function setup(d: Draft, options: NonNullable<Awaited<ReturnType<typeof choices>>>) {
    if (!options.characters.length) return feedbackMessage({ text: "You need a registered Albion Online character with active member-group membership to submit proof." });
    if (options.character && !options.targets.length) return feedbackMessage({ text: "There are no available weapon specialisations to submit for this selection." });
    const rows: Row[] = [
      menu(d, "character", "Character", options.characters.map(c => ({ label: c.characterName, description: getAlbionServerLabel(c.albionServer), value: formatSpecialisationCharacterReference(c) })), d.character),
      menu(d, "tree", "Tree", options.trees.map(t => ({ label: t.name, value: t.key })), d.tree, !d.character)
    ];
    if (d.kind === "weapon") rows.push(menu(d, "weapon", "Weapon", options.weapons.map(w => ({ label: w.name, value: w.key })), d.weapon, !d.tree));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button(d, "continue", "Continue", !d.character || !d.tree || (d.kind === "weapon" && !d.weapon)), button(d, "cancel", "Cancel")));
    return card(d.kind === "weapon" ? "# Weapon 100\n\nSelect your Albion Online character, weapon tree, and weapon." : "# Tree 800\n\nSelect your Albion Online character and weapon tree.", rows);
  }
  async function handleInteraction(i: EntryInteraction): Promise<boolean> {
    if (i.isChatInputCommand()) return false;
    const publicId = parseEntryPanelId(i.customId);
    if (publicId?.feature === "specialisation" && i.isButton()) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const mutation = publicId.action === "weapon" || publicId.action === "tree";
      const access = await entries.checkAccess(i, "specialisation", { mutation, generation: publicId.generation });
      if (!access || !i.inCachedGuild()) return true;
      if (publicId.action === "history") await sendWeaponsReport(i, membershipRepository, repository);
      else if (publicId.action === "pending") await sendPendingSpecialisationReport(i, repository, reviewerRepository, access.member);
      else if (mutation) {
        const d = remember(i, access, publicId.action as Draft["kind"]);
        const options = await choices(d);
        if (!options || !await entries.checkAccess(i, "specialisation", { mutation: true, expected: d })) return true;
        await editPrivatePanel(i, setup(d, options));
      } else await stale(i);
      return true;
    }
    if (!i.customId.startsWith(PREFIX)) return false;
    const [, id, action, form] = i.customId.split(":");
    const d = drafts.get(id);
    if (!d || !alive(d) || d.guild !== i.guildId || d.owner !== i.user.id || d.origin !== i.channelId || !i.inCachedGuild()) { await stale(i); return true; }
    if (i.isModalSubmit()) await i.deferReply({ flags: MessageFlags.Ephemeral });
    else if (i.isStringSelectMenu() || (i.isButton() && action !== "continue")) await i.deferUpdate();
    if (!await entries.checkAccess(i, "specialisation", { mutation: action !== "cancel", expected: d })) return true;
    if (!alive(d)) { await stale(i); return true; }
    if (i.isModalSubmit()) {
      if (action !== "submit" || form !== String(d.form) || d.state !== "form" || !d.frozen) { await stale(i); return true; }
      d.state = "submitting";
      const files = [...i.fields.getUploadedFiles("proof", true).values()];
      if (files.length !== 1 || !files[0].contentType?.toLocaleLowerCase().startsWith("image/")) {
        d.state = "done";
        await editFeedback(i, { text: "Upload exactly one image in Proof Screenshot." });
        return true;
      }
      await entries.runExclusive(d.guild, async () => {
        const access = await entries.checkAccess(i, "specialisation", { mutation: true, expected: d });
        if (!access) return;
        if (!alive(d)) { await stale(i); return; }
        await submitWeaponRequest(i, repository, reviewerRepository, logger, { ...d.frozen!, screenshot: files[0] }, access.channel, () => validSubmission(i, d));
      });
      d.state = "done";
      await entries.refresh(i.guild);
      return true;
    }
    if (i.isButton() && action === "cancel" && (d.state === "setup" || d.state === "form")) {
      drafts.delete(id);
      await completeFeedbackPrompt(i, { text: "Cancelled. No changes were made." });
      return true;
    }
    if (i.isButton() && action === "continue" && d.state === "form") {
      d.state = "setup";
      d.frozen = undefined;
    }
    if (d.state !== "setup") { await stale(i); return true; }
    let options = await choices(d);
    if (!options) { await stale(i); return true; }
    if (i.isStringSelectMenu()) {
      const value = i.values[0];
      if (action === "character" && options.characters.some(c => formatSpecialisationCharacterReference(c) === value)) { d.character = value; d.tree = undefined; d.weapon = undefined; }
      else if (action === "tree" && d.character && options.trees.some(t => t.key === value)) { d.tree = value; d.weapon = undefined; }
      else if (action === "weapon" && d.tree && options.weapons.some(w => w.key === value)) d.weapon = value;
      else { await stale(i); return true; }
      options = await choices(d);
      if (options) await update(i, setup(d, options));
      return true;
    }
    if (i.isButton() && action === "continue") {
      const target = options.targets.find(t => t.key === (d.kind === "weapon" ? d.weapon : d.tree));
      if (!options.character || !target || !d.tree || !d.character) { await update(i, setup(d, options)); return true; }
      if (!await entries.checkAccess(i, "specialisation", { mutation: true, expected: d }) || !alive(d) || d.state !== "setup") return true;
      d.frozen = Object.freeze({ kind: d.kind, targetKey: target.key, characterReference: formatSpecialisationCharacterReference(options.character) });
      d.state = "form";
      d.form++;
      await i.showModal(buildWeaponEntryModal(`${PREFIX}${d.id}:submit:${d.form}`, options.character, target));
    } else await stale(i);
    return true;
  }
  return {
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
export function buildWeaponEntryModal(id: string, character: EligibleSpecialisationCharacter, target: CatalogueEntry): ModalBuilder {
  const tree = target.kind === "tree" ? target : catalogueByKey.get(target.treeKey!);
  const text = [`**Character**\n${sanitizeUserText(character.characterName)} • ${getAlbionServerLabel(character.albionServer)}`, `**Tree**\n${sanitizeUserText(tree!.name)}`, ...(target.kind === "weapon" ? [`**Weapon**\n${sanitizeUserText(target.name)}`] : []), `**Level**\n${target.kind === "weapon" ? 100 : 800}`].join("\n");
  return new ModalBuilder().setCustomId(id).setTitle(target.kind === "weapon" ? "Submit Weapon 100" : "Submit Tree 800")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    .addLabelComponents(new LabelBuilder().setLabel("Proof Screenshot").setDescription("Upload one screenshot showing the selected specialisation.").setFileUploadComponent(new FileUploadBuilder().setCustomId("proof").setMinValues(1).setMaxValues(1).setRequired(true)));
}
