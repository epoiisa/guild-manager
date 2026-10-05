import { reconcileApplicationActiveRole } from "./activeRoleService.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import type { Guild } from "discord.js";
import type { ApplicationClass, OpenApplication, createApplicationRepository } from "../../db/applicationRepository.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;

export type WithdrawApplicationResult =
  | { kind: "withdrawn"; application: OpenApplication; warnings: MemberUpdateWarning[] }
  | { kind: "error"; title: string; description: string };

/**
 * Performs the compare-and-set withdrawal transition under the application
 * lock. Presentation remains with the interaction adapter, while this service
 * owns the durable mutation and the temporary active-role cleanup.
 */
export async function withdrawApplication(input: {
  guild: Guild;
  guildId: string;
  applicationId: string;
  applicantDiscordUserId: string;
  application: ApplicationClass;
  applicationRepository: ApplicationRepository;
}): Promise<WithdrawApplicationResult> {
  return withApplicationOperationLock(input.guildId, input.applicationId, async () => {
    const current = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
    if (!current || current.applicantDiscordUserId !== input.applicantDiscordUserId || current.status !== "open" || current.channelStatus !== "open") {
      return {
        kind: "error",
        title: "Application Already Decided",
        description: "This application can no longer be withdrawn."
      };
    }
    const withdrawn = await input.applicationRepository.markApplicationWithdrawn(input.guildId, input.applicationId);
    if (!withdrawn) {
      return {
        kind: "error",
        title: "Application Already Decided",
        description: "This application can no longer be withdrawn."
      };
    }
    const warnings = await reconcileApplicationActiveRole(input.guild, input.applicationRepository, input.application, current.applicantDiscordUserId);
    return { kind: "withdrawn", application: withdrawn, warnings };
  });
}
