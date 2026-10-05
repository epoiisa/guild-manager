import type { Guild } from "discord.js";
import { ComponentType, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { RegearClaim } from "../../db/regearRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createRegearService } from "./service.js";

const pendingClaim: RegearClaim = {
  regearClaimId: "22222222-2222-4222-8222-222222222222",
  discordGuildId: "guild-1",
  regearContentId: "11111111-1111-4111-8111-111111111111",
  albionServer: "asia",
  albionCharacterId: "character-1",
  characterName: "Example",
  currentOwnerDiscordUserId: "owner-1",
  originalSubmitterDiscordUserId: "owner-1",
  requestedValue: 1_250_000n,
  status: "pending",
  reviewChannelId: "review-channel",
  reviewMessageId: "review-message",
  submittedAt: new Date("2026-08-12T12:30:00.000Z"),
  updatedAt: new Date("2026-08-12T12:30:00.000Z"),
  contentName: "Reset Day",
  contentDate: "2026-08-12",
  contentAt: new Date("2026-08-12T12:00:00.000Z"),
  contentState: "open",
  contentChannelId: "content-channel"
};

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function pendingGallery(ids: [string, string] = ["attachment-1", "attachment-2"], options: { contentTypes?: [string, string]; descriptions?: [string, string]; fetchedMedia?: boolean } = {}) {
  const contentTypes = options.contentTypes ?? ["image/png", "image/png"];
  const descriptions = options.descriptions ?? ["Screenshot/Evidence 1", "Screenshot/Evidence 2"];
  return [{ type: ComponentType.Container, components: [{
    type: ComponentType.MediaGallery,
    items: ids.map((id, index) => ({
      description: descriptions[index],
      media: options.fetchedMedia
        ? { data: { id, url: `https://cdn.discord.test/${id}.png`, content_type: contentTypes[index] } }
        : { attachment_id: id, url: `https://cdn.discord.test/${id}.png`, content_type: contentTypes[index] }
    }))
  }] }];
}

function editedEvidenceUrls(payload: unknown): string[] | undefined {
  const message = JSON.parse(JSON.stringify(payload)) as {
    components: Array<{ components: Array<{ type: ComponentType; items?: Array<{ media: { url: string } }> }> }>;
  };
  return message.components[0].components
    .find((component) => component.type === ComponentType.MediaGallery)?.items?.map((item) => item.media.url);
}

test("a fetched Components V2 Pending gallery retains a healthy claim and both media.data IDs", async () => {
  const edits: unknown[] = [];
  let reviewerRoleIds = ["role-2", "role-1", "role-1"];
  const message = { attachments: new Map(), components: pendingGallery(undefined, { fetchedMedia: true }), edit: async (payload: unknown) => edits.push(payload) };
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: async () => message },
    send: async () => assert.fail("must not notify evidence deletion")
  };
  const guild = { id: "guild-1", channels: { fetch: async () => channel } } as unknown as Guild;
  const repository = {
    getClaim: async () => pendingClaim,
    listReviewerRoleIds: async (guildId: string) => {
      assert.equal(guildId, "guild-1");
      return reviewerRoleIds;
    },
    removePendingClaim: async () => assert.fail("must retain healthy claim")
  } as unknown as Parameters<typeof createRegearService>[0];

  await createRegearService(repository, logger).reconcilePendingClaim(guild, pendingClaim);

  assert.equal(edits.length, 1);
  assert.deepEqual((edits[0] as { attachments: unknown }).attachments, [{ id: "attachment-1" }, { id: "attachment-2" }]);
  assert.deepEqual(editedEvidenceUrls(edits[0]), [
    "https://cdn.discord.test/attachment-1.png",
    "https://cdn.discord.test/attachment-2.png"
  ]);
  const refreshed = JSON.parse(JSON.stringify(edits[0]));
  assert.match(refreshed.components[0].components[0].content, /\n- \*\*Managers\*\* <@&role-1> <@&role-2>$/);
  assert.deepEqual(refreshed.allowedMentions, { parse: [], repliedUser: false });
  reviewerRoleIds = ["role-3"];
  await createRegearService(repository, logger).reconcilePendingClaim(guild, pendingClaim);
  const updatedRoles = JSON.parse(JSON.stringify(edits[1]));
  assert.match(updatedRoles.components[0].components[0].content, /\n- \*\*Managers\*\* <@&role-3>$/);
  assert.deepEqual(updatedRoles.attachments, [{ id: "attachment-1" }, { id: "attachment-2" }]);
});

test("invalid direct, duplicate, non-image, or malformed Pending gallery evidence is removed", async () => {
  for (const components of [
    [{ type: ComponentType.MediaGallery, items: [{ description: "Screenshot/Evidence 1", media: { url: "https://example.test/one.png", content_type: "image/png" } }, { description: "Screenshot/Evidence 2", media: { url: "https://example.test/two.png", content_type: "image/png" } }] }],
    pendingGallery(["same", "same"]),
    pendingGallery(["one", "two"], { contentTypes: ["image/png", "video/mp4"] }),
    pendingGallery(["one", "two"], { descriptions: ["Screenshot/Evidence 2", "Screenshot/Evidence 1"] })
  ]) {
    let removals = 0;
    const message = { attachments: new Map(), components, edit: async () => assert.fail("must not edit invalid evidence") };
    const channel = { isTextBased: () => true, messages: { fetch: async () => message }, isSendable: () => true, send: async () => ({}) };
    const guild = { id: "guild-1", channels: { fetch: async () => channel } } as unknown as Guild;
    const repository = { getClaim: async () => pendingClaim, removePendingClaim: async () => { removals++; return undefined; } } as unknown as Parameters<typeof createRegearService>[0];
    await createRegearService(repository, logger).reconcilePendingClaim(guild, pendingClaim);
    assert.equal(removals, 1);
  }
});

test("a detached named-attachment Pending card is repaired using its retained evidence IDs", async () => {
  const edits: unknown[] = [];
  const message = {
    components: [],
    attachments: new Map([
      ["attachment-1", { id: "attachment-1", name: "regear-evidence-1.png", url: "https://cdn.discord.test/one.png", contentType: "image/png" }],
      ["attachment-2", { id: "attachment-2", name: "regear-evidence-2.png", url: "https://cdn.discord.test/two.png", contentType: "image/png" }]
    ]), edit: async (payload: unknown) => edits.push(payload)
  };
  const channel = { isTextBased: () => true, messages: { fetch: async () => message } };
  const guild = { id: "guild-1", channels: { fetch: async () => channel } } as unknown as Guild;
  const repository = { getClaim: async () => pendingClaim, listReviewerRoleIds: async () => [] } as unknown as Parameters<typeof createRegearService>[0];
  await createRegearService(repository, logger).reconcilePendingClaim(guild, pendingClaim);
  assert.deepEqual((edits[0] as { attachments: unknown }).attachments, [{ id: "attachment-1" }, { id: "attachment-2" }]);
  assert.deepEqual(editedEvidenceUrls(edits[0]), ["https://cdn.discord.test/one.png", "https://cdn.discord.test/two.png"]);
});

test("transient or permission inspection failures retain the claim and log for a later retry", async () => {
  for (const error of [new Error("network timeout"), { code: 50013, message: "Missing Permissions" }]) {
    let removals = 0;
    const warnings: unknown[] = [];
    const channel = { isTextBased: () => true, messages: { fetch: async () => { throw error; } } };
    const guild = { id: "guild-1", channels: { fetch: async () => channel } } as unknown as Guild;
    const repository = { getClaim: async () => pendingClaim, removePendingClaim: async () => { removals++; } } as unknown as Parameters<typeof createRegearService>[0];
    const serviceLogger = { ...logger, warn: (...input: unknown[]) => warnings.push(input) } as Logger;
    await createRegearService(repository, serviceLogger).reconcilePendingClaim(guild, pendingClaim);
    assert.equal(removals, 0);
    assert.equal(warnings.length, 1);
  }
});

test("missing Pending evidence removes and notifies exactly once", async () => {
  const sent: unknown[] = [];
  let removals = 0;
  const channel = {
    isSendable: () => true,
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: "notification" };
    }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => channel }
  } as unknown as Guild;
  const repository = {
    removePendingClaim: async () => removals++ === 0 ? pendingClaim : undefined
  } as unknown as Parameters<typeof createRegearService>[0];
  const service = createRegearService(repository, logger);

  await service.removeMissingEvidence(guild, pendingClaim);
  await service.removeMissingEvidence(guild, pendingClaim);

  assert.equal(removals, 2);
  assert.equal(sent.length, 1);
  const payload = sent[0] as { content: string; flags: number };
  assert.equal(payload.flags, MessageFlags.SuppressEmbeds);
  assert.equal(
    payload.content,
    "<@owner-1>, Example's 1,250,000 re-gear request for Reset Day on 12/8/26 was removed because its review evidence was deleted. Use `/regearme` to submit it again."
  );
});

test("Accepted outcome repair stores the replacement before deleting Pending evidence", async () => {
  const acceptedClaim: RegearClaim = {
    ...pendingClaim,
    status: "accepted",
    acceptedValue: 1_100_000n,
    acceptedByDiscordUserId: "reviewer-1",
    acceptedAt: new Date("2026-08-12T12:35:00.000Z"),
    acceptanceReason: "Adjusted after review"
  };
  const sequence: string[] = [];
  const review = { delete: async () => { sequence.push("delete-review"); } };
  const outcome = { id: "accepted-outcome", url: "https://example.test/outcome", delete: async () => undefined };
  const channel = {
    id: "review-channel",
    isSendable: () => true,
    isTextBased: () => true,
    send: async () => { sequence.push("post-outcome"); return outcome; },
    messages: { fetch: async () => review }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async (id: string) => { assert.equal(id, "review-channel"); return channel; } }
  } as unknown as Guild;
  const repository = {
    getClaim: async () => acceptedClaim,
    setAcceptedOutcome: async () => { sequence.push("store-outcome"); },
    clearAcceptedOutcomeByMessage: async () => false
  } as unknown as Parameters<typeof createRegearService>[0];

  const repaired = await createRegearService(repository, logger).repairAcceptedOutcome(guild, acceptedClaim);

  assert.equal(repaired, outcome);
  assert.deepEqual(sequence, ["post-outcome", "store-outcome", "delete-review"]);
});

test("unavailable existing Accepted outcomes retain their binding without posting a replacement", async () => {
  const acceptedClaim: RegearClaim = { ...pendingClaim, status: "accepted", outcomeChannelId: "original-outcome-channel", outcomeMessageId: "original-outcome" };
  for (const stage of ["channel", "message"]) {
    for (const error of [new Error("network timeout"), { code: 50013, message: "Missing Permissions" }]) {
      const channel = { isTextBased: () => true, isSendable: () => true,
        messages: { fetch: async () => { throw error; } }, send: async () => assert.fail("must not duplicate an unverified outcome") };
      const guild = { id: "guild-1", channels: { fetch: async (id: string) => {
        assert.equal(id, "original-outcome-channel");
        if (stage === "channel") throw error;
        return channel;
      } } };
      const repository = { getClaim: async () => acceptedClaim,
        clearAcceptedOutcomeByMessage: async () => assert.fail("must retain the original binding"),
        setAcceptedOutcome: async () => assert.fail("must retain the original binding") };
      const outcome = await createRegearService(repository as never, logger).repairAcceptedOutcome(guild as never, acceptedClaim);
      assert.equal(outcome, undefined);
    }
  }
});

test("a confirmed missing Accepted outcome is repaired in its stored original channel", async () => {
  const acceptedClaim: RegearClaim = { ...pendingClaim, status: "accepted", outcomeChannelId: "original-outcome-channel", outcomeMessageId: "original-outcome" };
  const sequence: string[] = [];
  const outcome = { id: "replacement", delete: async () => undefined };
  const channel = { id: "original-outcome-channel", isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async () => { throw { code: 10008 }; } },
    send: async () => { sequence.push("post-original-channel"); return outcome; } };
  const guild = { id: "guild-1", channels: { fetch: async (id: string) => {
    if (id === "original-outcome-channel") return channel;
    assert.equal(id, "review-channel");
    return { isTextBased: () => true, messages: { fetch: async () => ({ delete: async () => { sequence.push("delete-review"); } }) } };
  } } };
  const repository = { getClaim: async () => acceptedClaim,
    clearAcceptedOutcomeByMessage: async () => assert.fail("keep the original binding until its replacement is saved"),
    setAcceptedOutcome: async (_guild: string, _claim: string, channelId: string, messageId: string) => {
      assert.equal(channelId, "original-outcome-channel"); assert.equal(messageId, "replacement"); sequence.push("save-replacement");
    } };
  assert.equal(await createRegearService(repository as never, logger).repairAcceptedOutcome(guild as never, acceptedClaim), outcome);
  assert.deepEqual(sequence, ["post-original-channel", "save-replacement", "delete-review"]);
});

test("a failed Accepted outcome projection removes the orphan and preserves evidence", async () => {
  const acceptedClaim: RegearClaim = {
    ...pendingClaim,
    status: "accepted",
    acceptedValue: pendingClaim.requestedValue,
    acceptedByDiscordUserId: "reviewer-1",
    acceptedAt: new Date("2026-08-12T12:35:00.000Z")
  };
  let outcomeDeleted = false;
  let reviewDeleted = false;
  const outcome = { id: "accepted-outcome", delete: async () => { outcomeDeleted = true; } };
  const channel = {
    id: "content-channel",
    isSendable: () => true,
    isTextBased: () => true,
    send: async () => outcome,
    messages: { fetch: async () => ({ delete: async () => { reviewDeleted = true; } }) }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => channel }
  } as unknown as Guild;
  const repository = {
    getClaim: async () => acceptedClaim,
    setAcceptedOutcome: async () => { throw new Error("projection failed"); },
    clearAcceptedOutcomeByMessage: async () => false
  } as unknown as Parameters<typeof createRegearService>[0];

  await assert.rejects(
    createRegearService(repository, logger).repairAcceptedOutcome(guild, acceptedClaim),
    /projection failed/
  );
  assert.equal(outcomeDeleted, true);
  assert.equal(reviewDeleted, false);
});

test("reconciliation retires historical content entry controls and clears its pointer only after a successful edit", async () => {
  for (const fail of [false, true]) {
    const sequence: string[] = [];
    const message = { edit: async (payload: unknown) => {
      const rendered = JSON.stringify(payload);
      assert.ok(!rendered.includes("REGEARME"));
      assert.ok(!rendered.includes("regear:submit:"));
      sequence.push("edit");
      if (fail) throw new Error("temporary Discord error");
    } };
    const repository = {
      listContents: async () => [{
        regearContentId: "content", discordGuildId: "guild-1", albionServer: "asia", name: "Old Content",
        contentDate: "2026-09-10", state: "open", channelId: "historical", announcementMessageId: "announcement"
      }],
      clearAnnouncementByMessage: async (guildId: string, id: string) => { assert.equal(guildId, "guild-1"); assert.equal(id, "announcement"); sequence.push("clear-pointer"); },
      listPendingClaims: async () => []
    };
    const guild = { id: "guild-1", channels: { fetch: async (id: string) => { assert.equal(id, "historical"); return { isTextBased: () => true, messages: { fetch: async () => message } }; } } };
    await createRegearService(repository as never, logger).reconcileGuild(guild as never);
    assert.deepEqual(sequence, fail ? ["edit"] : ["edit", "clear-pointer"]);
  }
});
