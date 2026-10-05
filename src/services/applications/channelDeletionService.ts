import type { Guild } from "discord.js";
import type { createApplicationRepository } from "../../db/applicationRepository.js";
import { reconcileApplicationActiveRole } from "./activeRoleService.js";

/** Direct Discord channel deletion must release the same entitlement as bot deletion. */
export async function reconcileDeletedApplicationChannel(
  guild: Guild,
  channelId: string,
  applications: ReturnType<typeof createApplicationRepository>,
) {
  const application = await applications.markApplicationChannelDeleted(guild.id, channelId);
  if (!application) return { application, warnings: [] };
  const configured = await applications.getApplicationClass(guild.id, application.applicationClassId);
  if (!configured) throw new Error("Deleted application class unavailable for role reconciliation");
  const warnings = await reconcileApplicationActiveRole(guild, applications, configured, application.applicantDiscordUserId);
  return { application, warnings };
}
