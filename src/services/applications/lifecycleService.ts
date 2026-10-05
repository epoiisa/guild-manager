import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { ApplicationClass, ApplicationStatus, OpenApplication, createApplicationRepository } from "../../db/applicationRepository.js";
import { setTicketConversationSendPermission } from "../../commands/ticketChannelPermissions.js";
import { reconcileApplicationActiveRole, applicationRoleWarnings } from "./activeRoleService.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;

export type ApplicationLifecycleOperationAction = "close" | "cancel" | "reopen";
export type ApplicationLifecyclePresentation = {
  renderClosed(applicationId: string, description: string): Promise<string | undefined>;
  renderOpen(application: ApplicationClass, openApplication: OpenApplication, applicationId: string, description: string): Promise<void>;
  retireClosedCandidate(messageId: string): Promise<void>;
};
export type ApplicationLifecycleOperationInput = {
  action: ApplicationLifecycleOperationAction;
  guild: Guild;
  guildId: string;
  applicationId: string;
  actor: { userId: string; roleIds: ReadonlySet<string> };
  channel?: TextChannel;
  applicationRepository: ApplicationRepository;
  presentation: ApplicationLifecyclePresentation;
};
export type ApplicationLifecycleOperationResult =
  | { kind: "closed"; repaired: boolean; retainedState: ApplicationStatus; warnings?: MemberUpdateWarning[] }
  | { kind: "reopened"; repaired: boolean; retainedState: ApplicationStatus; warnings?: MemberUpdateWarning[] }
  | { kind: "error"; title: string; description: string };

export async function runApplicationLifecycleOperation(input: ApplicationLifecycleOperationInput): Promise<ApplicationLifecycleOperationResult> {
  return withApplicationOperationLock(input.guildId, input.applicationId, () => runApplicationLifecycleOperationLocked(input));
}

async function runApplicationLifecycleOperationLocked(input: ApplicationLifecycleOperationInput): Promise<ApplicationLifecycleOperationResult> {
  const openApplication = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  if (!openApplication) return { kind: "error", title: "Application Not Found", description: "Choose an active application." };
  if (input.action === "reopen" && openApplication.accessRevokedAt) return { kind: "error", title: "Application Access Revoked", description: "This historical application channel cannot be reopened after the applicant was kicked." };
  const application = await input.applicationRepository.getApplicationClass(input.guildId, openApplication.applicationClassId);
  if (!application) return { kind: "error", title: "Application Class Missing", description: "This application class no longer exists." };
  if (application.archivedAt && input.action === "reopen") return { kind: "error", title: "Application Target Removed", description: "This historical application channel cannot be reopened because its target member group was removed." };
  if (!openApplication.ticketChannelId) return { kind: "error", title: "Application Channel Unavailable", description: "The retained application channel is no longer available." };
  const channel = input.channel ?? input.guild.channels.cache.get(openApplication.ticketChannelId) ?? await input.guild.channels.fetch(openApplication.ticketChannelId).catch(() => undefined);
  if (channel?.type !== ChannelType.GuildText) return { kind: "error", title: "Application Channel Unavailable", description: "The retained application channel is no longer available." };
  const reviewer = input.actor.roleIds.has(application.reviewerRoleId);
  const applicant = input.actor.userId === openApplication.applicantDiscordUserId;
  const reviewerOnly = input.action === "cancel" || (input.action === "close" && openApplication.status === "open");
  if ((reviewerOnly && !reviewer) || (!reviewerOnly && !reviewer && !applicant)) return { kind: "error", title: reviewerOnly ? "Reviewer Role Required" : "Application Access Required", description: reviewerOnly ? `Only members with <@&${application.reviewerRoleId}> can use this control.` : `Only the applicant or a configured reviewer can ${input.action} this channel.` };
  if (input.action === "cancel" && openApplication.status !== "awaiting_ingame_membership") return { kind: "error", title: "Cancellation Unavailable", description: "Only an open application waiting for in-game membership can be cancelled." };
  if (input.action === "close" && !application.archivedAt && openApplication.status === "awaiting_ingame_membership") return { kind: "error", title: "Use Cancel", description: "Use Cancel to close an application waiting for in-game membership." };
  if (input.action === "reopen") {
    if (openApplication.channelStatus === "open") {
      await setTicketConversationSendPermission(channel, openApplication.applicantDiscordUserId, application.reviewerRoleId, true);
      const warnings = await syncApplicationRole(input, application, openApplication);
      await input.presentation.renderOpen(application, openApplication, input.applicationId, "This application channel is open." + applicationRoleWarnings(warnings));
      await input.applicationRepository.setClosedControlMessageId(input.guildId, input.applicationId, undefined);
      return { kind: "reopened", repaired: true, retainedState: openApplication.status, ...(warnings.length ? { warnings } : {}) };
    }
    if (openApplication.channelStatus !== "closed") return { kind: "error", title: "Channel Not Closed", description: "This application channel cannot be reopened." };
    await setTicketConversationSendPermission(channel, openApplication.applicantDiscordUserId, application.reviewerRoleId, true);
    const reopened = await input.applicationRepository.markApplicationReopened(input.guildId, input.applicationId, input.actor.userId) ?? await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
    if (!reopened || reopened.channelStatus !== "open") return { kind: "error", title: "Channel Not Closed", description: "This application channel cannot be reopened." };
    const warnings = await syncApplicationRole(input, application, reopened);
    await input.presentation.renderOpen(application, reopened, input.applicationId, `Reopened by <@${input.actor.userId}>.` + applicationRoleWarnings(warnings));
    await input.applicationRepository.setClosedControlMessageId(input.guildId, input.applicationId, undefined);
    return { kind: "reopened", repaired: false, retainedState: reopened.status, ...(warnings.length ? { warnings } : {}) };
  }
  if (openApplication.channelStatus === "closed") {
    await setTicketConversationSendPermission(channel, openApplication.applicantDiscordUserId, application.reviewerRoleId, false);
    const warnings = await syncApplicationRole(input, application, openApplication);
    await renderAndClaimClosedApplicationControl(input, openApplication, "This application channel is closed." + applicationRoleWarnings(warnings));
    return { kind: "closed", repaired: true, retainedState: openApplication.status, ...(warnings.length ? { warnings } : {}) };
  }
  if (openApplication.channelStatus !== "open") return { kind: "error", title: input.action === "cancel" ? "Cancellation Unavailable" : "Channel Not Open", description: input.action === "cancel" ? "Only an open application waiting for in-game membership can be cancelled." : "This application channel is not open." };
  const closed = await input.applicationRepository.markApplicationClosed(input.guildId, input.applicationId, input.actor.userId);
  if (!closed) return { kind: "error", title: input.action === "cancel" ? "Cancellation Unavailable" : "Channel Not Open", description: input.action === "cancel" ? "Only an open application waiting for in-game membership can be cancelled." : "This application channel is not open." };
  await setTicketConversationSendPermission(channel, openApplication.applicantDiscordUserId, application.reviewerRoleId, false);
  const warnings = await syncApplicationRole(input, application, closed);
  await renderAndClaimClosedApplicationControl(input, closed, `Closed by <@${input.actor.userId}>.` + applicationRoleWarnings(warnings));
  return { kind: "closed", repaired: false, retainedState: closed.status, ...(warnings.length ? { warnings } : {}) };
}

async function syncApplicationRole(
  input: ApplicationLifecycleOperationInput,
  application: ApplicationClass,
  open: OpenApplication,
): Promise<MemberUpdateWarning[]> {
  return reconcileApplicationActiveRole(input.guild, input.applicationRepository, application, open.applicantDiscordUserId);
}

async function renderAndClaimClosedApplicationControl(input: ApplicationLifecycleOperationInput, application: OpenApplication, description: string): Promise<void> {
  const candidateMessageId = await input.presentation.renderClosed(input.applicationId, description);
  if (!candidateMessageId) return;
  const expectedMessageId = application.closedControlMessageId;
  const claimed = await input.applicationRepository.claimClosedControlMessageId(input.guildId, input.applicationId, expectedMessageId, candidateMessageId);
  if (claimed && expectedMessageId && candidateMessageId !== expectedMessageId) await input.presentation.retireClosedCandidate(expectedMessageId);
  else if (!claimed && candidateMessageId !== expectedMessageId) {
    const current = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
    if (current?.closedControlMessageId !== candidateMessageId) await input.presentation.retireClosedCandidate(candidateMessageId);
  }
}
