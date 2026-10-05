import { recordLogChange } from "../logFeed/events.js";
import type { Guild } from "discord.js";
import type { ApplicationClass } from "../../db/applicationRepository.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import { reconcileManagedRole, type RoleEntitlements } from "../membership/managedRoleReconciliation.js";

export async function reconcileApplicationActiveRole(
  guild: Guild,
  entitlements: RoleEntitlements,
  application: Pick<ApplicationClass, "activeRoleId">,
  applicantId: string,
): Promise<MemberUpdateWarning[]> {
  if (!application.activeRoleId) return [];
  const result = await reconcileManagedRole(guild, entitlements, applicantId, application.activeRoleId, "Guild Manager application role reconciliation");
  if (result.warnings.length) recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
  return result.warnings;
}

export function applicationRoleWarnings(warnings: readonly MemberUpdateWarning[]): string {
  return warnings.length ? `\n\n${warnings.map(warning => warning.message).join("\n")}\nRun \`/update\` to retry role reconciliation.` : "";
}
