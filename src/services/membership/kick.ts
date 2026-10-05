import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import type { createMembershipRepository } from "../../db/membershipRepository.js";
import type { createMemberAccessRepository } from "../../db/memberAccessRepository.js";
import type { createKickRolesRepository } from "../../db/kickRolesRepository.js";
import { fetchGuildMemberIfPresent } from "../../discord/guildMembers.js";
import { recordLogChange } from "../logFeed/events.js";
import type { MembershipCleanupResult } from "./discordMemberDepartures.js";
import type { MemberUpdateWarning } from "./discordMemberUpdates.js";
import { inspectKickCommandPermissions } from "./kickCommandPermissions.js";

interface KickDependencies {
  membershipRepository: ReturnType<typeof createMembershipRepository>;
  memberAccessRepository: ReturnType<typeof createMemberAccessRepository>;
  kickRolesRepository: ReturnType<typeof createKickRolesRepository>;
  activityCleanup: { reconcileUser(guild: Guild, userId: string): Promise<{ warnings: MemberUpdateWarning[]; pending: boolean }> };
  activityRepository: { hasPendingCleanup(guildId: string, userId: string): Promise<boolean> };
}

/** Caller holds the guild action barrier. The database block precedes Discord work. */
export function createKickService(deps: KickDependencies) {
  const { membershipRepository: memberships, memberAccessRepository: access } = deps;

  async function kickMember(guild: Guild, userId: string, actorId: string): Promise<MembershipCleanupResult> {
    const authorityRoles = await deps.kickRolesRepository.listAuthorityRoleIds(guild.id);
    const characters = await memberships.kickUser(guild.id, userId, authorityRoles, actorId);
    const warnings = await reconcileUser(guild, userId);
    if (warnings.length) recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
    return { characters, warnings };
  }

  async function reconcileUser(guild: Guild, userId: string): Promise<MemberUpdateWarning[]> {
    const state = await access.getMemberAccess(guild.id, userId);
    if (!state?.blocked) return [];
    const warnings: MemberUpdateWarning[] = [];
    // Re-arm before remote reads: a previously completed kick can gain new
    // Discord authority. Failed verification must also block replacement-owner
    // recovery, which relies on this persisted cleanup flag.
    if (!await access.addRevokedRoleIds(guild.id, userId, state.revision, state.revokedRoleIds, state.cleanupRoleIds)) {
      return [{ message: "Kick state changed during cleanup; cleanup will be retried." }];
    }
    try {
      const member = await fetchGuildMemberIfPresent(guild, userId);
      const authorityRoles = await deps.kickRolesRepository.listAuthorityRoleIds(guild.id);
      const adminRoles = member ? [...member.roles.cache.values()]
        .filter(role => role.permissions.has(PermissionFlagsBits.Administrator)).map(role => role.id) : [];
      let commandRoles: string[] = [];
      try {
        const grants = await inspectKickCommandPermissions(guild, userId, member ? [...member.roles.cache.keys()] : []);
        commandRoles = grants.roleIds;
        if (grants.requiresManualRemoval) warnings.push({ message: `Remove <@${userId}>'s direct or everyone-granted administrative command access in Discord Integrations before officer reconnection.` });
      } catch {
        warnings.push({ message: "Could not verify Discord Integration command grants; cleanup remains pending." });
      }
      const revoked = [...new Set([...state.revokedRoleIds, ...authorityRoles, ...adminRoles, ...commandRoles])];
      const cleanupRoles = [...new Set([...state.cleanupRoleIds, ...revoked, ...await memberships.listConfiguredRoleIdsForGuild(guild.id)])];
      if (!await access.addRevokedRoleIds(guild.id, userId, state.revision, revoked, cleanupRoles)) {
        return [{ message: "Kick state changed during cleanup; cleanup will be retried." }];
      }
      if (member) {
        for (const roleId of cleanupRoles) {
          if (!member.roles.cache.has(roleId)) continue;
          try {
            await member.roles.remove(roleId, "Guild Manager kick: revoke access and authority");
            recordLogChange(guild.id, { kind: "role", action: "remove", discordUserId: userId, roleId });
          } catch {
            warnings.push({ message: `Could not remove role <@&${roleId}> from <@${userId}>. An officer must resolve Discord permissions; Guild Manager access remains blocked.` });
          }
        }
        if (member.nickname !== null) {
          try { await member.setNickname(null, "Guild Manager kick: clear custom nickname"); }
          catch { warnings.push({ message: `Could not clear <@${userId}>'s nickname; cleanup remains pending.` }); }
        }
        // A server owner or Administrator granted through @everyone cannot be
        // demoted by the bot. Never unblock based only on successful REST calls.
        const current = await fetchGuildMemberIfPresent(guild, userId);
        if (current && retainsAuthority(guild, current, revoked)) {
          warnings.push({ message: `Discord authority remains for <@${userId}>. Remove their manager/reviewer and Administrator access before officer reconnection.` });
        }
      }
    } catch {
      warnings.push({ message: `Could not verify Discord access for <@${userId}>; Guild Manager access remains blocked and cleanup will be retried.` });
    }
    try {
      const activities = await deps.activityCleanup.reconcileUser(guild, userId);
      warnings.push(...activities.warnings);
      if (activities.pending && activities.warnings.length === 0) warnings.push({ message: "Activity and conversation cleanup remains pending." });
    }
    catch { warnings.push({ message: "Activity and conversation cleanup is pending and will be retried." }); }
    if (warnings.length === 0 && !await deps.activityRepository.hasPendingCleanup(guild.id, userId)) {
      if (!await access.markKickCleanupComplete(guild.id, userId, state.revision)) {
        warnings.push({ message: "Kick state changed before cleanup could finish; cleanup will be retried." });
      }
    }
    return warnings;
  }

  async function reconcileGuild(guild: Guild): Promise<MemberUpdateWarning[]> {
    const warnings: MemberUpdateWarning[] = [];
    for (const state of await access.listPendingKickCleanups(guild.id)) {
      warnings.push(...await reconcileUser(guild, state.discordUserId));
    }
    return warnings;
  }

  return { kickMember, reconcileUser, reconcileGuild };
}

export function retainsAuthority(guild: Pick<Guild, "ownerId">, member: Pick<GuildMember, "id" | "roles" | "permissions">, revokedRoleIds: readonly string[]): boolean {
  return guild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator)
    || revokedRoleIds.some(roleId => member.roles.cache.has(roleId));
}
