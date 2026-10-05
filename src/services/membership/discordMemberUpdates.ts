import { reconcileManagedRole } from "./managedRoleReconciliation.js";
import { PermissionFlagsBits, type Guild, type GuildMember, type PartialGuildMember } from "discord.js";
import type { createMembershipRepository } from "../../db/membershipRepository.js";
import { recordLogChange } from "../logFeed/events.js";
import { canonicalReactionEmojiKey } from "../reactionRoles/emoji.js";
import {
  botReactionRemovalSuppressor,
  reactionChangeKey
} from "../reactionRoles/subscriptions.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export interface MemberUpdateWarning {
  message: string;
}

export interface RoleReconciliationPlan {
  discordUserId: string;
  addRoleIds: string[];
  removeRoleIds: string[];
}

export interface RoleUpdateOutcome {
  kind: "role";
  action: "add" | "remove";
  discordUserId: string;
  roleId: string;
}

export type NicknameUpdateOutcome =
  | {
    kind: "nickname";
    action: "set";
    discordUserId: string;
    nickname: string;
  }
  | {
    kind: "nickname";
    action: "clear";
    discordUserId: string;
  };

export interface DiscordMemberUpdateResult<TOutcome> {
  outcomes: TOutcome[];
  warnings: MemberUpdateWarning[];
}

export async function cleanupConfiguredRoles(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string
): Promise<MemberUpdateWarning[]> {
  return reconcileConfiguredRoles(guild, membershipRepository, discordUserId);
}

export async function cleanupConfiguredRolesForMember(
  member: GuildMember | PartialGuildMember,
  membershipRepository: MembershipRepository
): Promise<MemberUpdateWarning[]> {
  const configuredRoleIds = await membershipRepository.listConfiguredRoleIdsForGuild(member.guild.id);
  const removable = configuredRoleIds.filter((roleId) => member.roles.cache.has(roleId));

  if (removable.length === 0) {
    return [];
  }

  try {
    await member.roles.remove(removable, "Guild Manager departure cleanup");
    for (const roleId of removable) {
      recordLogChange(member.guild.id, { kind: "role", action: "remove", discordUserId: member.id, roleId });
    }
    return [];
  } catch (error) {
    if (isDiscordUnknownMemberError(error)) {
      return [];
    }
    recordLogChange(member.guild.id, { kind: "incomplete", area: "membership" });
    return [{ message: `Role cleanup failed: ${formatError(error)}` }];
  }
}

export async function reconcileConfiguredRoles(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string,
  extraRetiredRoleIds: readonly string[] = []
): Promise<MemberUpdateWarning[]> {
  const warnings = await removeDormantReactionRoleReactions(
    guild,
    membershipRepository,
    discordUserId
  );
  try {
    const member = await guild.members.fetch(discordUserId);
    const plan = await planConfiguredRoleChangesForMember(
      member,
      membershipRepository,
      undefined,
      extraRetiredRoleIds
    );
    warnings.push(...(await applyConfiguredRolePlan(guild, membershipRepository, plan)).warnings);
  } catch (error) {
    warnings.push({ message: `Role update failed for <@${discordUserId}>: ${formatError(error)}` });
  }
  if (warnings.length) recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
  return warnings;
}

export async function planConfiguredRoleChangesForGuild(
  guild: Guild,
  membershipRepository: MembershipRepository,
  removeDormantReactions = false
): Promise<{ plans: RoleReconciliationPlan[]; warnings: MemberUpdateWarning[] }> {
  let members: Awaited<ReturnType<Guild["members"]["fetch"]>>;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    return {
      plans: [],
      warnings: [{ message: `Discord member check failed: ${formatError(error)}` }]
    };
  }

  const configuredRoleIds = await membershipRepository.listConfiguredRoleIdsForGuild(guild.id);
  if (configuredRoleIds.length === 0) {
    return { plans: [], warnings: [] };
  }

  const plans: RoleReconciliationPlan[] = [];
  const warnings: MemberUpdateWarning[] = [];
  for (const member of members.values()) {
    if (removeDormantReactions) {
      warnings.push(...await removeDormantReactionRoleReactions(
        guild,
        membershipRepository,
        member.id
      ));
    }
    const plan = await planConfiguredRoleChangesForMember(member, membershipRepository, configuredRoleIds);
    if (plan.addRoleIds.length > 0 || plan.removeRoleIds.length > 0) {
      plans.push(plan);
    }
  }

  return { plans, warnings };
}

export async function reconcileConfiguredRolesForGuild(
  guild: Guild,
  membershipRepository: MembershipRepository
): Promise<{
  plans: RoleReconciliationPlan[];
  outcomes: RoleUpdateOutcome[];
  warnings: MemberUpdateWarning[];
}> {
  const planned = await planConfiguredRoleChangesForGuild(guild, membershipRepository, true);
  const warnings = [...planned.warnings];
  const outcomes: RoleUpdateOutcome[] = [];

  for (const plan of planned.plans) {
    try {
      const applied = await applyConfiguredRolePlan(guild, membershipRepository, plan);
      outcomes.push(...applied.outcomes);
      warnings.push(...applied.warnings);
    } catch (error) {
      warnings.push({ message: `Role update failed for <@${plan.discordUserId}>: ${formatError(error)}` });
    }
  }

  if (warnings.length) recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
  return { plans: planned.plans, outcomes, warnings };
}

async function removeDormantReactionRoleReactions(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string
): Promise<MemberUpdateWarning[]> {
  let dormant: Awaited<ReturnType<MembershipRepository["listDormantReactionRoleSubscriptions"]>>;
  try {
    dormant = await membershipRepository.listDormantReactionRoleSubscriptions(
      guild.id,
      discordUserId
    );
  } catch (error) {
    return [{
      message: `Dormant reaction-role check failed for <@${discordUserId}>: ${formatError(error)}`
    }];
  }

  const warnings: MemberUpdateWarning[] = [];
  for (const subscription of dormant) {
    if (
      !subscription.channelId
      || !subscription.messageId
      || !subscription.emojiKey
    ) {
      continue;
    }
    try {
      const channel = await guild.channels.fetch(subscription.channelId);
      if (!channel?.isTextBased() || !("messages" in channel)) continue;
      const message = await channel.messages.fetch(subscription.messageId);
      const reaction = message.reactions.cache.find(
        (candidate) => canonicalReactionEmojiKey(candidate.emoji) === subscription.emojiKey
      );
      if (reaction) {
        const key = reactionChangeKey(
          guild.id,
          subscription.messageId,
          subscription.emojiKey,
          discordUserId
        );
        botReactionRemovalSuppressor.mark(key);
        try {
          await reaction.users.remove(discordUserId);
        } catch (error) {
          botReactionRemovalSuppressor.cancel(key);
          throw error;
        }
      }
    } catch (error) {
      warnings.push({
        message: `Reaction cleanup failed for <@${discordUserId}>: ${formatError(error)}`
      });
    }
  }
  return warnings;
}

export async function applyEffectiveNickname(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string
): Promise<MemberUpdateWarning[]> {
  return (await reconcileEffectiveNickname(
    guild,
    membershipRepository,
    discordUserId
  )).warnings;
}

export async function planEffectiveNicknameUpdate(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string
): Promise<DiscordMemberUpdateResult<NicknameUpdateOutcome>> {
  if (discordUserId === guild.ownerId) return { outcomes: [], warnings: [] };

  try {
    const nickname = await membershipRepository.getEffectiveNickname(guild.id, discordUserId);
    const member = await guild.members.fetch(discordUserId);
    const outcome = buildNicknameOutcome(discordUserId, member.nickname ?? null, nickname ?? null);
    if (!outcome) return { outcomes: [], warnings: [] };

    const warning = await checkNicknameUpdatePermission(guild, member, discordUserId);
    return {
      outcomes: warning ? [] : [outcome],
      warnings: warning ? [warning] : []
    };
  } catch (error) {
    return {
      outcomes: [],
      warnings: [{ message: `Nickname check failed for <@${discordUserId}>: ${formatError(error)}` }]
    };
  }
}

export async function reconcileEffectiveNickname(
  guild: Guild,
  membershipRepository: MembershipRepository,
  discordUserId: string
): Promise<DiscordMemberUpdateResult<NicknameUpdateOutcome>> {
  if (discordUserId === guild.ownerId) return { outcomes: [], warnings: [] };

  try {
    const nickname = await membershipRepository.getEffectiveNickname(guild.id, discordUserId);
    const member = await guild.members.fetch(discordUserId);
    const outcome = buildNicknameOutcome(discordUserId, member.nickname ?? null, nickname ?? null);
    if (!outcome) {
      return { outcomes: [], warnings: [] };
    }

    const warning = await checkNicknameUpdatePermission(guild, member, discordUserId);
    if (warning) {
      recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
      return { outcomes: [], warnings: [warning] };
    }

    await member.setNickname(nickname ?? null, "Guild Manager nickname update");
    recordLogChange(guild.id, outcome);
    return { outcomes: [outcome], warnings: [] };
  } catch (error) {
    recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
    return {
      outcomes: [],
      warnings: [{ message: `Nickname update failed for <@${discordUserId}>: ${formatError(error)}` }]
    };
  }
}

async function checkNicknameUpdatePermission(
  guild: Guild,
  member: GuildMember,
  discordUserId: string
): Promise<MemberUpdateWarning | undefined> {
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (botMember.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return { message: `Could not update <@${discordUserId}>'s nickname: their highest role is equal to or above Guild Manager's highest role.` };
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) {
    return { message: `Could not update <@${discordUserId}>'s nickname: Guild Manager lacks the Manage Nicknames permission.` };
  }
  return undefined;
}

async function planConfiguredRoleChangesForMember(
  member: GuildMember,
  membershipRepository: MembershipRepository,
  configuredRoleIds?: readonly string[],
  extraRetiredRoleIds: readonly string[] = []
): Promise<RoleReconciliationPlan> {
  const [configured, qualifiedRoleIds, access] = await Promise.all([
    configuredRoleIds ? Promise.resolve(configuredRoleIds) : membershipRepository.listConfiguredRoleIdsForGuild(member.guild.id),
    membershipRepository.listQualifiedRoleIdsForUser(member.guild.id, member.id),
    membershipRepository.getMemberAccess?.(member.guild.id, member.id)
  ]);
  const qualified = new Set(qualifiedRoleIds);
  const configuredSet = new Set([...configured, ...extraRetiredRoleIds]);

  return {
    discordUserId: member.id,
    addRoleIds: qualifiedRoleIds.filter((roleId) => !member.roles.cache.has(roleId)),
    removeRoleIds: [...configuredSet].filter((roleId) => !qualified.has(roleId) && member.roles.cache.has(roleId)
      && !(access && !access.blocked && access.revokedRoleIds.includes(roleId)))
  };
}

async function applyConfiguredRolePlan(
  guild: Guild,
  membershipRepository: MembershipRepository,
  plan: RoleReconciliationPlan
): Promise<DiscordMemberUpdateResult<RoleUpdateOutcome>> {
  const result: DiscordMemberUpdateResult<RoleUpdateOutcome> = { outcomes: [], warnings: [] };
  for (const roleId of new Set([...plan.addRoleIds, ...plan.removeRoleIds])) {
    const applied = await reconcileManagedRole(guild, membershipRepository, plan.discordUserId, roleId, "Guild Manager membership reconciliation");
    result.outcomes.push(...applied.outcomes);
    result.warnings.push(...applied.warnings);
  }
  return result;
}

function buildNicknameOutcome(
  discordUserId: string,
  currentNickname: string | null,
  effectiveNickname: string | null
): NicknameUpdateOutcome | undefined {
  if (currentNickname === effectiveNickname) return undefined;

  return effectiveNickname === null
    ? {
      kind: "nickname",
      action: "clear",
      discordUserId
    }
    : {
      kind: "nickname",
      action: "set",
      discordUserId,
      nickname: effectiveNickname
    };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDiscordUnknownMemberError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === 10007;
}
