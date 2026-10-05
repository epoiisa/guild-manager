import assert from "node:assert/strict";
import test from "node:test";
import type { Guild } from "discord.js";
import type { ContentItem, createContentRepository } from "../../db/contentRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createContentScheduler, isContentReconciliationBoundary } from "./scheduler.js";

type ContentRepository = ReturnType<typeof createContentRepository>;

test("the content scheduler removes the weekday when the UTC date is reached", async () => {
  const content = contentItem();
  let titleReconciliations = 0;
  const renamed: string[] = [];
  const repository = {
    listContentNeedingSignupApprovalReconciliation: async () => [],
    listContentNeedingControlMessage: async () => [],
    listContentForThreadTitleReconciliation: async () => {
      titleReconciliations += 1;
      return [content];
    },
    listContentDueStart: async () => [],
    listContentDueCleanup: async () => []
  } as unknown as ContentRepository;
  const thread = {
    name: "Avalonian Dungeon Monday 12 UTC",
    isThread: () => true,
    setName: async (name: string) => {
      renamed.push(name);
      thread.name = name;
    }
  };
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    channels: {
      fetch: async () => thread
    }
  } as unknown as Guild;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown as Logger;

  const scheduler = createContentScheduler(repository, logger);
  await scheduler.runContentReconciliation(
    [guild],
    new Date("2026-08-10T00:00:00.000Z")
  );
  await scheduler.runContentReconciliation(
    [guild],
    new Date("2026-08-10T00:01:00.000Z")
  );

  assert.equal(titleReconciliations, 2);
  assert.deepEqual(renamed, ["Avalonian Dungeon 12 UTC"]);
});

test("the content scheduler cleans up active and finished parties after six hours", async () => {
  const active = contentItem({ contentId: "active-content", state: "active" });
  const cancelled = contentItem({ contentId: "cancelled-content", state: "cancelled" });
  const cleanupCutoffs: Date[] = [];
  const claimedContentIds: string[] = [];
  const archivedContentIds: string[] = [];
  const threadUpdates: string[] = [];
  const repository = {
    listContentNeedingSignupApprovalReconciliation: async () => [],
    listContentNeedingControlMessage: async () => [],
    listContentForThreadTitleReconciliation: async () => [],
    listContentDueStart: async () => [],
    listContentDueCleanup: async (cutoff: Date) => {
      cleanupCutoffs.push(cutoff);
      return [active, cancelled];
    },
    claimContentDueCleanup: async (_guildId: string, contentId: string) => {
      claimedContentIds.push(contentId);
      return contentId === active.contentId ? active : cancelled;
    },
    markArchived: async (_guildId: string, contentId: string) => {
      archivedContentIds.push(contentId);
      return contentId === active.contentId ? active : cancelled;
    },
    getContentSnapshot: async () => undefined
  } as unknown as ContentRepository;
  const thread = {
    isThread: () => true,
    setLocked: async () => {
      threadUpdates.push("locked");
    },
    setArchived: async () => {
      threadUpdates.push("archived");
    }
  };
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    channels: {
      fetch: async () => thread
    }
  } as unknown as Guild;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown as Logger;

  const scheduler = createContentScheduler(repository, logger);
  await scheduler.runDueContent([guild], new Date("2026-08-10T18:00:00.000Z"));

  assert.deepEqual(cleanupCutoffs, [new Date("2026-08-10T18:00:00.000Z")]);
  assert.deepEqual(claimedContentIds, ["active-content", "cancelled-content"]);
  assert.deepEqual(archivedContentIds, ["active-content", "cancelled-content"]);
  assert.deepEqual(threadUpdates, ["locked", "archived", "locked", "archived"]);
});

test("the content scheduler schedules lifecycle checks on minute boundaries", async (context) => {
  const delays: number[] = [];
  context.mock.method(Date, "now", () => Date.parse("2026-08-10T01:00:00.000Z"));
  context.mock.method(globalThis, "setTimeout", ((_: TimerHandler, delay?: number) => {
    delays.push(Number(delay));
    return {} as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  const repository = {
    listContentNeedingSignupApprovalReconciliation: async () => [],
    listContentNeedingControlMessage: async () => [],
    listContentForThreadTitleReconciliation: async () => [],
    listContentDueStart: async () => [],
    listContentDueCleanup: async () => []
  } as unknown as ContentRepository;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown as Logger;

  const scheduler = createContentScheduler(repository, logger);
  scheduler.startScheduler(() => []);
  scheduler.stopScheduler();

  assert.deepEqual(delays, [60 * 1000]);
});

test("content reconciliation runs only on six-hour UTC boundaries", () => {
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T00:00:00.000Z")), true);
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T06:00:00.000Z")), true);
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T12:00:00.000Z")), true);
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T18:00:00.000Z")), true);
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T05:59:00.000Z")), false);
  assert.equal(isContentReconciliationBoundary(new Date("2026-08-10T06:01:00.000Z")), false);
});

test("minute lifecycle checks do not run broad content reconciliation", async () => {
  let dueStartChecks = 0;
  let dueCleanupChecks = 0;
  const repository = {
    listContentDueStart: async () => {
      dueStartChecks += 1;
      return [];
    },
    listContentDueCleanup: async () => {
      dueCleanupChecks += 1;
      return [];
    },
    listContentNeedingSignupApprovalReconciliation: async () => [],
    listContentNeedingControlMessage: async () => {
      throw new Error("Lifecycle checks must not reconcile content messages.");
    },
    listContentForThreadTitleReconciliation: async () => {
      throw new Error("Lifecycle checks must not reconcile thread titles.");
    }
  } as unknown as ContentRepository;
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  } as unknown as Logger;

  const scheduler = createContentScheduler(repository, logger);
  await scheduler.runDueContent([], new Date("2026-08-10T12:01:00.000Z"));

  assert.equal(dueStartChecks, 1);
  assert.equal(dueCleanupChecks, 1);
});

function contentItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    contentId: "content-1",
    discordGuildId: "guild-1",
    sourceChannelId: "content-channel",
    threadChannelId: "party-thread",
    hostDiscordUserId: "host-1",
    title: "Avalonian Dungeon",
    description: "Bring swaps and food.",
    scheduledStartAt: new Date("2026-08-10T12:00:00.000Z"),
    state: "scheduled",
    announcementMessageId: "announcement-1",
    detailsMessageId: "details-1",
    controlMessageId: "control-1",
    startNotificationMessageId: null,
    lastRenderedAt: null,
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    archivedAt: null,
    createdAt: new Date("2026-08-09T12:00:00.000Z"),
    updatedAt: new Date("2026-08-09T12:00:00.000Z"),
    ...overrides
  };
}


test("cleanup rechecks a stale waiting candidate before touching Discord", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "unscheduled" });
  let fetched = false;
  const repository = {
    listContentDueStart: async () => [],
    listContentDueCleanup: async () => [content],
    claimContentDueCleanup: async () => undefined
  } as unknown as ContentRepository;
  const guild = { id: "guild-1", channels: { fetch: async () => { fetched = true; } } } as unknown as Guild;
  await createContentScheduler(repository, quietLogger()).runDueContent([guild]);
  assert.equal(fetched, false);
});

test("waiting unscheduled cleanup stays silent and retries Discord failures before archiving", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "unscheduled" });
  let attempts = 0;
  let archived = false;
  const repository = {
    listContentDueStart: async () => [],
    listContentDueCleanup: async () => archived ? [] : [content],
    claimContentDueCleanup: async () => ({ ...content, state: "ended" }),
    getContentSnapshot: async () => undefined,
    markArchived: async () => { archived = true; }
  } as unknown as ContentRepository;
  const thread = {
    isThread: () => true,
    send: async () => { throw new Error("Cleanup must never send a start notification"); },
    setLocked: async () => undefined,
    setArchived: async () => { if (++attempts === 1) throw new Error("Temporary Discord failure"); }
  };
  const guild = { id: "guild-1", channels: { fetch: async () => thread } } as unknown as Guild;
  const scheduler = createContentScheduler(repository, quietLogger());
  await scheduler.runDueContent([guild]);
  assert.equal(archived, false);
  await scheduler.runDueContent([guild]);
  assert.equal(archived, true);
  assert.equal(attempts, 2);
});

test("cleanup removes a missing thread only after a successful persisted claim", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "unscheduled" });
  let deleted = false;
  const repository = {
    listContentDueStart: async () => [], listContentDueCleanup: async () => [content],
    claimContentDueCleanup: async () => content,
    deleteContent: async (guildId: string, contentId: string) => {
      assert.equal(guildId, content.discordGuildId); assert.equal(contentId, content.contentId);
      deleted = true; return true;
    }
  } as unknown as ContentRepository;
  const guild = { id: "guild-1", channels: { fetch: async () => null } } as unknown as Guild;
  await createContentScheduler(repository, quietLogger()).runDueContent([guild]);
  assert.equal(deleted, true);
});

function quietLogger(): Logger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
}


test("a failed thread lookup preserves claimed content for the next cleanup pass", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "unscheduled" });
  let deleted = false;
  const repository = {
    listContentDueStart: async () => [], listContentDueCleanup: async () => [content],
    claimContentDueCleanup: async () => ({ ...content, state: "ended" }),
    deleteContent: async () => { deleted = true; return true; }
  } as unknown as ContentRepository;
  const guild = { id: "guild-1", channels: { fetch: async () => { throw new Error("Temporary network error"); } } } as unknown as Guild;
  await createContentScheduler(repository, quietLogger()).runDueContent([guild]);
  assert.equal(deleted, false);
});


test("cleanup archives the expired thread even when control presentation needs repair", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "ended", announcementMessageId: null });
  let archived = false;
  let fetches = 0;
  const repository = {
    listContentDueStart: async () => [], listContentDueCleanup: async () => [content],
    claimContentDueCleanup: async () => content,
    getContentSnapshot: async () => ({ content, slots: [], signups: [] }),
    markArchived: async () => { archived = true; }
  } as unknown as ContentRepository;
  const thread = { isThread: () => true, setLocked: async () => undefined, setArchived: async () => undefined };
  const guild = { id: "guild-1", channels: { fetch: async () => ++fetches === 1 ? thread : null } } as unknown as Guild;
  await createContentScheduler(repository, quietLogger()).runDueContent([guild]);
  assert.equal(fetches, 2);
  assert.equal(archived, true);
});

test("cleanup can retire controls and archive a thread whose parent announcement was deleted", async () => {
  const content = contentItem({ scheduledStartAt: null, state: "ended", announcementMessageId: null });
  let edited = false;
  let archived = false;
  const repository = {
    listContentDueStart: async () => [], listContentDueCleanup: async () => [content],
    claimContentDueCleanup: async () => content,
    getContentSnapshot: async () => ({ content, slots: [{ contentRoleSlotId: "slot-1", contentId: content.contentId, discordGuildId: "guild-1", slotIndex: 1, label: "Tank" }], signups: [] }),
    markRendered: async () => undefined,
    markArchived: async () => { archived = true; }
  } as unknown as ContentRepository;
  const thread = {
    isThread: () => true, setLocked: async () => undefined, setArchived: async () => undefined,
    client: { user: { id: "bot" } },
    send: async () => { throw new Error("Existing controls must be edited"); },
    messages: { fetch: async ({ message: id }: { message: string }) => ({ id, pinned: id === "control-1", author: { id: "bot" }, edit: async () => { edited = true; } }) }
  };
  const guild = { id: "guild-1", client: { user: { id: "bot" } }, channels: { fetch: async () => thread } } as unknown as Guild;
  const errors: unknown[] = [];
  const logger = { ...quietLogger(), error: (_message: string, fields: unknown) => { errors.push(fields); } } as unknown as Logger;
  await createContentScheduler(repository, logger).runDueContent([guild]);
  assert.deepEqual(errors, []);
  assert.equal(edited, true);
  assert.equal(archived, true);
});

test("panel maintenance follows lifecycle without blocking it, coalesces across reconnect, and resumes", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const repository = {
    listContentDueStart: async () => { calls.push("start"); return []; },
    listContentDueCleanup: async () => { calls.push("cleanup"); return []; },
    listContentNeedingSignupApprovalReconciliation: async () => [],
    listContentNeedingControlMessage: async () => { calls.push("reconcile"); return []; },
    listContentForThreadTitleReconciliation: async () => []
  } as never;
  const scheduler = createContentScheduler(repository, { error() {} } as never, { runPanels: async () => { calls.push("panels"); await new Promise<void>(resolve => { release = resolve; }); } });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    scheduler.startScheduler(() => []);
    await flush();
    assert.deepEqual(calls, ["start", "cleanup", "panels", "reconcile"]);
    scheduler.stopScheduler();
    scheduler.startScheduler(() => []);
    await flush();
    assert.equal(calls.filter(call => call === "panels").length, 1);
    release(); await flush();
    scheduler.stopScheduler(); scheduler.startScheduler(() => []); await flush();
    assert.equal(calls.filter(call => call === "panels").length, 2);
    release();
  } finally { scheduler.stopScheduler(); }
});
