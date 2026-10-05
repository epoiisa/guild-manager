import type { Guild } from "discord.js";
import { fetchGuildMemberIfPresent } from "../../discord/guildMembers.js";
import { recordLogChange } from "../logFeed/events.js";
import { createKeyedSerialQueue } from "../reactionRoles/keyedSerialQueue.js";
import type { DiscordMemberUpdateResult, RoleUpdateOutcome } from "./discordMemberUpdates.js";

export interface RoleEntitlements {
  listQualifiedRoleIdsForUser(guildId: string, userId: string): Promise<string[]>;
  getMemberAccess?(guildId: string, userId: string): Promise<{ blocked: boolean; revokedRoleIds: string[] } | undefined>;
}

const updates = createKeyedSerialQueue();

/** Re-read entitlements and Discord state inside the queue shared by application and membership reconciliation. */
export async function reconcileManagedRole(
  guild: Guild,
  entitlements: RoleEntitlements,
  userId: string,
  roleId: string,
  reason: string,
): Promise<DiscordMemberUpdateResult<RoleUpdateOutcome>> {
  const result: DiscordMemberUpdateResult<RoleUpdateOutcome> = { outcomes: [], warnings: [] };
  await updates.enqueue(`${guild.id}:${userId}:${roleId}`, async () => {
    try {
      const member = await fetchGuildMemberIfPresent(guild, userId);
      if (!member) return;
      const access = await entitlements.getMemberAccess?.(guild.id, userId);
      // Reconnection never rebuilds former authority. A later manual Discord
      // role grant is an explicit new grant and is outside automatic ownership.
      if (access && !access.blocked && access.revokedRoleIds.includes(roleId)) return;
      const required = (await entitlements.listQualifiedRoleIdsForUser(guild.id, userId)).includes(roleId);
      if (required === member.roles.cache.has(roleId)) return;
      const action = required ? "add" : "remove";
      await member.roles[action](roleId, reason);
      const outcome: RoleUpdateOutcome = { kind: "role", action, discordUserId: userId, roleId };
      recordLogChange(guild.id, outcome);
      result.outcomes.push(outcome);
    } catch (error) {
      result.warnings.push({ message: `Role update failed for <@${userId}>: ${error instanceof Error ? error.message : "Discord or role entitlement check unavailable"}` });
    }
  });
  return result;
}
