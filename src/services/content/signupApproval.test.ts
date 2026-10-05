import assert from "node:assert/strict";
import test from "node:test";
import { ButtonStyle, Collection, type Guild, type MessageCreateOptions } from "discord.js";
import type { ContentItem, ContentSignupRequest } from "../../db/contentRepository.js";
import { buildSignupOutcomeMessage, buildSignupRequestMessage, reconcileSignupApprovals } from "./signupApproval.js";

const content = { contentId: "party", discordGuildId: "guild", threadChannelId: "thread", hostDiscordUserId: "host", state: "active", approvalRequired: true } as ContentItem;
function request(overrides: Partial<ContentSignupRequest> = {}): ContentSignupRequest {
  return {
    requestId: "request", contentId: "party", discordGuildId: "guild", discordUserId: "member", roleSlotId: "slot", slotIndex: 2, roleLabel: "Tank <@&role>",
    status: "pending", requestMessageId: null, outcomeMessageId: null, requestNotificationClaimedAt: null, outcomeNotificationClaimedAt: null,
    presentationFinishedAt: null, createdAt: new Date("2026-01-01"), resolvedAt: null, ...overrides
  };
}

function fixture(initial = request()) {
  const row = initial;
  const messages = new Collection<string, any>();
  const sent: MessageCreateOptions[] = [];
  const events: string[] = [];
  const failures = { send: false, store: false, delete: false, lookup: false };
  let sequence = 0;
  const thread = {
    client: { user: { id: "bot" } }, isThread: () => true,
    messages: { fetch: async (value: string | object) => {
      if (failures.lookup) throw new Error("temporary lookup failure");
      if (typeof value !== "string") return messages;
      const message = messages.get(value);
      if (!message) throw Object.assign(new Error("Unknown message"), { code: 10008 });
      return message;
    } },
    send: async (payload: MessageCreateOptions) => {
      if (failures.send) throw new Error("send unavailable");
      events.push("send"); sent.push(payload);
      const id = String(++sequence);
      const message = {
        id, author: { id: "bot" }, content: payload.content, components: JSON.parse(JSON.stringify(payload.components ?? [])), nonce: payload.nonce, createdTimestamp: Date.now(),
        edit: async (edit: MessageCreateOptions) => { events.push("edit"); Object.assign(message, { ...edit, components: JSON.parse(JSON.stringify(edit.components ?? message.components)) }); return message; },
        delete: async () => { events.push("delete"); if (failures.delete) throw new Error("delete unavailable"); messages.delete(id); }
      };
      messages.set(id, message);
      return message;
    }
  };
  const repository = {
    reconcileSignupRequestClosure: async () => { if (["ended", "cancelled", "archived"].includes(content.state) && row.status === "pending") row.status = "closed"; },
    getContentSnapshot: async () => ({ content, slots: [], signups: [] }),
    listSignupRequests: async () => [{ ...row }],
    getSignupRequest: async () => ({ ...row }),
    claimSignupRequestNotification: async (_g: string, _c: string, _r: string, kind: "request" | "outcome") => {
      const field = kind === "request" ? "requestNotificationClaimedAt" : "outcomeNotificationClaimedAt";
      if (row[field]) return false;
      row[field] = new Date(); return true;
    },
    setSignupRequestMessage: async (_g: string, _c: string, _r: string, kind: "request" | "outcome", id: string) => {
      if (failures.store) { failures.store = false; throw new Error("store unavailable"); }
      row[kind === "request" ? "requestMessageId" : "outcomeMessageId"] = id; events.push(`store-${kind}`); return true;
    },
    finishSignupRequestPresentation: async () => { row.presentationFinishedAt = new Date(); }
  };
  const guild = { id: "guild", channels: { fetch: async () => thread } } as unknown as Guild;
  const reconcile = (options?: Parameters<typeof reconcileSignupApprovals>[3]) => reconcileSignupApprovals(guild, repository as unknown as Parameters<typeof reconcileSignupApprovals>[1], "party", options);
  return { row, messages, sent, events, failures, reconcile, guild, repository };
}

test("request and outcome text, button styles, and mention allowlists are exact", () => {
  const row = request();
  const payload = buildSignupRequestMessage(content, row, true);
  assert.equal(payload.content, "<@host>, <@member> has requested **2. Tank <@&role>**.");
  const controls = JSON.parse(JSON.stringify(payload.components));
  assert.deepEqual(controls[0].components.map((button: any) => [button.label, button.style]), [["Accept", ButtonStyle.Success], ["Decline", ButtonStyle.Secondary]]);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ["host"], roles: [], repliedUser: false });
  assert.equal(buildSignupOutcomeMessage({ ...row, status: "accepted" }, true).content, "<@member> accepted for role **2. Tank <@&role>**.");
  assert.equal(buildSignupOutcomeMessage({ ...row, status: "declined" }).content, "<@member> not accepted for **2. Tank <@&role>**.");
  assert.equal(buildSignupOutcomeMessage({ ...row, status: "invalidated" }).content, "<@member>, your request for **2. Tank <@&role>** was cleared because that role changed. Choose a role again.");
  for (const status of ["accepted", "declined"] as const) {
    const standby = { ...row, roleSlotId: null, status };
    assert.equal(buildSignupRequestMessage(content, standby).content, "<@host>, <@member> has requested **Standby**.");
    assert.equal(buildSignupOutcomeMessage(standby, true).content, `<@member> ${status === "accepted" ? "accepted" : "not accepted"} for **Standby**.`);
    assert.deepEqual(buildSignupOutcomeMessage(standby, true).allowedMentions?.users, ["member"]);
    assert.deepEqual(buildSignupOutcomeMessage(standby).components, []);
  }
});

test("initial request notifies once; repeats and host transfer edit silently", async () => {
  const f = fixture();
  assert.equal((await f.reconcile({ notifyRequestId: "request" })).complete, true);
  await f.reconcile({ notifyRequestId: "request" });
  content.hostDiscordUserId = "new-host";
  try {
    await f.reconcile();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].allowedMentions?.users, ["host"]);
    assert.match(f.messages.first().content, /^<@new-host>/);
    assert.deepEqual(f.messages.first().allowedMentions.users, []);
  } finally { content.hostDiscordUserId = "host"; }
});

test("deleted pending card repairs silently without changing request identity", async () => {
  const f = fixture();
  await f.reconcile({ notifyRequestId: "request" });
  f.messages.clear();
  await f.reconcile();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[1].allowedMentions?.users, []);
  assert.match(JSON.stringify(f.sent[1]), /content:approval:accept:party:request/);
});

test("ambiguous send claim and failed canonical linking recover without another request or notification", async () => {
  const f = fixture(); f.failures.store = true;
  assert.equal((await f.reconcile({ notifyRequestId: "request" })).complete, false);
  assert.equal(f.row.requestMessageId, null);
  assert.equal((await f.reconcile()).complete, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.row.requestMessageId, "1");
});

test("a failed first send retries silently even if repeated direct action asks to notify", async () => {
  const f = fixture(); f.failures.send = true;
  assert.equal((await f.reconcile({ notifyRequestId: "request" })).complete, false);
  f.failures.send = false;
  await f.reconcile({ notifyRequestId: "request" });
  assert.deepEqual(f.sent[0].allowedMentions?.users, []);
});

test("decision sends and stores outcome before removing request; failed deletion retires controls and retries without another outcome", async () => {
  const f = fixture(); await f.reconcile();
  f.row.status = "accepted"; f.row.resolvedAt = new Date(); f.events.length = 0; f.failures.delete = true;
  assert.equal((await f.reconcile({ notifyOutcomeRequestId: "request" })).complete, false);
  assert.deepEqual(f.events.slice(0, 3), ["send", "store-outcome", "delete"]);
  assert.deepEqual(f.sent[1].allowedMentions?.users, ["member"]);
  assert.deepEqual(f.messages.get("1").components, []);
  assert.equal(f.row.presentationFinishedAt, null);
  f.failures.delete = false;
  await f.reconcile();
  assert.equal(f.sent.length, 2); assert.equal(f.messages.size, 1); assert.ok(f.row.presentationFinishedAt);
});

test("failed outcome send retires controls and later recovers the saved decision silently", async () => {
  const f = fixture(); await f.reconcile(); f.row.status = "declined"; f.row.resolvedAt = new Date(); f.failures.send = true;
  assert.equal((await f.reconcile({ notifyOutcomeRequestId: "request" })).complete, false);
  assert.deepEqual(f.messages.get("1").components, []);
  f.failures.send = false; await f.reconcile();
  assert.equal(f.row.status, "declined"); assert.deepEqual(f.sent[1].allowedMentions?.users, []); assert.equal(f.messages.size, 1);
});

test("outcome send survives failed ID persistence without another outcome after restart", async () => {
  const f = fixture(); await f.reconcile(); f.row.status = "accepted"; f.row.resolvedAt = new Date(); f.failures.store = true;
  assert.equal((await f.reconcile({ notifyOutcomeRequestId: "request" })).complete, false);
  await f.reconcile();
  assert.equal(f.sent.length, 2); assert.equal(f.messages.size, 1); assert.ok(f.row.presentationFinishedAt);
});

for (const status of ["withdrawn", "superseded", "closed"] as const) {
  test(`${status} removes the pending message without a decision outcome`, async () => {
    const f = fixture(); await f.reconcile(); f.row.status = status;
    await f.reconcile();
    assert.equal(f.sent.length, 1); assert.equal(f.messages.size, 0); assert.ok(f.row.presentationFinishedAt);
  });
}

test("background recovery never notifies an unclaimed request, and overlapping reconciliation does not duplicate sends", async () => {
  const f = fixture(); await Promise.all([f.reconcile(), f.reconcile(), f.reconcile()]);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].allowedMentions?.users, []);
});

test("transient history lookup failure never creates another card", async () => {
  const f = fixture(); await f.reconcile(); f.failures.lookup = true;
  assert.equal((await f.reconcile()).complete, false); assert.equal(f.sent.length, 1);
});

test("role invalidation notifies once with the retained role snapshot and removes its controls", async () => {
  const f = fixture(); await f.reconcile(); f.row.status = "invalidated"; f.row.resolvedAt = new Date();
  await f.reconcile({ notifyOutcomeRequestIds: ["request"] }); await f.reconcile({ notifyOutcomeRequestIds: ["request"] });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].content, "<@member>, your request for **2. Tank <@&role>** was cleared because that role changed. Choose a role again.");
  assert.deepEqual(f.sent[1].allowedMentions?.users, ["member"]);
  assert.equal(f.messages.size, 1);
});

test("a decision that races publication cannot leave pending controls behind", async () => {
  const f = fixture();
  const originalClaim = f.repository.claimSignupRequestNotification;
  f.repository.claimSignupRequestNotification = async (...args) => {
    const claimed = await originalClaim(...args);
    f.row.status = "closed";
    return claimed;
  };
  assert.equal((await f.reconcile({ notifyRequestId: "request" })).complete, true);
  assert.equal(f.sent.length, 0); assert.ok(f.row.presentationFinishedAt);
});

test("closed party reconciliation clears requests without an outcome", async () => {
  const f = fixture(); await f.reconcile(); content.state = "ended";
  try {
    await f.reconcile(); assert.equal(f.row.status, "closed"); assert.equal(f.sent.length, 1); assert.equal(f.messages.size, 0);
  } finally { content.state = "active"; }
});

test("existing scheduled reconciliation repairs a deleted pending card silently", async () => {
  const { createContentScheduler } = await import("./scheduler.js");
  const f = fixture(); await f.reconcile({ notifyRequestId: "request" }); f.messages.clear();
  const repository = { ...f.repository,
    listContentNeedingSignupApprovalReconciliation: async () => [content],
    listContentNeedingControlMessage: async () => [],
    listContentForThreadTitleReconciliation: async () => []
  };
  const errors: unknown[] = [];
  const scheduler = createContentScheduler(repository as unknown as Parameters<typeof createContentScheduler>[0], {
    info: () => undefined, warn: () => undefined, error: (...args: unknown[]) => errors.push(args)
  } as unknown as Parameters<typeof createContentScheduler>[1]);
  await scheduler.runContentReconciliation([f.guild]);
  assert.deepEqual(errors, []); assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[1].allowedMentions?.users, []);
});

test("orphan request recovery persists its ID before a failed deletion strips its identifying controls", async () => {
  const f = fixture(); f.failures.store = true;
  await f.reconcile({ notifyRequestId: "request" });
  assert.equal(f.row.requestMessageId, null);
  f.row.status = "withdrawn"; f.failures.delete = true;
  assert.equal((await f.reconcile()).complete, false);
  assert.equal(f.row.requestMessageId, "1");
  assert.deepEqual(f.messages.get("1").components, []);
  assert.equal(f.row.presentationFinishedAt, null);
  f.failures.delete = false;
  assert.equal((await f.reconcile()).complete, true);
  assert.equal(f.messages.size, 0);
  assert.ok(f.row.presentationFinishedAt);
});

test("two identical outcomes with failed ID saves and absent nonces recover oldest eligible messages without another send", async () => {
  const start = Date.now() - 10_000;
  const first = request({ status: "declined", resolvedAt: new Date(start) });
  const second = request({ requestId: "second", status: "declined", createdAt: new Date(start + 1000), resolvedAt: new Date(start + 1000) });
  const f = fixture(first);
  let rows = [first];
  f.repository.listSignupRequests = async () => rows.map((row) => ({ ...row }));
  f.repository.getSignupRequest = (async (_g: string, _c: string, id: string) => ({ ...rows.find((row) => row.requestId === id)! })) as typeof f.repository.getSignupRequest;
  let failStore = true;
  f.repository.setSignupRequestMessage = async (_g, _c, id, kind, messageId) => {
    if (failStore) throw new Error("lost outcome canonical ID");
    rows.find((row) => row.requestId === id)![kind === "request" ? "requestMessageId" : "outcomeMessageId"] = messageId;
    return true;
  };
  f.repository.finishSignupRequestPresentation = (async (_g: string, _c: string, id: string) => {
    rows.find((row) => row.requestId === id)!.presentationFinishedAt = new Date();
  }) as typeof f.repository.finishSignupRequestPresentation;
  await f.reconcile();
  f.messages.get("1").createdTimestamp = start + 500;
  rows = [second];
  await f.reconcile();
  f.messages.get("2").createdTimestamp = start + 1500;
  assert.equal(f.sent.length, 2);
  assert.equal(first.outcomeMessageId, null); assert.equal(second.outcomeMessageId, null);
  for (const message of f.messages.values()) delete message.nonce;
  // Discord history arrives newest first.
  const newest = f.messages.get("2"), oldest = f.messages.get("1");
  f.messages.clear(); f.messages.set("2", newest); f.messages.set("1", oldest);
  rows = [first, second]; failStore = false;
  assert.equal((await f.reconcile()).complete, true);
  assert.equal(first.outcomeMessageId, "1"); assert.equal(second.outcomeMessageId, "2");
  assert.equal(f.sent.length, 2);
});
