import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type OverwriteResolvable,
  type VoiceChannel,
  type VoiceState
} from "discord.js";
import type { Logger } from "../logging/logger.js";
import type {
  TemporaryVoiceChannelRecord,
  createTemporaryVoiceRepository
} from "../db/temporaryVoiceRepository.js";
import { createKeyedSerialQueue } from "./reactionRoles/keyedSerialQueue.js";
import type { MemberActionGuard } from "../runtime/memberActionGuard.js";

type TemporaryVoiceRepository = ReturnType<typeof createTemporaryVoiceRepository>;

export const TEMPORARY_VOICE_OWNER_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.SetVoiceChannelStatus,
  PermissionFlagsBits.ManageMessages
] as const;

const REQUIRED_BOT_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.Connect, "Connect"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles"],
  [PermissionFlagsBits.MoveMembers, "Move Members"]
] as const;

export interface TemporaryVoiceService {
  getConfig: TemporaryVoiceRepository["getConfig"];
  configureBaseChannel(guild: Guild, channel: VoiceChannel): Promise<void>;
  clearConfig(discordGuildId: string): Promise<boolean>;
  getMissingBotPermissions(guild: Guild, channel: VoiceChannel): string[];
  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void>;
  handleChannelDelete(channel: GuildBasedChannel): Promise<void>;
  reconcileGuild(guild: Guild): Promise<void>;
  deleteAllTemporaryChannels(guild: Guild): Promise<void>;
}

export function createTemporaryVoiceService(
  repository: TemporaryVoiceRepository,
  logger: Logger,
  actionGuard: MemberActionGuard
): TemporaryVoiceService {
  const queue = createKeyedSerialQueue();

  async function configureBaseChannel(guild: Guild, channel: VoiceChannel): Promise<void> {
    await repository.setBaseChannel(guild.id, channel.id);
    logger.info("configured temporary voice base channel", {
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name
    });
  }

  async function clearConfig(discordGuildId: string): Promise<boolean> {
    return repository.clearConfig(discordGuildId);
  }

  function getMissingBotPermissions(guild: Guild, channel: VoiceChannel): string[] {
    const bot = guild.members.me;
    if (!bot) return REQUIRED_BOT_PERMISSIONS.map(([, label]) => label);
    const permissions = channel.permissionsFor(bot);
    return REQUIRED_BOT_PERMISSIONS
      .filter(([permission]) => !permissions?.has(permission))
      .map(([, label]) => label);
  }

  async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await queue.enqueue(`channel:${oldState.channelId}`, () =>
        deleteIfEmpty(oldState.guild, oldState.channelId!)
      );
    }

    if (!newState.channelId || oldState.channelId === newState.channelId || newState.member?.user.bot) {
      return;
    }

    const config = await repository.getConfig(newState.guild.id);
    if (!config || config.baseChannelId !== newState.channelId || !newState.member) {
      return;
    }

    await actionGuard.run(newState.guild.id, newState.member.id, () =>
      queue.enqueue(`owner:${newState.guild.id}:${newState.member!.id}`, () =>
        createOrReuseChannel(newState.guild, newState.member!, config.baseChannelId)));
  }

  async function createOrReuseChannel(
    guild: Guild,
    owner: GuildMember,
    baseChannelId: string
  ): Promise<void> {
    if (owner.voice.channelId !== baseChannelId) return;

    const existingRecord = await repository.getChannelByOwner(guild.id, owner.id);
    if (existingRecord) {
      const existingChannel = await fetchVoiceChannel(guild, existingRecord.discordChannelId);
      if (existingChannel) {
        await owner.voice.setChannel(existingChannel, "Return temporary voice channel owner to their channel");
        return;
      }
      await repository.removeChannel(guild.id, existingRecord.discordChannelId);
    }

    const baseChannel = await fetchVoiceChannel(guild, baseChannelId);
    if (!baseChannel) {
      await repository.clearConfig(guild.id);
      logger.warn("cleared missing temporary voice base channel", {
        guildId: guild.id,
        guildName: guild.name,
        channelId: baseChannelId
      });
      return;
    }

    const missingPermissions = getMissingBotPermissions(guild, baseChannel);
    if (missingPermissions.length > 0) {
      logger.warn("temporary voice channel creation skipped for missing permissions", {
        guildId: guild.id,
        guildName: guild.name,
        channelId: baseChannel.id,
        missingPermissions
      });
      return;
    }

    const channel = await guild.channels.create({
      name: buildTemporaryVoiceChannelName(owner.displayName),
      type: ChannelType.GuildVoice,
      parent: baseChannel.parentId,
      nsfw: baseChannel.nsfw,
      bitrate: baseChannel.bitrate,
      userLimit: baseChannel.userLimit,
      rateLimitPerUser: baseChannel.rateLimitPerUser ?? undefined,
      rtcRegion: baseChannel.rtcRegion ?? undefined,
      videoQualityMode: baseChannel.videoQualityMode ?? undefined,
      position: baseChannel.rawPosition + 1,
      permissionOverwrites: buildPermissionOverwrites(baseChannel, owner.id),
      reason: `Create temporary voice channel for ${owner.user.tag}`
    });

    const record: TemporaryVoiceChannelRecord = {
      discordGuildId: guild.id,
      discordChannelId: channel.id,
      ownerDiscordUserId: owner.id,
      baseChannelId
    };

    try {
      await repository.addChannel(record);
    } catch (error) {
      await channel.delete("Remove untracked temporary voice channel after persistence failure").catch(() => undefined);
      throw error;
    }

    try {
      await owner.voice.setChannel(channel, "Move temporary voice channel owner into their channel");
    } catch (error) {
      if (channel.members.size === 0) {
        await channel.delete("Remove empty temporary voice channel after move failure").catch(() => undefined);
        await repository.removeChannel(guild.id, channel.id);
      }
      throw error;
    }

    logger.info("created temporary voice channel", {
      guildId: guild.id,
      guildName: guild.name,
      baseChannelId,
      channelId: channel.id,
      channelName: channel.name,
      ownerDiscordUserId: owner.id
    });
  }

  async function deleteIfEmpty(guild: Guild, discordChannelId: string): Promise<void> {
    const record = await repository.getChannel(guild.id, discordChannelId);
    if (!record) return;

    const channel = await fetchVoiceChannel(guild, discordChannelId);
    if (!channel) {
      await repository.removeChannel(guild.id, discordChannelId);
      return;
    }
    if (channel.members.size > 0) return;

    await channel.delete("Remove empty temporary voice channel");
    await repository.removeChannel(guild.id, discordChannelId);
    logger.info("removed empty temporary voice channel", {
      guildId: guild.id,
      guildName: guild.name,
      channelId: discordChannelId,
      ownerDiscordUserId: record.ownerDiscordUserId
    });
  }

  async function handleChannelDelete(channel: GuildBasedChannel): Promise<void> {
    const config = await repository.getConfig(channel.guild.id);
    if (config?.baseChannelId === channel.id) {
      await repository.clearConfig(channel.guild.id);
      logger.info("cleared deleted temporary voice base channel", {
        guildId: channel.guild.id,
        guildName: channel.guild.name,
        channelId: channel.id
      });
    }
    await repository.removeChannel(channel.guild.id, channel.id);
  }

  async function reconcileGuild(guild: Guild): Promise<void> {
    const config = await repository.getConfig(guild.id);
    if (config && !await fetchVoiceChannel(guild, config.baseChannelId)) {
      await repository.clearConfig(guild.id);
      logger.info("cleared stale temporary voice base channel", {
        guildId: guild.id,
        guildName: guild.name,
        channelId: config.baseChannelId
      });
    }

    for (const record of await repository.listChannels(guild.id)) {
      await queue.enqueue(`channel:${record.discordChannelId}`, () =>
        deleteIfEmpty(guild, record.discordChannelId)
      );
    }
  }

  async function deleteAllTemporaryChannels(guild: Guild): Promise<void> {
    for (const record of await repository.listChannels(guild.id)) {
      const channel = await fetchVoiceChannel(guild, record.discordChannelId);
      if (channel) {
        await channel.delete("Remove temporary voice channel during Guild Manager cleanup").catch((error) => {
          logger.warn("failed to remove temporary voice channel during cleanup", {
            guildId: guild.id,
            guildName: guild.name,
            channelId: record.discordChannelId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      await repository.removeChannel(guild.id, record.discordChannelId);
    }
  }

  return {
    getConfig: repository.getConfig,
    configureBaseChannel,
    clearConfig,
    getMissingBotPermissions,
    handleVoiceStateUpdate,
    handleChannelDelete,
    reconcileGuild,
    deleteAllTemporaryChannels
  };
}

async function fetchVoiceChannel(guild: Guild, channelId: string): Promise<VoiceChannel | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.type === ChannelType.GuildVoice ? channel : undefined;
}

export function buildTemporaryVoiceChannelName(displayName: string): string {
  return displayName.slice(0, 100);
}

function buildPermissionOverwrites(baseChannel: VoiceChannel, ownerDiscordUserId: string): OverwriteResolvable[] {
  const ownerPermissions = new PermissionsBitField(TEMPORARY_VOICE_OWNER_PERMISSIONS).bitfield;
  const overwrites: OverwriteResolvable[] = [];
  let ownerOverwriteFound = false;

  for (const overwrite of baseChannel.permissionOverwrites.cache.values()) {
    if (overwrite.id === ownerDiscordUserId && overwrite.type === OverwriteType.Member) {
      ownerOverwriteFound = true;
      overwrites.push({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield | ownerPermissions,
        deny: overwrite.deny.bitfield & ~ownerPermissions
      });
      continue;
    }
    overwrites.push({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield
    });
  }

  if (!ownerOverwriteFound) {
    overwrites.push({
      id: ownerDiscordUserId,
      type: OverwriteType.Member,
      allow: ownerPermissions
    });
  }

  return overwrites;
}
