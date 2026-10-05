import { reconcileApplicationActiveRole } from "./activeRoleService.js";
import type { Guild } from "discord.js";
import type { ApplicationClass, OpenApplication, createApplicationRepository } from "../../db/applicationRepository.js";
import {
  CharacterAlreadyRegisteredError,
  CharacterRecoveryRequiredError,
  CharacterRegistrationLimitError,
  type MemberGroup,
  type createMembershipRepository
} from "../../db/membershipRepository.js";
import { fetchGuildMemberIfPresent } from "../../discord/guildMembers.js";
import { AlbionApiError, type AlbionClient } from "../albion/client.js";
import type { AlbionPlayer } from "../albion/types.js";
import { applyEffectiveNickname, type MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import { reconcileRegisteredCharacterMembership } from "../membership/reconciliation.js";
import { checkPlayerAllianceMembership } from "../membership/allianceMembership.js";
import { checkPlayerGuildMembership } from "../membership/guildMembership.js";
import type { RegearCharacterObserver } from "../regears/service.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export type ApplicationAcceptVerificationPresentation = {
  retireUndecidedControls(): Promise<void>;
  retainWaitingControls(): Promise<void>;
  renderWaiting(input: { application: ApplicationClass; group?: MemberGroup; membershipLabel?: string; verification: boolean; warnings: MemberUpdateWarning[] }): Promise<string | undefined>;
  renderAccepted(input: {
    application: ApplicationClass;
    group?: MemberGroup;
    player: AlbionPlayer;
    reviewerDiscordUserId: string;
    warnings: MemberUpdateWarning[];
    pendingRegearNotice: string;
  }): Promise<string | undefined>;
};

export type ApplicationAcceptVerificationInput = {
  verification: boolean;
  guild: Guild;
  guildId: string;
  channelId?: string;
  applicationId: string;
  actor: { userId: string; roleIds: ReadonlySet<string> };
  applicationRepository: ApplicationRepository;
  membershipRepository: MembershipRepository;
  albionClient: AlbionClient;
  regearObserver?: RegearCharacterObserver;
  presentation: ApplicationAcceptVerificationPresentation;
};

export type ApplicationAcceptVerificationResult =
  | { kind: "accepted" }
  | { kind: "waiting" }
  | { kind: "error"; title: string; description: string };

export async function acceptOrVerifyApplication(
  input: ApplicationAcceptVerificationInput
): Promise<ApplicationAcceptVerificationResult> {
  return withApplicationOperationLock(input.guildId, input.applicationId, () => acceptOrVerifyApplicationLocked(input));
}

async function acceptOrVerifyApplicationLocked(
  input: ApplicationAcceptVerificationInput
): Promise<ApplicationAcceptVerificationResult> {
  const openApplication = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  const application = openApplication
    ? await input.applicationRepository.getApplicationClass(input.guildId, openApplication.applicationClassId)
    : undefined;
  if (!openApplication || !application) {
    return error("Application Not Found", "That application is no longer available.");
  }
  if (application.archivedAt) {
    return error("Application Target Removed", "This application can no longer create membership because its target member group was removed.");
  }
  if (input.channelId && openApplication.ticketChannelId !== input.channelId) {
    return error("Wrong Channel", "That control can only be used in the matching application ticket.");
  }
  if (!input.actor.roleIds.has(application.reviewerRoleId)) {
    return error("Reviewer Role Required", `Only members with <@&${application.reviewerRoleId}> can use this control.`);
  }
  if (openApplication.channelStatus !== "open") {
    return error("Application Closed", "Reopen the application before using decision controls.");
  }
  const expectedStatus = input.verification ? "awaiting_ingame_membership" : "open";
  if (openApplication.status !== expectedStatus) {
    return error("Application Already Decided", "That application can no longer be accepted.");
  }
  if (openApplication.characterResolutionState !== "selected" || !openApplication.selectedAlbionCharacterId) {
    return error("Character Not Resolved", "Approval is blocked until the applicant's intended character is verified and selected.");
  }

  const applicant = await fetchGuildMemberIfPresent(input.guild, openApplication.applicantDiscordUserId);
  if (!applicant) {
    const nextAction = input.verification ? "Cancel" : "Reject";
    const outcome = input.verification ? "completed" : "accepted";
    return error(
      "Applicant Not In Server",
      `This application cannot be ${outcome} because the applicant is no longer in this Discord server. ${nextAction} the application if no further review is needed.`
    );
  }

  let player: AlbionPlayer;
  try {
    player = await input.albionClient.getPlayer(openApplication.albionServer, openApplication.selectedAlbionCharacterId);
  } catch (caught) {
    if (!(caught instanceof AlbionApiError)) throw caught;
    return error(
      "Character Verification Unavailable",
      `Albion Online character details could not be confirmed. Try ${input.verification ? "Verify Membership" : "Accept"} again.`
    );
  }
  if (player.id !== openApplication.selectedAlbionCharacterId || !player.name?.trim()) {
    return error("Character Verification Unavailable", "The Albion Online response did not match the selected character. Retry character verification before accepting this application.");
  }
  const existing = await input.membershipRepository.getRegisteredCharacter(input.guildId, openApplication.albionServer, player.id);
  if (existing && existing.discordUserId !== openApplication.applicantDiscordUserId) {
    return error("Character Already Registered", `${player.name} • <@${existing.discordUserId}> is already registered.`);
  }
  if (await input.membershipRepository.getCharacterRegistrationLifecycle(input.guildId, openApplication.albionServer, player.id)) {
    return error("Officer Recovery Required", "An officer must reconnect this character with `/character register` before this application can be accepted. Application approval cannot recover a registration on hold or abandoned.");
  }
  const group = application.memberGroupId
    ? (await input.membershipRepository.listMemberGroups(input.guildId, application.albionServer))
      .find((candidate) => candidate.memberGroupId === application.memberGroupId)
    : undefined;
  const membershipCheck = await getMembershipFailure(input, group, player);
  if (membershipCheck?.kind === "unavailable") {
    return error(membershipCheck.title, membershipCheck.description);
  }
  if (membershipCheck) {
    const waiting = await input.applicationRepository.markApplicationAwaitingMembership(
      input.guildId, input.applicationId, input.actor.userId, membershipCheck.message, expectedStatus
    );
    if (!waiting) return error("Application Already Decided", "That application can no longer be accepted.");
    if (input.verification) await input.presentation.retainWaitingControls();
    else await input.presentation.retireUndecidedControls();
    const warnings = await reconcileApplicationActiveRole(input.guild, input.applicationRepository, application, openApplication.applicantDiscordUserId);
    const messageId = await input.presentation.renderWaiting({ application, group, membershipLabel: membershipCheck.label, verification: input.verification, warnings });
    if (!input.verification && messageId) {
      await input.applicationRepository.setApplicationControlMessageId(input.guildId, input.applicationId, messageId);
    }
    return { kind: "waiting" };
  }

  let registered;
  try {
    registered = await input.membershipRepository.completeApplicationAcceptance({
      discordGuildId: input.guildId,
      discordUserId: openApplication.applicantDiscordUserId,
      albionServer: openApplication.albionServer,
      player,
      applicationId: input.applicationId,
      reviewerDiscordUserId: input.actor.userId,
      expectedApplicationStatus: expectedStatus,
      memberGroupId: group?.memberGroupId
    });
  } catch (caught) {
    if (caught instanceof CharacterRecoveryRequiredError) {
      return error("Officer Recovery Required", "An officer must reconnect this character with `/character register` before this application can be accepted. Application approval cannot recover a registration on hold or abandoned.");
    }
    if (caught instanceof CharacterRegistrationLimitError) {
      return error(
        "Character Registration Limit Reached",
        `A Discord user can have at most ${caught.limit} registered characters in this server. The applicant must unregister one before approval can continue.`
      );
    }
    if (caught instanceof CharacterAlreadyRegisteredError) {
      const owner = await input.membershipRepository.getRegisteredCharacter(input.guildId, openApplication.albionServer, player.id);
      if (owner) return error("Character Already Registered", `${player.name} • <@${owner.discordUserId}> is already registered.`);
    }
    throw caught;
  }
  if (!registered) return error("Application Already Decided", "That application can no longer be accepted.");
  const warnings = [
    ...await reconcileRegisteredCharacterMembership(
      input.guild,
      input.albionClient,
      input.membershipRepository,
      openApplication.applicantDiscordUserId,
      player,
      openApplication.albionServer
    ),
    ...await applyEffectiveNickname(input.guild, input.membershipRepository, openApplication.applicantDiscordUserId)
  ];
  if (!input.verification) await input.presentation.retireUndecidedControls();
  warnings.push(...await reconcileApplicationActiveRole(input.guild, input.applicationRepository, application, openApplication.applicantDiscordUserId));
  const pendingRegearNotice = input.regearObserver
    ? (await input.regearObserver.observeCharacterRegistration(input.guild, registered.albionServer, registered.albionCharacterId)).hasPendingClaims
      ? `\n${registered.characterName} has pending re-gear requests.`
      : ""
    : "";
  const messageId = await input.presentation.renderAccepted({
    application,
    group,
    player,
    reviewerDiscordUserId: input.actor.userId,
    warnings,
    pendingRegearNotice
  });
  if (messageId) await input.applicationRepository.setApplicationControlMessageId(input.guildId, input.applicationId, messageId);
  return { kind: "accepted" };
}

async function getMembershipFailure(
  input: ApplicationAcceptVerificationInput,
  group: MemberGroup | undefined,
  player: AlbionPlayer
): Promise<{ kind: "not_member"; message: string; label: string } | { kind: "unavailable"; title: string; description: string } | undefined> {
  if (group?.groupType === "guild") {
    const configured = await input.membershipRepository.getConfiguredAlbionGuild(input.guildId, group.memberGroupId, group.albionServer);
    if (configured) {
      const membership = await checkPlayerGuildMembership(
        input.albionClient,
        group.albionServer,
        player,
        configured.albionGuildId
      );
      if (membership.kind === "unavailable") {
        return {
          kind: "unavailable",
          title: "Guild Membership Check Unavailable",
          description: `Guild membership could not be confirmed. Try ${input.verification ? "Verify Membership" : "Accept"} again.`
        };
      }
      if (membership.kind === "not_member") {
        return { kind: "not_member", message: "Character is not in the configured guild.", label: configured.albionGuildName };
      }
    }
  }
  if (group?.groupType === "alliance") {
    const configured = await input.membershipRepository.getConfiguredAlbionAlliance(input.guildId, group.memberGroupId, group.albionServer);
    if (configured) {
      const membership = await checkPlayerAllianceMembership(
        input.albionClient,
        group.albionServer,
        player,
        configured.albionAllianceId
      );
      if (membership.kind === "unavailable") {
        return {
          kind: "unavailable",
          title: "Alliance Membership Check Unavailable",
          description: `Alliance membership could not be confirmed. Try ${input.verification ? "Verify Membership" : "Accept"} again.`
        };
      }
      if (membership.kind === "not_member") {
        return { kind: "not_member", message: "Character is not in the configured alliance.", label: configured.albionAllianceName };
      }
    }
  }
  return undefined;
}

function error(title: string, description: string): ApplicationAcceptVerificationResult {
  return { kind: "error", title, description };
}
