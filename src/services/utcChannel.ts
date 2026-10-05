import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type VoiceChannel
} from "discord.js";
import type { Logger } from "../logging/logger.js";
import type { createUtcChannelRepository } from "../db/utcChannelRepository.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const UTC_TIME_PATTERN = /\b([01]\d|2[0-3]):[0-5]\d\b/;

type UtcChannelRepository = ReturnType<typeof createUtcChannelRepository>;

export interface UtcChannelService {
  add(guild: Guild): Promise<{ created: boolean; channel: VoiceChannel }>;
  remove(guild: Guild): Promise<{ removed: boolean }>;
  updateAllManagedChannels(guilds: Iterable<Guild>): Promise<void>;
  startScheduler(getGuilds: () => Iterable<Guild>): void;
  stopScheduler(): void;
}

export function createUtcChannelService(repository: UtcChannelRepository, logger: Logger): UtcChannelService {
  let scheduler: NodeJS.Timeout | undefined;
  let schedulerActive = false;

  async function getManagedVoiceChannel(guild: Guild): Promise<VoiceChannel | undefined> {
    const record = await repository.getUtcChannel(guild.id);

    if (!record) {
      return undefined;
    }

    const channel = await guild.channels.fetch(record.discordChannelId).catch(() => null);

    if (!channel) {
      await repository.removeUtcChannel(guild.id);
      logger.info("removed stale UTC channel record for missing channel", {
        guildId: guild.id,
        guildName: guild.name,
        channelId: record.discordChannelId
      });
      return undefined;
    }

    if (channel.type !== ChannelType.GuildVoice) {
      await repository.removeUtcChannel(guild.id);
      logger.warn("removed stale UTC channel record for non-voice channel", {
        guildId: guild.id,
        guildName: guild.name,
        channelId: record.discordChannelId,
        channelType: channel.type
      });
      return undefined;
    }

    return channel;
  }

  async function updateChannelName(channel: GuildBasedChannel): Promise<void> {
    if (channel.type !== ChannelType.GuildVoice) {
      return;
    }

    const nextName = applyUtcTimeToName(channel.name);

    if (channel.name === nextName) {
      return;
    }

    const previousName = channel.name;
    await channel.setName(nextName, "Update Guild Manager UTC time channel");
    logger.debug("renamed UTC channel", {
      guildId: channel.guild.id,
      guildName: channel.guild.name,
      channelId: channel.id,
      previousName,
      nextName
    });
  }

  function scheduleNextRun(getGuilds: () => Iterable<Guild>): void {
    if (!schedulerActive) {
      return;
    }

    const now = Date.now();
    const nextBoundary = Math.ceil((now + 1) / TEN_MINUTES_MS) * TEN_MINUTES_MS;
    const delay = Math.max(1000, nextBoundary - now);

    scheduler = setTimeout(() => {
      if (!schedulerActive) {
        return;
      }

      void updateAllManagedChannels(getGuilds()).catch((error) => {
        logger.error("failed to update UTC channels", {
          error: error instanceof Error ? error.message : String(error)
        });
      }).finally(() => scheduleNextRun(getGuilds));
    }, delay);
  }

  async function add(guild: Guild): Promise<{ created: boolean; channel: VoiceChannel }> {
    const existingChannel = await getManagedVoiceChannel(guild);

    if (existingChannel) {
      return { created: false, channel: existingChannel };
    }

    const channel = await guild.channels.create({
      name: `${getCurrentUtcTime()} UTC`,
      type: ChannelType.GuildVoice,
      reason: "Create Guild Manager UTC time channel"
    });

    await repository.setUtcChannel(guild.id, channel.id);
    logger.info("created UTC channel", {
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: channel.name
    });
    return { created: true, channel };
  }

  async function remove(guild: Guild): Promise<{ removed: boolean }> {
    const existingChannel = await getManagedVoiceChannel(guild);

    if (!existingChannel) {
      await repository.removeUtcChannel(guild.id);
      return { removed: false };
    }

    await existingChannel.delete("Remove Guild Manager UTC time channel");
    await repository.removeUtcChannel(guild.id);
    logger.info("removed UTC channel", {
      guildId: guild.id,
      guildName: guild.name,
      channelId: existingChannel.id
    });
    return { removed: true };
  }

  async function updateAllManagedChannels(guilds: Iterable<Guild>): Promise<void> {
    await Promise.all(
      Array.from(guilds, async (guild) => {
        const channel = await getManagedVoiceChannel(guild);

        if (!channel) {
          return;
        }

        await updateChannelName(channel);
      })
    );
  }

  function startScheduler(getGuilds: () => Iterable<Guild>): void {
    if (schedulerActive) {
      return;
    }

    schedulerActive = true;
    void updateAllManagedChannels(getGuilds()).catch((error) => {
      logger.error("failed to update UTC channels", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    scheduleNextRun(getGuilds);
  }

  function stopScheduler(): void {
    schedulerActive = false;

    if (!scheduler) {
      return;
    }

    clearTimeout(scheduler);
    scheduler = undefined;
  }

  return {
    add,
    remove,
    updateAllManagedChannels,
    startScheduler,
    stopScheduler
  };
}

export function getCurrentUtcTime(now = new Date()): string {
  const hours = now.getUTCHours().toString().padStart(2, "0");
  const minutes = (Math.floor(now.getUTCMinutes() / 10) * 10).toString().padStart(2, "0");

  return `${hours}:${minutes}`;
}

export function applyUtcTimeToName(name: string, now = new Date()): string {
  const time = getCurrentUtcTime(now);

  if (UTC_TIME_PATTERN.test(name)) {
    return name.replace(UTC_TIME_PATTERN, time);
  }

  return `${time} UTC`;
}
