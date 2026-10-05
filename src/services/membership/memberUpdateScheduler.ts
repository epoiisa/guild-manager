import type { Guild } from "discord.js";
import type { createMemberUpdateScheduleRepository, MemberUpdateScheduleRecord } from "../../db/memberUpdateScheduleRepository.js";
import type { createMembershipRepository } from "../../db/membershipRepository.js";
import { logErrorContext, type Logger } from "../../logging/logger.js";
import type { AlbionClient } from "../albion/client.js";
import {
  reconcileMembershipForGuild,
  type MembershipReconciliationResult
} from "./reconciliation.js";

type MemberUpdateScheduleRepository = ReturnType<typeof createMemberUpdateScheduleRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;

const ONE_MINUTE_MS = 60 * 1000;

export interface MemberUpdateScheduler {
  runDueSchedules(guilds?: Iterable<Guild>, now?: Date): Promise<void>;
  startScheduler(getGuilds: () => Iterable<Guild>): void;
  stopScheduler(): void;
}

interface DueSchedule {
  schedule: MemberUpdateScheduleRecord;
  runKey: string;
}

export interface MemberUpdateSchedulerOptions {
  reconcileMembershipForGuild?: (
    guild: Guild,
    albionClient: AlbionClient,
    membershipRepository: MembershipRepository
  ) => Promise<MembershipReconciliationResult>;
}

export function createMemberUpdateScheduler(
  scheduleRepository: MemberUpdateScheduleRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient,
  logger: Logger,
  options: MemberUpdateSchedulerOptions = {}
): MemberUpdateScheduler {
  const reconcile = options.reconcileMembershipForGuild ?? reconcileMembershipForGuild;
  let scheduler: NodeJS.Timeout | undefined;
  let schedulerActive = false;
  let running = false;

  async function runDueSchedules(guilds?: Iterable<Guild>, now = new Date()): Promise<void> {
    if (running) {
      return;
    }

    running = true;
    try {
      const guildById = new Map(Array.from(guilds ?? []).map((guild) => [guild.id, guild]));
      const allowedGuildIds = guilds ? new Set(guildById.keys()) : undefined;
      const dueSchedules = (await scheduleRepository.listSchedules())
        .filter((schedule) => !allowedGuildIds || allowedGuildIds.has(schedule.discordGuildId))
        .flatMap((schedule) => {
          const due = getDueSchedule(schedule, now);
          return due ? [due] : [];
        });

      for (const due of dueSchedules) {
        const guild = guildById.get(due.schedule.discordGuildId);
        if (!guild) {
          continue;
        }

        await runGuildSchedule(guild, due);
      }
    } finally {
      running = false;
    }
  }

  async function runGuildSchedule(guild: Guild, due: DueSchedule): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await reconcile(guild, albionClient, membershipRepository);
      await scheduleRepository.markScheduleRun(guild.id, due.runKey, true);
      const context = scheduledReconciliationContext(guild.id, due.runKey, startedAt, result);
      if (result.warnings.length > 0) {
        logger.warn("scheduled membership reconciliation completed with warnings", {
          ...context,
          outcome: "partial"
        });
      } else {
        logger.info("scheduled membership reconciliation completed", {
          ...context,
          outcome: "success"
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await scheduleRepository.markScheduleRun(guild.id, due.runKey, false, message);
      logger.error("scheduled membership reconciliation failed", {
        discordGuildId: guild.id,
        runKey: due.runKey,
        durationMilliseconds: Date.now() - startedAt,
        outcome: "failure",
        failureKind: getFailureKind(error),
        ...logErrorContext(error, true)
      });
    }
  }

  function scheduleNextRun(getGuilds: () => Iterable<Guild>): void {
    if (!schedulerActive) {
      return;
    }

    const now = Date.now();
    const nextBoundary = Math.ceil((now + 1) / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    const delay = Math.max(1000, nextBoundary - now);

    scheduler = setTimeout(() => {
      if (!schedulerActive) {
        return;
      }

      void runDueSchedules(getGuilds()).catch((error) => {
        logger.error("failed to run member update schedules", {
          error: error instanceof Error ? error.message : String(error)
        });
      }).finally(() => scheduleNextRun(getGuilds));
    }, delay);
  }

  function startScheduler(getGuilds: () => Iterable<Guild>): void {
    if (schedulerActive) {
      return;
    }

    schedulerActive = true;
    void runDueSchedules(getGuilds()).catch((error) => {
      logger.error("failed to run member update schedules", {
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
    runDueSchedules,
    startScheduler,
    stopScheduler
  };
}

function scheduledReconciliationContext(
  discordGuildId: string,
  runKey: string,
  startedAt: number,
  result: MembershipReconciliationResult
): Record<string, number | string> {
  return {
    discordGuildId,
    runKey,
    durationMilliseconds: Date.now() - startedAt,
    selectedGroups: result.selectedGroups,
    registeredCharactersChecked: result.registeredCharactersChecked,
    managedRosterCharacters: result.managedRosterCharacters,
    profilesApplied: result.profilesApplied,
    profilesOrphaned: result.profilesOrphaned,
    usersReconciled: result.usersReconciled,
    outcomeCount: result.outcomes.length,
    warningCount: result.warnings.length
  };
}

function getFailureKind(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }

  return "unknown";
}

export function getDueSchedule(schedule: MemberUpdateScheduleRecord, now: Date): DueSchedule | undefined {
  if (schedule.cadence === "weekly" && schedule.weekday !== now.getUTCDay()) {
    return undefined;
  }

  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const scheduledMinutes = schedule.hourUtc * 60 + schedule.minuteUtc;

  if (currentMinutes < scheduledMinutes) {
    return undefined;
  }

  const runKey = formatUtcDateKey(now);
  if (schedule.lastRunKey === runKey) {
    return undefined;
  }

  return { schedule, runKey };
}

function formatUtcDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
