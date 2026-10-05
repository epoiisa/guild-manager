import type { GuildMember, PartialGuildMember } from "discord.js";
import type { createGuildLifecycleRepository } from "../../db/guildLifecycleRepository.js";
import type { createMembershipRepository, RegisteredCharacter } from "../../db/membershipRepository.js";
import type { createReactionRoleRepository } from "../../db/reactionRoleRepository.js";
import type { Logger } from "../../logging/logger.js";
import type { createApplicationRepository } from "../../db/applicationRepository.js";
import type { LogFeedRuntime } from "../logFeed/runtime.js";
import type { LogOperation } from "../logFeed/formatting.js";
import { recordLogChange } from "../logFeed/events.js";
import {
  cleanupConfiguredRolesForMember,
  type MemberUpdateWarning
} from "./discordMemberUpdates.js";

type GuildLifecycleRepository = ReturnType<typeof createGuildLifecycleRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type ReactionRoleRepository = ReturnType<typeof createReactionRoleRepository>;

export interface MembershipCleanupResult {
  characters: RegisteredCharacter[];
  warnings: MemberUpdateWarning[];
}

export async function cleanupDiscordUserDeparture(
  discordGuildId: string,
  discordUserId: string,
  membershipRepository: MembershipRepository,
  _reactionRoleRepository: ReactionRoleRepository,
  now = new Date(),
  expectedSnapshot?: Record<string, string>
): Promise<RegisteredCharacter[]> {
  const result = await membershipRepository.beginDiscordDeparture(discordGuildId, discordUserId, now, expectedSnapshot);
  for (const hold of result.holds) {
    const character = result.characters.find(candidate => candidate.albionServer === hold.albionServer
      && candidate.albionCharacterId === hold.albionCharacterId);
    recordLogChange(discordGuildId, { kind: "membershipLifecycle", action: "hold",
      characterName: character?.characterName ?? hold.albionCharacterId, albionServer: hold.albionServer, discordUserId });
  }
  return result.characters;
}

export async function handleDiscordMemberDeparture(
  member: GuildMember | PartialGuildMember,
  lifecycleRepository: GuildLifecycleRepository,
  membershipRepository: MembershipRepository,
  reactionRoleRepository: ReactionRoleRepository,
  logger: Logger,
  logFeed?: { runtime: LogFeedRuntime; applicationRepository: Pick<ReturnType<typeof createApplicationRepository>, "listOperationalApplicationTargets"> }
): Promise<void> {
  const detectedAt = new Date();
  const isActiveGuild = await lifecycleRepository.isGuildActive(member.guild.id);
  if (!isActiveGuild) {
    await reactionRoleRepository.deleteUserSubscriptions(member.guild.id, member.id);
    logger.debug("ignored member departure for inactive guild", {
      guildId: member.guild.id,
      guildName: member.guild.name,
      discordUserId: member.id
    });
    return;
  }

  const registrationSnapshot = await membershipRepository.getDiscordRegistrationSnapshot(member.guild.id, member.id);
  const context: LogOperation = {
    kind: "departure",
    discordUserId: member.id,
    discordUserDisplayName: member.displayName,
    applicationChannelIds: []
  };
  const cleanup = async () => {
    if (logFeed) {
      try {
        const applications = await logFeed.applicationRepository.listOperationalApplicationTargets(member.guild.id, true);
        context.applicationChannelIds = applications.filter(application => application.applicantDiscordUserId === member.id
          && application.channelStatus === "open" && application.ticketChannelId).map(application => application.ticketChannelId!);
      } catch {
        context.incomplete = true;
        logger.warn("departure application references unavailable", { guildId: member.guild.id, discordUserId: member.id });
      }
    }
    const characters = await cleanupDiscordUserDeparture(
      member.guild.id,
      member.id,
      membershipRepository,
      reactionRoleRepository,
      detectedAt,
      registrationSnapshot
    );
    if (characters.length === 0) {
      logger.debug("ignored member departure with no registrations", {
        guildId: member.guild.id,
        guildName: member.guild.name,
        discordUserId: member.id
      });
      return;
    }

    const warnings = await cleanupConfiguredRolesForMember(member, membershipRepository);
    if (warnings.length) context.incomplete = true;
    for (const warning of warnings) {
      logger.warn("member departure role cleanup warning", {
        guildId: member.guild.id,
        guildName: member.guild.name,
        discordUserId: member.id,
        warning: warning.message
      });
    }

    logger.info("cleaned up departed member registrations", {
      guildId: member.guild.id,
      guildName: member.guild.name,
      discordUserId: member.id,
      registrationCount: characters.length,
      characters: characters.map((character) => ({
        albionServer: character.albionServer,
        albionCharacterId: character.albionCharacterId,
        characterName: character.characterName
      }))
    });
  };
  if (logFeed) await logFeed.runtime.run(member.guild, cleanup, context);
  else await cleanup();
}
