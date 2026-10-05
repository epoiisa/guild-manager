import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  NewsChannel,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type Attachment,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import type { ContentSnapshot, ContentState, createContentRepository } from "../db/contentRepository.js";
import { editFeedback, feedbackMessage, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import type { Logger } from "../logging/logger.js";
import { provisionContent } from "../services/content/hosting.js";
import { CONTENT_ACTIVE_DURATION_MS, canUnstartContent, getContentCleanupAt } from "../services/content/lifecycle.js";
import { refreshContentMessages as refreshManagedContentMessages } from "../services/content/messages.js";
import {
  CONTENT_CUSTOM_PREFIX,
  STANDBY_SIGNUP_VALUE,
  approvalRoleValidationError,
  buildArchiveActionRow,
  buildContentCancellationMessages,
  buildContentCreateModalId,
  buildContentCreatedMessage,
  buildContentEditModalId,
  buildContentRescheduleMessages,
  buildContentUnstartedMessage,
  buildRoleSlotSelectRows,
  buildRoleSlotSelectValue,
  getInteractionChannelId,
  isContentComponentInteraction,
  isContentModalSubmit,
  parseContentButtonId,
  parseContentModalId,
  parseRoleLines,
  parseSlotSelectId
} from "../services/content/rendering.js";
import { reconcileSignupApprovals } from "../services/content/signupApproval.js";
import { deliverStartNotification } from "../services/content/startNotification.js";
import { buildThreadTitle } from "../services/content/threadTitle.js";
import { UTC_TIME_INPUT_HELP, UTC_TIME_OPTION_DESCRIPTION, buildNextUtcDateChoices, parseUtcDateTime } from "../services/scheduling.js";
import {
  INFO_COLOR,
  buildInfoEmbed,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  truncateChoiceName
} from "./configurationHelpers.js";
import { handlePartyApprovalButton } from "./partyApproval.js";

type ContentRepository = ReturnType<typeof createContentRepository>;

const TITLE_FIELD = "title";
const DESCRIPTION_FIELD = "description";
const ROLES_FIELD = "roles";
const BUILDS_GRAPHIC_FIELD = "builds-graphic";
const BLANK_TEMPLATE_VALUE = "blank";
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ROLES_LENGTH = 2000;

interface PendingPartyEdit {
  contentId: string;
  discordGuildId: string;
  discordUserId: string;
  scheduledStartAt?: Date;
  image?: Attachment;
}

const pendingPartyEdits = new Map<string, PendingPartyEdit>();

export type FinishContentResult =
  | { outcome: "updated"; state: "ended" | "cancelled"; partial: boolean }
  | { outcome: "unchanged"; state: ContentState }
  | { outcome: "missing" };

export type ArchiveContentResult =
  | "archived"
  | "already-archived"
  | "not-ready"
  | "thread-unavailable"
  | "thread-update-failed"
  | "record-update-failed"
  | "missing";

export async function handleContentAutocomplete(
  interaction: AutocompleteInteraction,
  repository: ContentRepository
): Promise<boolean> {
  if (interaction.commandName !== "party") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "date") {
    await interaction.respond(buildNextUtcDateChoices());
    return true;
  }
  if (focused.name === "template") {
    await respondTemplateAutocomplete(interaction, repository);
    return true;
  }
  return false;
}

export async function handleContentModalSubmit(
  interaction: ModalSubmitInteraction,
  repository: ContentRepository,
  logger: Logger,
  hostingHooks?: { runExclusive<T>(guildId: string, task: () => Promise<T>): Promise<T>; validate(interaction: ModalSubmitInteraction<"cached">): Promise<void> }
): Promise<boolean> {
  if (!isContentModalSubmit(interaction)) return false;
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Server Only", "Content signups can only be used in a Discord server.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const parsed = parseContentModalId(interaction.customId);
  if (!parsed) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Content Form", "That content form is no longer valid.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const title = interaction.fields.getTextInputValue(TITLE_FIELD).trim();
  const description = interaction.fields.getTextInputValue(DESCRIPTION_FIELD).trim();
  const rolesText = interaction.fields.getTextInputValue(ROLES_FIELD);
  const roleLabels = parseRoleLines(rolesText);
  if (!validateContentFields(interaction, title, roleLabels)) return true;

  if (parsed.action === "create") {
    const roleError = approvalRoleValidationError(roleLabels, parsed.approvalRequired ?? false);
    if (roleError) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Role Too Long", roleError)], flags: MessageFlags.Ephemeral }));
      return true;
    }
    const graphic = uploadedGraphic(interaction);
    if (!validGraphic(graphic)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Builds Graphic", "Upload one image file for the builds graphic.")], flags: MessageFlags.Ephemeral }));
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const create = () => createContentFromModal(interaction, repository, logger, title, description, roleLabels, parsed.scheduledStartAt ?? null, parsed.approvalRequired ?? false, parsed.multiSignupEnabled ?? false, graphic[0], hostingHooks ? () => hostingHooks.validate(interaction) : undefined);
    if (hostingHooks) await hostingHooks.runExclusive(interaction.guildId, create);
    else await create();
    return true;
  }

  const snapshot = await repository.getContentSnapshot(interaction.guildId, parsed.contentId!);
  if (!snapshot || !isContentInteractionChannel(snapshot, interaction.channelId)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Not Found", "Use this form from the managed content thread.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if (!await isHost(interaction.user.id, snapshot, repository)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Host Only", "Only the party host can edit this signup.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const roleError = approvalRoleValidationError(roleLabels, snapshot.content.approvalRequired ?? false);
  if (roleError) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Role Too Long", roleError)], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const pendingEdit = parsed.editId ? pendingPartyEdits.get(parsed.editId) : undefined;
  if (parsed.editId) pendingPartyEdits.delete(parsed.editId);
  if (parsed.editId && (!pendingEdit
    || pendingEdit.contentId !== snapshot.content.contentId
    || pendingEdit.discordGuildId !== interaction.guildId
    || pendingEdit.discordUserId !== interaction.user.id)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Edit Expired", "Use Edit on the party announcement or open `/party edit` again and submit the current form.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  const scheduleRequested = Boolean(pendingEdit?.scheduledStartAt);
  const scheduleChanged = scheduleRequested
    && pendingEdit!.scheduledStartAt!.getTime() !== snapshot.content.scheduledStartAt?.getTime();
  const graphicChanged = Boolean(pendingEdit?.image);
  if (scheduleRequested && snapshot.content.scheduledStartAt === null) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Unscheduled Party", "Unscheduled parties cannot have a date or time. This edit cannot change the party mode.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if ((scheduleRequested || graphicChanged) && snapshot.content.state !== "scheduled" && snapshot.content.state !== "unscheduled") {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Schedule Locked", "Date, time, and builds graphic cannot be changed after content starts.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if (pendingEdit?.scheduledStartAt && pendingEdit.scheduledStartAt.getTime() <= Date.now()) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Start Time", "The resulting UTC start time must be in the future.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const updated = await repository.updateContentDetails({
      discordGuildId: interaction.guildId,
      contentId: snapshot.content.contentId,
      title,
      description,
      roleLabels,
      scheduledStartAt: pendingEdit?.scheduledStartAt,
      graphicAttachmentName: pendingEdit?.image ? normalizedGraphicName(pendingEdit.image) : undefined,
      actorDiscordUserId: interaction.user.id,
      requireScheduledState: scheduleRequested || graphicChanged
    });
    if (!updated) {
      await editFeedback(interaction, { cards: [buildNotFoundEmbed("Content Not Updated", scheduleRequested || graphicChanged
        ? "Builds graphics can only be changed before starting. Scheduled start times must remain in the future."
        : "Only waiting or active content can be edited.")] });
      return true;
    }
    const warnings = await applyPartyEditPresentation(interaction, repository, logger, updated.snapshot, pendingEdit?.image?.url, scheduleChanged, updated.invalidatedRequestIds);
    const movedToStandbyNote = formatMovedToStandbyNote(updated.movedToStandbyCount);
    await editFeedback(interaction, { structured: warnings.length > 0 || updated.movedToStandbyCount > 0, cards: [warnings.length === 0
      ? buildSuccessEmbed("Content Updated", `The content signup was updated.${movedToStandbyNote}`)
      : buildInfoEmbed("Content Updated With Warning", `The content signup was saved.${movedToStandbyNote} However, ${warnings.join(" ")}`)] });
  } catch (error) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed(
        "Content Not Updated",
        error instanceof Error ? error.message : "Guild Manager could not update that content signup."
      )]
    });
  }
  return true;
}

export async function handleContentButton(
  interaction: ButtonInteraction,
  repository: ContentRepository,
  logger: Logger
): Promise<boolean> {
  if (!isContentComponentInteraction(interaction)) return false;
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Server Only", "Content controls can only be used in a Discord server.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  if (await handlePartyApprovalButton(interaction, repository)) return true;

  const parsed = parseContentButtonId(interaction.customId);
  if (!parsed) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Content Control", "That content control is no longer valid.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const snapshot = await repository.getContentSnapshot(interaction.guildId, parsed.contentId);
  if (!snapshot || !isContentInteractionChannel(snapshot, interaction.channelId)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Not Found", "That content signup is no longer available.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  const signupAction = parsed.action === "join" || parsed.action === "standby" || parsed.action === "leave";
  const canonicalMessageId = parsed.action === "unstart" ? snapshot.content.startNotificationMessageId
    : signupAction ? snapshot.content.controlMessageId : snapshot.content.detailsMessageId;
  if (parsed.action !== "archive" && interaction.message.id !== canonicalMessageId) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Stale Content Control",
      `Use the buttons on the current ${parsed.action === "unstart" ? "start notification" : signupAction ? "roles" : "details"} message inside the party thread.`)], flags: MessageFlags.Ephemeral }));
    return true;
  }

  if (parsed.action === "join") {
    await openSignupSelect(interaction, repository, snapshot, interaction.user.id);
    return true;
  }
  if (parsed.action === "standby") {
    if (!canJoin(snapshot)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Signups Closed", "This content signup is no longer open.")], flags: MessageFlags.Ephemeral }));
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = await signupContent(interaction, repository, snapshot, interaction.user.id, null);
    await editFeedback(interaction, { cards: [embed] });
    return true;
  }
  if (parsed.action === "leave") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const embed = await leaveContent(interaction, repository, snapshot, interaction.user.id, interaction.user.id);
    await editFeedback(interaction, { cards: [embed] });
    return true;
  }

  if (!await isHost(interaction.user.id, snapshot, repository)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Host Only", "Only the party host can use that control.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  if (parsed.action === "edit") {
    await showContentEditModal(interaction, snapshot);
    return true;
  }

  if (parsed.action === "unstart") {
    if (!canUnstartContent(snapshot.content) || snapshot.content.startRevision !== parsed.startRevision) {
      await interaction.reply(feedbackReply({ text: "This start can no longer be undone.", flags: MessageFlags.Ephemeral }));
      return true;
    }
    await interaction.deferUpdate();
    await unstartContent(interaction, repository, logger, snapshot, parsed.startRevision!);
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (parsed.action === "start") {
    const result = await startContent(interaction, repository, logger, snapshot);
    await editFeedback(interaction, { structured: result === "notification-failed" || result === "notification-uncertain", cards: [buildStartContentResultEmbed(result)] });
  } else if (parsed.action === "end") {
    const result = await finishContent(interaction, repository, snapshot, "end");
    await editFeedback(interaction, { cards: [buildFinishContentResultEmbed("end", result)] });
  } else if (parsed.action === "cancel") {
    const result = await finishContent(interaction, repository, snapshot, "cancel");
    await editFeedback(interaction, { cards: [buildFinishContentResultEmbed("cancel", result)] });
  } else if (parsed.action === "archive") {
    const result = await archiveContent(interaction, repository, logger, snapshot);
    await editFeedback(interaction, { cards: [buildArchiveContentResultEmbed(result)] });
  }
  return true;
}

export async function handleContentRoleSelect(
  interaction: StringSelectMenuInteraction,
  repository: ContentRepository
): Promise<boolean> {
  if (!interaction.customId.startsWith(`${CONTENT_CUSTOM_PREFIX}slot:`)) return false;
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Server Only", "Content controls can only be used in a Discord server.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const parsed = parseSlotSelectId(interaction.customId);
  const selectedValue = interaction.values[0];
  if (!parsed || interaction.values.length !== 1 || !selectedValue || selectedValue === "none") {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Role Selection", "That role selection is no longer valid.")], flags: MessageFlags.Ephemeral }));
    return true;
  }

  const snapshot = await repository.getContentSnapshot(interaction.guildId, parsed.contentId);
  if (!snapshot || !isContentInteractionChannel(snapshot, interaction.channelId)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Not Found", "That content signup is no longer available.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if (!canJoin(snapshot)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Signups Closed", "This content signup is no longer open.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if ((parsed.hostAssignment || parsed.targetUserId !== interaction.user.id) && !await isHost(interaction.user.id, snapshot, repository)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Host Only", "Only the party host can add another user.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  if (selectedValue === STANDBY_SIGNUP_VALUE) {
    await interaction.reply(feedbackReply({ text: "Use the Standby button or /standby.", flags: MessageFlags.Ephemeral }));
    return true;
  }
  const selectedSlotId = selectedValue.split("~")[0];
  const slot = snapshot.slots.find((candidate) => candidate.contentRoleSlotId === selectedSlotId);
  if (!slot) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Role Not Found", "That role slot no longer exists.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  // Legacy ungated controls used a raw slot ID. New controls always carry the
  // displayed role's signature, so a rename cannot silently change a selection.
  if (selectedValue !== buildRoleSlotSelectValue(slot)
    && (snapshot.content.approvalRequired || selectedValue !== selectedSlotId)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Role Changed", "That role has changed. Choose a role again.")], flags: MessageFlags.Ephemeral }));
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await signupContent(interaction, repository, snapshot, parsed.targetUserId,
    selectedSlotId, parsed.hostAssignment || parsed.targetUserId !== interaction.user.id);
  await editFeedback(interaction, { cards: [embed] });
  return true;
}

export async function openSignupSelect(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  targetUserId: string,
  hostAssignment = false
): Promise<void> {
  if (!canJoin(snapshot)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Signups Closed", "This content signup is no longer open.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  const fresh = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
  if (!fresh) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Not Found", "That content signup is no longer available.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  if (!canJoin(fresh)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Signups Closed", "This party is no longer open for signups.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  const actionRows = buildRoleSlotSelectRows(fresh, targetUserId, hostAssignment);
  if (actionRows.length === 0) {
    await interaction.reply(feedbackReply({
      text: hostAssignment
        ? `All roles are filled for <@${targetUserId}>. They can use the Standby button or /standby.`
        : "All roles are filled. Use the Standby button or /standby.",
      flags: MessageFlags.Ephemeral
    }));
    return;
  }
  await interaction.reply(v2Reply({
    cards: [buildInfoEmbed("Choose Signup", `Choose a role for <@${targetUserId}>.${fresh.content.approvalRequired ? "\nHost approval is required. Requests do not reserve a place." : ""}`)],
    actionRows,
    flags: MessageFlags.Ephemeral
  }));
}

/** All member and explicit host assignments share the repository's atomic gate. */
export async function signupContent(
  interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  targetUserId: string,
  roleSlotId: string | null,
  hostAssignment = false
): Promise<EmbedBuilder> {
  const slot = snapshot.slots.find((candidate) => candidate.contentRoleSlotId === roleSlotId);
  const result = await repository.requestSignup({
    discordGuildId: snapshot.content.discordGuildId,
    contentId: snapshot.content.contentId,
    discordUserId: targetUserId,
    roleSlotId,
    expectedSlot: slot ? { slotIndex: slot.slotIndex, label: slot.label } : undefined,
    actorDiscordUserId: hostAssignment ? interaction.user.id : undefined
  });
  if (result.status === "closed") return buildNotFoundEmbed("Signups Closed", "This party is no longer open for signups.");
  if (result.status === "not_host") return buildNotFoundEmbed("Host Only", "Only the party host can add another user.");
  if (result.status === "slot_filled") return buildNotFoundEmbed("Role Filled", "That role is already filled. No changes were made.");
  if (result.status === "slot_changed") return buildNotFoundEmbed("Role Changed", "That role has changed. Choose a role again.");
  const presentation = await refreshSignupPresentation(interaction, repository, snapshot, {
    notifyRequestId: result.status === "requested" ? result.request?.requestId : undefined,
    notifyOutcomeRequestId: result.status === "signed_up" ? result.request?.requestId : undefined
  });
  if (!presentation) {
    return buildInfoEmbed(result.status === "requested" || result.status === "unchanged" ? "Request Saved" : "Signup Saved",
      result.status === "requested" || result.status === "unchanged"
        ? "Your request is saved, but its message could not be posted or fully updated. Guild Manager will recover the same request."
        : "Your signup change is saved, but its messages could not be fully updated. Guild Manager will repair them.");
  }
  if (result.status === "unchanged") return buildInfoEmbed("Awaiting Host Approval", "Your request is awaiting host approval.");
  if (result.status === "requested") {
    const place = slot ? `${slot.slotIndex}. ${escapeMarkdown(slot.label)}` : "Standby";
    return buildSuccessEmbed("Request Sent", `Request sent for **${place}**. Your place is confirmed when the host accepts.`);
  }
  if (result.status === "already_signed_up") return buildSuccessEmbed("Signup Kept", "Your confirmed signup was kept and any pending move was cancelled.");
  return buildSuccessEmbed("Signup Updated", roleSlotId === null
    ? targetUserId === interaction.user.id && !hostAssignment && !("values" in interaction) ? "You were signed up as Standby." : `<@${targetUserId}> was signed up as Standby.`
    : `<@${targetUserId}> was signed up.`);
}

export async function refreshSignupPresentation(
  interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  notifications?: { notifyRequestId?: string; notifyOutcomeRequestId?: string }
): Promise<boolean> {
  let complete = true;
  if (interaction.guild) {
    try {
      const result = await reconcileSignupApprovals(interaction.guild, repository, snapshot.content.contentId, notifications);
      complete = result.complete && complete;
    } catch { complete = false; }
  }
  try {
    const updated = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    if (updated) await refreshContentMessages(interaction, repository, updated, undefined, Boolean(interaction.guild));
  } catch { complete = false; }
  return complete;
}

export async function leaveContent(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  targetUserId: string,
  removedByDiscordUserId: string,
  hostRemoval = false
): Promise<EmbedBuilder> {
  const result = await repository.withdrawSignup({
    discordGuildId: snapshot.content.discordGuildId,
    contentId: snapshot.content.contentId,
    discordUserId: targetUserId,
    actorDiscordUserId: hostRemoval ? removedByDiscordUserId : undefined
  });
  if (result.status === "closed") return buildNotFoundEmbed("Signups Closed", "This party is no longer open for signups.");
  if (result.status === "not_host") return buildNotFoundEmbed("Host Only", "Only the party host can remove another user.");
  if (result.status === "none") return buildNotFoundEmbed(hostRemoval ? "User Not Signed Up" : "Not Signed Up", hostRemoval
    ? `<@${targetUserId}> has no signup or pending request for this content.` : "You have no signup or pending request for this content.");
  const complete = await refreshSignupPresentation(interaction, repository, snapshot);
  const removed = result.removedSignup && result.removedRequest ? "signup and pending request"
    : result.removedRequest ? "pending request" : "signup";
  return buildSuccessEmbed(hostRemoval ? "Signup Removed" : "Left Content", `${hostRemoval ? `<@${targetUserId}>'s` : "Your"} ${removed} ${result.removedSignup && result.removedRequest ? "were" : "was"} removed.${complete ? "" : " The change is saved, but some messages could not be updated. Guild Manager will repair them."}`);
}

export async function requireManagedThread(
  interaction: ChatInputCommandInteraction,
  repository: ContentRepository
): Promise<ContentSnapshot | undefined> {
  const channelId = getInteractionChannelId(interaction);
  if (!interaction.guildId || !channelId) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Thread Required", "Use this command inside a managed content thread.")], flags: MessageFlags.Ephemeral }));
    return undefined;
  }
  const snapshot = await repository.getContentByThread(interaction.guildId, channelId);
  if (!snapshot) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Thread Required", "Use this command inside a managed content thread.")], flags: MessageFlags.Ephemeral }));
    return undefined;
  }
  return snapshot;
}

export async function isHost(discordUserId: string, snapshot: ContentSnapshot, repository: ContentRepository): Promise<boolean> {
  return snapshot.content.hostDiscordUserId === discordUserId
    && !await repository.isHostAuthorityRevoked(snapshot.content.discordGuildId, discordUserId, snapshot.content.contentId);
}

export function isContentInteractionChannel(snapshot: ContentSnapshot, channelId: string | null): boolean {
  return snapshot.content.threadChannelId === channelId || snapshot.content.sourceChannelId === channelId;
}

export async function refreshContentMessages(
  interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  replacementGraphicUrl?: string,
  requireAvailable = false
): Promise<void> {
  if (!interaction.guild) {
    if (requireAvailable) throw new Error("Content server is unavailable.");
    return;
  }
  await refreshManagedContentMessages(interaction.guild, repository, snapshot, replacementGraphicUrl, requireAvailable);
}

export async function handleCreate(interaction: ChatInputCommandInteraction, repository: ContentRepository, unscheduled = false): Promise<void> {
  let scheduledStartAt: Date | null = null;
  if (!unscheduled) {
    const dateValue = interaction.options.getString("date", true);
    const timeValue = interaction.options.getString("time", true);
    scheduledStartAt = parseUtcDateTime(dateValue, timeValue) ?? null;
    if (!scheduledStartAt || scheduledStartAt.getTime() <= Date.now()) {
      await interaction.reply(v2Reply({ cards: [buildNotFoundEmbed("Invalid Start Time", `Choose a future UTC start. ${UTC_TIME_INPUT_HELP}`)], flags: MessageFlags.Ephemeral }));
      return;
    }
  }

  const templateId = interaction.options.getString("template", true);
  const template = templateId === BLANK_TEMPLATE_VALUE ? undefined : await repository.getTemplate(interaction.guildId!, templateId);
  if (templateId !== BLANK_TEMPLATE_VALUE && !template) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Template Not Found", "Choose Blank or an existing content template.")], flags: MessageFlags.Ephemeral }));
    return;
  }

  const modal = buildContentModal(
    "Create Content",
    buildContentCreateModalId(template?.contentTemplateId, scheduledStartAt, interaction.options.getString("approval") === "true", interaction.options.getString("multisignup") === "true"),
    template?.title ?? "",
    template?.description ?? "",
    template?.rolesText ?? "",
    { graphic: true }
  );
  await interaction.showModal(modal);
}

async function createContentFromModal(
  interaction: ModalSubmitInteraction<"cached">,
  repository: ContentRepository,
  logger: Logger,
  title: string,
  description: string,
  roleLabels: string[],
  scheduledStartAt: Date | null,
  approvalRequired: boolean,
  multiSignupEnabled: boolean,
  graphic?: Attachment,
  validate?: () => Promise<void>
): Promise<void> {
  if (scheduledStartAt && scheduledStartAt.getTime() <= Date.now()) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Invalid Start Time", "The UTC start time must still be in the future. Open `/party host scheduled` again.")] });
    return;
  }
  const parentChannel = await resolveContentParentChannel(interaction, repository);
  if (!parentChannel) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Content Channel Not Found", "Set a content channel or run `/party host scheduled` or `/party host unscheduled` from a text channel.")] });
    return;
  }

  const result = await provisionContent({ repository, logger, parentChannel, guildId: interaction.guildId, hostUserId: interaction.user.id, title, description, roleLabels, scheduledStartAt, approvalRequired, multiSignupEnabled, graphic, validate });
  await interaction.editReply(buildContentCreatedMessage(result.snapshot.content, result.announcementUrl));
}

async function resolveContentParentChannel(
  interaction: ModalSubmitInteraction<"cached">,
  repository: ContentRepository
): Promise<TextChannel | NewsChannel | undefined> {
  const configured = await repository.getContentChannel(interaction.guildId);
  const configuredChannel = configured
    ? await interaction.guild.channels.fetch(configured.discordChannelId).catch(() => null)
    : null;
  const currentChannel = interaction.channel;
  const channel = configuredChannel ?? currentChannel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    return undefined;
  }
  return channel;
}

export async function showContentEditModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  snapshot: ContentSnapshot,
  options?: { date?: string | null; time?: string | null; image?: Attachment | null }
): Promise<void> {
  if (snapshot.content.state !== "scheduled" && snapshot.content.state !== "unscheduled" && snapshot.content.state !== "active") {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Not Editable", "Only waiting or active content can be edited.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  let scheduledStartAt: Date | undefined;
  if (options?.date || options?.time) {
    if (!snapshot.content.scheduledStartAt) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Unscheduled Party", "Unscheduled parties cannot have a date or time. This edit cannot change the party mode.")], flags: MessageFlags.Ephemeral }));
      return;
    }
    const date = options.date ?? snapshot.content.scheduledStartAt.toISOString().slice(0, 10);
    const time = options.time ?? `${String(snapshot.content.scheduledStartAt.getUTCHours()).padStart(2, "0")}:${String(snapshot.content.scheduledStartAt.getUTCMinutes()).padStart(2, "0")}`;
    scheduledStartAt = parseUtcDateTime(date, time);
    if (!scheduledStartAt) {
      await interaction.reply(v2Reply({ cards: [buildNotFoundEmbed("Invalid Start Time", `Choose an autocomplete date. ${UTC_TIME_INPUT_HELP}`)], flags: MessageFlags.Ephemeral }));
      return;
    }
    if (scheduledStartAt.getTime() <= Date.now()) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Start Time", "The resulting UTC start time must be in the future.")], flags: MessageFlags.Ephemeral }));
      return;
    }
  }
  if (options?.image && !validGraphic([options.image])) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Invalid Builds Graphic", "Upload one image file for the builds graphic.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  if ((scheduledStartAt || options?.image) && snapshot.content.state !== "scheduled" && snapshot.content.state !== "unscheduled") {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Content Schedule Locked", "Date, time, and builds graphic cannot be changed after content starts.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  const editId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  pendingPartyEdits.set(editId, {
    contentId: snapshot.content.contentId,
    discordGuildId: snapshot.content.discordGuildId,
    discordUserId: interaction.user.id,
    scheduledStartAt,
    image: options?.image ?? undefined
  });
  const rolesText = snapshot.slots.map((slot) => slot.label).join("\n");
  await interaction.showModal(buildContentModal(
    "Edit Content",
    buildContentEditModalId(snapshot.content.contentId, editId),
    snapshot.content.title,
    snapshot.content.description,
    rolesText
  ));
}

export type StartContentResult = "started" | "already-started" | "not-open" | "notification-failed" | "notification-uncertain";

export function buildStartContentResultEmbed(result: StartContentResult): EmbedBuilder {
  if (result === "started") return buildSuccessEmbed("Content Started", "The content signup was started.");
  if (result === "already-started") return buildInfoEmbed("Content Already Started", "This content signup has already started.");
  if (result === "notification-failed") return buildInfoEmbed("Content Started With Warning", "The content signup started, but Guild Manager could not prepare its start announcement. Use `/party start` to retry; the start time and expiry will stay unchanged.");
  if (result === "notification-uncertain") return buildInfoEmbed("Content Started With Warning", "The content signup started, but delivery of its start notifications is incomplete or unconfirmed. Guild Manager will not send them again to avoid duplicate notifications.");
  return buildNotFoundEmbed("Content Not Started", "This content signup is closed or expired and cannot be started.");
}

export async function startContent(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  repository: ContentRepository,
  logger: Logger,
  snapshot: ContentSnapshot
): Promise<StartContentResult> {
  const started = await repository.markStarted(snapshot.content.discordGuildId, snapshot.content.contentId, new Date(), interaction.user?.id);
  try {
    const fresh = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    if (!fresh || fresh.content.state !== "active" || getContentCleanupAt(fresh.content).getTime() <= Date.now()
      || (interaction.user && !await isHost(interaction.user.id, fresh, repository))) return "not-open";
    if (fresh.content.startNotificationClaimedAt && !fresh.content.startNotificationMessageId) return "notification-uncertain";
    if (!interaction.guild) return "notification-failed";
    const delivery = await deliverStartNotification(interaction.guild, repository, fresh);
    if (delivery === "unavailable") {
      const current = await repository.getContentSnapshot(fresh.content.discordGuildId, fresh.content.contentId);
      return current?.content.startNotificationClaimedAt ? "notification-uncertain" : "notification-failed";
    }
    if (delivery === "already-sent") return started ? "started" : "already-started";
    logger.info("posted content start notification", {
      guildId: fresh.content.discordGuildId,
      contentId: fresh.content.contentId,
      threadId: fresh.content.threadChannelId
    });
    return "started";
  } catch (error) {
    logger.warn("content started but presentation failed", { contentId: snapshot.content.contentId, error: error instanceof Error ? error.message : String(error) });
    const current = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId).catch(() => undefined);
    return current?.content.startNotificationClaimedAt || !current ? "notification-uncertain" : "notification-failed";
  }
}

export async function unstartContent(
  interaction: ButtonInteraction,
  repository: ContentRepository,
  logger: Logger,
  snapshot: ContentSnapshot,
  startRevision: string
): Promise<boolean> {
  const updated = await repository.markUnstarted(snapshot.content.discordGuildId, snapshot.content.contentId,
    interaction.user.id, startRevision, interaction.message.id);
  if (!updated) return false;

  // The durable transition consumes this exact start. Cleanup failures do not
  // undo it, repeat the operation, or produce a private success/warning message.
  await interaction.message.delete().catch(() => undefined);
  try {
    if (interaction.channel && "send" in interaction.channel) {
      await interaction.channel.send(buildContentUnstartedMessage(updated));
    }
  } catch {
    logger.warn("content unstarted notice delivery unconfirmed", { guildId: updated.discordGuildId, contentId: updated.contentId });
  }
  try {
    const fresh = await repository.getContentSnapshot(updated.discordGuildId, updated.contentId);
    if (fresh) await refreshContentMessages(interaction, repository, fresh);
  } catch {
    // The state change rotates the saved render revision, so normal message
    // reconciliation can restore Start even if this immediate refresh fails.
    logger.warn("content unstarted with presentation repair outstanding", { guildId: updated.discordGuildId, contentId: updated.contentId });
  }
  return true;
}

export async function finishContent(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  action: "end" | "cancel"
): Promise<FinishContentResult> {
  const updated = action === "end"
    ? await repository.markEnded(snapshot.content.discordGuildId, snapshot.content.contentId, interaction.user?.id)
    : await repository.markCancelled(snapshot.content.discordGuildId, snapshot.content.contentId, interaction.user?.id);
  if (!updated) {
    const current = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    return current
      ? { outcome: "unchanged", state: current.content.state }
      : { outcome: "missing" };
  }
  let partial = false;
  let fresh: ContentSnapshot | undefined;
  try {
    fresh = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    if (fresh) await refreshContentMessages(interaction, repository, fresh);
    else partial = true;
  } catch {
    partial = true;
  }
  // Closure is already committed. A failed request cleanup must not prevent the
  // separate terminal message from giving the host its ordinary Archive control.
  try {
    const channel = await interaction.client.channels.fetch(snapshot.content.threadChannelId);
    if (channel && "send" in channel) {
      const payloads = action === "end" ? [feedbackMessage({
        text: "Content ended.",
        allowActionRows: true,
        accentColor: INFO_COLOR,
        actionRows: [buildArchiveActionRow(snapshot.content.contentId)]
      })] : buildContentCancellationMessages(fresh ?? snapshot);
      for (const payload of payloads) await channel.send(payload);
    } else partial = true;
  } catch {
    partial = true;
  }
  return { outcome: "updated", state: action === "end" ? "ended" : "cancelled", partial };
}

export async function archiveContent(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  repository: ContentRepository,
  logger: Logger,
  snapshot: ContentSnapshot
): Promise<ArchiveContentResult> {
  const current = await repository.getContentSnapshot(
    snapshot.content.discordGuildId,
    snapshot.content.contentId
  );
  if (!current) return "missing";
  if (current.content.state === "archived") return "already-archived";
  if (current.content.state !== "ended" && current.content.state !== "cancelled") {
    return "not-ready";
  }

  let channel = interaction.channel?.id === current.content.threadChannelId
    && interaction.channel.isThread()
    ? interaction.channel
    : null;
  if (!channel) {
    try {
      const fetched = await interaction.client.channels.fetch(current.content.threadChannelId);
      channel = fetched?.isThread() ? fetched : null;
    } catch (error) {
      logger.warn("content thread lookup failed during archive", {
        guildId: current.content.discordGuildId,
        contentId: current.content.contentId,
        threadId: current.content.threadChannelId,
        error: error instanceof Error ? error.message : String(error)
      });
      return "thread-unavailable";
    }
  }
  if (!channel) {
    logger.warn("content thread unavailable during archive", {
      guildId: current.content.discordGuildId,
      contentId: current.content.contentId,
      threadId: current.content.threadChannelId
    });
    return "thread-unavailable";
  }

  try {
    await channel.setLocked(true, "Close and lock Guild Manager content signup thread");
    await channel.setArchived(true, "Close Guild Manager content signup thread");
  } catch (error) {
    logger.warn("content thread archive failed", {
      guildId: current.content.discordGuildId,
      contentId: current.content.contentId,
      threadId: current.content.threadChannelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return "thread-update-failed";
  }

  try {
    const archived = await repository.markArchived(current.content.discordGuildId, current.content.contentId, interaction.user?.id);
    if (archived) return "archived";
    const latest = await repository.getContentSnapshot(current.content.discordGuildId, current.content.contentId);
    return latest?.content.state === "archived" ? "already-archived" : "record-update-failed";
  } catch (error) {
    logger.error("content record archive failed", {
      guildId: current.content.discordGuildId,
      contentId: current.content.contentId,
      threadId: current.content.threadChannelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return "record-update-failed";
  }
}

export function buildFinishContentResultEmbed(
  action: "end" | "cancel",
  result: FinishContentResult
): EmbedBuilder {
  if (result.outcome === "updated") {
    if (result.partial) {
      return buildInfoEmbed(action === "end" ? "Content Ended With Warning" : "Content Cancelled With Warning",
        `The content signup was ${action === "end" ? "ended" : "cancelled"} and is closed to signups, but Guild Manager could not finish updating its messages.${action === "cancel" ? " Signup notification delivery may be incomplete. Attempted notifications will not be repeated." : ""}`);
    }
    return action === "end"
      ? buildSuccessEmbed("Content Ended", "The content signup was ended.")
      : buildSuccessEmbed("Content Cancelled", "The content signup was cancelled.");
  }
  if (result.outcome === "missing") {
    return buildNotFoundEmbed("Content Not Found", "That content signup is no longer available.");
  }
  if (result.state === "ended") {
    return buildInfoEmbed("Content Already Ended", "The content signup is already ended and ready to archive.");
  }
  if (result.state === "cancelled") {
    return buildInfoEmbed("Content Already Cancelled", "The content signup is already cancelled and ready to archive.");
  }
  if (result.state === "archived") {
    return buildInfoEmbed("Content Already Archived", "The content signup is already archived.");
  }
  return buildNotFoundEmbed(
    "Content Not Updated",
    `The content could not be ${action === "end" ? "ended" : "cancelled"}. Try again.`
  );
}

export function buildArchiveContentResultEmbed(result: ArchiveContentResult): EmbedBuilder {
  if (result === "archived") {
    return buildSuccessEmbed("Content Archived", "The content thread was archived and locked.");
  }
  if (result === "already-archived") {
    return buildInfoEmbed("Content Already Archived", "The content signup is already archived.");
  }
  if (result === "not-ready") {
    return buildNotFoundEmbed("Content Not Ready", "End or cancel the content before archiving it.");
  }
  if (result === "thread-unavailable") {
    return buildNotFoundEmbed(
      "Content Thread Unavailable",
      "Guild Manager could not access the managed content thread. Try again; if this continues, check that the bot can view the thread."
    );
  }
  if (result === "thread-update-failed") {
    return buildNotFoundEmbed(
      "Content Not Archived",
      "Guild Manager could not lock and archive the thread. Check that the bot has Manage Threads, then try again."
    );
  }
  if (result === "record-update-failed") {
    return buildNotFoundEmbed(
      "Content Archive Incomplete",
      "The thread was archived, but Guild Manager could not update its content record. Try again later."
    );
  }
  return buildNotFoundEmbed("Content Not Found", "That content signup is no longer available.");
}

export function buildContentModal(
  title: string,
  customId: string,
  contentTitle: string,
  description: string,
  rolesText: string,
  options: { graphic?: boolean; time?: string; date?: string } = {}
): ModalBuilder {
  return new ModalBuilder()
    .setTitle(title)
    .setCustomId(customId)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TITLE_FIELD)
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(MAX_TITLE_LENGTH)
          .setValue(contentTitle.slice(0, MAX_TITLE_LENGTH))
      ),
      ...(options.time !== undefined ? [new LabelBuilder().setLabel("Time (UTC)").setDescription(UTC_TIME_OPTION_DESCRIPTION).setTextInputComponent(new TextInputBuilder().setCustomId("time").setStyle(TextInputStyle.Short).setRequired(true).setValue(options.time))] : []),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(DESCRIPTION_FIELD)
          .setLabel("Description")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(MAX_DESCRIPTION_LENGTH)
          .setValue(description.slice(0, MAX_DESCRIPTION_LENGTH))
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(ROLES_FIELD)
          .setLabel("Roles, one per line")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(MAX_ROLES_LENGTH)
          .setValue(rolesText.slice(0, MAX_ROLES_LENGTH))
      ),
      ...(options.graphic
        ? [new LabelBuilder().setLabel("Builds graphic").setDescription("Optional image shown above Roles.").setFileUploadComponent(
          new FileUploadBuilder().setCustomId(BUILDS_GRAPHIC_FIELD).setRequired(false).setMinValues(1).setMaxValues(1)
        )]
        : [])
    );
}

function uploadedGraphic(interaction: ModalSubmitInteraction): Attachment[] {
  return [...(interaction.fields.getUploadedFiles(BUILDS_GRAPHIC_FIELD, false)?.values() ?? [])];
}

function validGraphic(files: Attachment[]): files is [] | [Attachment] {
  return files.length <= 1 && (files.length === 0 || Boolean(files[0].contentType?.toLocaleLowerCase().startsWith("image/")));
}

function normalizedGraphicName(attachment: Attachment): string {
  const extension = attachment.contentType?.toLocaleLowerCase().includes("png") ? ".png"
    : attachment.contentType?.toLocaleLowerCase().includes("gif") ? ".gif"
      : attachment.contentType?.toLocaleLowerCase().includes("webp") ? ".webp"
        : ".jpg";
  return `content-builds-graphic${extension}`;
}

async function applyPartyEditPresentation(
  interaction: ModalSubmitInteraction<"cached">,
  repository: ContentRepository,
  logger: Logger,
  snapshot: ContentSnapshot,
  replacementGraphicUrl: string | undefined,
  scheduleChanged: boolean,
  invalidatedRequestIds: string[] = []
): Promise<string[]> {
  const warnings: string[] = [];
  if (invalidatedRequestIds.length > 0) {
    try {
      const result = await reconcileSignupApprovals(interaction.guild, repository, snapshot.content.contentId, { notifyOutcomeRequestIds: invalidatedRequestIds });
      if (!result.complete) warnings.push("Guild Manager could not fully publish the cleared role requests.");
    } catch {
      warnings.push("Guild Manager could not fully publish the cleared role requests.");
    }
  }
  try {
    await refreshContentMessages(interaction, repository, snapshot, replacementGraphicUrl);
  } catch (error) {
    logger.error("content edit message refresh failed", { guildId: snapshot.content.discordGuildId, contentId: snapshot.content.contentId, error: error instanceof Error ? error.message : String(error) });
    warnings.push("Guild Manager could not fully refresh the canonical messages.");
  }
  if (!scheduleChanged) return warnings;
  const thread = await interaction.guild.channels.fetch(snapshot.content.threadChannelId).catch(() => null);
  if (!thread?.isThread()) {
    warnings.push("Guild Manager could not refresh the thread title.");
  } else {
    try {
      await thread.setName(buildThreadTitle(snapshot.content.title, snapshot.content.scheduledStartAt), "Reschedule Guild Manager content thread");
    } catch (error) {
      logger.warn("content thread reschedule title failed", { guildId: snapshot.content.discordGuildId, contentId: snapshot.content.contentId, error: error instanceof Error ? error.message : String(error) });
      warnings.push("Guild Manager could not refresh the thread title.");
    }
    if (snapshot.signups.length > 0) {
      try {
        const payloads = buildContentRescheduleMessages(snapshot);
        for (const payload of payloads) await thread.send(payload);
      } catch (error) {
        logger.warn("content reschedule notification failed", { guildId: snapshot.content.discordGuildId, contentId: snapshot.content.contentId, error: error instanceof Error ? error.message : String(error) });
        warnings.push("Guild Manager could not fully deliver the rescheduling notifications. Attempted notifications will not be repeated.");
      }
    }
  }
  return warnings;
}

function validateContentFields(
  interaction: ModalSubmitInteraction,
  title: string,
  roleLabels: string[]
): boolean {
  if (!title || roleLabels.length === 0) {
    void interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Missing Content Details", "Provide a title and at least one role line.")],
      flags: MessageFlags.Ephemeral
    }));
    return false;
  }
  if (roleLabels.length > 25) {
    void interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Too Many Roles", "Use 25 role slots or fewer for v1.")],
      flags: MessageFlags.Ephemeral
    }));
    return false;
  }
  return true;
}

export function formatMovedToStandbyNote(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? " 1 signup was moved to Standby because its role was removed."
    : ` ${count} signups were moved to Standby because their roles were removed.`;
}

export { buildThreadTitle } from "../services/content/threadTitle.js";

async function respondTemplateAutocomplete(interaction: AutocompleteInteraction, repository: ContentRepository): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = String(interaction.options.getFocused(true).value ?? "").toLocaleLowerCase();
  const templates = await repository.listTemplates(interaction.guildId);
  await interaction.respond([
    { name: "Blank", value: BLANK_TEMPLATE_VALUE },
    ...templates
      .filter((template) => template.name.toLocaleLowerCase().includes(focused))
      .slice(0, 24)
      .map((template) => ({ name: truncateChoiceName(template.name), value: template.contentTemplateId }))
  ]);
}

export function canJoin(snapshot: ContentSnapshot): boolean {
  return (snapshot.content.state === "scheduled" || snapshot.content.state === "unscheduled" || snapshot.content.state === "active")
    && getContentCleanupAt(snapshot.content).getTime() > Date.now();
}

export function getCleanupWindowMs(): number {
  return CONTENT_ACTIVE_DURATION_MS;
}
