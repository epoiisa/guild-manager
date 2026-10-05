import { reconcileApplicationActiveRole } from "./activeRoleService.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import type { Guild } from "discord.js";
import type { ApplicationClass, createApplicationRepository } from "../../db/applicationRepository.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;

export type ApplicationRejectInput = {
  guild: Guild;
  guildId: string;
  channelId?: string;
  applicationId: string;
  actor: { userId: string; roleIds: ReadonlySet<string> };
  applicationRepository: ApplicationRepository;
  presentation: {
    retireUndecidedControls(): Promise<void>;
    renderRejected(input: { application: ApplicationClass; reviewerDiscordUserId: string; warnings: MemberUpdateWarning[] }): Promise<string | undefined>;
  };
};

export type ApplicationRejectResult = { kind: "rejected" } | { kind: "error"; title: string; description: string };

export async function rejectApplication(input: ApplicationRejectInput): Promise<ApplicationRejectResult> {
  return withApplicationOperationLock(input.guildId, input.applicationId, () => rejectApplicationLocked(input));
}

async function rejectApplicationLocked(input: ApplicationRejectInput): Promise<ApplicationRejectResult> {
  const open = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  const application = open ? await input.applicationRepository.getApplicationClass(input.guildId, open.applicationClassId) : undefined;
  if (!open || !application) return error("Application Not Found", "That application is no longer available.");
  if (application.archivedAt) return error("Application Target Removed", "This application is retained as history because its target member group was removed.");
  if (input.channelId && open.ticketChannelId !== input.channelId) return error("Wrong Channel", "That control can only be used in the matching application ticket.");
  if (!input.actor.roleIds.has(application.reviewerRoleId)) return error("Reviewer Role Required", `Only members with <@&${application.reviewerRoleId}> can use this control.`);
  if (open.channelStatus !== "open") return error("Application Closed", "Reopen the application before using decision controls.");
  if (open.status !== "open") return error("Application Already Decided", "That application can no longer be rejected.");
  if (open.characterResolutionState !== "selected" || !open.selectedAlbionCharacterId) return error("Character Selection Required", "Select a valid Albion Online character before accepting or rejecting this application.");
  if (open.selectedCharacterOwnerDiscordUserId && open.selectedCharacterOwnerDiscordUserId !== open.applicantDiscordUserId) return error("Character Already Registered", "The selected Albion Online character is now registered to another Discord user. Resolve the ownership conflict before reviewing this application.");
  const rejected = await input.applicationRepository.markApplicationRejected(input.guildId, input.applicationId, input.actor.userId);
  if (!rejected) return error("Application Already Decided", "That application can no longer be rejected.");
  await input.presentation.retireUndecidedControls();
  const warnings = await reconcileApplicationActiveRole(input.guild, input.applicationRepository, application, open.applicantDiscordUserId);
  const messageId = await input.presentation.renderRejected({
    application,
    reviewerDiscordUserId: rejected.reviewerDiscordUserId ?? input.actor.userId,
    warnings
  });
  if (messageId) await input.applicationRepository.setApplicationControlMessageId(input.guildId, input.applicationId, messageId);
  return { kind: "rejected" };
}

function error(title: string, description: string): ApplicationRejectResult { return { kind: "error", title, description }; }
