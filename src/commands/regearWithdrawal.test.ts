import { MessageFlags, type EmbedBuilder } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { RegearOperationError, type RegearClaim } from "../db/regearRepository.js";
import { messageDescription, messageRows, messageSummary } from "../testSupport/messageAssertions.js";
import { handleRegearButton } from "./regear.js";

const pendingClaim: RegearClaim = {
  regearClaimId: "22222222-2222-4222-8222-222222222222",
  discordGuildId: "guild-1",
  regearContentId: "11111111-1111-4111-8111-111111111111",
  albionServer: "asia",
  albionCharacterId: "character-1",
  characterName: "Example",
  currentOwnerDiscordUserId: "owner-1",
  originalSubmitterDiscordUserId: "owner-1",
  requestedValue: 1_234_567n,
  status: "pending",
  reviewChannelId: "review-channel-1",
  reviewMessageId: "review-message-1",
  submittedAt: new Date("2026-09-09T12:30:00.000Z"),
  updatedAt: new Date("2026-09-09T12:30:00.000Z"),
  contentName: "Test",
  contentDate: "2026-09-09",
  contentAt: new Date("2026-09-09T12:00:00.000Z"),
  contentState: "open",
  contentChannelId: "content-channel-1"
};

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  components?: unknown[];
  flags?: number;
  allowedMentions?: unknown;
}

interface WithdrawalOptions {
  claim?: RegearClaim | null;
  actorId?: string;
  channelId?: string;
  messageId?: string;
  customId?: string;
  withdrawalError?: RegearOperationError;
}

function withdrawalHarness(options: WithdrawalOptions = {}) {
  let currentClaim = options.claim === null ? undefined : options.claim ?? pendingClaim;
  const actorId = options.actorId ?? "owner-1";
  const sequence: string[] = [];
  const replies: ReplyPayload[] = [];
  const edits: ReplyPayload[] = [];
  const updates: ReplyPayload[] = [];
  const deferred: Array<{ flags: number }> = [];
  const withdrawals: Array<[string, string, string]> = [];
  const fetchedChannels: string[] = [];
  const fetchedMessages: string[] = [];
  const review = {
    id: pendingClaim.reviewMessageId,
    delete: async () => { sequence.push("delete-evidence"); },
    edit: async () => assert.fail("withdrawal must not edit the public request")
  };
  const channel = {
    isTextBased: () => true,
    send: async () => assert.fail("withdrawal must not post a public outcome"),
    messages: {
      fetch: async (messageId: string) => {
        fetchedMessages.push(messageId);
        return review;
      }
    }
  };
  const repository = {
    getClaim: async (guildId: string, claimId: string) => {
      sequence.push("get-claim");
      assert.deepEqual([guildId, claimId], [pendingClaim.discordGuildId, pendingClaim.regearClaimId]);
      return currentClaim;
    },
    withdrawPendingClaim: async (guildId: string, claimId: string, userId: string) => {
      sequence.push("withdraw-transaction");
      withdrawals.push([guildId, claimId, userId]);
      if (options.withdrawalError) throw options.withdrawalError;
      assert.ok(currentClaim, "a repeated withdrawal must not reach the transaction");
      const removed = currentClaim;
      currentClaim = undefined;
      sequence.push("withdraw-committed");
      return removed;
    }
  };
  const interaction = {
    customId: options.customId ?? `regear:withdraw:${pendingClaim.regearClaimId}`,
    guildId: pendingClaim.discordGuildId,
    channelId: options.channelId ?? pendingClaim.reviewChannelId,
    user: { id: actorId },
    message: { ...review, id: options.messageId ?? pendingClaim.reviewMessageId },
    guild: {
      id: pendingClaim.discordGuildId,
      channels: {
        fetch: async (channelId: string) => {
          fetchedChannels.push(channelId);
          return channel;
        }
      }
    },
    inCachedGuild: () => true,
    reply: async (payload: ReplyPayload) => { sequence.push("reply"); replies.push(payload); },
    deferReply: async (payload: { flags: number }) => { sequence.push("defer-reply"); deferred.push(payload); },
    deleteReply: async () => { sequence.push("delete-reply"); },
    editReply: async (payload: ReplyPayload) => { sequence.push("edit-reply"); edits.push(payload); },
    update: async (payload: ReplyPayload) => { sequence.push("update-controls"); updates.push(payload); },
    showModal: async () => assert.fail("withdrawal must not open a confirmation or modal")
  };
  return {
    sequence, replies, edits, updates, deferred, withdrawals, fetchedChannels, fetchedMessages,
    click: () => handleRegearButton(interaction as never, repository as never, undefined as never)
  };
}

const withdrawalFeedback: Record<string, string> = {
  "Withdraw Not Allowed": "Withdraw Not Allowed: Only the character's current eligible owner may withdraw this request.",
  "Re-Gear Request Unavailable": "Re-Gear Request Unavailable: That request is missing or has already been resolved.",
  "Re-Gear Controls Expired": "Re-Gear Controls Expired: Use Withdraw on the request message to withdraw it.",
  "Controls Not Yours": "Controls Not Yours: Only the person who started this action can use these controls.",
  "Re-Gear Request Resolved": "Re-Gear Request Resolved: The request has already been resolved.",
  "Re-Gear Request Not Found": "Re-Gear Request Not Found: The request is missing or no longer available."
};

function assertPrivateReply(payload: ReplyPayload, title: string): void {
  assert.equal(payload.flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
  assert.equal(messageSummary(payload), withdrawalFeedback[title].slice(title.length + 2));
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
}

function assertNoWithdrawal(harness: ReturnType<typeof withdrawalHarness>): void {
  assert.deepEqual(harness.withdrawals, []);
  assert.deepEqual(harness.fetchedChannels, []);
  assert.deepEqual(harness.fetchedMessages, []);
  assert.deepEqual(harness.deferred, []);
  assert.deepEqual(harness.edits, []);
  assert.ok(!harness.sequence.includes("delete-reply"));
}

test("Withdraw immediately removes the request before its evidence and leaves no private confirmation", async () => {
  const harness = withdrawalHarness();

  assert.equal(await harness.click(), true);

  assert.deepEqual(harness.sequence, ["get-claim", "defer-reply", "withdraw-transaction", "withdraw-committed", "delete-evidence", "delete-reply"]);
  assert.deepEqual(harness.deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(harness.withdrawals, [[pendingClaim.discordGuildId, pendingClaim.regearClaimId, "owner-1"]]);
  assert.deepEqual(harness.fetchedChannels, [pendingClaim.reviewChannelId]);
  assert.deepEqual(harness.fetchedMessages, [pendingClaim.reviewMessageId]);
  assert.deepEqual(harness.replies, []);
  assert.deepEqual(harness.updates, []);
  assert.deepEqual(harness.edits, []);
});

test("Withdraw follows the current owner after character ownership changes", async () => {
  const harness = withdrawalHarness({
    claim: { ...pendingClaim, currentOwnerDiscordUserId: "new-owner" },
    actorId: "new-owner"
  });

  assert.equal(await harness.click(), true);

  assert.deepEqual(harness.withdrawals, [[pendingClaim.discordGuildId, pendingClaim.regearClaimId, "new-owner"]]);
  assert.deepEqual(harness.edits, []);
  assert.ok(harness.sequence.includes("delete-reply"));
  assert.deepEqual(harness.updates, []);
});

for (const [name, claim, actorId] of [
  ["another user", pendingClaim, "reviewer-1"],
  ["the original submitter after ownership changes", { ...pendingClaim, currentOwnerDiscordUserId: "new-owner" }, "owner-1"],
  ["a request without a current eligible owner", { ...pendingClaim, currentOwnerDiscordUserId: undefined }, "owner-1"]
] as const) {
  test(`Withdraw refuses ${name} without changing the request or evidence`, async () => {
    const harness = withdrawalHarness({ claim, actorId });

    assert.equal(await harness.click(), true);

    assertNoWithdrawal(harness);
    assert.deepEqual(harness.updates, []);
    assert.equal(harness.replies.length, 1);
    assertPrivateReply(harness.replies[0], "Withdraw Not Allowed");
  });
}

for (const [name, claim] of [
  ["missing", null],
  ["accepted", { ...pendingClaim, status: "accepted", acceptedValue: pendingClaim.requestedValue }]
] as const) {
  test(`Withdraw refuses ${name} requests without touching evidence`, async () => {
    const harness = withdrawalHarness({ claim });

    assert.equal(await harness.click(), true);

    assertNoWithdrawal(harness);
    assert.deepEqual(harness.updates, []);
    assert.equal(harness.replies.length, 1);
    assertPrivateReply(harness.replies[0], "Re-Gear Request Unavailable");
  });
}

for (const [name, options] of [
  ["channel", { channelId: "copied-channel" }],
  ["message", { messageId: "copied-message" }]
] as const) {
  test(`Withdraw refuses a noncanonical ${name} without changing the request`, async () => {
    const harness = withdrawalHarness(options);

    assert.equal(await harness.click(), true);

    assertNoWithdrawal(harness);
    assert.deepEqual(harness.updates, []);
    assert.equal(harness.replies.length, 1);
    assertPrivateReply(harness.replies[0], "Re-Gear Controls Expired");
  });
}

for (const [code, title] of [
  ["not_owner", "Withdraw Not Allowed"],
  ["claim_resolved", "Re-Gear Request Resolved"],
  ["claim_not_found", "Re-Gear Request Not Found"]
] as const) {
  test(`Withdraw reports a transactional ${code} race privately and preserves evidence`, async () => {
    const harness = withdrawalHarness({ withdrawalError: new RegearOperationError(code) });

    assert.equal(await harness.click(), true);

    assert.deepEqual(harness.sequence, ["get-claim", "defer-reply", "withdraw-transaction", "edit-reply"]);
    assert.deepEqual(harness.deferred, [{ flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(harness.withdrawals, [[pendingClaim.discordGuildId, pendingClaim.regearClaimId, "owner-1"]]);
    assert.deepEqual(harness.fetchedChannels, []);
    assert.deepEqual(harness.fetchedMessages, []);
    assert.deepEqual(harness.replies, []);
    assert.deepEqual(harness.updates, []);
    assert.equal(harness.edits.length, 1);
    assert.equal(messageSummary(harness.edits[0]), withdrawalFeedback[title]);
    assert.deepEqual(messageRows(harness.edits[0]), []);
    assert.deepEqual(harness.edits[0].allowedMentions, { parse: [], repliedUser: false });
  });
}

test("a repeated Withdraw click cannot delete or withdraw the request twice", async () => {
  const harness = withdrawalHarness();

  assert.equal(await harness.click(), true);
  assert.equal(await harness.click(), true);

  assert.equal(harness.withdrawals.length, 1);
  assert.equal(harness.sequence.filter((step) => step === "delete-evidence").length, 1);
  assert.equal(harness.deferred.length, 1);
  assert.equal(harness.edits.length, 0);
  assert.equal(harness.replies.length, 1);
  assertPrivateReply(harness.replies[0], "Re-Gear Request Unavailable");
  assert.deepEqual(harness.updates, []);
});

for (const action of ["confirm", "cancel"] as const) {
  test(`legacy ${action}-withdraw controls retire privately without changing the request`, async () => {
    const harness = withdrawalHarness({ customId: `regear:${action}-withdraw:${pendingClaim.regearClaimId}:owner-1` });

    assert.equal(await harness.click(), true);

    assertNoWithdrawal(harness);
    assert.deepEqual(harness.sequence, ["update-controls"]);
    assert.deepEqual(harness.replies, []);
    assert.equal(harness.updates.length, 1);
    assert.equal(messageSummary(harness.updates[0]), "Re-Gear Controls Expired");
    assert.equal(messageDescription(harness.updates[0]), "Use Withdraw on the request message to withdraw it.");
    assert.deepEqual(messageRows(harness.updates[0]), []);
    assert.deepEqual(harness.updates[0].allowedMentions, { parse: [], repliedUser: false });
  });

  test(`legacy ${action}-withdraw controls still refuse another user`, async () => {
    const harness = withdrawalHarness({
      customId: `regear:${action}-withdraw:${pendingClaim.regearClaimId}:owner-1`,
      actorId: "other-user"
    });

    assert.equal(await harness.click(), true);

    assertNoWithdrawal(harness);
    assert.deepEqual(harness.sequence, ["reply"]);
    assert.deepEqual(harness.updates, []);
    assert.equal(harness.replies.length, 1);
    assertPrivateReply(harness.replies[0], "Controls Not Yours");
  });
}
