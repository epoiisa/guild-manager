import type { Logger } from "../logging/logger.js";

export const DISCORD_DISCONNECT_WATCHDOG_MS = 5 * 60 * 1_000;

export interface DiscordLifecycleOptions {
  logger: Logger;
  startWork(): void;
  stopWork(): void;
  onWatchdogExpired(): void;
  watchdogMilliseconds?: number;
  now?(): number;
}

export interface DiscordLifecycle {
  connected(event: "ready" | "shard-ready" | "shard-resume", shardId?: number): boolean;
  disconnected(event: "shard-disconnect" | "shard-reconnecting", shardId?: number): boolean;
  stop(reason: string): void;
}

export function createDiscordLifecycle(options: DiscordLifecycleOptions): DiscordLifecycle {
  let active = false;
  let stopped = false;
  let watchdog: NodeJS.Timeout | undefined;
  let disconnectStartedAt: number | undefined;
  let disconnectStartEvent: "shard-disconnect" | "shard-reconnecting" | undefined;
  let disconnectStartShardId: number | undefined;

  function now(): number {
    return options.now?.() ?? Date.now();
  }

  function clearWatchdog(): void {
    if (!watchdog) return;
    clearTimeout(watchdog);
    watchdog = undefined;
  }

  function startWatchdog(): void {
    if (watchdog || stopped) return;
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (stopped || active) return;
      options.logger.error("discord disconnect watchdog expired", {
        timeoutMilliseconds: options.watchdogMilliseconds ?? DISCORD_DISCONNECT_WATCHDOG_MS
      });
      options.onWatchdogExpired();
    }, options.watchdogMilliseconds ?? DISCORD_DISCONNECT_WATCHDOG_MS);
  }

  return {
    connected(event, shardId): boolean {
      if (stopped) return false;
      clearWatchdog();
      if (active) {
        options.logger.debug("discord connection event while runtime work is active", { event, shardId });
        return false;
      }
      active = true;
      options.startWork();
      if (disconnectStartedAt !== undefined && disconnectStartEvent !== undefined) {
        options.logger.info("discord runtime work recovered", {
          durationMilliseconds: now() - disconnectStartedAt,
          startEvent: disconnectStartEvent,
          startShardId: disconnectStartShardId,
          recoveryEvent: event,
          recoveryShardId: shardId
        });
        disconnectStartedAt = undefined;
        disconnectStartEvent = undefined;
        disconnectStartShardId = undefined;
      } else {
        options.logger.info("discord runtime work started", { event, shardId });
      }
      return true;
    },

    disconnected(event, shardId): boolean {
      if (stopped) return false;
      if (disconnectStartedAt === undefined) {
        disconnectStartedAt = now();
        disconnectStartEvent = event;
        disconnectStartShardId = shardId;
      }
      if (active) {
        active = false;
        options.stopWork();
      }
      startWatchdog();
      return true;
    },

    stop(reason): void {
      if (stopped) return;
      stopped = true;
      clearWatchdog();
      if (active) {
        active = false;
        options.stopWork();
      }
      options.logger.info("discord runtime lifecycle stopped", { reason });
    }
  };
}
