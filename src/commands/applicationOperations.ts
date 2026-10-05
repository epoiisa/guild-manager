import { applicationRoleWarnings } from "../services/applications/activeRoleService.js";
import { ChannelType, MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type GuildMember, type InteractionReplyOptions, type TextChannel } from "discord.js";
import type { ApplicationClass, OpenApplication, createApplicationRepository } from "../db/applicationRepository.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import { feedbackEdit, feedbackReply } from "../discord/feedbackMessages.js";
import type { AlbionClient } from "../services/albion/client.js";
import { acceptOrVerifyApplication } from "../services/applications/acceptVerificationService.js";
import { withApplicationOperationLock } from "../services/applications/applicationOperationLock.js";
import { createApplicationCommandLifecyclePresentation, isClosedControlSource, renderReopenedApplication, replyStaleApplicationControl, requireCanonicalApplicationControlSource, rerenderApplicationMessage, retainWaitingApplicationControls, retireApplicationDecisionControls, retireApplicationMessage, retireStoredApplicationControl, retireUndecidedControls } from "../services/applications/controlPresentation.js";
import { deleteApplicationChannel } from "../services/applications/deleteService.js";
import { runApplicationLifecycleOperation, type ApplicationLifecycleOperationAction } from "../services/applications/lifecycleService.js";
import { rejectApplication } from "../services/applications/rejectService.js";
import { buildApplicationControlReplacementEmbed, buildApplicationV2Card, buildCloseButton, buildClosedChannelButtons, buildWaitingButtons, formatAcceptedApplicationDescription, formatRejectedApplicationDescription, formatWarnings, withControlFooter } from "../services/applications/rendering.js";
import { withdrawApplication } from "../services/applications/withdrawService.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import { buildInfoEmbed, buildNotFoundEmbed, buildSuccessEmbed, formatCharacterUserMentionPair, formatMemberGroupLabel, formatRole } from "./configurationHelpers.js";
import type { ApplicationTarget } from "./operationalTargets.js";
import { resolveApplicationTarget } from "./operationalTargets.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
export type ApplicationUndecidedRefresher = (channel: TextChannel, application: ApplicationClass, openApplication: OpenApplication) => Promise<void>;

const WAITING_MEMBERSHIP_FOOTER = "Reviewers can verify membership or cancel this application.";
const OUTCOME_CLOSE_FOOTER = "The applicant or reviewers can close this channel.";
const CLOSED_CHANNEL_FOOTER = "The applicant or reviewers can reopen this channel. Reviewers can delete it.";

function response(embed: ReturnType<typeof buildInfoEmbed>, edit: true): ReturnType<typeof feedbackEdit>;
function response(embed: ReturnType<typeof buildInfoEmbed>, edit?: false): ReturnType<typeof feedbackReply>;
function response(embed: ReturnType<typeof buildInfoEmbed>, edit = false) {
  return edit ? feedbackEdit({ cards: [embed] }) : feedbackReply({ cards: [embed] });
}

function buttonResponse(embed: ReturnType<typeof buildInfoEmbed>, ephemeral = true) {
  return feedbackReply({ cards: [embed], flags: ephemeral ? MessageFlags.Ephemeral : 0 }, "context");
}

export async function handleApplicationLifecycleCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  action: ApplicationLifecycleOperationAction,
  refreshUndecided?: ApplicationUndecidedRefresher,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(buildApplicationV2Card(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), [], { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveApplicationTarget(await applicationRepository.listOperationalApplicationTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("application") ?? undefined);
  if (resolution.kind !== "resolved") {
    const [title, description] = applicationTargetResolutionError(resolution.kind);
    await interaction.editReply(response(buildNotFoundEmbed(title, description), true));
    return;
  }
  const channel = await resolveOperationalApplicationChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(response(buildNotFoundEmbed("Application Channel Unavailable", "The retained application channel is no longer available."), true)); return; }
  const result = await runApplicationLifecycleOperation({
    action, guild: interaction.guild, guildId: interaction.guildId, applicationId: resolution.target.applicationId,
    actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, channel, applicationRepository,
    presentation: createApplicationCommandLifecyclePresentation(channel, applicationRepository, refreshUndecided ? (application, open) => refreshUndecided(channel, application, open) : undefined),
  });
  if (result.kind === "error") {
    const description = result.title === "Reviewer Role Required" ? `Only members with ${formatRole(resolution.target.reviewerRoleId)} can perform this action.` : result.description;
    await interaction.editReply(response(buildNotFoundEmbed(result.title, description), true));
    return;
  }
  if (result.warnings?.length) await interaction.followUp(buttonResponse(buildNotFoundEmbed("Application Role Update Incomplete", applicationRoleWarnings(result.warnings).trim())));
  const channelMention = `<#${channel.id}>`;
  if (result.kind === "closed") {
    await interaction.editReply(response(buildSuccessEmbed(result.repaired ? "Application Already Closed" : "Application Closed", result.repaired ? `${channelMention} was already closed. Its conversation permissions and controls were repaired.` : action === "cancel" ? `${channelMention} was closed. The application remains waiting for in-game membership.` : result.retainedState === "open" ? `${channelMention} was closed. The application remains undecided.` : `${channelMention} was closed. The ${result.retainedState} decision was retained.`), true));
    return;
  }
  await interaction.editReply(response(buildSuccessEmbed(result.repaired ? "Application Already Open" : "Application Reopened", result.repaired ? `${channelMention} was already open. Its conversation permissions and controls were repaired.` : `${channelMention} was reopened. The ${result.retainedState} state was retained.`), true));
}

export async function handleApplicationAcceptVerifyCommand(
  interaction: ChatInputCommandInteraction, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository,
  albionClient: AlbionClient, verification: boolean, regearObserver?: RegearCharacterObserver,
): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(buildApplicationV2Card(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), [], { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveApplicationTarget(await applicationRepository.listOperationalApplicationTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("application") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = applicationTargetResolutionError(resolution.kind); await interaction.editReply(response(buildNotFoundEmbed(title, description), true)); return; }
  const channel = await resolveOperationalApplicationChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(response(buildNotFoundEmbed("Application Channel Unavailable", "The retained application channel is no longer available."), true)); return; }
  let retireControls: (() => Promise<void>) | undefined;
  const result = await acceptOrVerifyApplication({
    verification, guild: interaction.guild, guildId: interaction.guildId, channelId: channel.id, applicationId: resolution.target.applicationId,
    actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, membershipRepository, albionClient, regearObserver,
    presentation: {
      retireUndecidedControls: async () => { retireControls = () => retireApplicationDecisionControls(channel, applicationRepository, resolution.target.applicationId); },
      retainWaitingControls: async () => { await retainWaitingApplicationControls(channel, applicationRepository, resolution.target.applicationId); },
      renderWaiting: async ({ group, membershipLabel, verification: verifying, warnings }) => {
        const label = membershipLabel && group ? formatMemberGroupLabel({ groupName: membershipLabel, albionServer: group.albionServer }) : group ? formatMemberGroupLabel(group) : "the configured member group";
        const message = await channel.send(buildApplicationV2Card(withControlFooter(buildInfoEmbed("Waiting For In-Game Membership", `Application accepted. Final registration is waiting for this character to appear in ${label}.\n\nAfter the character has joined in game, a reviewer can click Verify Membership.${applicationRoleWarnings(warnings)}`), WAITING_MEMBERSHIP_FOOTER), verifying ? [] : [buildWaitingButtons(resolution.target.applicationId)]));
        await retireControls?.(); return verifying ? undefined : message.id;
      },
      renderAccepted: async ({ application, group, player, reviewerDiscordUserId, warnings, pendingRegearNotice }) => {
        const registrationDescription = `${formatCharacterUserMentionPair(player.name, resolution.target.applicantDiscordUserId)} was registered${group ? ` and added to ${formatMemberGroupLabel(group)}` : ""}.${pendingRegearNotice}${formatWarnings(warnings)}`;
        const message = await channel.send(buildApplicationV2Card(withControlFooter(buildSuccessEmbed("Application Accepted", formatAcceptedApplicationDescription(reviewerDiscordUserId, application.acceptanceMessage, registrationDescription)), OUTCOME_CLOSE_FOOTER), [buildCloseButton(resolution.target.applicationId)]));
        if (retireControls) await retireControls(); else await retireApplicationDecisionControls(channel, applicationRepository, resolution.target.applicationId); return message.id;
      },
    },
  });
  if (result.kind === "error") { const description = result.title === "Reviewer Role Required" ? `Only members with ${formatRole(resolution.target.reviewerRoleId)} can perform this action.` : result.description; await interaction.editReply(response(buildNotFoundEmbed(result.title, description), true)); return; }
  const channelMention = `<#${channel.id}>`;
  await interaction.editReply(response(buildSuccessEmbed(result.kind === "accepted" ? "Application Accepted" : "Waiting For In-Game Membership", result.kind === "accepted" ? `The application in ${channelMention} was accepted.` : `${channelMention} remains open while the selected character is waiting for in-game membership.`), true));
}

export async function handleApplicationRejectCommand(interaction: ChatInputCommandInteraction, applicationRepository: ApplicationRepository): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(buildApplicationV2Card(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), [], { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveApplicationTarget(await applicationRepository.listOperationalApplicationTargets(interaction.guildId), interaction.channelId ?? undefined, interaction.options.getString("application") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = applicationTargetResolutionError(resolution.kind); await interaction.editReply(response(buildNotFoundEmbed(title, description), true)); return; }
  const channel = await resolveOperationalApplicationChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(response(buildNotFoundEmbed("Application Channel Unavailable", "The retained application channel is no longer available."), true)); return; }
  let retireControls: (() => Promise<void>) | undefined;
  const result = await rejectApplication({ guild: interaction.guild, guildId: interaction.guildId, channelId: channel.id, applicationId: resolution.target.applicationId, actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, presentation: {
    retireUndecidedControls: async () => { retireControls = () => retireApplicationDecisionControls(channel, applicationRepository, resolution.target.applicationId); },
    renderRejected: async ({ application, reviewerDiscordUserId, warnings }) => { const message = await channel.send(buildApplicationV2Card(withControlFooter(buildNotFoundEmbed("Application Rejected", formatRejectedApplicationDescription(reviewerDiscordUserId, application.rejectionMessage) + applicationRoleWarnings(warnings)), OUTCOME_CLOSE_FOOTER), [buildCloseButton(resolution.target.applicationId)])); await retireControls?.(); return message.id; },
  }});
  if (result.kind === "error") { const description = result.title === "Reviewer Role Required" ? `Only members with ${formatRole(resolution.target.reviewerRoleId)} can perform this action.` : result.description; await interaction.editReply(response(buildNotFoundEmbed(result.title, description), true)); return; }
  await interaction.editReply(response(buildNotFoundEmbed("Application Rejected", `The application in <#${channel.id}> was rejected.`), true));
}

export async function handleApplicationDeleteCommand(interaction: ChatInputCommandInteraction, applicationRepository: ApplicationRepository): Promise<void> {
  if (!interaction.inCachedGuild()) { await interaction.reply(buildApplicationV2Card(buildNotFoundEmbed("Server Only", "This command can only be used in a Discord server."), [], { ephemeral: true })); return; }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const resolution = resolveApplicationTarget(await applicationRepository.listOperationalApplicationTargets(interaction.guildId, true), interaction.channelId ?? undefined, interaction.options.getString("application") ?? undefined);
  if (resolution.kind !== "resolved") { const [title, description] = applicationTargetResolutionError(resolution.kind); await interaction.editReply(response(buildNotFoundEmbed(title, description), true)); return; }
  const channel = await resolveOperationalApplicationChannel(interaction.guild, resolution.target);
  if (!channel) { await interaction.editReply(response(buildNotFoundEmbed("Application Channel Unavailable", "The retained application channel is no longer available."), true)); return; }
  const open = await applicationRepository.getOpenApplication(interaction.guildId, resolution.target.applicationId);
  const application = open ? await applicationRepository.getApplicationClass(interaction.guildId, open.applicationClassId) : undefined;
  const roles = new Set((interaction.member as GuildMember).roles.cache.keys());
  if (!open || !application) { await interaction.editReply(response(buildNotFoundEmbed("Application Not Found", "That application is no longer available."), true)); return; }
  if (!roles.has(application.reviewerRoleId)) { await interaction.editReply(response(buildNotFoundEmbed("Reviewer Role Required", `Only members with ${formatRole(application.reviewerRoleId)} can perform this action.`), true)); return; }
  if (open.channelStatus !== "closed") { await interaction.editReply(response(buildNotFoundEmbed("Close Channel First", "This application channel must be closed before it can be deleted."), true)); return; }
  const result = await deleteApplicationChannel({ guild: interaction.guild, guildId: interaction.guildId, applicationId: resolution.target.applicationId, actor: { userId: interaction.user.id, roleIds: roles }, applicationRepository, channel });
  if (result.kind === "error") { await interaction.editReply(response(buildNotFoundEmbed(result.title, result.title === "Reviewer Role Required" ? result.description.replace("use this control.", "perform this action.") : result.description), true)); return; }
  await interaction.editReply(response(buildSuccessEmbed("Application Channel Deleted", `${result.channelName} was deleted. The retained application record and decision were not deleted.${applicationRoleWarnings(result.warnings ?? [])}`), true)).catch(() => undefined);
}

export type ApplicationButtonOperation = "accept" | "reject" | "withdraw" | "close" | "cancel" | "reopen" | "delete" | "verify";

/** Handles the operational application controls; character-search controls stay with the intake adapter. */
export async function handleApplicationButtonOperation(
  interaction: ButtonInteraction<"cached">,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient,
  applicationId: string,
  action: ApplicationButtonOperation,
  regearObserver?: RegearCharacterObserver,
  refreshUndecided?: ApplicationUndecidedRefresher,
): Promise<void> {
  await interaction.deferUpdate();
  return withApplicationOperationLock(interaction.guildId, applicationId, async () => {
  if (action === "accept" || action === "verify") {
    await handleAccept(interaction, applicationRepository, membershipRepository, albionClient, applicationId, action === "verify", regearObserver);
    return;
  }
  if (action === "reject") return handleReject(interaction, applicationRepository, applicationId);
  if (action === "close") return handleClose(interaction, applicationRepository, applicationId);
  if (action === "cancel") return handleCancel(interaction, applicationRepository, applicationId);
  if (action === "withdraw") return handleWithdraw(interaction, applicationRepository, applicationId);
  if (action === "reopen") return handleReopen(interaction, applicationRepository, applicationId, refreshUndecided);
  return handleDelete(interaction, applicationRepository, applicationId);
  });
}

async function handleAccept(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, membershipRepository: MembershipRepository, albionClient: AlbionClient, applicationId: string, verification = false, regearObserver?: RegearCharacterObserver): Promise<void> {
  const context = await requireReviewerContext(interaction, applicationRepository, applicationId);
  if (!context) return;
  const expectedStatus = verification ? "awaiting_ingame_membership" : "open";
  if (context.openApplication.channelStatus !== "open") {
    await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Closed", "Reopen the application before using decision controls.")));
    return;
  }
  if (context.openApplication.status !== expectedStatus) {
    await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Already Decided", "That application can no longer be accepted.")));
    return;
  }
  if (!await requireCanonicalApplicationControlSource(interaction, applicationRepository, context.application, context.openApplication, expectedStatus)) return;
  if (context.openApplication.characterResolutionState !== "selected" || !context.openApplication.selectedAlbionCharacterId) {
    await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Character Not Resolved", "Approval is blocked until the applicant's intended character is verified and selected.")));
    return;
  }
  const result = await acceptOrVerifyApplication({
    verification, guild: interaction.guild, guildId: interaction.guildId, channelId: interaction.channelId, applicationId,
    actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, membershipRepository, albionClient, regearObserver,
    presentation: {
      retireUndecidedControls: () => retireUndecidedControls(context.channel, interaction, context.openApplication),
      retainWaitingControls: async () => { await rerenderApplicationMessage(interaction.message, buildApplicationControlReplacementEmbed(context.application, { ...context.openApplication, status: "awaiting_ingame_membership" }), [buildWaitingButtons(applicationId)]).catch(() => undefined); },
      renderWaiting: async ({ group, membershipLabel, verification: verifying, warnings }) => {
        const label = membershipLabel && group ? formatMemberGroupLabel({ groupName: membershipLabel, albionServer: group.albionServer }) : group ? formatMemberGroupLabel(group) : "the configured member group";
        const message = await interaction.followUp(buildApplicationV2Card(withControlFooter(buildInfoEmbed("Waiting For In-Game Membership", `Application accepted. Final registration is waiting for this character to appear in ${label}.\n\nAfter the character has joined in game, a reviewer can click Verify Membership.${applicationRoleWarnings(warnings)}`), WAITING_MEMBERSHIP_FOOTER), verifying ? [] : [buildWaitingButtons(applicationId)]));
        return verifying ? undefined : message.id;
      },
      renderAccepted: async ({ application, group, player, reviewerDiscordUserId, warnings, pendingRegearNotice }) => {
        if (verification) await rerenderApplicationMessage(interaction.message, buildApplicationControlReplacementEmbed(context.application, context.openApplication), []).catch(() => undefined);
        const registrationDescription = `${formatCharacterUserMentionPair(player.name, context.openApplication.applicantDiscordUserId)} was registered${group ? ` and added to ${formatMemberGroupLabel(group)}` : ""}.${pendingRegearNotice}${formatWarnings(warnings)}`;
        const message = await interaction.followUp(buildApplicationV2Card(withControlFooter(buildSuccessEmbed("Application Accepted", formatAcceptedApplicationDescription(reviewerDiscordUserId, application.acceptanceMessage, registrationDescription)), OUTCOME_CLOSE_FOOTER), [buildCloseButton(applicationId)]));
        return message.id;
      },
    },
  });
  if (result.kind === "error") await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(result.title, result.description)));
}

async function handleReject(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string): Promise<void> {
  const context = await requireReviewerContext(interaction, applicationRepository, applicationId);
  if (!context) return;
  const { application, openApplication } = context;
  if (openApplication.channelStatus !== "open") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Closed", "Reopen the application before using decision controls."))); return; }
  if (openApplication.status !== "open") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Already Decided", "That application can no longer be rejected."))); return; }
  if (!await requireCanonicalApplicationControlSource(interaction, applicationRepository, application, openApplication, "open")) return;
  const result = await rejectApplication({
    guild: interaction.guild, guildId: interaction.guildId, channelId: interaction.channelId, applicationId,
    actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository,
    presentation: {
      retireUndecidedControls: () => retireUndecidedControls(context.channel, interaction, openApplication),
      renderRejected: async ({ application: freshApplication, reviewerDiscordUserId, warnings }) => {
        const message = await interaction.followUp(buildApplicationV2Card(withControlFooter(buildNotFoundEmbed("Application Rejected", formatRejectedApplicationDescription(reviewerDiscordUserId, freshApplication.rejectionMessage) + applicationRoleWarnings(warnings)), OUTCOME_CLOSE_FOOTER), [buildCloseButton(applicationId)]));
        return message.id;
      },
    },
  });
  if (result.kind === "error") await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(result.title, result.description)));
}

async function handleClose(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string): Promise<void> {
  const context = await requireApplicationContext(interaction, applicationRepository, applicationId);
  if (!context) return;
  if (!isApplicantOrReviewer(interaction.member as GuildMember, context.openApplication.applicantDiscordUserId, interaction.user.id, context.application)) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Access Required", "Only the applicant or a configured reviewer can close this channel."))); return; }
  const status = context.openApplication.status;
  if (status === "open" && !isReviewer(interaction.member as GuildMember, context.application)) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Reviewer Role Required", `Only members with ${formatRole(context.application.reviewerRoleId)} can use this control.`))); return; }
  if (status === "awaiting_ingame_membership") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Use Cancel", "Use Cancel to close an application waiting for in-game membership."))); return; }
  if (!await requireCanonicalApplicationControlSource(interaction, applicationRepository, context.application, context.openApplication, status)) return;
  await runButtonLifecycleOperation(interaction, applicationRepository, applicationId, "close");
}

async function handleCancel(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string): Promise<void> {
  const context = await requireReviewerContext(interaction, applicationRepository, applicationId);
  if (!context) return;
  if (context.openApplication.status !== "awaiting_ingame_membership") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Cancellation Unavailable", "Only an open application waiting for in-game membership can be cancelled."))); return; }
  if (!await requireCanonicalApplicationControlSource(interaction, applicationRepository, context.application, context.openApplication, "awaiting_ingame_membership")) return;
  await runButtonLifecycleOperation(interaction, applicationRepository, applicationId, "cancel");
}

async function handleWithdraw(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string): Promise<void> {
  const context = await requireApplicationContext(interaction, applicationRepository, applicationId);
  if (!context) return;
  if (context.application.archivedAt) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Target Removed", "This application is retained as history because its target member group was removed."))); return; }
  if (interaction.user.id !== context.openApplication.applicantDiscordUserId) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Applicant Required", "Only the applicant can withdraw this application."))); return; }
  if (context.openApplication.channelStatus !== "open") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Closed", "Reopen the application before withdrawing."))); return; }
  if (context.openApplication.status !== "open") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Already Decided", "This application can no longer be withdrawn."))); return; }
  if (!await requireCanonicalApplicationControlSource(interaction, applicationRepository, context.application, context.openApplication, "open")) return;
  const result = await withdrawApplication({ guild: interaction.guild, guildId: interaction.guildId, applicationId, applicantDiscordUserId: interaction.user.id, application: context.application, applicationRepository });
  if (result.kind === "error") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(result.title, result.description))); return; }
  const reply = await interaction.followUp(buildApplicationV2Card(withControlFooter(buildInfoEmbed("Application Withdrawn", `${interaction.user} withdrew this application.${applicationRoleWarnings(result.warnings)}`), OUTCOME_CLOSE_FOOTER), [buildCloseButton(applicationId)]));
  await applicationRepository.setApplicationControlMessageId(interaction.guildId, applicationId, reply.id);
  await retireUndecidedControls(context.channel, interaction, result.application);
}

async function handleReopen(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string, refreshUndecided?: ApplicationUndecidedRefresher): Promise<void> {
  const context = await requireApplicationContext(interaction, applicationRepository, applicationId); if (!context) return;
  if (context.application.archivedAt) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Target Removed", "This historical application channel cannot be reopened because its target member group was removed."))); return; }
  if (!isApplicantOrReviewer(interaction.member as GuildMember, context.openApplication.applicantDiscordUserId, interaction.user.id, context.application)) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Access Required", "Only the applicant or a configured reviewer can reopen this channel."))); return; }
  if (!isClosedControlSource(interaction, context.application)) { await replyStaleApplicationControl(interaction); return; }
  if (!context.openApplication.closedControlMessageId) await applicationRepository.setClosedControlMessageId(interaction.guildId, applicationId, interaction.message.id);
  else if (context.openApplication.closedControlMessageId !== interaction.message.id) { await replyStaleApplicationControl(interaction); return; }
  await runButtonLifecycleOperation(interaction, applicationRepository, applicationId, "reopen", refreshUndecided);
}

async function handleDelete(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string): Promise<void> {
  const context = await requireReviewerContext(interaction, applicationRepository, applicationId, true); if (!context) return;
  if (context.openApplication.channelStatus !== "closed") { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Close Channel First", "This application channel must be closed before it can be deleted."))); return; }
  if (!isClosedControlSource(interaction, context.application)) { await replyStaleApplicationControl(interaction); return; }
  if (!context.openApplication.closedControlMessageId) await applicationRepository.setClosedControlMessageId(interaction.guildId, applicationId, interaction.message.id);
  else if (context.openApplication.closedControlMessageId !== interaction.message.id) { await replyStaleApplicationControl(interaction); return; }
  const result = await deleteApplicationChannel({ guild: interaction.guild, guildId: interaction.guildId, applicationId, actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository, channel: context.channel });
  if (result.kind === "error") await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(result.title, result.description)));
  else if (result.warnings?.length) await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Role Update Incomplete", applicationRoleWarnings(result.warnings).trim()))).catch(() => undefined);
}

async function runButtonLifecycleOperation(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string, action: ApplicationLifecycleOperationAction, refreshUndecided?: ApplicationUndecidedRefresher): Promise<void> {
  const result = await runApplicationLifecycleOperation({
    action, guild: interaction.guild, guildId: interaction.guildId, applicationId,
    actor: { userId: interaction.user.id, roleIds: new Set((interaction.member as GuildMember).roles.cache.keys()) }, applicationRepository,
    presentation: {
      renderClosed: async (id, description) => {
        const message = await interaction.followUp(buildApplicationV2Card(withControlFooter(buildInfoEmbed("Application Closed", description), CLOSED_CHANNEL_FOOTER), [buildClosedChannelButtons(id)]));
        const open = await applicationRepository.getOpenApplication(interaction.guildId, id);
        const channel = interaction.guild.channels.cache.get(interaction.channelId);
        if (channel?.type === ChannelType.GuildText) {
          await retireApplicationMessage(channel, interaction.message, open);
          if (open?.characterResolutionMessageId !== interaction.message.id) await retireStoredApplicationControl(channel, open?.characterResolutionMessageId, open);
        } else await rerenderApplicationMessage(interaction.message, undefined, []);
        return message.id;
      },
      retireClosedCandidate: async (messageId) => { const channel = interaction.guild.channels.cache.get(interaction.channelId); if (channel?.type === ChannelType.GuildText) await retireStoredApplicationControl(channel, messageId); },
      renderOpen: async (application, openApplication, id, description) => {
        const channel = interaction.guild.channels.cache.get(openApplication.ticketChannelId!) ?? await interaction.guild.channels.fetch(openApplication.ticketChannelId!).catch(() => undefined);
        if (channel?.type !== ChannelType.GuildText) throw new Error("Application channel became unavailable during lifecycle presentation.");
        await renderReopenedApplication(channel, applicationRepository, application, openApplication, description, {
          refreshUndecided: refreshUndecided ? (configured, current) => refreshUndecided(channel, configured, current) : undefined,
          send: (payload) => interaction.followUp(payload),
        });
        await rerenderApplicationMessage(interaction.message, undefined, []);
      },
    },
  });
  if (result.kind === "error") await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(result.title, result.description)));
  else if (result.warnings?.length) await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Application Role Update Incomplete", applicationRoleWarnings(result.warnings).trim()))).catch(() => undefined);
}

async function requireReviewerContext(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string, allowArchived = false): Promise<ResolvedApplicationButtonContext | undefined> {
  const context = await requireApplicationContext(interaction, applicationRepository, applicationId, allowArchived);
  if (!context) return undefined;
  if (!isReviewer(interaction.member as GuildMember, context.application)) {
    await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed("Reviewer Role Required", `Only members with ${formatRole(context.application.reviewerRoleId)} can use this control.`)));
    return undefined;
  }
  return context;
}

async function requireApplicationContext(interaction: ButtonInteraction<"cached">, applicationRepository: ApplicationRepository, applicationId: string, allowArchived = false): Promise<ResolvedApplicationButtonContext | undefined> {
  const context = await resolveApplicationButtonContext(interaction, applicationRepository, applicationId, allowArchived);
  if ("kind" in context) { await replyAfterAcknowledgement(interaction, buttonResponse(buildNotFoundEmbed(context.title, context.description))); return undefined; }
  return context;
}

async function replyAfterAcknowledgement(interaction: ButtonInteraction<"cached">, payload: InteractionReplyOptions): Promise<void> {
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

/** Shared operational target/channel resolution for slash-command adapters. */
export async function resolveOperationalApplicationChannel(
  guild: Guild,
  target: ApplicationTarget
): Promise<TextChannel | undefined> {
  if (!target.ticketChannelId) return undefined;
  const cached = guild.channels.cache.get(target.ticketChannelId);
  const channel = cached ?? await guild.channels.fetch(target.ticketChannelId).catch(() => undefined);
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

export function applicationTargetResolutionError(kind: "required" | "mismatch" | "not_found"): [string, string] {
  if (kind === "required") return ["Application Target Required", "Run this command in an application channel or choose an application."];
  if (kind === "mismatch") return ["Application Target Mismatch", "The selected application does not match this channel. Omit the option or run the command outside an application channel."];
  return ["Application Not Found", "Choose an active application."];
}

export type ResolvedApplicationButtonContext = {
  application: ApplicationClass;
  openApplication: OpenApplication;
  channel: TextChannel;
};

/** Resolves the canonical application and checks the button's ticket channel. */
export async function resolveApplicationButtonContext(
  interaction: ButtonInteraction<"cached">,
  applicationRepository: ApplicationRepository,
  applicationId: string,
  allowArchived = false
): Promise<ResolvedApplicationButtonContext | { kind: "error"; title: string; description: string }> {
  const openApplication = await applicationRepository.getOpenApplication(interaction.guildId, applicationId);
  if (!openApplication) return { kind: "error", title: "Application Not Found", description: "That application ticket is no longer tracked." };
  if (openApplication.ticketChannelId !== interaction.channelId) return { kind: "error", title: "Wrong Channel", description: "That control can only be used in the matching application ticket." };
  const application = await applicationRepository.getApplicationClass(interaction.guildId, openApplication.applicationClassId);
  if (!application || (!allowArchived && application.archivedAt)) {
    return {
      kind: "error",
      title: application?.archivedAt ? "Application Target Removed" : "Application Class Missing",
      description: application?.archivedAt
        ? "This application is retained as history because its target member group was removed."
        : "This application class no longer exists."
    };
  }
  const channel = interaction.guild.channels.cache.get(interaction.channelId);
  if (channel?.type !== ChannelType.GuildText) return { kind: "error", title: "Wrong Channel", description: "Application controls require the matching text channel." };
  return { application, openApplication, channel };
}

export function isReviewer(member: GuildMember, application: ApplicationClass): boolean {
  return member.roles.cache.has(application.reviewerRoleId);
}

export function isApplicantOrReviewer(member: GuildMember, applicantId: string, actorId: string, application: ApplicationClass): boolean {
  return actorId === applicantId || isReviewer(member, application);
}
