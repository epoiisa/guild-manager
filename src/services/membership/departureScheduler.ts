import type { Guild } from "discord.js";
import type { createGuildLifecycleRepository } from "../../db/guildLifecycleRepository.js";
import type { createMembershipRepository, RegistrationLifecycle } from "../../db/membershipRepository.js";
import type { createReactionRoleRepository } from "../../db/reactionRoleRepository.js";
import { fetchGuildMemberIfPresent } from "../../discord/guildMembers.js";
import type { Logger } from "../../logging/logger.js";
import { cleanupDiscordUserDeparture } from "./discordMemberDepartures.js";
import { reconcileConfiguredRoles } from "./discordMemberUpdates.js";
import { recordLogChange } from "../logFeed/events.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
const MINUTE_MS = 60_000;
const RETRY_MS = 15 * MINUTE_MS;
const CHECK_LIMIT = 25;

export interface MembershipDepartureSchedulerOptions {
  membershipRepository: MembershipRepository;
  lifecycleRepository: Pick<ReturnType<typeof createGuildLifecycleRepository>, "isGuildActive">;
  reactionRoleRepository: ReturnType<typeof createReactionRoleRepository>;
  logger: Logger;
  cleanupEvidence?: (guild: Guild) => Promise<void>;
  runLogged?: (guild: Guild, work: () => Promise<void>) => Promise<void>;
  onMissedDeparture?: (guild: Guild, discordUserId: string, now: Date, snapshot: Record<string, string>) => Promise<void>;
}

/** Discord registration holds and missed departures run independently of
 * membership updates. Albion Online membership cleanup belongs to /update
 * and its configured schedule, never this maintenance clock.
 */
export function createMembershipDepartureScheduler(options: MembershipDepartureSchedulerOptions) {
  const { membershipRepository: repository, logger } = options;
  let timer: NodeJS.Timeout | undefined;
  let active = false;
  let running = false;
  const nextCheck = new Map<string, number>();
  const lastDiscordCheck = new Map<string, number>();

  async function runDueDepartures(guilds: Iterable<Guild>, now = new Date()): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const [key, retryAt] of nextCheck) if (retryAt <= now.getTime()) nextCheck.delete(key);
      for (const guild of guilds) {
        try {
          if (!await options.lifecycleRepository.isGuildActive(guild.id)) continue;
          const work = async () => {
            await detectMissedDepartures(guild, now);
            await expireRegistrationHolds(guild, now);
            await options.cleanupEvidence?.(guild);
          };
          if (options.runLogged) await options.runLogged(guild, work);
          else await work();
        } catch (error) {
          logger.error("membership departure maintenance failed", {
            discordGuildId: guild.id, error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } finally {
      running = false;
    }
  }

  async function detectMissedDepartures(guild: Guild, now: Date): Promise<void> {
    const userIds = await repository.listRegisteredUserIdsForGuild(guild.id);
    const candidates = userIds
      .filter(id => (lastDiscordCheck.get(`${guild.id}:${id}`) ?? 0) <= now.getTime() - RETRY_MS)
      .sort((a, b) => (lastDiscordCheck.get(`${guild.id}:${a}`) ?? 0) - (lastDiscordCheck.get(`${guild.id}:${b}`) ?? 0))
      .slice(0, CHECK_LIMIT);
    for (const userId of candidates) {
      lastDiscordCheck.set(`${guild.id}:${userId}`, now.getTime());
      try {
        const snapshot = await repository.getDiscordRegistrationSnapshot(guild.id, userId);
        const member = await fetchGuildMemberIfPresent(guild, userId);
        if (member) continue;
        if (options.onMissedDeparture) await options.onMissedDeparture(guild, userId, now, snapshot);
        else await cleanupDiscordUserDeparture(guild.id, userId, repository, options.reactionRoleRepository, now, snapshot);
      } catch {
        // Cache misses and failed requests do not establish Discord absence.
        logger.warn("Discord departure check unavailable", { discordGuildId: guild.id, discordUserId: userId });
      }
    }
    // Bound remembered checks to registrations that still exist in this server.
    const retained = new Set(userIds.map(id => `${guild.id}:${id}`));
    for (const key of lastDiscordCheck.keys()) {
      if (key.startsWith(`${guild.id}:`) && !retained.has(key)) lastDiscordCheck.delete(key);
    }
  }

  async function expireRegistrationHolds(guild: Guild, now: Date): Promise<void> {
    const holds = await repository.listDueRegistrationHolds(guild.id, now, 100);
    let checks = 0;
    for (const hold of holds) {
      const key = `registration:${guild.id}:${hold.albionServer}:${hold.albionCharacterId}:${hold.revision}`;
      if ((nextCheck.get(key) ?? 0) > now.getTime()) continue;
      if (++checks > CHECK_LIMIT) break;
      try {
        // Rejoining does not establish recovered ownership. Both confirmed
        // presence and confirmed absence permit an unrecovered hold to expire.
        if (hold.previousDiscordUserId) await fetchGuildMemberIfPresent(guild, hold.previousDiscordUserId);
        const character = await repository.getCharacterRecord(hold.albionServer, hold.albionCharacterId);
        if (await repository.abandonRegistration(hold, hold.revision, now)) {
          recordLogChange(guild.id, { kind: "membershipLifecycle", action: "abandoned",
            characterName: character?.characterName ?? hold.albionCharacterId, albionServer: hold.albionServer,
            discordUserId: hold.previousDiscordUserId });
          if (hold.previousDiscordUserId) await reconcileFormerOwner(guild, hold.previousDiscordUserId);
        }
        nextCheck.delete(key);
      } catch {
        await deferCheck(hold, "registration", hold.revision, key, now);
      }
    }
  }

  async function reconcileFormerOwner(guild: Guild, discordUserId: string): Promise<void> {
    try {
      if (!await fetchGuildMemberIfPresent(guild, discordUserId)) return;
      const warnings = await reconcileConfiguredRoles(guild, repository, discordUserId);
      if (warnings.length) logger.warn("departure role reconciliation incomplete", { discordGuildId: guild.id, discordUserId });
    } catch {
      logger.warn("departure role reconciliation unavailable", { discordGuildId: guild.id, discordUserId });
    }
  }

  async function deferCheck(
    record: RegistrationLifecycle,
    kind: "registration",
    revision: number,
    key: string,
    now: Date
  ): Promise<void> {
    nextCheck.set(key, now.getTime() + RETRY_MS);
    await repository.noteLifecycleCheckFailure({ ...record, kind, revision }, now);
    logger.warn("departure expiry verification deferred", {
      discordGuildId: record.discordGuildId, albionServer: record.albionServer,
      albionCharacterId: record.albionCharacterId, kind
    });
  }

  function startScheduler(getGuilds: () => Iterable<Guild>): void {
    if (active) return;
    active = true;
    const tick = () => void runDueDepartures(getGuilds()).catch(error => logger.error("departure scheduler failed", {
      error: error instanceof Error ? error.message : String(error)
    }));
    tick();
    timer = setInterval(tick, MINUTE_MS);
  }

  function stopScheduler(): void {
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { runDueDepartures, startScheduler, stopScheduler };
}
