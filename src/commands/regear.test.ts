import { ComponentType, MessageFlags, type EmbedBuilder, type MessageCreateOptions } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { CreateRegearContentInput, RegearClaim, RegearContent } from "../db/regearRepository.js";
import { RegearOperationError } from "../db/regearRepository.js";
import { activeGuildCommands } from "../discord/commands.js";
import {
  buildAcceptedRegearOutcome,
  buildEvidenceDeletedNotification,
  buildPendingRegearReview,
  buildRegearContentAnnouncement,
  buildRegearHistoryEmbed,
  buildRejectedRegearOutcome
} from "../services/regears/rendering.js";
import { messageDescription, messageSummary } from "../testSupport/messageAssertions.js";
import { managerCommand } from "./manager.js";
import {
  buildRegearContentDateChoices,
  handleRegearCommand,
  handleRegearModalSubmit,
  parseContentDate,
  parseUtcContentTime,
  parseWholeSilver,
  regearCommand,
  regearmeCommand,
  regearsCommand,
  submitRegearRequest
} from "./regear.js";
import { buildRegearEntryModal, buildRegearPanel } from "./regearPanel.js";

const content: RegearContent = {
  regearContentId: "11111111-1111-4111-8111-111111111111",
  discordGuildId: "guild-1",
  albionServer: "asia",
  name: "Reset Day",
  contentDate: "2026-08-12",
  contentAt: new Date("2026-08-12T12:00:00.000Z"),
  state: "open",
  channelId: "channel-1",
  createdByDiscordUserId: "admin-1",
  createdAt: new Date("2026-08-10T00:00:00.000Z"),
  updatedAt: new Date("2026-08-10T00:00:00.000Z")
};

const claim: RegearClaim = {
  regearClaimId: "22222222-2222-4222-8222-222222222222",
  discordGuildId: "guild-1",
  regearContentId: content.regearContentId,
  albionServer: "asia",
  albionCharacterId: "character-1",
  characterName: "Example",
  currentOwnerDiscordUserId: "owner-1",
  originalSubmitterDiscordUserId: "owner-1",
  requestedValue: 1_250_000n,
  acceptedValue: 1_100_000n,
  status: "accepted",
  reviewChannelId: "channel-1",
  reviewMessageId: "review-1",
  outcomeChannelId: "channel-1",
  outcomeMessageId: "outcome-1",
  submittedAt: new Date("2026-08-12T12:30:00.000Z"),
  updatedAt: new Date("2026-08-12T12:35:00.000Z"),
  acceptedByDiscordUserId: "reviewer-1",
  acceptedAt: new Date("2026-08-12T12:35:00.000Z"),
  acceptanceReason: "Adjusted after review",
  contentName: content.name,
  contentDate: content.contentDate,
  contentAt: content.contentAt,
  contentState: content.state,
  contentChannelId: content.channelId
};

test("approved re-gear commands are registered with the exact command leaves and hidden defaults", () => {
  assert.equal(activeGuildCommands.length, 50);
  assert.deepEqual(
    ["manager", "regear", "regearme", "regears"].map((name) => activeGuildCommands.find((command) => command.name === name)?.name),
    ["manager", "regear", "regearme", "regears"]
  );
  for (const command of [managerCommand, regearCommand, regearmeCommand, regearsCommand]) {
    assert.equal(command.toJSON().default_member_permissions, "0");
  }

  const manager = managerCommand.toJSON();
  const regear = regearCommand.toJSON();
  assert.deepEqual(manager.options?.map((option) => option.name), ["add", "remove", "list"]);
  assert.deepEqual(regear.options?.map((option) => option.name), ["content", "report", "view", "accept", "reject"]);
  assert.deepEqual((regear.options?.[0] as { options?: Array<{ name: string }> }).options?.map((option) => option.name), ["add", "close", "reopen", "list"]);
  assert.equal(regearmeCommand.toJSON().options?.length ?? 0, 0);
  assert.equal(regearsCommand.toJSON().options?.length ?? 0, 0);
});

test("new submission form fixes the selected content and character and uses exact evidence labels", () => {
  const modal = buildRegearEntryModal("regear-entry:draft:submit", content, { albionServer: "asia", albionCharacterId: "character-1", characterName: "Example", discordUserId: "owner-1" }).toJSON();
  assert.equal(modal.title, "Submit Re-Gear Request");
  assert.equal(modal.components.length, 4);
  assert.equal(modal.components[0].type, ComponentType.TextDisplay);
  assert.match(JSON.stringify(modal.components[0]), /12 August 2026 • 12:00 UTC/);
  const labels = modal.components.slice(1) as Array<{label: string; description: string; component: {type: number; min_values?: number; max_values?: number}}>;
  assert.deepEqual(labels.map(l => [l.label, l.description]), [
    ["Requested Amount", "Enter a positive amount in whole silver."],
    ["Evidence 1", "Upload the first evidence screenshot."],
    ["Evidence 2", "Upload the second evidence screenshot."]
  ]);
  assert.ok(labels.slice(1).every(l => l.component.type === ComponentType.FileUpload && l.component.min_values === 1 && l.component.max_values === 1));
});

test("current compact and legacy claim modal IDs are routed to re-gear handling", async () => {
  for (const customId of [
    `rgc:owner-1:asia:${content.regearContentId.replaceAll("-", "")}:character-1`,
    `regear:claim-modal:owner-1:asia:${content.regearContentId}`
  ]) {
    const interaction = { customId, inCachedGuild: () => false } as never;
    assert.equal(await handleRegearModalSubmit(interaction, undefined as never, undefined as never), true);
  }

  const unrelated = { customId: "giveaway-create:example", inCachedGuild: () => false } as never;
  assert.equal(await handleRegearModalSubmit(unrelated, undefined as never, undefined as never), false);
});

for (const cleanupFails of [false, true]) {
  test(`claim submission retains uploaded evidence and returns the approved private receipt${cleanupFails ? " when receipt delivery fails" : ""}`, () => verifyClaimSubmission(cleanupFails));
}

async function verifyClaimSubmission(cleanupFails: boolean) {
  const evidenceUrls = ["https://cdn.example.test/evidence-one.png", "https://cdn.example.test/evidence-two.png"];
  const sent: MessageCreateOptions[] = [];
  const edits: unknown[] = [];
  const hydrated = {
    attachments: new Map(),
    components: [{ type: ComponentType.Container, components: [{
      type: ComponentType.MediaGallery,
      items: [
        { description: "Screenshot/Evidence 1", media: { data: { url: "https://cdn.discord.test/one.png", id: "attachment-1", content_type: "image/png" } } },
        { description: "Screenshot/Evidence 2", media: { data: { url: "https://cdn.discord.test/two.png", id: "attachment-2", content_type: "image/png" } } }
      ]
    }] }]
  };
  const review = {
    id: "review-1",
    url: "https://discord.example.test/review-1",
    attachments: new Map(),
    components: [],
    edit: async (payload: unknown) => { edits.push(payload); },
    delete: async () => assert.fail("the successful review must not be deleted")
  };
  const channel = {
    id: content.channelId,
    isSendable: () => true,
    send: async (payload: MessageCreateOptions) => { sent.push(payload); return review; },
    messages: { fetch: async () => hydrated }
  };
  let removals = 0;
  const repository = {
    getContent: async () => content,
    listReviewerRoleIds: async (guildId: string) => {
      assert.equal(guildId, "guild-1");
      return ["role-2", "role-1", "role-1"];
    },
    listEligibleCharactersForUser: async () => [{
      albionServer: "asia" as const,
      albionCharacterId: "character-1",
      characterName: "Example",
      discordUserId: "owner-1"
    }],
    createPendingClaim: async (input: { regearClaimId: string }) => ({
      ...claim,
      regearClaimId: input.regearClaimId,
      status: "pending" as const,
      acceptedValue: undefined,
      acceptedByDiscordUserId: undefined,
      acceptedAt: undefined,
      acceptanceReason: undefined,
      outcomeChannelId: undefined,
      outcomeMessageId: undefined
    }),
    removePendingClaim: async () => { removals++; }
  };
  const replies: unknown[] = [];
  let dismissed = 0;
  const interaction = {
    customId: `rgc:owner-1:asia:${content.regearContentId.replaceAll("-", "")}:character-1`,
    guildId: "guild-1",
    user: { id: "owner-1" },
    guild: { channels: { fetch: async () => channel } },
    inCachedGuild: () => true,
    fields: {
      getTextInputValue: () => "1250000",
      getUploadedFiles: (id: string) => new Map([[id, {
        url: id.endsWith("1") ? evidenceUrls[0] : evidenceUrls[1],
        contentType: "image/png"
      }]])
    },
    deferReply: async () => undefined,
    deleteReply: async () => { dismissed++; if (cleanupFails) throw new Error("interaction reply expired"); },
    editReply: async (payload: unknown) => { replies.push(payload); if (cleanupFails) throw new Error("receipt expired"); },
    reply: async () => assert.fail("the valid submission must not use an immediate reply")
  };

  await submitRegearRequest(interaction as never, repository as never, { server: "asia", contentId: content.regearContentId, characterId: "character-1" }, channel as never);
  assert.equal(removals, 0);
  assert.equal(edits.length, 1);
  assert.equal(replies.length, 1);
  assert.match(JSON.stringify(replies[0]), /Your re-gear request has been submitted/);
  assert.match(JSON.stringify(replies[0]), /View Request/);
  assert.equal(dismissed, 0);
  const finalPayload = edits[0] as { components: unknown[]; attachments: Array<{ id: string }> };
  assert.deepEqual(finalPayload.attachments, [{ id: "attachment-1" }, { id: "attachment-2" }]);
  for (const payload of [sent[0], finalPayload]) {
    const card = componentJson(payload.components?.[0]) as { components: Array<{ content?: string }> };
    assert.match(card.components[0].content ?? "", /\n- \*\*Managers\*\* <@&role-1> <@&role-2>$/);
    assert.deepEqual((payload as MessageCreateOptions).allowedMentions, { parse: [], repliedUser: false });
  }
  const reviewJson = componentJson(finalPayload.components[0]) as {
    components: Array<{ type: ComponentType; items?: Array<{ media: { url: string } }> }>;
  };
  assert.deepEqual(
    reviewJson.components.find((component) => component.type === ComponentType.MediaGallery)?.items?.map((item) => item.media.url),
    ["https://cdn.discord.test/one.png", "https://cdn.discord.test/two.png"]
  );
}

test("claim submission creates no claim when uploaded evidence cannot be confirmed", async () => {
  let created = 0;
  let deleted = 0;
  const review = { id: "review-1", url: "https://discord.example.test/review-1", attachments: new Map(), components: [], edit: async () => undefined, delete: async () => { deleted++; } };
  const channel = { id: content.channelId, isSendable: () => true, send: async () => review, messages: { fetch: async () => undefined } };
  const repository = {
    getContent: async () => content,
    listReviewerRoleIds: async () => [],
    listEligibleCharactersForUser: async () => [{ albionServer: "asia" as const, albionCharacterId: "character-1", characterName: "Example", discordUserId: "owner-1" }],
    createPendingClaim: async () => { created++; return claim; }
  };
  const replies: unknown[] = [];
  const interaction = {
    customId: `rgc:owner-1:asia:${content.regearContentId.replaceAll("-", "")}:character-1`, guildId: "guild-1", user: { id: "owner-1" },
    guild: { channels: { fetch: async () => channel } }, inCachedGuild: () => true,
    fields: { getTextInputValue: () => "1250000", getUploadedFiles: (id: string) => new Map([[id, { url: `https://cdn.example.test/${id}.png`, contentType: "image/png" }]]) },
    deferReply: async () => undefined, editReply: async (payload: unknown) => { replies.push(payload); }, reply: async () => assert.fail("must defer")
  };
  await submitRegearRequest(interaction as never, repository as never, { server: "asia", contentId: content.regearContentId, characterId: "character-1" }, channel as never);
  assert.equal(created, 0);
  assert.equal(deleted, 1);
  assert.match((messageSummary(replies[0]) ?? ""), /Not Confirmed/);
});

test("a final Pending edit failure rolls back the claim and review message", async () => {
  let removed = 0;
  let deleted = 0;
  const gallery = pendingGalleryForTest();
  const review = { id: "review-1", url: "https://discord.example.test/review-1", attachments: new Map(), components: gallery, edit: async () => { throw new Error("edit failed"); }, delete: async () => { deleted++; } };
  const channel = { id: content.channelId, isSendable: () => true, send: async () => review };
  const repository = {
    getContent: async () => content,
    listReviewerRoleIds: async () => [],
    listEligibleCharactersForUser: async () => [{ albionServer: "asia" as const, albionCharacterId: "character-1", characterName: "Example", discordUserId: "owner-1" }],
    createPendingClaim: async (input: { regearClaimId: string }) => ({ ...claim, regearClaimId: input.regearClaimId, status: "pending" as const, acceptedValue: undefined, acceptedByDiscordUserId: undefined, acceptedAt: undefined, acceptanceReason: undefined, outcomeChannelId: undefined, outcomeMessageId: undefined }),
    removePendingClaim: async () => { removed++; }
  };
  const interaction = {
    customId: `rgc:owner-1:asia:${content.regearContentId.replaceAll("-", "")}:character-1`, guildId: "guild-1", user: { id: "owner-1" }, guild: { channels: { fetch: async () => channel } }, inCachedGuild: () => true,
    fields: { getTextInputValue: () => "1250000", getUploadedFiles: (id: string) => new Map([[id, { url: `https://cdn.example.test/${id}.png`, contentType: "image/png" }]]) },
    deferReply: async () => undefined, editReply: async () => undefined, reply: async () => assert.fail("must defer")
  };
  await assert.rejects(
    submitRegearRequest(interaction as never, repository as never, { server: "asia", contentId: content.regearContentId, characterId: "character-1" }, channel as never),
    /edit failed/
  );
  assert.equal(removed, 1);
  assert.equal(deleted, 1);
});

function pendingGalleryForTest() {
  return [{ type: ComponentType.Container, components: [{ type: ComponentType.MediaGallery, items: [
    { description: "Screenshot/Evidence 1", media: { attachment_id: "attachment-1", url: "https://cdn.discord.test/one.png", content_type: "image/png" } },
    { description: "Screenshot/Evidence 2", media: { attachment_id: "attachment-2", url: "https://cdn.discord.test/two.png", content_type: "image/png" } }
  ] }] }];
}

test("whole-silver, date, and UTC time parsers accept only approved forms", () => {
  assert.equal(parseWholeSilver("1,250 000"), 1_250_000n);
  assert.equal(parseWholeSilver("1m"), undefined);
  assert.equal(parseWholeSilver("1.5"), undefined);
  assert.equal(parseWholeSilver("-1"), undefined);
  assert.equal(parseWholeSilver("0"), undefined);
  assert.equal(parseWholeSilver("9223372036854775808"), undefined);
  assert.equal(parseContentDate("12/8/2026"), "2026-08-12");
  assert.equal(parseContentDate("2026-08-12"), "2026-08-12");
  assert.equal(parseContentDate("31/2/2026"), undefined);
  assert.equal(parseUtcContentTime("2026-08-12", "9:05")?.toISOString(), "2026-08-12T09:05:00.000Z");
  assert.equal(parseUtcContentTime("2026-08-12", "24:00")?.toISOString(), "2026-08-13T00:00:00.000Z");
  assert.equal(parseUtcContentTime("2026-08-12", "24:01"), undefined);
});

test("re-gear content stores and displays the UTC date produced by the time input", async () => {
  for (const [time, expectedDate, expectedClock, expectedSummary] of [
    [null, "2026-09-09", undefined, "Asia • Wednesday, 9 September 2026 • Open"],
    ["9", "2026-09-09", "09:00", "Asia • Wednesday, 9 September 2026 • 09 UTC • Open"],
    ["09", "2026-09-09", "09:00", "Asia • Wednesday, 9 September 2026 • 09 UTC • Open"],
    ["9:30", "2026-09-09", "09:30", "Asia • Wednesday, 9 September 2026 • 09:30 UTC • Open"],
    ["09:30", "2026-09-09", "09:30", "Asia • Wednesday, 9 September 2026 • 09:30 UTC • Open"],
    ["0", "2026-09-09", "00:00", "Asia • Wednesday, 9 September 2026 • 00 UTC • Open"],
    ["00:00", "2026-09-09", "00:00", "Asia • Wednesday, 9 September 2026 • 00 UTC • Open"],
    ["24", "2026-09-10", "00:00", "Asia • Thursday, 10 September 2026 • 00 UTC • Open"],
    ["24:00", "2026-09-10", "00:00", "Asia • Thursday, 10 September 2026 • 00 UTC • Open"]
  ] as const) {
    const harness = regearContentEntryHarness(time);
    await handleRegearCommand(harness.interaction, harness.repository, {} as Parameters<typeof handleRegearCommand>[2], harness.entries);

    assert.equal(harness.inputs.length, 1, String(time));
    assert.equal(harness.inputs[0].contentDate, expectedDate, String(time));
    assert.equal(harness.inputs[0].contentAt?.toISOString(), expectedClock ? `${expectedDate}T${expectedClock}:00.000Z` : undefined);
    assert.equal(harness.inputs[0].channelId, "configured-channel");
    assert.deepEqual(harness.announcements, []);
    const panel = JSON.stringify(buildRegearPanel([{ ...content, ...harness.inputs[0] }], "current"));
    assert.match(panel, new RegExp(expectedDate.endsWith("10") ? "10 September 2026" : "9 September 2026"));
    if (expectedClock) assert.ok(panel.includes(`${expectedClock} UTC`));
    assert.deepEqual(harness.replies, []);
    assert.deepEqual(harness.acknowledgements, ["defer", "dismiss"]);
  }
});

test("re-gear content rejects malformed supplied times without creating records", async () => {
  for (const time of ["24:01", "24:30", "25", "9:5", " "]) {
    const harness = regearContentEntryHarness(time);
    await handleRegearCommand(harness.interaction, harness.repository, {} as Parameters<typeof handleRegearCommand>[2], harness.entries);
    assert.deepEqual(harness.inputs, []);
    assert.deepEqual(harness.announcements, []);
    assert.equal(messageSummary(harness.replies[0]), "Invalid Content Date Or Time");
  }
});

for (const failure of ["create"] as const) {
  test("content add retains its private authorization error", async () => {
    const harness = regearContentEntryHarness(null, failure);
    await handleRegearCommand(harness.interaction, harness.repository, undefined as never, harness.entries);
    assert.deepEqual(harness.acknowledgements, ["defer"]);
    assert.equal(harness.inputs.length, failure === "create" ? 0 : 1);
    assert.deepEqual(harness.announcements, []);
    assert.equal(messageSummary(harness.replies[0]), "Re-Gear Access Required: You need a configured re-gear manager role or Discord Administrator permission.");
  });
}

function regearContentEntryHarness(time: string | null, failure?: "create" | "announcement") {
  const inputs: CreateRegearContentInput[] = [];
  const announcements: MessageCreateOptions[] = [];
  const replies: Array<{ embeds: EmbedBuilder[] }> = [];
  const acknowledgements: string[] = [];
  const values = { server: "asia", date: "9/9/2026", name: "Reset Day", time };
  const interaction = {
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "admin-1" },
    options: {
      getSubcommandGroup: () => "content",
      getSubcommand: () => "add",
      getString: (name: keyof typeof values) => values[name]
    },
    channel: {
      id: "channel-1",
      isSendable: () => true,
      send: async (payload: MessageCreateOptions) => {
        if (failure === "announcement") throw new Error("announcement unavailable");
        announcements.push(payload);
        return { id: "announcement-1", url: "https://discord.com/channels/guild-1/channel-1/announcement-1" };
      }
    },
    reply: async (payload: typeof replies[number]) => { replies.push(payload); },
    deferReply: async () => { acknowledgements.push("defer"); },
    deleteReply: async () => { acknowledgements.push("dismiss"); },
    editReply: async (payload: typeof replies[number]) => { replies.push(payload); }
  } as unknown as Parameters<typeof handleRegearCommand>[0];
  const repository = {
    createContent: async (input: CreateRegearContentInput) => {
      if (failure === "create") throw new RegearOperationError("admin_ineligible");
      inputs.push(input);
      return { ...content, ...input };
    },
    setContentAnnouncement: async () => undefined
  } as unknown as Parameters<typeof handleRegearCommand>[1];
  const entries = {
    checkAccess: async () => ({ discordChannelId: "configured-channel", configurationRevision: "revision", channel: { id: "configured-channel" } }),
    runExclusive: async (_g: string, work: () => Promise<unknown>) => work(),
    refresh: async () => undefined
  } as never;
  return { interaction, repository, entries, inputs, announcements, replies, acknowledgements };
}

function privateActionResponses() {
  const sequence: string[] = [];
  const replies: Array<{ embeds: EmbedBuilder[] }> = [];
  let deferred = false;
  return {
    sequence, replies,
    deferReply: async (payload: { flags: number }) => {
      assert.equal(deferred, false);
      assert.equal(payload.flags, MessageFlags.Ephemeral);
      deferred = true;
      sequence.push("defer");
    },
    deleteReply: async () => { assert.ok(deferred); sequence.push("dismiss"); },
    reply: async (payload: typeof replies[number]) => { assert.equal(deferred, false); replies.push(payload); },
    editReply: async (payload: typeof replies[number]) => { assert.ok(deferred); replies.push(payload); }
  };
}

for (const action of ["close", "reopen"] as const) {
  for (const missingAnnouncement of [false, true]) {
    test(`content ${action} ${missingAnnouncement ? "handles a missing announcement" : "leaves no private success confirmation"}`, async () => {
      const responses = privateActionResponses();
      const current = { ...content, announcementMessageId: "announcement-1" };
      const announcement = {
        id: "announcement-1",
        edit: async () => { responses.sequence.push("public-edit"); }
      };
      const channel = {
        id: content.channelId,
        isTextBased: () => true,
        isSendable: () => true,
        messages: { fetch: async () => missingAnnouncement ? undefined : announcement },
        send: async () => { responses.sequence.push("public-send"); return announcement; }
      };
      const repository = {
        getContent: async () => current,
        isEffectiveAdministrator: async () => true,
        closeContent: async () => ({ ...current, state: "closed" }),
        reopenContent: async () => ({ ...current, state: "open" }),
        setContentAnnouncement: async () => { responses.sequence.push("save-announcement"); }
      };
      const interaction = {
        ...responses, inCachedGuild: () => true, guildId: content.discordGuildId, user: { id: "reviewer-1" },
        guild: { channels: { fetch: async () => channel } },
        options: { getSubcommandGroup: () => "content", getSubcommand: () => action, getString: () => content.regearContentId, getChannel: () => null }
      };

      await handleRegearCommand(interaction as never, repository as never, undefined as never, {
        checkAccess: async () => ({ discordChannelId: channel.id, configurationRevision: "revision", channel }),
        runExclusive: async (_g: string, work: () => Promise<unknown>) => work(),
        refresh: async () => { responses.sequence.push("panel-refresh"); }
      } as never);

      assert.deepEqual(responses.replies, []);
      assert.deepEqual(responses.sequence, ["defer", ...(!missingAnnouncement ? ["public-edit"] : []), "panel-refresh", "dismiss"]);
    });
  }
}

function reviewActionHarness(action: "accept" | "reject", options: { missingOutcome?: boolean; operationError?: RegearOperationError; cleanupFails?: boolean } = {}) {
  const responses = privateActionResponses();
  const pending = { ...claim, status: "pending" as const };
  const outcome = { id: "outcome-1", delete: async () => { responses.sequence.push("delete-outcome"); } };
  const channel = {
    id: content.channelId, isSendable: () => true, isTextBased: () => true,
    send: async () => { responses.sequence.push("public-outcome"); return outcome; },
    messages: { fetch: async () => ({ delete: async () => { responses.sequence.push("delete-evidence"); } }) }
  };
  const repository = {
    getClaim: async () => pending,
    isEffectiveAdministrator: async () => true,
    acceptPendingClaim: async () => {
      if (options.operationError) throw options.operationError;
      responses.sequence.push("accept");
      return { claim, alreadyAccepted: false };
    },
    rejectPendingClaim: async () => {
      if (options.operationError) throw options.operationError;
      responses.sequence.push("reject");
      return pending;
    }
  };
  const service = {
    fetchPendingReviewMessage: async () => ({ state: "valid", message: {} }),
    repairAcceptedOutcome: async () => {
      if (options.missingOutcome) return undefined;
      responses.sequence.push("public-outcome");
      return outcome;
    }
  };
  const interaction = {
    ...responses, inCachedGuild: () => true, guildId: content.discordGuildId, user: { id: "reviewer-1" },
    guild: { channels: { fetch: async () => channel } },
    customId: `regear:${action}-modal:${claim.regearClaimId}:reviewer-1`,
    options: { getSubcommandGroup: () => null, getSubcommand: () => action, getString: (name: string) => name === "claim" ? claim.regearClaimId : null },
    fields: { getTextInputValue: (name: string) => name === "regear-amount" ? "1250000" : "" },
    deleteReply: async () => {
      await responses.deleteReply();
      if (options.cleanupFails) throw new Error("interaction reply expired");
    }
  };
  return { responses, interaction, repository, service };
}

for (const action of ["accept", "reject"] as const) {
  for (const source of ["command", "modal"] as const) {
    test(`${action} ${source} retains its public result without a private confirmation`, async () => {
      const { responses, interaction, repository, service } = reviewActionHarness(action);
      if (source === "command") await handleRegearCommand(interaction as never, repository as never, service as never);
      else await handleRegearModalSubmit(interaction as never, repository as never, service as never);

      assert.deepEqual(responses.replies, []);
      assert.deepEqual(responses.sequence, action === "accept"
        ? ["defer", "accept", "public-outcome", "dismiss"]
        : ["defer", "public-outcome", "reject", "delete-evidence", "dismiss"]);
    });
  }
}

test("acceptance retains private repair instructions when its credited outcome is unavailable", async () => {
  const { responses, interaction, repository, service } = reviewActionHarness("accept", { missingOutcome: true });
  await handleRegearCommand(interaction as never, repository as never, service as never);
  assert.deepEqual(responses.sequence, ["defer", "accept"]);
  assert.equal(messageSummary(responses.replies[0]), "Re-Gear Accepted; Outcome Missing");
  assert.match(messageDescription(responses.replies[0]) ?? "", /was credited.*`\/regear view`/);
});

test("acceptance errors remain private and are not dismissed", async () => {
  const { responses, interaction, repository, service } = reviewActionHarness("accept", { operationError: new RegearOperationError("account_frozen") });
  await handleRegearCommand(interaction as never, repository as never, service as never);
  assert.deepEqual(responses.sequence, ["defer"]);
  assert.equal(messageSummary(responses.replies[0]), "Character Account Frozen: Unfreeze the character account before accepting this request.");
});

test("failed private reply cleanup cannot remove a completed rejection outcome", async () => {
  const { responses, interaction, repository, service } = reviewActionHarness("reject", { cleanupFails: true });
  await handleRegearCommand(interaction as never, repository as never, service as never);
  assert.deepEqual(responses.sequence, ["defer", "public-outcome", "reject", "delete-evidence", "dismiss"]);
  assert.deepEqual(responses.replies, []);
});

test("re-gear content date autocomplete spans the surrounding fortnight without doubled labels", () => {
  const choices = buildRegearContentDateChoices(new Date("2026-08-14T12:00:00.000Z"));
  assert.equal(choices.length, 15);
  assert.deepEqual(choices[0], { name: "Friday, 7 August 2026", value: "2026-08-07" });
  assert.deepEqual(choices[7], { name: "Friday, 14 August 2026", value: "2026-08-14" });
  assert.deepEqual(choices[14], { name: "Friday, 21 August 2026", value: "2026-08-21" });
  assert.deepEqual(
    buildRegearContentDateChoices(new Date("2026-08-14T12:00:00.000Z"), "2026-08-10"),
    [{ name: "Monday, 10 August 2026", value: "2026-08-10" }]
  );
});

test("historical re-gear content is read-only while review cards preserve controls and evidence", () => {
  const announcement = buildRegearContentAnnouncement(content);
  const announcementJson = componentJson(announcement.components?.[0]) as { components: Array<{ content?: string; components?: Array<{ label: string }> }> };
  assert.deepEqual(announcementJson.components.map((component) => component.content), [
    "**Re-Geared Content**",
    "# Reset Day",
    "Asia • Wednesday, 12 August 2026 • 12 UTC • Open"
  ]);
  assert.equal(announcementJson.components.find((component) => component.content?.includes("Click the REGEARME button"))?.content, undefined);
  assert.deepEqual(announcementJson.components.at(-1)?.components?.map((button) => button.label), undefined);

  const offHour = buildRegearContentAnnouncement({ ...content, contentAt: new Date("2026-08-12T09:05:00.000Z") });
  const offHourJson = componentJson(offHour.components?.[0]) as { components: Array<{ content?: string }> };
  assert.equal(offHourJson.components[2].content, "Asia • Wednesday, 12 August 2026 • 09:05 UTC • Open");

  const noTime = buildRegearContentAnnouncement({ ...content, contentAt: undefined });
  const noTimeJson = componentJson(noTime.components?.[0]) as { components: Array<{ content?: string }> };
  assert.equal(noTimeJson.components[2].content, "Asia • Wednesday, 12 August 2026 • Open");

  const pending = buildPendingRegearReview(claim, ["https://example.test/one.png", "https://example.test/two.png"]);
  const pendingJson = componentJson(pending.components?.[0]) as { components: Array<{ type: ComponentType; items?: unknown[]; components?: Array<{ label: string }> }> };
  assert.equal(pendingJson.components.find((component) => component.type === ComponentType.MediaGallery)?.items?.length, 2);
  assert.deepEqual(pendingJson.components.at(-1)?.components?.map((button) => button.label), ["Withdraw", "Accept", "Reject"]);
  assert.deepEqual(pending.allowedMentions, { parse: [], repliedUser: false });

  const accepted = buildAcceptedRegearOutcome(claim);
  assert.deepEqual(accepted.allowedMentions, { parse: [], users: ["owner-1", "reviewer-1"], repliedUser: false });
});

test("evidence deletion and history use the approved language without a public claim reference", () => {
  const pending = { ...claim, status: "pending" as const, acceptedValue: undefined, acceptedByDiscordUserId: undefined, acceptedAt: undefined, acceptanceReason: undefined, outcomeChannelId: undefined, outcomeMessageId: undefined };
  const notification = buildEvidenceDeletedNotification(pending);
  const notificationJson = notification;
  assert.equal(
    notificationJson.content,
    "<@owner-1>, Example's 1,250,000 re-gear request for Reset Day on 12/8/26 was removed because its review evidence was deleted. Use `/regearme` to submit it again."
  );
  assert.doesNotMatch(notificationJson.content ?? "", /RG-|22222222/);
  assert.match(buildRegearHistoryEmbed([claim], 0, 1).data.description ?? "", /Credited to account/);
});

test("request cards use the exact compact field order and current reviewer-role mentions", () => {
  const payload = buildPendingRegearReview(claim, ["https://example.test/one.png", "https://example.test/two.png"], false, ["role-2", "role-1", "role-1"]);
  assert.deepEqual(cardTextDisplays(payload), [[
    "# Re-gear Request",
    "- **Owner** <@owner-1>",
    "- **Content** Reset Day • 12 August 2026 • 12:00 UTC",
    "- **Character** Example • Asia",
    "- **Requested** 1,250,000",
    "- **Managers** <@&role-1> <@&role-2>"
  ].join("\n")]);
  const noTime = buildPendingRegearReview({ ...claim, contentAt: undefined, currentOwnerDiscordUserId: undefined }, ["https://example.test/one.png", "https://example.test/two.png"]);
  assert.deepEqual(cardTextDisplays(noTime), [[
    "# Re-gear Request",
    "- **Owner** No current eligible owner",
    "- **Content** Reset Day • 12 August 2026",
    "- **Character** Example • Asia",
    "- **Requested** 1,250,000",
    "- **Managers** None configured"
  ].join("\n")]);
});

test("accepted notices show content and requested value, with optional adjustment and lowercase notes", () => {
  const unadjusted = { ...claim, acceptedValue: claim.requestedValue, acceptanceReason: undefined };
  const expected = [
    "<@owner-1>, your re-gear request has been accepted.",
    "- **Content** Reset Day • 12 August 2026 • 12:00 UTC",
    "- **Character** Example",
    "- **Amount** 1,250,000",
    "- **Reviewer** <@reviewer-1>"
  ].join("\n");
  assert.deepEqual(cardTextDisplays(buildAcceptedRegearOutcome(unadjusted)), [expected]);
  assert.deepEqual(cardTextDisplays(buildAcceptedRegearOutcome({ ...unadjusted, acceptanceReason: "   " })), [expected]);
  assert.deepEqual(cardTextDisplays(buildAcceptedRegearOutcome({ ...unadjusted, acceptanceReason: "  Checked.  " })), [expected, "**notes**\nChecked."]);
  assert.deepEqual(cardTextDisplays(buildAcceptedRegearOutcome(claim)), [
    expected.replace("- **Amount** 1,250,000", "- **Amount** 1,250,000 → 1,100,000"),
    "**notes**\nAdjusted after review"
  ]);
  assert.deepEqual(cardTextDisplays(buildAcceptedRegearOutcome({ ...unadjusted, contentAt: undefined })), [expected.replace(" • 12:00 UTC", "")]);
});

test("rejected notices use the exact field order and omit absent or blank notes", () => {
  const expected = [
    "<@owner-1>, your re-gear request was rejected.",
    "- **Content** Reset Day • 12 August 2026 • 12:00 UTC",
    "- **Character** Example",
    "- **Requested** 1,250,000",
    "- **Reviewer** <@reviewer-1>"
  ].join("\n");
  for (const reason of [undefined, "", "   "]) {
    assert.deepEqual(cardTextDisplays(buildRejectedRegearOutcome(claim, "reviewer-1", reason)), [expected]);
  }
  const payload = buildRejectedRegearOutcome(claim, "reviewer-1", "  Because.  ");
  assert.deepEqual(cardTextDisplays(payload), [expected, "**Notes**\nBecause."]);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: ["owner-1", "reviewer-1"], repliedUser: false });
  assert.deepEqual(cardTextDisplays(buildRejectedRegearOutcome({ ...claim, contentAt: undefined }, "reviewer-1")), [expected.replace(" • 12:00 UTC", "")]);
});

test("re-gear card fields escape submitted text and preserve full integer precision", () => {
  const input = { ...claim, contentName: "**Test** @everyone", characterName: "*Example*", requestedValue: 9_223_372_036_854_775_807n };
  for (const payload of [
    buildPendingRegearReview(input, ["https://example.test/one.png", "https://example.test/two.png"]),
    buildAcceptedRegearOutcome({ ...input, acceptanceReason: "**Checked** @everyone" }),
    buildRejectedRegearOutcome(input, "reviewer-1", "**Checked** @everyone")
  ]) {
    const text = cardTextDisplays(payload).join("\n");
    assert.ok(text.includes("\\*\\*Test\\*\\* @\u200beveryone"));
    assert.ok(text.includes("\\*Example\\*"));
    assert.ok(text.includes("9,223,372,036,854,775,807"));
    assert.equal(text.includes("@everyone"), false);
  }
});

function cardTextDisplays(payload: MessageCreateOptions): string[] {
  const container = componentJson(payload.components?.[0]) as { components: Array<{ type: ComponentType; content?: string }> };
  return container.components.filter((component) => component.type === ComponentType.TextDisplay).map((component) => component.content!);
}

function componentJson(component: unknown): unknown {
  return component && typeof component === "object" && "toJSON" in component
    ? (component as { toJSON(): unknown }).toJSON()
    : component;
}

for (const action of ["accept", "reject"] as const) {
  for (const state of ["missing", "indeterminate"] as const) {
    test(`${action} handles ${state} evidence before any decision`, async () => {
      const harness = reviewActionHarness(action);
      let removed = 0;
      const service = { ...harness.service, fetchPendingReviewMessage: async () => ({ state, error: new Error("temporary") }), removeMissingEvidence: async () => { removed++; } };
      await handleRegearCommand(harness.interaction as never, harness.repository as never, service as never);
      assert.equal(removed, state === "missing" ? 1 : 0);
      assert.deepEqual(harness.responses.sequence, []);
      assert.equal(messageSummary(harness.responses.replies[0]), state === "missing" ? "The invalid Pending request was removed and cannot be accepted or rejected." : "Guild Manager could not verify the review evidence. The Pending request was retained; try again when the review channel is available.");
    });
  }
}
