import { Collection } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSnapshot } from "../db/contentRepository.js";
import type { Logger } from "../logging/logger.js";
import {
  archiveContent,
  buildArchiveContentResultEmbed,
  buildFinishContentResultEmbed,
  buildStartContentResultEmbed,
  finishContent,
  handleContentButton,
  startContent
} from "./content.js";

test("a repeated finish reports the persisted terminal state instead of false success", async () => {
  const snapshot = contentSnapshot("cancelled");
  const repository = {
    markEnded: async () => undefined,
    markCancelled: async () => undefined,
    getContentSnapshot: async () => snapshot
  } as unknown as Parameters<typeof finishContent>[1];

  const result = await finishContent(
    {} as Parameters<typeof finishContent>[0],
    repository,
    snapshot,
    "end"
  );

  assert.deepEqual(result, { outcome: "unchanged", state: "cancelled" });
  assert.equal(buildFinishContentResultEmbed("end", result).toJSON().title, "Content Already Cancelled");
});

test("archive refreshes lifecycle state and uses the current interaction thread without refetching it", async () => {
  const staleSnapshot = contentSnapshot("scheduled");
  const currentSnapshot = contentSnapshot("cancelled");
  const threadUpdates: string[] = [];
  let fetchCount = 0;
  const interaction = {
    channel: {
      id: "party-thread",
      isThread: () => true,
      setLocked: async () => {
        threadUpdates.push("locked");
      },
      setArchived: async () => {
        threadUpdates.push("archived");
      }
    },
    client: {
      channels: {
        fetch: async () => {
          fetchCount += 1;
          throw new Error("The current interaction thread should not be fetched again.");
        }
      }
    }
  } as unknown as Parameters<typeof archiveContent>[0];
  const archivedContentIds: string[] = [];
  const repository = {
    getContentSnapshot: async () => currentSnapshot,
    markArchived: async (_guildId: string, contentId: string) => {
      archivedContentIds.push(contentId);
      return { ...currentSnapshot.content, state: "archived" as const };
    }
  } as unknown as Parameters<typeof archiveContent>[1];

  const result = await archiveContent(interaction, repository, testLogger(), staleSnapshot);

  assert.equal(result, "archived");
  assert.equal(fetchCount, 0);
  assert.deepEqual(threadUpdates, ["locked", "archived"]);
  assert.deepEqual(archivedContentIds, ["content-1"]);
});

test("archive exposes and logs a thread lookup failure instead of reporting a lifecycle error", async () => {
  const snapshot = contentSnapshot("cancelled");
  const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const logger = testLogger({
    warn: (message, context) => warnings.push({ message, context })
  });
  const interaction = {
    channel: null,
    client: {
      channels: {
        fetch: async () => {
          throw new Error("Unknown Channel");
        }
      }
    }
  } as unknown as Parameters<typeof archiveContent>[0];
  const repository = {
    getContentSnapshot: async () => snapshot
  } as unknown as Parameters<typeof archiveContent>[1];

  const result = await archiveContent(interaction, repository, logger, snapshot);

  assert.equal(result, "thread-unavailable");
  assert.equal(buildArchiveContentResultEmbed(result).toJSON().title, "Content Thread Unavailable");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "content thread lookup failed during archive");
  assert.equal(warnings[0].context?.error, "Unknown Channel");
});

function testLogger(overrides: Partial<Logger> = {}): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    ...overrides
  };
}

function contentSnapshot(state: ContentSnapshot["content"]["state"]): ContentSnapshot {
  return {
    content: {
      contentId: "content-1",
      discordGuildId: "guild-1",
      sourceChannelId: "content-channel",
      threadChannelId: "party-thread",
      hostDiscordUserId: "host-1",
      title: "Soup Skip",
      description: "",
      scheduledStartAt: new Date("2026-08-16T12:00:00.000Z"),
      state,
      announcementMessageId: "announcement-1",
      detailsMessageId: "details-1",
      controlMessageId: "control-1",
      startNotificationMessageId: null,
      lastRenderedAt: null,
      startedAt: null,
      endedAt: null,
      cancelledAt: state === "cancelled" ? new Date("2026-08-14T13:56:00.000Z") : null,
      archivedAt: null,
      createdAt: new Date("2026-08-14T13:45:00.000Z"),
      updatedAt: new Date("2026-08-14T13:56:00.000Z")
    },
    slots: [],
    signups: []
  };
}


function startHarness(failure: "none" | "fetch" | "send" | "save" | "missing-parent") {
  const snapshot = contentSnapshot("unscheduled");
  snapshot.content.scheduledStartAt = null;
  snapshot.slots = [{ contentRoleSlotId: "slot", contentId: "content-1", discordGuildId: "guild-1", slotIndex: 1, label: "Tank" }];
  snapshot.signups = [{ discordUserId: "role-user", signupType: "role", contentRoleSlotId: "slot" }, { discordUserId: "standby-user", signupType: "standby", contentRoleSlotId: null }] as ContentSnapshot["signups"];
  let startClaimed = false;
  let notificationClaimed = false;
  const sends: Array<{ allowedMentions: { users: string[] } }> = [];
  const repository = {
    isHostAuthorityRevoked: async () => false,
    markStarted: async () => {
      if (startClaimed) return undefined;
      startClaimed = true;
      snapshot.content.state = "active";
      snapshot.content.startedAt = new Date();
      snapshot.content.startRevision = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      return snapshot.content;
    },
    claimStartNotification: async () => {
      if (notificationClaimed) return false;
      notificationClaimed = true;
      snapshot.content.startNotificationClaimedAt = new Date();
      return true;
    },
    getContentSnapshot: async () => snapshot,
    markRendered: async () => undefined,
    setStartNotificationMessage: async (_guild: string, _content: string, id: string) => {
      if (failure === "save") throw new Error("ambiguous save");
      snapshot.content.startNotificationMessageId = id;
      return true;
    }
  } as unknown as Parameters<typeof startContent>[1];
  const message = { pinned: true, unpin: async () => undefined, author: { id: "bot" }, attachments: new Collection(), edit: async () => undefined };
  const thread = {
    client: { user: { id: "bot" } },
    isThread: () => true,
    messages: { fetch: async ({ message: id }: { message: string }) => ({ ...message, id }) },
    send: async (payload: typeof sends[number]) => {
      sends.push(payload);
      if (failure === "send") throw new Error("ambiguous send");
      return { id: sends.length === 1 ? "start-message" : `continuation-${sends.length}` };
    }
  };
  const interaction = { guild: { client: { user: { id: "bot" } }, channels: { fetch: async (id: string) => {
    if (failure === "fetch") { failure = "none"; throw new Error("temporary fetch failure"); }
    return id === "content-channel" ? { messages: { fetch: async () => {
      if (failure === "missing-parent") throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      return message;
    } } } : thread;
  } } } } as unknown as Parameters<typeof startContent>[0];
  return { interaction, repository, snapshot, sends };
}

test("concurrent manual starts and retries notify role and standby users only once", async () => {
  const h = startHarness("none");
  const results = await Promise.all([startContent(h.interaction, h.repository, testLogger(), h.snapshot), startContent(h.interaction, h.repository, testLogger(), h.snapshot)]);
  assert.ok(results.includes("started"));
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0].allowedMentions.users, ["role-user", "standby-user"]);
  const startedAt = h.snapshot.content.startedAt;
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "already-started");
  assert.equal(h.snapshot.content.startedAt, startedAt);
  assert.equal(h.sends.length, 1);
});

for (const failure of ["none", "save"] as const) {
  test(`large start delivery uses one message and never replays after ${failure}`, async () => {
    const h = startHarness(failure);
    h.snapshot.content.multiSignupEnabled = true;
    h.snapshot.signups = Array.from({ length: 205 }, (_, index) => ({
      ...h.snapshot.signups[0], discordUserId: String(100000000000000000n + BigInt(index))
    }));
    assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot),
      failure === "none" ? "started" : "notification-uncertain");
    assert.equal(h.sends.length, 1);
    assert.equal(h.snapshot.content.startNotificationMessageId, failure === "none" ? "start-message" : null);
    assert.ok(h.snapshot.content.startNotificationClaimedAt);
    assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot),
      failure === "none" ? "already-started" : "notification-uncertain");
    assert.equal(h.sends.length, 1);
    const users = h.sends.flatMap(p => p.allowedMentions.users);
    assert.equal(new Set(users).size, users.length);
    assert.deepEqual(users, h.snapshot.signups.slice(0, 100).map(s => s.discordUserId));
  });
}

test("a failed cancellation continuation reports partial delivery without repeating the saved cancellation", async () => {
  const snapshot = contentSnapshot("active");
  snapshot.signups = Array.from({ length: 205 }, (_, index) => ({ discordUserId: String(100000000000000000n + BigInt(index)) })) as ContentSnapshot["signups"];
  let sends = 0, cancellations = 0;
  const repository = {
    markCancelled: async () => {
      if (snapshot.content.state === "cancelled") return undefined;
      cancellations++;
      snapshot.content.state = "cancelled";
      return snapshot.content;
    },
    getContentSnapshot: async () => snapshot
  } as never;
  const interaction = { client: { channels: { fetch: async () => ({ send: async () => {
    sends++;
    if (sends === 2) throw new Error("ambiguous continuation delivery");
    return { id: "primary" };
  } }) } } } as never;
  const result = await finishContent(interaction, repository, snapshot, "cancel");
  assert.deepEqual(result, { outcome: "updated", state: "cancelled", partial: true });
  assert.equal(sends, 2);
  assert.deepEqual(await finishContent(interaction, repository, snapshot, "cancel"), { outcome: "unchanged", state: "cancelled" });
  assert.equal(cancellations, 1);
  assert.equal(sends, 2);
});

test("Start on the thread details message starts the party and notifies signups in its thread", async () => {
  const h = startHarness("none");
  const replies: unknown[] = [];
  await handleContentButton({
    ...h.interaction,
    customId: "content:start:content-1", inCachedGuild: () => true,
    guildId: "guild-1", channelId: "party-thread",
    message: { id: "details-1" }, user: { id: "host-1" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { replies.push(payload); }
  } as unknown as Parameters<typeof handleContentButton>[0], h.repository, testLogger());
  assert.equal(h.snapshot.content.state, "active");
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0].allowedMentions.users, ["role-user", "standby-user"]);
  assert.match(JSON.stringify(replies), /The content signup was started/);
});

test("pre-send failure permits manual retry without moving the start timestamp", async () => {
  const h = startHarness("fetch");
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "notification-failed");
  const startedAt = h.snapshot.content.startedAt;
  assert.equal(h.sends.length, 0);
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "started");
  assert.equal(h.snapshot.content.startedAt, startedAt);
  assert.equal(h.sends.length, 1);
});

test("ambiguous send retains its claim and prevents a deliberately repeated ping", async () => {
  const h = startHarness("send");
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "notification-uncertain");
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "notification-uncertain");
  assert.equal(h.sends.length, 1);
});

test("expired manual start reports refusal without touching Discord", async () => {
  const snapshot = contentSnapshot("unscheduled");
  snapshot.content.scheduledStartAt = null;
  const repository = { markStarted: async () => undefined, getContentSnapshot: async () => snapshot } as unknown as Parameters<typeof startContent>[1];
  const result = await startContent({} as never, repository, testLogger(), snapshot);
  assert.equal(result, "not-open");
  assert.equal(buildStartContentResultEmbed(result).data.title, "Content Not Started");
});

test("a deleted parent announcement does not prevent start notification in the intact thread", async () => {
  const h = startHarness("missing-parent");
  assert.equal(await startContent(h.interaction, h.repository, testLogger(), h.snapshot), "started");
  assert.equal(h.sends.length, 1);
});

test("an announcement retry after the active deadline cannot notify before cleanup runs", async () => {
  const snapshot = contentSnapshot("active");
  snapshot.content.scheduledStartAt = null;
  snapshot.content.startedAt = new Date(Date.now() - 7 * 3600000);
  const repository = {
    markStarted: async () => undefined,
    getContentSnapshot: async () => snapshot,
    claimStartNotification: async () => { throw new Error("Expired content must not claim a notification."); }
  } as unknown as Parameters<typeof startContent>[1];
  assert.equal(await startContent({} as never, repository, testLogger(), snapshot), "not-open");
});

for (const action of ["end", "cancel"] as const) {
  test(`${action} still posts its terminal Archive control after saved closure and failed approval refresh`, async () => {
    const snapshot = contentSnapshot("active");
    snapshot.content.approvalRequired = true;
    const events: string[] = [];
    const posts: unknown[] = [];
    let closed = false;
    const close = async () => {
      if (closed) return undefined;
      closed = true;
      snapshot.content.state = action === "end" ? "ended" : "cancelled";
      events.push("closed");
      return snapshot.content;
    };
    const repository = {
      markEnded: close, markCancelled: close,
      getContentSnapshot: async () => snapshot,
      reconcileSignupRequestClosure: async () => {
        events.push("approval-refresh-failed");
        throw Error("Request cleanup unavailable");
      }
    } as unknown as Parameters<typeof finishContent>[1];
    const interaction = {
      user: { id: "host-1" },
      guild: { id: "guild-1", channels: { fetch: async () => null } },
      client: { channels: { fetch: async () => ({ send: async (payload: unknown) => {
        events.push("terminal-posted"); posts.push(payload);
      } }) } }
    } as unknown as Parameters<typeof finishContent>[0];

    const result = await finishContent(interaction, repository, snapshot, action);
    assert.deepEqual(result, { outcome: "updated", state: action === "end" ? "ended" : "cancelled", partial: true });
    assert.deepEqual(events, ["closed", "approval-refresh-failed", "terminal-posted"]);
    assert.match(JSON.stringify(posts[0]), /content:archive:content-1/);
    const warning = buildFinishContentResultEmbed(action, result).toJSON();
    assert.match(warning.title!, /With Warning/);
    assert.match(warning.description!, /closed to signups.*could not finish updating its messages/);

    const retry = await finishContent(interaction, repository, snapshot, action);
    assert.equal(retry.outcome, "unchanged");
    assert.equal(posts.length, 1, "Retry cannot repeat a terminal post after saved closure");
  });
}

test("failed terminal delivery reports saved closure instead of throwing", async () => {
  const snapshot = contentSnapshot("ended");
  const result = await finishContent({
    user: { id: "host-1" },
    client: { channels: { fetch: async () => ({ send: async () => { throw Error("Send unavailable"); } }) } }
  } as never, {
    markEnded: async () => snapshot.content,
    getContentSnapshot: async () => snapshot
  } as never, snapshot, "end");
  assert.deepEqual(result, { outcome: "updated", state: "ended", partial: true });
});
