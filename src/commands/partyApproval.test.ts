import { ChannelType, Collection, PermissionFlagsBits, type MessageCreateOptions } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContentSignupRequest, ContentSnapshot } from "../db/contentRepository.js";
import type { DecideSignupRequestInput, DecideSignupRequestResult } from "../db/contentSignupApprovalRepository.js";
import { messageDescription } from "../testSupport/messageAssertions.js";
import { handlePartyApprovalButton, handlePartyApprovalReview } from "./partyApproval.js";

function fixture(button = false) {
  const now = new Date();
  const snapshot: ContentSnapshot = {
    content: {
      contentId: "party", discordGuildId: "guild", sourceChannelId: "source", threadChannelId: "thread",
      hostDiscordUserId: "host", title: "Party", description: "", scheduledStartAt: null, approvalRequired: true,
      state: "unscheduled", announcementMessageId: "announcement", detailsMessageId: "details", controlMessageId: "roles",
      startNotificationMessageId: null, lastRenderedAt: null, startedAt: null, endedAt: null,
      cancelledAt: null, archivedAt: null, createdAt: now, updatedAt: now
    },
    slots: [{ contentId: "party", contentRoleSlotId: "slot", discordGuildId: "guild", slotIndex: 1, label: "Tank" }],
    signups: []
  };
  const row: ContentSignupRequest = {
    requestId: "request", discordGuildId: "guild", contentId: "party", discordUserId: "member", roleSlotId: "slot",
    slotIndex: 1, roleLabel: "Tank", status: "pending", requestMessageId: "request-card", outcomeMessageId: null,
    requestNotificationClaimedAt: now, outcomeNotificationClaimedAt: null, presentationFinishedAt: null,
    createdAt: now, resolvedAt: null
  };
  const calls: string[] = [];
  const replies: any[] = [];
  const sent: MessageCreateOptions[] = [];
  const messages = new Collection<string, any>();
  const controls = [{ components: [{ custom_id: "content:approval:accept:party:request" }] }];
  function message(id: string, payload: any = {}) {
    const item = {
      id, pinned: id === "roles", author: { id: "bot" }, content: payload.content ?? "", components: payload.components ?? [],
      nonce: payload.nonce, createdTimestamp: Date.now(), attachments: new Collection(),
      edit: async (value: any) => { Object.assign(item, value); return item; },
      delete: async () => { calls.push("delete"); messages.delete(id); }
    };
    messages.set(id, item);
    return item;
  }
  const requestCard = message("request-card", { components: controls });
  message("roles"); message("details"); message("announcement");
  const state = { member: true, visible: true, privateMember: true, memberError: false, sendError: false, nextDecision: undefined as DecideSignupRequestResult["status"] | undefined };
  const thread = {
    id: "thread", type: ChannelType.PublicThread, client: { user: { id: "bot" } },
    isThread: () => true,
    permissionsFor: () => ({ has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel ? state.visible : false }),
    members: { fetch: async () => state.privateMember ? { id: "member" } : undefined },
    messages: { fetch: async (id: string | object) => {
      if (typeof id !== "string") return messages;
      const existing = messages.get(id);
      if (!existing) throw Object.assign(new Error("Unknown message"), { code: 10008 });
      return existing;
    } },
    send: async (payload: MessageCreateOptions) => {
      if (state.sendError) throw new Error("Discord unavailable");
      calls.push("send"); sent.push(payload); return message(`sent-${sent.length}`, payload);
    }
  };
  const guild = {
    id: "guild", client: { user: { id: "bot" } },
    members: { fetch: async (options: { user: string; force: boolean }) => {
      calls.push("member-check"); assert.deepEqual(options, { user: "member", force: true });
      if (state.memberError) throw new Error("Discord lookup timed out");
      if (!state.member) throw Object.assign(new Error("Unknown member"), { code: 10007 });
      return { id: "member" };
    } },
    channels: { fetch: async (id: string) => id === "thread" ? thread : { messages: thread.messages } }
  };
  const repository = {
    isHostAuthorityRevoked: async () => false, getContentSnapshot: async () => snapshot,
    getPendingSignupRequest: async (_g: string, _c: string, user: string) => user === row.discordUserId && row.status === "pending" ? { ...row } : undefined,
    getSignupRequest: async () => ({ ...row }),
    listSignupRequests: async () => [{ ...row }],
    reconcileSignupRequestClosure: async () => {
      if (!["unscheduled", "scheduled", "active"].includes(snapshot.content.state) && row.status === "pending") row.status = "closed";
    },
    decideSignupRequest: async (input: DecideSignupRequestInput): Promise<DecideSignupRequestResult> => {
      calls.push("decision-attempt");
      assert.equal(input.requestId, "request");
      if (button) assert.equal(input.requestMessageId, "request-card");
      if (state.nextDecision) return { status: state.nextDecision, request: { ...row } };
      if (input.decision === "accept") {
        assert.ok(input.validateAvailability);
        if (!await input.validateAvailability(row)) return { status: "unavailable", request: { ...row } };
      } else assert.equal(input.validateAvailability, undefined);
      row.status = input.decision === "accept" ? "accepted" : "declined";
      row.resolvedAt = new Date(); calls.push("decided");
      return { status: row.status, request: { ...row } };
    },
    claimSignupRequestNotification: async (_g: string, _c: string, _r: string, kind: "request" | "outcome") => {
      const key = kind === "request" ? "requestNotificationClaimedAt" : "outcomeNotificationClaimedAt";
      if (row[key]) return false;
      row[key] = new Date(); return true;
    },
    setSignupRequestMessage: async (_g: string, _c: string, _r: string, kind: "request" | "outcome", id: string) => {
      row[kind === "request" ? "requestMessageId" : "outcomeMessageId"] = id; return true;
    },
    finishSignupRequestPresentation: async () => { row.presentationFinishedAt = new Date(); },
    markRendered: async () => { calls.push("rendered"); }
  };
  const interaction = {
    guildId: "guild", guild, channelId: "thread", user: { id: "host" }, message: requestCard,
    customId: "content:approval:accept:party:request", deferred: false, replied: false,
    isButton: () => button,
    deferReply: async () => { calls.push("defer"); interaction.deferred = true; },
    editReply: async (value: unknown) => { replies.push(value); }
  };
  const review = (action: "accept" | "decline" = "accept") => {
    interaction.customId = `content:approval:${action}:party:request`;
    return button
      ? handlePartyApprovalButton(interaction as unknown as Parameters<typeof handlePartyApprovalButton>[0], repository as unknown as Parameters<typeof handlePartyApprovalButton>[1])
      : handlePartyApprovalReview(interaction as unknown as Parameters<typeof handlePartyApprovalReview>[0], repository as unknown as Parameters<typeof handlePartyApprovalReview>[1], snapshot, action, "member");
  };
  const description = () => messageDescription(replies.at(-1));
  return { snapshot, row, calls, replies, sent, messages, state, thread, interaction, repository, review, description };
}

test("reconnection does not revive authority over an old party's pending request", async () => {
  for (const button of [false, true]) {
    const f = fixture(button);
    f.repository.isHostAuthorityRevoked = async () => true;
    await f.review();
    assert.equal(f.row.status, "pending");
    assert.equal(f.calls.includes("decision-attempt"), false);
    assert.match(f.description(), /Only the party host/);
  }
});

for (const button of [false, true]) {
  test(`${button ? "button without command permission" : "command"} acceptance shares current-access checks and exact public outcome`, async () => {
    const f = fixture(button);
    await f.review();
    assert.equal(f.calls[0], "defer");
    assert.equal(f.row.status, "accepted");
    assert.equal(f.sent[0].content, "<@member> accepted for role **1. Tank**.");
    assert.deepEqual(f.sent[0].allowedMentions?.users, ["member"]);
    assert.ok(f.calls.indexOf("decided") < f.calls.indexOf("send"));
    assert.ok(f.calls.indexOf("send") < f.calls.indexOf("delete"));
    assert.equal(f.messages.has("request-card"), false);
    await f.review();
    assert.equal(f.calls.filter(call => call === "decided").length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.description(), "Request Unavailable: That request is no longer pending.");
  });
  test(`${button ? "button" : "command"} denies non-host even with Administrator permission`, async () => {
    const f = fixture(button);
    f.interaction.user.id = "administrator";
    Object.assign(f.interaction, { memberPermissions: { has: () => true } });
    await f.review();
    assert.equal(f.description(), "Host Only: Only the party host can review signup requests.");
    assert.deepEqual(f.calls, ["defer"]);
  });
}

test("stale button cannot decide a pending request through its replaced message", async () => {
  const f = fixture(true); f.row.requestMessageId = "replacement";
  await f.review();
  assert.equal(f.row.status, "pending");
  assert.ok(!f.calls.includes("decision-attempt"));
  assert.equal(f.description(), "Request Unavailable: That request is no longer pending.");
});

test("reviews require the exact party thread and current host after queued transfer", async () => {
  const wrong = fixture(); wrong.interaction.channelId = "source"; await wrong.review();
  assert.ok(!wrong.calls.includes("decision-attempt"));
  const transfer = fixture(); transfer.state.nextDecision = "not_host"; await transfer.review();
  assert.equal(transfer.description(), "Request Not Updated: Only the party host can review signup requests.");
  assert.equal(transfer.row.status, "pending");
});

test("absent member, hidden thread, and missing private-thread membership each retain the request", async () => {
  for (const condition of ["member", "visible", "privateMember"] as const) {
    const f = fixture(); f.state[condition] = false;
    if (condition === "privateMember") f.thread.type = ChannelType.PrivateThread;
    await f.review();
    assert.equal(f.row.status, "pending");
    assert.match(f.description(), /cannot access this party thread/);
    assert.equal(f.sent.length, 0);
  }
});

test("an uncertain Discord membership lookup does not become a rejection or successful decision", async () => {
  const f = fixture(); f.state.memberError = true; await f.review();
  assert.equal(f.row.status, "pending");
  assert.equal(f.description(), "Request Still Pending: Guild Manager could not verify that member's current access. Try again.");
  assert.equal(f.sent.length, 0);
});

test("decline needs no membership or vacancy check and keeps its exact outcome", async () => {
  const f = fixture(true); f.state.memberError = true; await f.review("decline");
  assert.equal(f.row.status, "declined"); assert.ok(!f.calls.includes("member-check"));
  assert.equal(f.sent[0].content, "<@member> not accepted for **1. Tank**.");
});

test("occupied role does not decide or retire the pending review controls", async () => {
  const f = fixture(true); f.state.nextDecision = "slot_filled"; await f.review();
  assert.equal(f.description(), "Request Not Updated: That role is already filled. No changes were made.");
  assert.equal(f.row.status, "pending"); assert.equal(f.interaction.message.components.length, 1);
});

test("closed and expired parties cannot decide and retire obsolete controls", async () => {
  for (const expiry of [false, true]) {
    const f = fixture(true);
    if (expiry) f.snapshot.content.createdAt = new Date(Date.now() - 13 * 3600000);
    else f.snapshot.content.state = "ended";
    await f.review();
    assert.equal(f.description(), "Signups Closed: This party is no longer open for signups.");
    assert.ok(!f.calls.includes("decision-attempt"));
    assert.equal(f.interaction.message.components.length, 0);
  }
});

test("failed outcome delivery retains the saved decision and repeated review repairs without another decision or ping", async () => {
  const f = fixture(true); f.state.sendError = true; await f.review();
  assert.equal(f.row.status, "accepted"); assert.match(f.description(), /decision was saved/);
  assert.equal(f.interaction.message.components.length, 0);
  f.state.sendError = false; await f.review();
  assert.equal(f.calls.filter(call => call === "decided").length, 1);
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].allowedMentions?.users, []);
});
