import { reconcileApplicationActiveRole, applicationRoleWarnings } from "../services/applications/activeRoleService.js";
import { editFeedback, feedbackEdit, feedbackReply } from "../discord/feedbackMessages.js";
/**
 * Intake routing for application entry, submission, and character resolution.
 *
 * The public command façade deliberately supplies the concrete handlers.  This
 * keeps archival reconciliation in application.ts and prevents an intake ↔
 * operations dependency cycle while making the intake surface explicit.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel
} from "discord.js";
import { ApplicationClassUnavailableError, type ApplicationClass, type CharacterResolutionState, type OpenApplication, type createApplicationRepository } from "../db/applicationRepository.js";
import type { MemberGroup, createMembershipRepository } from "../db/membershipRepository.js";
import type { AlbionClient } from "../services/albion/client.js";
import { type AlbionServer } from "../services/albion/servers.js";
import type { AlbionPlayer, AlbionSearchPlayer } from "../services/albion/types.js";
import { withApplicationOperationLock } from "../services/applications/applicationOperationLock.js";
import { refreshApplicationIntakeCard } from "../services/applications/intakePresentation.js";
import * as applicationRendering from "../services/applications/rendering.js";
import { buildApplicationChannelName, buildApplicationV2Card } from "../services/applications/rendering.js";
import { retryApplicationCharacterSearch } from "../services/applications/retryCharacterSearchService.js";
import { withConversationClassLock } from "../services/conversationClassLock.js";
import { applicationTargetResolutionError, isApplicantOrReviewer, resolveOperationalApplicationChannel } from "./applicationOperations.js";
import { buildInfoEmbed, buildNotFoundEmbed, buildSuccessEmbed, formatCharacterUserMentionPair, formatMemberGroupLabel } from "./configurationHelpers.js";
import { resolveApplicationTarget } from "./operationalTargets.js";
import { buildTicketConversationPermissionOverwrites, setTicketConversationSendPermission } from "./ticketChannelPermissions.js";
export const APPLICATION_CUSTOM_PREFIX = "app:";
export const OPEN_BUTTON_PREFIX = "app:open:";
export const SUBMIT_MODAL_PREFIX = "app:submit:";
export const CHARACTER_SELECT_PREFIX = "app:character:";
export const REMOTE_CHARACTER_SELECT_PREFIX = "app:remote-character:";
export const CHARACTER_SEARCH_MODAL_PREFIX = "app:character-search:";
const LEGACY_REVIEWER_CHARACTER_SELECT_PREFIX = "app:reviewer-character-select:";
export const REMOTE_CHARACTER_SELECT_TTL_MS = 14 * 60_000;
export const APPLICATION_MODAL_LOOKUP_TIMEOUT_MS = 2_000;
const NOT_LISTED_VALUE = "__not_listed";
const MAX_CONFIGURED_QUESTIONS = 4;
const REVIEWER_ONLY_FOOTER = "Reviewers only.";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type ComponentsV2Payload = MessageCreateOptions & InteractionReplyOptions & MessageEditOptions;

type IntakeCallbacks = {
  reconcileArchivedActiveRole: (guild: Guild, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, target: { applicationId: string; applicationClassId: string; applicantDiscordUserId: string; ticketChannelId: string; reviewerRoleId: string; activeRoleId?: string; channelStatus: "open"; channelClosedByRemoval: boolean }) => Promise<void>;
};

function card(embed: EmbedBuilder, actionRows: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] = [], options: { openingMentions?: { applicantId: string; reviewerRoleId: string }; edit?: boolean; ephemeral?: boolean } = {}): ComponentsV2Payload {
  return buildApplicationV2Card(embed, actionRows, options);
}

function response(embed: EmbedBuilder, options: { ephemeral?: boolean; edit?: boolean; actionRows?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] } = {}): ComponentsV2Payload {
  const payload = { cards: [embed], actionRows: options.actionRows, flags: options.ephemeral ? MessageFlags.Ephemeral : 0 };
  return (options.edit ? feedbackEdit(payload) : feedbackReply(payload)) as ComponentsV2Payload;
}

async function editResponse(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, embed: EmbedBuilder, options: { edit?: boolean; actionRows?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] } = {}) {
  await editFeedback(interaction, { cards: [embed], actionRows: options.actionRows });
}

export type ApplicationAction = "accept" | "reject" | "withdraw" | "retry-character" | "reviewer-character" | "close" | "cancel" | "reopen" | "delete" | "verify";
export type RemoteCharacterSelect = { applicationId: string; actorId: string; expiry: number; attempt: number };

export function parseRemoteCharacterSelect(customId: string): RemoteCharacterSelect | undefined {
  if (!customId.startsWith(REMOTE_CHARACTER_SELECT_PREFIX)) return undefined;
  const [applicationId, actorId, expiryText, attemptText] = customId.slice(REMOTE_CHARACTER_SELECT_PREFIX.length).split(":");
  const expiry = Number.parseInt(expiryText, 36);
  const attempt = Number.parseInt(attemptText, 36);
  return applicationId && actorId && Number.isFinite(expiry) && Number.isFinite(attempt)
    ? { applicationId, actorId, expiry, attempt }
    : undefined;
}

export function parseApplicationAction(customId: string): { action: ApplicationAction; applicationId: string } | undefined {
  const [prefix, action, applicationId] = customId.split(":");
  if (prefix !== "app" || !applicationId || ![
    "accept", "reject", "withdraw", "retry-character", "reviewer-character", "close", "cancel", "reopen", "delete", "verify"
  ].includes(action)) return undefined;
  return { action: action as ApplicationAction, applicationId };
}

export async function beforeApplicationModal<T>(operation: () => Promise<T>): Promise<{ kind: "value"; value: T } | { kind: "timeout" }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation().then((value) => ({ kind: "value" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), APPLICATION_MODAL_LOOKUP_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function buildApplicationCharacterSelectRow(server: AlbionServer, applicationId: string, players: AlbionSearchPlayer[], attempt?: number): ActionRowBuilder<StringSelectMenuBuilder> {
  return applicationRendering.buildApplicationCharacterSelectRow(server, applicationId, players, attempt);
}

export function buildRemoteApplicationCharacterSelectRow(server: AlbionServer, applicationId: string, actorId: string, expiry: number, attempt: number, players: AlbionSearchPlayer[]): ActionRowBuilder<StringSelectMenuBuilder> {
  return applicationRendering.buildRemoteApplicationCharacterSelectRow(server, applicationId, actorId, expiry, attempt, players);
}

export function buildCharacterRecoveryButtons(applicationId: string, state: CharacterResolutionState): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildCharacterRecoveryButtons(applicationId, state);
}

export function buildCharacterMatchesEmbed(server: AlbionServer, query: string, players: AlbionSearchPlayer[], attemptCount: number): EmbedBuilder {
  return applicationRendering.buildCharacterMatchesEmbed(server, query, players, attemptCount);
}

export function buildCharacterResolvedEmbed(server: AlbionServer, player: AlbionPlayer, title: string, attemptCount: number, verifiedAllianceDisplay?: string): EmbedBuilder {
  return applicationRendering.buildCharacterResolvedEmbed(server, player, title, attemptCount, verifiedAllianceDisplay);
}

export function buildCharacterSearchStatusEmbed(title: string, query: string, attemptCount: number, description: string): EmbedBuilder {
  return applicationRendering.buildCharacterSearchStatusEmbed(title, query, attemptCount, description);
}

export async function handleApplicationSearchCommand(interaction: ChatInputCommandInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(response(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveApplicationTarget(await applicationRepository.listOperationalApplicationTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("application") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = applicationTargetResolutionError(resolution.kind); await editResponse(interaction, buildNotFoundEmbed(title, description), { edit: true }); return; }
  const channel = await resolveOperationalApplicationChannel(interaction.guild, resolution.target);
  if (!channel) { await editResponse(interaction, buildNotFoundEmbed("Application Channel Unavailable", "The retained application channel is no longer available."), { edit: true }); return; }
  const characterName = interaction.options.getString("character", true).trim();
  await withApplicationOperationLock(interaction.guildId, resolution.target.applicationId, async () => {
    const result = await retryApplicationCharacterSearch({ guildId: interaction.guildId, channelId: channel.id, applicationId: resolution.target.applicationId, characterName, actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, albionClient });
    if (result.kind === "error") { await refreshSearchFailure(channel, applicationRepository, membershipRepository, interaction.guildId, resolution.target.applicationId, result.description); await editResponse(interaction, buildNotFoundEmbed(result.title, result.description), { edit: true }); return; }
    const current = await applicationRepository.getOpenApplication(interaction.guildId, resolution.target.applicationId);
    if (current) await refreshApplicationIntakeCard(channel, applicationRepository, result.application, current, await findApplicationMemberGroup(result.application, membershipRepository), { players: result.kind === "matches" ? result.players : [], statusText: result.kind === "no_matches" ? "No matching Albion Online characters were found. Retry the character search." : undefined });
    const remote = interaction.channelId !== channel.id && result.kind === "matches";
    await interaction.editReply(remote
      ? response(buildInfoEmbed("Choose Application Character", `Choose a result below. The selected outcome will be saved to <#${channel.id}>.`), { edit: true, actionRows: [buildRemoteApplicationCharacterSelectRow(result.application.albionServer, resolution.target.applicationId, interaction.user.id, Date.now() + REMOTE_CHARACTER_SELECT_TTL_MS, result.attempt, result.players)] })
      : response(buildSuccessEmbed("Character Search Updated", `The character search for ${characterName} was updated in <#${channel.id}>.`), { edit: true }));
  });
}

export async function handleApplicationIntakeButton(interaction: ButtonInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository): Promise<boolean> {
  if (!interaction.customId.startsWith(APPLICATION_CUSTOM_PREFIX)) return false;
  if (!interaction.inCachedGuild()) { await interaction.reply(response(buildNotFoundEmbed("Server Only", "Applications can only be used in a Discord server."), { ephemeral: true })); return true; }
  if (interaction.customId.startsWith(OPEN_BUTTON_PREFIX)) {
    await handleOpenButton(interaction, applicationRepository, membershipRepository);
    return true;
  }
  const parsed = parseApplicationAction(interaction.customId);
  if (parsed?.action !== "retry-character" && parsed?.action !== "reviewer-character") return false;
  await handleCharacterSearchButton(interaction, applicationRepository, parsed.applicationId);
  return true;
}

export async function handleApplicationIntakeModalSubmit(interaction: ModalSubmitInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, callbacks: IntakeCallbacks): Promise<boolean> {
  if (interaction.customId.startsWith(SUBMIT_MODAL_PREFIX)) { await handleApplicationSubmitModal(interaction, applicationRepository, membershipRepository, albionClient, callbacks); return true; }
  if (interaction.customId.startsWith(CHARACTER_SEARCH_MODAL_PREFIX)) { await handleCharacterSearchModal(interaction, applicationRepository, membershipRepository, albionClient); return true; }
  return false;
}

export async function handleApplicationIntakeCharacterSelect(interaction: StringSelectMenuInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient): Promise<boolean> {
  const remote = parseRemoteCharacterSelect(interaction.customId);
  if (!remote && !interaction.customId.startsWith(CHARACTER_SELECT_PREFIX) && !interaction.customId.startsWith(LEGACY_REVIEWER_CHARACTER_SELECT_PREFIX)) return false;
  if (!interaction.inCachedGuild()) { await interaction.reply(response(buildNotFoundEmbed("Server Only", "Application character selections can only be used in a Discord server."), { ephemeral: true })); return true; }
  await interaction.deferUpdate();
  const publicPrefix = interaction.customId.startsWith(LEGACY_REVIEWER_CHARACTER_SELECT_PREFIX) ? LEGACY_REVIEWER_CHARACTER_SELECT_PREFIX : CHARACTER_SELECT_PREFIX;
  const [publicId, attemptText] = interaction.customId.slice(publicPrefix.length).split(":");
  const applicationId = remote?.applicationId ?? publicId;
  const report = async (title: string, description: string) => remote
    ? editResponse(interaction, buildNotFoundEmbed(title, description), { edit: true })
    : interaction.followUp(response(buildNotFoundEmbed(title, description), { ephemeral: true }));
  if (remote && (interaction.user.id !== remote.actorId || Date.now() >= remote.expiry)) { await report("Character Search Unavailable", "This search menu has expired or belongs to another user."); return true; }
  return withApplicationOperationLock(interaction.guildId, applicationId, async () => {
    const open = await applicationRepository.getOpenApplication(interaction.guildId, applicationId);
    const application = open ? await applicationRepository.getApplicationClass(interaction.guildId, open.applicationClassId) : undefined;
    if (!open || !application || application.archivedAt || open.status !== "open" || open.channelStatus !== "open") { await report("Application Not Open", "That application is no longer open."); return true; }
    if (!applicantOrReviewer(interaction, application, open.applicantDiscordUserId)) { await report("Selection Not Allowed", "Only the applicant or a configured reviewer can choose the application character."); return true; }
    const legacySource = !remote && isLegacyCharacterControlSource(interaction, open);
    const legacyMenu = legacySource && attemptText === undefined;
    const attempt = remote?.attempt ?? (legacyMenu ? open.characterSearchAttemptCount : Number(attemptText));
    if (attempt !== open.characterSearchAttemptCount || (!remote && (!isCharacterControlSource(interaction, open) || interaction.channelId !== open.ticketChannelId))) { await report("Stale Character Control", "Use the controls on the current application card."); return true; }
    const channel = remote ? await resolveOperationalApplicationChannel(interaction.guild, { applicationId, applicationName: application.name, applicantDiscordUserId: open.applicantDiscordUserId, ticketChannelId: open.ticketChannelId, status: open.status, channelStatus: open.channelStatus, characterResolutionState: open.characterResolutionState, selectedAlbionCharacterId: open.selectedAlbionCharacterId, reviewerRoleId: application.reviewerRoleId }) : interaction.channel as TextChannel;
    const canonicalId = legacySource ? open.characterResolutionMessageId : open.applicationControlMessageId;
    const canonical = channel && canonicalId ? await channel.messages.fetch(canonicalId).catch(() => undefined) : undefined;
    const value = interaction.values[0];
    if (!channel || !canonical || canonical.author.id !== channel.client.user.id || !hasCanonicalCharacterOption(canonical, applicationId, value, attempt, legacyMenu ? interaction.customId : undefined)) { await report("Stale Character Control", "Use the controls on the current application card."); return true; }
    let updated: OpenApplication | undefined;
    let statusText: string | undefined;
    if (value === NOT_LISTED_VALUE) {
      updated = await applicationRepository.markApplicationCharacterNotListed(interaction.guildId, applicationId);
      statusText = "Your character was not shown. Retry the character search with the correct name.";
    } else {
      let player: AlbionPlayer;
      try {
        player = await albionClient.getPlayer(open.albionServer, value);
        if (player.id !== value || !player.name.trim()) throw new Error("Invalid identity");
      } catch {
        await refreshApplicationIntakeCard(channel, applicationRepository, application, open, await findApplicationMemberGroup(application, membershipRepository), { statusText: "Albion Online character verification is temporarily unavailable. Retry the character search." });
        await report("Character Verification Unavailable", "The Albion Online character could not be verified. Your prior selection is unchanged."); return true;
      }
      await membershipRepository.upsertVerifiedCharacter(open.albionServer, player);
      const owner = await membershipRepository.getRegisteredCharacter(interaction.guildId, open.albionServer, player.id);
      const conflict = !!owner && owner.discordUserId !== open.applicantDiscordUserId;
      updated = await applicationRepository.selectApplicationCharacter(interaction.guildId, applicationId, player.id, conflict ? "registered_to_other_user" : "selected");
      if (conflict) statusText = `${formatCharacterUserMentionPair(player.name, owner!.discordUserId)} is already registered. Staff must resolve the ownership conflict before this application can be reviewed.`;
    }
    if (updated) await refreshApplicationIntakeCard(channel, applicationRepository, application, updated, await findApplicationMemberGroup(application, membershipRepository), { statusText, publishReview: updated.characterResolutionState === "selected" });
    if (remote) await editResponse(interaction, buildSuccessEmbed("Application Updated", `The application card in <#${channel.id}> was updated.`), { edit: true });
    return true;
  });
}

function hasCanonicalCharacterOption(message: { components: unknown[] }, applicationId: string, value: string, attempt: number, legacyCustomId?: string): boolean {
  const visited = new WeakSet<object>();
  const inspect = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(inspect);
    if (!node || typeof node !== "object" || visited.has(node)) return false;
    visited.add(node);
    const valueNode = node as { customId?: string; custom_id?: string; options?: Array<{ value: string }>; components?: unknown; data?: unknown; toJSON?: () => unknown };
    if ((valueNode.customId ?? valueNode.custom_id) === (legacyCustomId ?? `${CHARACTER_SELECT_PREFIX}${applicationId}:${attempt}`) && valueNode.options?.some((option) => option.value === value)) return true;
    return inspect(valueNode.components) || inspect(valueNode.data) || (valueNode.toJSON ? inspect(valueNode.toJSON()) : false);
  };
  return inspect(message.components);
}

async function handleCharacterSearchButton(
  interaction: ButtonInteraction<"cached">,
  applicationRepository: ApplicationRepository,
  applicationId: string
): Promise<void> {
  const loaded = await beforeApplicationModal(async () => {
    const openApplication = await applicationRepository.getOpenApplication(interaction.guildId, applicationId);
    const application = openApplication
      ? await applicationRepository.getApplicationClass(interaction.guildId, openApplication.applicationClassId)
      : undefined;
    const channel = interaction.guild.channels.cache.get(interaction.channelId);
    return { application, openApplication, channel };
  });
  if (loaded.kind === "timeout") {
    await interaction.reply(response(buildNotFoundEmbed("Character Search Unavailable", "Guild Manager could not load this character search in time. Try again."), { ephemeral: true }));
    return;
  }
  const { application, openApplication, channel } = loaded.value;
  if (!openApplication) { await interaction.reply(response(buildNotFoundEmbed("Application Not Found", "That application ticket is no longer tracked."), { ephemeral: true })); return; }
  if (openApplication.ticketChannelId !== interaction.channelId) { await interaction.reply(response(buildNotFoundEmbed("Wrong Channel", "That control can only be used in the matching application ticket."), { ephemeral: true })); return; }
  if (!application) { await interaction.reply(response(buildNotFoundEmbed("Application Class Missing", "This application class no longer exists."), { ephemeral: true })); return; }
  if (channel?.type !== ChannelType.GuildText) { await interaction.reply(response(buildNotFoundEmbed("Wrong Channel", "Application controls require the matching text channel."), { ephemeral: true })); return; }
  if (application.archivedAt) { await interaction.reply(response(buildNotFoundEmbed("Application Target Removed", "This application is retained as history because its target member group was removed."), { ephemeral: true })); return; }
  if (!isCharacterControlSource(interaction, openApplication)) { await replyStaleCharacterControl(interaction); return; }
  if (openApplication.status !== "open" || openApplication.channelStatus !== "open") { await interaction.reply(response(buildNotFoundEmbed("Character Search Unavailable", "Character searches are only available for an open, undecided application."), { ephemeral: true })); return; }
  if (!applicantOrReviewer(interaction, application, openApplication.applicantDiscordUserId)) { await interaction.reply(response(buildNotFoundEmbed("Character Search Not Allowed", "Only the applicant or a configured reviewer can retry the character search."), { ephemeral: true })); return; }
  await interaction.showModal(new ModalBuilder()
    .setCustomId(`${CHARACTER_SEARCH_MODAL_PREFIX}${applicationId}`)
    .setTitle("Retry Character Search")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId("character_name").setLabel("Character Name").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(64)
      .setValue(openApplication.submittedCharacterName))));
}

async function handleCharacterSearchModal(
  interaction: ModalSubmitInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient
): Promise<void> {
  if (!interaction.inCachedGuild() || !interaction.isFromMessage()) {
    await interaction.reply(response(buildNotFoundEmbed("Character Search Unavailable", "This character search is no longer attached to its application message."), { ephemeral: true })); return;
  }
  await interaction.deferUpdate();
  const modalTarget = interaction.customId.slice(CHARACTER_SEARCH_MODAL_PREFIX.length);
  const applicationId = modalTarget.startsWith("reviewer:") || modalTarget.startsWith("applicant:") ? modalTarget.split(":")[1] : modalTarget;
  await withApplicationOperationLock(interaction.guildId, applicationId, async () => {
    const open = await applicationRepository.getOpenApplication(interaction.guildId, applicationId);
    if (!open || !isCharacterControlSource(interaction, open)) { await replyStaleCharacterControl(interaction); return; }
    const result = await retryApplicationCharacterSearch({ guildId: interaction.guildId, channelId: interaction.channelId, applicationId, characterName: interaction.fields.getTextInputValue("character_name").trim(), actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, albionClient });
    if (result.kind === "error") { await refreshSearchFailure(interaction.channel as TextChannel, applicationRepository, membershipRepository, interaction.guildId, applicationId, result.description); await interaction.followUp(response(buildNotFoundEmbed(result.title, result.description), { ephemeral: true })); return; }
    const updated = await applicationRepository.getOpenApplication(interaction.guildId, applicationId);
    if (updated) await refreshApplicationIntakeCard(interaction.channel as TextChannel, applicationRepository, result.application, updated, await findApplicationMemberGroup(result.application, membershipRepository), { players: result.kind === "matches" ? result.players : [], statusText: result.kind === "no_matches" ? "No matching Albion Online characters were found. Retry the character search." : undefined });
  });
}

async function handleOpenButton(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository): Promise<void> {
  const applicationClassId = interaction.customId.slice(OPEN_BUTTON_PREFIX.length);
  const loaded = await beforeApplicationModal(async () => {
    const application = await applicationRepository.getApplicationClass(interaction.guildId, applicationClassId);
    const activeGroup = application?.memberGroupId ? await membershipRepository.getActiveMemberGroupForUser(interaction.guildId, application.memberGroupId, interaction.user.id) : undefined;
    return { application, activeGroup };
  });
  if (loaded.kind === "timeout") { await interaction.reply(response(buildNotFoundEmbed("Application Unavailable", "Guild Manager could not load that application in time. Try again."), { ephemeral: true })); return; }
  const { application, activeGroup } = loaded.value;
  if (!application || !application.enabled || application.archivedAt) { await interaction.reply(response(buildNotFoundEmbed("Application Unavailable", "That application is no longer available."), { ephemeral: true })); return; }
  if (activeGroup) { await interaction.reply(response(buildNotFoundEmbed("Already Registered", `You are already registered to ${formatMemberGroupLabel(activeGroup)}. No application was opened.`), { ephemeral: true })); return; }
  const modal = new ModalBuilder().setCustomId(`${SUBMIT_MODAL_PREFIX}${application.applicationClassId}`).setTitle(application.name.slice(0, 45));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("character_name").setLabel("Character Name").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(64)));
  for (const [index, question] of application.questions.slice(0, MAX_CONFIGURED_QUESTIONS).entries()) modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(`question_${index}`).setLabel(question.label.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)));
  await interaction.showModal(modal);
}

async function handleApplicationSubmitModal(interaction: ModalSubmitInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, callbacks: IntakeCallbacks): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(response(buildNotFoundEmbed("Server Only", "Applications can only be submitted in a Discord server."), { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await withConversationClassLock("application", interaction.guildId, interaction.customId.slice(SUBMIT_MODAL_PREFIX.length), () => submitApplicationLocked(interaction, applicationRepository, membershipRepository, albionClient, callbacks));
}

async function submitApplicationLocked(interaction: ModalSubmitInteraction<"cached">, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, callbacks: IntakeCallbacks): Promise<void> {
  const application = await applicationRepository.getApplicationClass(interaction.guildId, interaction.customId.slice(SUBMIT_MODAL_PREFIX.length));
  if (!application || !application.enabled || application.archivedAt) { await editResponse(interaction, buildNotFoundEmbed("Application Unavailable", "That application is no longer available."), { edit: true }); return; }
  if (await replyAlreadyRegisteredForApplication(interaction, application, membershipRepository)) return;
  const characterName = interaction.fields.getTextInputValue("character_name").trim();
  const modalAnswers = application.questions.slice(0, MAX_CONFIGURED_QUESTIONS).map((question, index) => ({ question: question.label, answer: interaction.fields.getTextInputValue(`question_${index}`)?.trim() ?? "" }));
  let openApplication: OpenApplication;
  try { openApplication = await applicationRepository.createOpenApplication({ applicationClassId: application.applicationClassId, discordGuildId: interaction.guildId, applicantDiscordUserId: interaction.user.id, submittedCharacterName: characterName, modalAnswers, albionServer: application.albionServer }); }
  catch (error) { if (!(error instanceof ApplicationClassUnavailableError)) throw error; await editResponse(interaction, buildNotFoundEmbed("Application Unavailable", "That application is no longer available."), { edit: true }); return; }
  const ticket = await createTicketChannel(interaction.guild, interaction.member, application);
  if (!await applicationRepository.setOpenApplicationTicketChannel(interaction.guildId, openApplication.applicationId, ticket.id)) { await ticket.delete("Guild Manager application target became unavailable").catch(() => undefined); await applicationRepository.markApplicationChannelDeleted(interaction.guildId, ticket.id); await editResponse(interaction, buildNotFoundEmbed("Application Unavailable", "That application became unavailable before its ticket could be opened."), { edit: true }); return; }
  const roleWarnings = await reconcileApplicationActiveRole(interaction.guild, applicationRepository, application, interaction.user.id);
  const group = await findApplicationMemberGroup(application, membershipRepository);
  const control = await ticket.send(applicationRendering.buildApplicationIntakeCard(application, openApplication, group, { searching: true, openingApplicantId: interaction.user.id }));
  await applicationRepository.setApplicationControlMessageId(interaction.guildId, openApplication.applicationId, control.id);
  await applicationRepository.setCharacterResolutionMessageId(interaction.guildId, openApplication.applicationId, control.id);
  await resolveSubmittedCharacter(ticket, applicationRepository, membershipRepository, albionClient, application, openApplication.applicationId, interaction.user.id, characterName);
  if (!await applicationRepository.isOpenApplicationClassOperational(interaction.guildId, openApplication.applicationId)) {
    await callbacks.reconcileArchivedActiveRole(interaction.guild, applicationRepository, membershipRepository, { applicationId: openApplication.applicationId, applicationClassId: application.applicationClassId, applicantDiscordUserId: openApplication.applicantDiscordUserId, ticketChannelId: ticket.id, reviewerRoleId: application.reviewerRoleId, activeRoleId: application.activeRoleId, channelStatus: "open", channelClosedByRemoval: false });
    const deleted = await ticket.delete("Guild Manager application target removed during ticket provisioning").then(() => true, () => false);
    if (deleted) await applicationRepository.markApplicationChannelDeleted(interaction.guildId, ticket.id);
    else { await setTicketConversationSendPermission(ticket, openApplication.applicantDiscordUserId, application.reviewerRoleId, false); await applicationRepository.markApplicationClosed(interaction.guildId, openApplication.applicationId, interaction.guild.client.user.id); const closed = await ticket.send(card(applicationRendering.withControlFooter(buildInfoEmbed("Application Target Removed", "The target member group was removed. This application and its decision are retained as history, and the channel is closed."), REVIEWER_ONLY_FOOTER), [applicationRendering.buildArchivedApplicationButtons(openApplication.applicationId)])); await applicationRepository.setClosedControlMessageId(interaction.guildId, openApplication.applicationId, closed.id); }
    await editResponse(interaction, buildNotFoundEmbed("Application Target Removed", "The target member group was removed while this application was opening. No application entitlements remain."), { edit: true }); return;
  }
  await editResponse(interaction, buildSuccessEmbed("Application Opened", `Your application ticket is ${ticket}.${applicationRoleWarnings(roleWarnings)}`), { edit: true });
}

async function replyAlreadyRegisteredForApplication(interaction: ModalSubmitInteraction<"cached">, application: ApplicationClass, membershipRepository: MembershipRepository): Promise<boolean> {
  if (!application.memberGroupId) return false;
  const group = await membershipRepository.getActiveMemberGroupForUser(interaction.guildId, application.memberGroupId, interaction.user.id);
  if (!group) return false;
  await editResponse(interaction, buildNotFoundEmbed("Already Registered", `You are already registered to ${formatMemberGroupLabel(group)}. No application was opened.`), { edit: true });
  return true;
}

async function createTicketChannel(guild: Guild, member: GuildMember, application: ApplicationClass): Promise<TextChannel> {
  return guild.channels.create({ name: buildApplicationChannelName(application.name, member.user.username), type: ChannelType.GuildText, parent: application.ticketCategoryId, permissionOverwrites: buildTicketConversationPermissionOverwrites(guild.roles.everyone.id, member.id, application.reviewerRoleId), reason: "Guild Manager application ticket" });
}

async function findApplicationMemberGroup(application: ApplicationClass, membershipRepository: MembershipRepository): Promise<MemberGroup | undefined> {
  if (!application.memberGroupId) return undefined;
  return (await membershipRepository.listMemberGroups(application.discordGuildId, application.albionServer)).find((candidate) => candidate.memberGroupId === application.memberGroupId);
}

async function resolveSubmittedCharacter(ticket: TextChannel, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, application: ApplicationClass, applicationId: string, _applicantDiscordUserId: string, characterName: string): Promise<void> {
  const before = await applicationRepository.getOpenApplication(application.discordGuildId, applicationId);
  if (!before) return;
  await refreshUnresolvedApplicationSearch(ticket, applicationRepository, membershipRepository, albionClient, application, before);
}

/** Initial searches release the operation lock during HTTP so Close and Withdraw remain usable. */
export async function refreshUnresolvedApplicationSearch(channel: TextChannel, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, application: ApplicationClass, before: OpenApplication): Promise<void> {
  let players: AlbionSearchPlayer[] = [];
  let statusText: string | undefined;
  try {
    const search = await albionClient.searchCharacters(application.albionServer, before.submittedCharacterName);
    const registered = (await membershipRepository.listRegisteredCharactersByName(application.discordGuildId, before.submittedCharacterName)).filter((character) => character.albionServer === application.albionServer);
    const candidates = [...registered.map((character) => ({ id: character.albionCharacterId, name: character.characterName })), ...search.players];
    players = [...new Map(candidates.map((player) => [player.id, player])).values()].slice(0, 24);
    if (!players.length) statusText = "No matching Albion Online characters were found. Retry the character search.";
  } catch { statusText = "Albion Online character search is temporarily unavailable. Retry the character search."; }
  await withApplicationOperationLock(application.discordGuildId, before.applicationId, async () => {
    const current = await applicationRepository.getOpenApplication(application.discordGuildId, before.applicationId);
    const latestClass = await applicationRepository.getApplicationClass(application.discordGuildId, application.applicationClassId);
    if (!current || !latestClass || latestClass.archivedAt || current.status !== "open" || current.channelStatus !== "open" || current.characterSearchAttemptCount !== before.characterSearchAttemptCount || current.characterResolutionState === "selected") return;
    const failed = statusText?.startsWith("Albion Online character search is temporarily");
    const updated = failed ? current : await applicationRepository.beginApplicationCharacterSearch(application.discordGuildId, before.applicationId, before.submittedCharacterName);
    if (updated) await refreshApplicationIntakeCard(channel, applicationRepository, latestClass, updated, await findApplicationMemberGroup(latestClass, membershipRepository), { players, statusText });
  });
}

type CharacterControlSource = { message: { id: string; author: { id: string } } | null; client: { user: { id: string } | null } };
function isLegacyCharacterControlSource(interaction: CharacterControlSource, open: OpenApplication): boolean {
  return !!open.legacyReviewPublication && !!interaction.message && !!interaction.client.user
    && interaction.message.author.id === interaction.client.user.id
    && open.characterResolutionMessageId !== open.applicationControlMessageId
    && open.characterResolutionMessageId === interaction.message.id;
}
function isCharacterControlSource(interaction: CharacterControlSource, open: OpenApplication): boolean {
  return !!interaction.message && !!interaction.client.user && interaction.message.author.id === interaction.client.user.id
    && (open.applicationControlMessageId === interaction.message.id || isLegacyCharacterControlSource(interaction, open));
}
async function replyStaleCharacterControl(interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached"> | ModalSubmitInteraction<"cached">): Promise<void> {
  const payload = response(buildNotFoundEmbed("Stale Character Control", "Use the controls on the current application card."), { ephemeral: true });
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}
function applicantOrReviewer(interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached"> | ModalSubmitInteraction<"cached">, application: ApplicationClass, applicantId: string): boolean { return isApplicantOrReviewer(interaction.member as GuildMember, applicantId, interaction.user.id, application); }

export async function refreshApplicationForReopen(channel: TextChannel, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, application: ApplicationClass, open: OpenApplication): Promise<void> {
  if (open.characterResolutionState === "selected" && open.selectedAlbionCharacterId) {
    await refreshApplicationIntakeCard(channel, applicationRepository, application, open, await findApplicationMemberGroup(application, membershipRepository), { publishReview: false });
  } else {
    await refreshUnresolvedApplicationSearch(channel, applicationRepository, membershipRepository, albionClient, application, open);
  }
}

async function refreshSearchFailure(channel: TextChannel, repository: ApplicationRepository, membership: MembershipRepository, guildId: string, applicationId: string, description: string): Promise<void> {
  if (!description.startsWith("Albion Online character search is temporarily")) return;
  const current = await repository.getOpenApplication(guildId, applicationId);
  const application = current ? await repository.getApplicationClass(guildId, current.applicationClassId) : undefined;
  if (current && application && !application.archivedAt) await refreshApplicationIntakeCard(channel, repository, application, current, await findApplicationMemberGroup(application, membership), { statusText: description, publishReview: false });
}
