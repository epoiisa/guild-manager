import type { Guild } from "discord.js";
import type { createGiveawayRepository } from "../../db/giveawayRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createGiveawayService } from "./service.js";
import type { MemberActionGuard } from "../../runtime/memberActionGuard.js";

type GiveawayRepository = ReturnType<typeof createGiveawayRepository>;

const ONE_MINUTE_MS = 60 * 1000;

export function createGiveawayScheduler(repository: GiveawayRepository, logger: Logger, actionGuard?: Pick<MemberActionGuard, "runSystem">) {
  const service = createGiveawayService(repository, logger);
  let scheduler: NodeJS.Timeout | undefined;
  let active = false;
  let running = false;

  async function runDue(guilds?: Iterable<Guild>, now = new Date()): Promise<void> {
    if (running) return;
    running = true;
    try {
      const guildById = new Map(Array.from(guilds ?? []).map((guild) => [guild.id, guild]));
      const allowedGuildIds = guilds ? new Set(guildById.keys()) : undefined;
      for (const giveaway of await repository.listDue(now)) {
        if (allowedGuildIds && !allowedGuildIds.has(giveaway.discordGuildId)) continue;
        const guild = guildById.get(giveaway.discordGuildId);
        if (!guild) continue;
        try {
          const draw = () => service.draw(guild, giveaway);
          if (actionGuard) await actionGuard.runSystem(guild.id, draw);
          else await draw();
        } catch (error) {
          logger.error("automatic giveaway draw failed", {
            guildId: guild.id,
            giveawayId: giveaway.giveawayId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      for (const giveaway of await repository.listDrawnNeedingPublication()) {
        if (allowedGuildIds && !allowedGuildIds.has(giveaway.discordGuildId)) continue;
        const guild = guildById.get(giveaway.discordGuildId);
        if (!guild) continue;
        try {
          const publish = () => service.publishPending(guild, giveaway);
          if (actionGuard) await actionGuard.runSystem(guild.id, publish);
          else await publish();
        } catch (error) {
          logger.error("pending giveaway announcement failed", {
            guildId: guild.id,
            giveawayId: giveaway.giveawayId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      running = false;
    }
  }

  function scheduleNext(getGuilds: () => Iterable<Guild>): void {
    if (!active) return;
    const delay = ONE_MINUTE_MS - (Date.now() % ONE_MINUTE_MS);
    scheduler = setTimeout(() => {
      void runDue(getGuilds()).finally(() => scheduleNext(getGuilds));
    }, delay);
  }

  return {
    runDue,
    startScheduler(getGuilds: () => Iterable<Guild>): void {
      if (active) return;
      active = true;
      void runDue(getGuilds());
      scheduleNext(getGuilds);
    },
    stopScheduler(): void {
      active = false;
      if (scheduler) clearTimeout(scheduler);
      scheduler = undefined;
    }
  };
}
