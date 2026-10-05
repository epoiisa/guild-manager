import type { Guild } from "discord.js";
import type { ContentItem, createContentRepository } from "../../db/contentRepository.js";
import type { Logger } from "../../logging/logger.js";
import { refreshContentMessages } from "./messages.js";
import { deliverStartNotification } from "./startNotification.js";
import { reconcileSignupApprovals } from "./signupApproval.js";
import { buildThreadTitle } from "./threadTitle.js";
import type { MemberActionGuard } from "../../runtime/memberActionGuard.js";

type ContentRepository = ReturnType<typeof createContentRepository>;

const LIFECYCLE_INTERVAL_MS = 60 * 1000;
const RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ContentScheduler {
  runDueContent(guilds?: Iterable<Guild>, now?: Date): Promise<void>;
  runContentReconciliation(guilds?: Iterable<Guild>, now?: Date): Promise<void>;
  startScheduler(getGuilds: () => Iterable<Guild>): void;
  stopScheduler(): void;
}

export function createContentScheduler(repository: ContentRepository, logger: Logger, panels?: { runPanels(guilds: Iterable<Guild>, now?: Date): Promise<void> }, actionGuard?: Pick<MemberActionGuard, "runSystem">): ContentScheduler {
  const runGuild = <T>(guild: Guild, work: () => Promise<T>) => actionGuard ? actionGuard.runSystem(guild.id, work) : work();
  let scheduler: NodeJS.Timeout | undefined;
  let schedulerActive = false;
  let lifecycleRunning = false;
  let reconciliationRunning = false;
  let startupMessageReconciliationPending = true;
  let panelRunning = false;
  let schedulerEpoch = 0;

  async function runDueContent(guilds?: Iterable<Guild>, now = new Date()): Promise<void> {
    if (lifecycleRunning) return;

    lifecycleRunning = true;
    try {
      const guildById = new Map(Array.from(guilds ?? []).map((guild) => [guild.id, guild]));
      const allowedGuildIds = guilds ? new Set(guildById.keys()) : undefined;
      const dueStarts = (await repository.listContentDueStart(now))
        .filter((content) => !allowedGuildIds || allowedGuildIds.has(content.discordGuildId));
      for (const content of dueStarts) {
        const guild = guildById.get(content.discordGuildId);
        if (guild) await runGuild(guild, () => startDueContent(guild, content, now));
      }

      const dueCleanups = (await repository.listContentDueCleanup(now))
        .filter((content) => !allowedGuildIds || allowedGuildIds.has(content.discordGuildId));
      for (const content of dueCleanups) {
        const guild = guildById.get(content.discordGuildId);
        if (guild) await runGuild(guild, () => cleanupDueContent(guild, content, now));
      }
    } finally {
      lifecycleRunning = false;
    }
  }

  async function runContentReconciliation(guilds?: Iterable<Guild>, now = new Date()): Promise<void> {
    if (reconciliationRunning) return;

    reconciliationRunning = true;
    try {
      const guildById = new Map(Array.from(guilds ?? []).map((guild) => [guild.id, guild]));
      const allowedGuildIds = guilds ? new Set(guildById.keys()) : undefined;
      // Rendering changes need adoption even when the saved data revision has
      // already been rendered by the previous runtime. Retry if a refresh fails.
      const missingControls = (await repository.listContentNeedingControlMessage(startupMessageReconciliationPending))
        .filter((content) => !allowedGuildIds || allowedGuildIds.has(content.discordGuildId));
      let messagesComplete = true;
      for (const content of missingControls) {
        const guild = guildById.get(content.discordGuildId);
        if (guild) messagesComplete = await runGuild(guild, () => reconcileContentMessages(guild, content)) && messagesComplete;
      }
      if (messagesComplete) startupMessageReconciliationPending = false;

      const approvalContent = (await repository.listContentNeedingSignupApprovalReconciliation())
        .filter((content) => !allowedGuildIds || allowedGuildIds.has(content.discordGuildId));
      for (const content of approvalContent) {
        const guild = guildById.get(content.discordGuildId);
        if (!guild) continue;
        const result = await runGuild(guild, () => reconcileSignupApprovals(guild, repository, content.contentId));
        if (!result.complete) logger.error("content signup request reconciliation incomplete", {
          guildId: guild.id, contentId: content.contentId, threadId: content.threadChannelId
        });
      }

      const contentForThreadTitleReconciliation = (await repository.listContentForThreadTitleReconciliation())
        .filter((content) => !allowedGuildIds || allowedGuildIds.has(content.discordGuildId));
      for (const content of contentForThreadTitleReconciliation) {
        const guild = guildById.get(content.discordGuildId);
        if (guild) await runGuild(guild, () => reconcileThreadTitle(guild, content, now));
      }
    } finally {
      reconciliationRunning = false;
    }
  }

  async function reconcileThreadTitle(guild: Guild, content: ContentItem, now: Date): Promise<void> {
    try {
      const thread = await guild.channels.fetch(content.threadChannelId).catch(() => null);
      if (!thread?.isThread()) return;
      const expectedName = buildThreadTitle(content.title, content.scheduledStartAt, now);
      if (thread.name === expectedName) return;
      await thread.setName(expectedName, "Reconcile Guild Manager content thread title");
      logger.info("reconciled content thread title", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        threadId: content.threadChannelId
      });
    } catch (error) {
      logger.error("content thread title reconciliation failed", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function startDueContent(guild: Guild, content: ContentItem, now: Date): Promise<void> {
    try {
      const snapshot = await repository.getContentSnapshot(content.discordGuildId, content.contentId);
      if (!snapshot || (snapshot.content.state !== "active" && snapshot.content.scheduledStartAt === null)) return;
      const thread = await guild.channels.fetch(snapshot.content.threadChannelId).catch(() => null);
      if (!thread) {
        logger.warn("content thread missing at scheduled start", {
          guildId: guild.id,
          guildName: guild.name,
          contentId: snapshot.content.contentId,
          threadId: snapshot.content.threadChannelId
        });
        return;
      }
      // Pre-send failures leave an active party with no delivery claim. Retry
      // presentation and delivery without changing its original start or expiry.
      if (snapshot.content.state !== "active") {
        const started = await repository.markStarted(snapshot.content.discordGuildId, snapshot.content.contentId, now);
        if (!started) return;
      }
      const fresh = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
      if (!fresh) return;
      await deliverStartNotification(guild, repository, fresh);
      logger.info("content auto-started", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: fresh.content.contentId,
        threadId: fresh.content.threadChannelId
      });
    } catch (error) {
      logger.error("content auto-start failed", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function cleanupDueContent(guild: Guild, content: ContentItem, now: Date): Promise<void> {
    try {
      const claimed = await repository.claimContentDueCleanup(content.discordGuildId, content.contentId, now);
      if (!claimed) return;
      const thread = await guild.channels.fetch(claimed.threadChannelId).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 10003) return null;
        throw error;
      });
      if (!thread) {
        const deleted = await repository.deleteContent(content.discordGuildId, content.contentId);
        if (deleted) {
          logger.info("deleted content record for missing thread", {
            guildId: guild.id,
            guildName: guild.name,
            contentId: content.contentId,
            threadId: content.threadChannelId
          });
        }
        return;
      }

      const snapshot = await repository.getContentSnapshot(content.discordGuildId, content.contentId);
      if (snapshot) {
        try { await refreshContentMessages(guild, repository, snapshot, undefined, "controls"); }
        catch (error) {
          // Domain closure is already committed. A failed card edit must not keep
          // an expired thread open; its durable presentation remains repairable.
          logger.warn("content closed with presentation repair outstanding", {
            guildId: guild.id, contentId: content.contentId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (thread.isThread()) {
        await thread.setLocked(true, "Close and lock stale Guild Manager content signup thread");
        await thread.setArchived(true, "Close stale Guild Manager content signup thread");
      }
      await repository.markArchived(content.discordGuildId, content.contentId);
      logger.info("auto-archived stale content", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        threadId: content.threadChannelId
      });
    } catch (error) {
      logger.error("content cleanup failed", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function reconcileContentMessages(guild: Guild, content: ContentItem): Promise<boolean> {
    try {
      const snapshot = await repository.getContentSnapshot(content.discordGuildId, content.contentId);
      if (!snapshot) return true;
      await refreshContentMessages(guild, repository, snapshot);
      logger.info("reconciled content announcement and thread controls", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        threadId: content.threadChannelId
      });
      return true;
    } catch (error) {
      logger.error("content message reconciliation failed", {
        guildId: guild.id,
        guildName: guild.name,
        contentId: content.contentId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async function runScheduledPass(getGuilds: () => Iterable<Guild>, now: Date, includeReconciliation: boolean): Promise<void> {
    const epoch = schedulerEpoch;
    const guilds = Array.from(getGuilds());
    await runDueContent(guilds, now).catch((error) => {
      logger.error("failed to run content lifecycle scheduler", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    if (schedulerActive && epoch === schedulerEpoch && panels && !panelRunning) {
      panelRunning = true;
      void panels.runPanels(guilds, now).catch(() => {
        logger.error("failed to run Content panel reconciliation");
      }).finally(() => { panelRunning = false; });
    }
    if (!includeReconciliation || !schedulerActive || epoch !== schedulerEpoch) return;
    await runContentReconciliation(guilds, now).catch((error) => {
      logger.error("failed to run content reconciliation scheduler", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  function scheduleNextRun(getGuilds: () => Iterable<Guild>): void {
    if (!schedulerActive) return;

    const now = Date.now();
    const nextBoundary = Math.ceil((now + 1) / LIFECYCLE_INTERVAL_MS) * LIFECYCLE_INTERVAL_MS;
    const delay = Math.max(1000, nextBoundary - now);

    const epoch = schedulerEpoch;
    scheduler = setTimeout(() => {
      if (!schedulerActive || epoch !== schedulerEpoch) return;
      const scheduledAt = new Date();
      const includeReconciliation = isContentReconciliationBoundary(scheduledAt);
      void runScheduledPass(getGuilds, scheduledAt, includeReconciliation)
        .finally(() => { if (epoch === schedulerEpoch) scheduleNextRun(getGuilds); });
    }, delay);
  }

  function startScheduler(getGuilds: () => Iterable<Guild>): void {
    if (schedulerActive) return;

    schedulerActive = true;
    startupMessageReconciliationPending = true;
    void runScheduledPass(getGuilds, new Date(), true);
    scheduleNextRun(getGuilds);
  }

  function stopScheduler(): void {
    schedulerActive = false;
    schedulerEpoch++;
    if (scheduler) clearTimeout(scheduler);
    scheduler = undefined;
  }

  return {
    runDueContent,
    runContentReconciliation,
    startScheduler,
    stopScheduler
  };
}

export function isContentReconciliationBoundary(now: Date): boolean {
  return Math.floor(now.getTime() / LIFECYCLE_INTERVAL_MS)
    % (RECONCILIATION_INTERVAL_MS / LIFECYCLE_INTERVAL_MS) === 0;
}
