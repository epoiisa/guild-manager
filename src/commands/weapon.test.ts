import { ApplicationCommandOptionType, ComponentType, MessageFlags, type ModalBuilder } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { SpecialisationRequest } from "../db/specialisationRepository.js";
import { activeGuildCommands } from "../discord/commands.js";
import { SPECIALISATION_CATALOGUE, catalogueModalValue } from "../services/specialisations/catalogue.js";
import {
  NO_REVIEWER_NOTICE,
  buildFinalSpecialisationCard,
  buildPendingSpecialisationCard,
  buildPendingSpecialisationCardEdit,
  buildSpecialisationOutcome,
  inspectPendingSpecialisationProof,
  parseSpecialisationButtonId
} from "../services/specialisations/rendering.js";
import { messageDescription, messageSummary, messageText, messageTexts } from "../testSupport/messageAssertions.js";
import {
  handleSpecialisationButton,
  handleSpecialisationMessageDeleted,
  handleSpecialisationModalSubmit,
  handleWeaponAutocomplete,
  handleWeaponCommand,
  specialisationCommand,
  weaponCommand,
  weaponsCommand
} from "./weapon.js";

const request: SpecialisationRequest = {
  specialisationRequestId: "11111111-1111-4111-8111-111111111111",
  discordGuildId: "guild-1",
  submittedByDiscordUserId: "submitter-1",
  currentOwnerDiscordUserId: "submitter-1",
  albionServer: "europe",
  albionCharacterId: "character-1",
  characterName: "Example",
  targetKey: "weapon:battleaxe",
  targetKind: "weapon",
  targetDisplayName: "Battleaxe",
  level: 100,
  state: "pending",
  reviewChannelId: "channel-1",
  reviewMessageId: "message-1",
  createdAt: new Date("2026-08-16T00:00:00.000Z"),
  updatedAt: new Date("2026-08-16T00:00:00.000Z")
};

test("weapon specialisation commands expose the exact approved leaves and hidden defaults", () => {
  for (const command of [weaponCommand, weaponsCommand, specialisationCommand]) {
    assert.equal(command.toJSON().default_member_permissions, "0");
    assert.ok(activeGuildCommands.some((registered) => registered.name === command.toJSON().name));
  }
  assert.deepEqual(weaponCommand.toJSON().options?.map((option) => option.name), ["100", "800"]);
  assert.equal(weaponCommand.toJSON().description, "Submit weapon specialisation proof.");
  assert.deepEqual(
    weaponCommand.toJSON().options?.map((subcommand) => ({
      name: subcommand.name,
      options: "options" in subcommand
        ? subcommand.options?.map((option) => ({
          name: option.name,
          required: "required" in option ? option.required : undefined,
          autocomplete: "autocomplete" in option ? option.autocomplete : undefined
        }))
        : undefined
    })),
    [
      { name: "100", options: [
        { name: "character", required: true, autocomplete: true },
        { name: "weapon", required: true, autocomplete: true },
        { name: "screenshot", required: true, autocomplete: undefined }
      ] },
      { name: "800", options: [
        { name: "character", required: true, autocomplete: true },
        { name: "tree", required: true, autocomplete: true },
        { name: "screenshot", required: true, autocomplete: undefined }
      ] }
    ]
  );
  assert.equal(specialisationCommand.toJSON().description, "Review and manage weapon specialisations.");
  assert.deepEqual(specialisationCommand.toJSON().options?.map((option) => option.name), [
    "requests", "review", "list", "add", "remove", "catalogue"
  ]);
  const specialisationJson = specialisationCommand.toJSON() as {
    options?: Array<{ name: string; options?: Array<{ name: string; required?: boolean; autocomplete?: boolean }> }>;
  };
  assert.deepEqual(specialisationJson.options?.map((subcommand) => ({
    name: subcommand.name,
    options: (subcommand.options ?? []).map((option) => ({
      name: option.name,
      required: option.required ?? false,
      autocomplete: option.autocomplete ?? false
    }))
  })), [
    { name: "requests", options: [] },
    { name: "review", options: [
      { name: "request", required: true, autocomplete: true },
      { name: "response", required: true, autocomplete: false }
    ] },
    { name: "list", options: [{ name: "character", required: false, autocomplete: true }] },
    { name: "add", options: [
      { name: "character", required: true, autocomplete: true },
      { name: "weapon", required: true, autocomplete: true },
      { name: "level", required: true, autocomplete: false }
    ] },
    { name: "remove", options: [
      { name: "character", required: true, autocomplete: true },
      { name: "specialisation", required: true, autocomplete: true }
    ] },
    { name: "catalogue", options: [
      { name: "reset", required: false, autocomplete: false },
      { name: "edit", required: false, autocomplete: false }
    ] }
  ]);
  const catalogue = specialisationCommand.toJSON().options?.find((option) => option.name === "catalogue");
  assert.equal(catalogue?.type, ApplicationCommandOptionType.SubcommandGroup);
  assert.ok(catalogue && "options" in catalogue);
  assert.deepEqual(catalogue.options?.map((option) => ({
    name: option.name, type: option.type, options: "options" in option ? option.options ?? [] : []
  })), [
    { name: "reset", type: ApplicationCommandOptionType.Subcommand, options: [] },
    { name: "edit", type: ApplicationCommandOptionType.Subcommand, options: [] }
  ]);
  assert.equal(weaponsCommand.toJSON().options?.length ?? 0, 0);
  const review = specialisationCommand.toJSON().options?.find((option) => option.name === "review") as {
    options?: Array<{ name: string; choices?: Array<{ name: string; value: string }> }>;
  };
  assert.deepEqual(review.options?.find((option) => option.name === "response")?.choices?.map(({ name, value }) => ({ name, value })), [
    { name: "Confirm", value: "confirmed" },
    { name: "Dismiss", value: "dismissed" }
  ]);
});

test("pending and completed fallback cards retain V2 while only new outcomes notify submitters", () => {
  const pending = buildPendingSpecialisationCard(request, "attachment://specialisation-proof.png", "reviewer-role");
  assert.equal(pending.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(pending.allowedMentions, { parse: [], roles: ["reviewer-role"], repliedUser: false });
  const multipleReviewers = buildPendingSpecialisationCard(request, "attachment://specialisation-proof.png", ["server-reviewer", "all-reviewer", "server-reviewer"]);
  assert.deepEqual(multipleReviewers.allowedMentions, { parse: [], roles: ["all-reviewer", "server-reviewer"], repliedUser: false });
  assert.ok(JSON.stringify(multipleReviewers.components).includes("<@&all-reviewer> <@&server-reviewer> Review this request."));
  const container = componentJson(pending.components?.[0]) as {
    components: Array<{ type: ComponentType; content?: string; items?: unknown[]; components?: Array<{ label: string }> }>;
  };
  assert.deepEqual(container.components.slice(0, 2).map((component) => component.content), [
    "# Weapon Specialisation Request",
    "<@submitter-1> • Example (Europe) • Battleaxe • Pending"
  ]);
  assert.equal(container.components[2]?.type, ComponentType.MediaGallery);
  assert.equal(container.components[3]?.content, "<@&reviewer-role> Review this request.");
  assert.equal(container.components.find((component) => component.type === ComponentType.MediaGallery)?.items?.length, 1);
  assert.deepEqual(container.components.at(-1)?.components?.map((button) => button.label), ["Confirm", "Dismiss"]);

  const withoutRole = componentJson(buildPendingSpecialisationCard(request, "attachment://proof", undefined).components?.[0]) as {
    components: Array<{ content?: string }>;
  };
  assert.equal(NO_REVIEWER_NOTICE, "No manager role is configured. Use `/manager add specialisation` to set one.");
  assert.equal(withoutRole.components[3]?.content, NO_REVIEWER_NOTICE);
  const refreshed = buildPendingSpecialisationCardEdit(request, { attachmentId: "attachment-1", attachmentUrl: "https://cdn.test/proof" }, "new-role");
  assert.deepEqual(refreshed.attachments, [{ id: "attachment-1" }]);
  assert.deepEqual(refreshed.allowedMentions, { parse: [], repliedUser: false });
  const refreshedContainer = componentJson(refreshed.components?.[0]) as {
    components: Array<{ type: ComponentType; items?: Array<{ media: { url: string } }> }>;
  };
  assert.deepEqual(
    refreshedContainer.components.find((component) => component.type === ComponentType.MediaGallery)?.items?.map((item) => item.media.url),
    ["https://cdn.test/proof"]
  );

  for (const decision of ["confirmed", "dismissed"] as const) {
    const final = buildFinalSpecialisationCard({ ...request, state: decision }, decision);
    assert.deepEqual(final.attachments, []);
    assert.deepEqual(final.allowedMentions, { parse: [], repliedUser: false });
    const finalContainer = componentJson(final.components?.[0]) as { components: Array<{ type: ComponentType; content?: string }> };
    assert.equal(finalContainer.components.some((component) => component.type === ComponentType.MediaGallery), false);
    assert.equal(finalContainer.components.some((component) => component.type === ComponentType.ActionRow), false);
    const status = decision === "confirmed" ? "Confirmed" : "Dismissed";
    assert.deepEqual(finalContainer.components.map((component) => component.content), [
      "# Weapon Specialisation Request",
      `<@submitter-1> • Example (Europe) • Battleaxe • ${status}`,
      `The weapon specialisation request was ${decision}.`
    ]);
    const outcome = buildSpecialisationOutcome({ ...request, state: decision }, decision);
    assert.equal(outcome.content, `<@submitter-1>, your Battleaxe specialisation request for Example (Europe) was ${decision}.`);
    assert.equal(outcome.flags, MessageFlags.SuppressEmbeds);
    assert.deepEqual(outcome.components, []);
    assert.equal(outcome.embeds, undefined);
    assert.equal(outcome.files, undefined);
    assert.deepEqual(outcome.allowedMentions, { parse: [], users: ["submitter-1"], repliedUser: false });
  }
});

test("specialisation outcomes escape names and preserve long or multiline details without extra notifications", () => {
  const tree = { ...request, targetKind: "tree" as const, targetDisplayName: "Axes", level: 800 as const };
  assert.equal(buildSpecialisationOutcome(tree, "confirmed").content,
    "<@submitter-1>, your Axes specialisation request for Example (Europe) was confirmed.");
  const escaped = buildSpecialisationOutcome({ ...request, characterName: "**Name**", targetDisplayName: "[Target] @everyone" }, "dismissed");
  assert.equal(escaped.content, "<@submitter-1>, your [Target] @everyone specialisation request for \\*\\*Name\\*\\* (Europe) was dismissed.");
  assert.deepEqual(escaped.allowedMentions, { parse: [], users: ["submitter-1"], repliedUser: false });
  for (const characterName of ["Name\nSecond line", "界".repeat(2_000)]) {
    const outcome = buildSpecialisationOutcome({ ...request, characterName }, "confirmed");
    assert.equal(outcome.flags, MessageFlags.IsComponentsV2);
    assert.ok(messageText(outcome).includes(characterName));
    assert.deepEqual(outcome.allowedMentions, { parse: [], users: ["submitter-1"], repliedUser: false });
  }
});

test("proof inspection accepts canonical Components V2 media metadata and rejects malformed galleries", () => {
  const message = proofMessage();
  assert.deepEqual(inspectPendingSpecialisationProof(message as never), {
    attachmentId: "attachment-1",
    attachmentUrl: "https://cdn.discord.test/proof.png"
  });
  assert.deepEqual(inspectPendingSpecialisationProof({
    ...message,
    attachments: new Map(),
    components: [{
      type: ComponentType.Container,
      components: [{
        type: ComponentType.MediaGallery,
        items: [{
          description: "Weapon specialisation proof",
          media: { attachment_id: "attachment-2", url: "https://cdn.discord.test/proof-2.png", content_type: "image/png" }
        }]
      }]
    }]
  } as never), {
    attachmentId: "attachment-2",
    attachmentUrl: "https://cdn.discord.test/proof-2.png"
  });
  assert.equal(inspectPendingSpecialisationProof({
    ...message,
    components: [{ type: ComponentType.Container, components: [] }]
  } as never), undefined);
  assert.equal(inspectPendingSpecialisationProof({
    ...message,
    components: [{
      type: ComponentType.MediaGallery,
      items: [{
        description: "Wrong description",
        media: { data: { id: "attachment-1", url: "https://cdn.discord.test/proof.png", content_type: "image/png" } }
      }]
    }]
  } as never), undefined);
  assert.equal(inspectPendingSpecialisationProof({
    ...message,
    components: [{
      type: ComponentType.MediaGallery,
      items: [{
        description: "Weapon specialisation proof",
        media: { data: { url: "https://cdn.discord.test/proof.png", content_type: "image/png" } }
      }]
    }]
  } as never), undefined);
  assert.equal(inspectPendingSpecialisationProof({
    ...message,
    components: [{
      type: ComponentType.MediaGallery,
      items: [{
        description: "Weapon specialisation proof",
        media: { data: { id: "attachment-1", url: "https://cdn.discord.test/proof.png", content_type: "application/pdf" } }
      }]
    }]
  } as never), undefined);
  assert.equal(inspectPendingSpecialisationProof({
    ...message,
    components: [
      { type: ComponentType.MediaGallery, items: [] },
      { type: ComponentType.MediaGallery, items: [] }
    ]
  } as never), undefined);
  assert.deepEqual(parseSpecialisationButtonId(`specialisation:confirmed:${request.specialisationRequestId}`), {
    decision: "confirmed",
    requestId: request.specialisationRequestId
  });
  assert.equal(parseSpecialisationButtonId("specialisation:confirm:bad:extra"), undefined);
});

test("button review saves each decision, retires proof silently, posts the result, then deletes only the original", async () => {
  for (const decision of ["confirmed", "dismissed"] as const) {
    const edits: unknown[] = [];
    const sent: unknown[] = [];
    const order: string[] = [];
    const replies: unknown[] = [];
    let saved = request;
    const message = {
      ...proofMessage(),
      id: "message-1",
      fetch: async function () { return this; },
      edit: async (payload: unknown) => { order.push("retire"); edits.push(payload); },
      channel: { isSendable: () => true, send: async (payload: unknown) => { order.push("send"); sent.push(payload); } },
      delete: async () => { order.push("delete-original"); }
    };
    const repository = repositoryStub({
      getRequest: async () => saved,
      decideRequest: async () => {
        order.push("decide"); saved = { ...request, state: decision };
        return { request: saved, changed: true };
      },
      markReviewMessageDeleted: async (guildId: string, messageId: string) => {
        assert.equal(guildId, request.discordGuildId); assert.equal(messageId, request.reviewMessageId);
        order.push("mark-deleted");
      }
    });
    const interaction = { ...buttonInteraction(message, replies, ["reviewer-role"]), customId: `specialisation:${decision}:${request.specialisationRequestId}` };
    assert.equal(await handleSpecialisationButton(interaction as never, repository as never, reviewerStub() as never, loggerStub()), true);
    assert.deepEqual(order, ["decide", "retire", "send", "delete-original", "mark-deleted"]);
    assert.equal(edits.length, 1);
    assert.deepEqual((edits[0] as { attachments: unknown[] }).attachments, []);
    assert.deepEqual((edits[0] as { allowedMentions: unknown }).allowedMentions, {
      parse: [], repliedUser: false
    });
    assert.equal(sent.length, 1);
    assert.equal(messageText(sent[0]), `<@submitter-1>, your Battleaxe specialisation request for Example (Europe) was ${decision}.`);
    assert.deepEqual((sent[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], users: ["submitter-1"], repliedUser: false });
    assert.equal(replies.length, 1);
    assert.match(messageText(replies[0]), /original review card is gone/);
    await handleSpecialisationButton(interaction as never, repository as never, reviewerStub() as never, loggerStub());
    assert.equal(sent.length, 1, "An already-decided request must not be republished");
    assert.equal(order.filter(value => value === "decide").length, 1);
  }
});

test("review presentation failures preserve the decision and never retry a new outcome send", async () => {
  for (const failure of ["retire", "send", "delete", "mark-deleted"] as const) {
    let saved = request;
    let decisions = 0;
    let edits = 0;
    let sends = 0;
    let deletes = 0;
    let marks = 0;
    const replies: unknown[] = [];
    const retained: unknown[] = [];
    const message = {
      ...proofMessage(), id: request.reviewMessageId,
      fetch: async function () { return this; },
      edit: async (payload: unknown) => {
        edits++;
        if (failure === "retire") throw new Error("Edit unavailable");
        retained.push(payload);
      },
      channel: { isSendable: () => true, send: async () => {
        sends++;
        if (failure === "send") throw new Error("Request timed out after possible delivery");
      } },
      delete: async () => { deletes++; if (failure === "delete") throw new Error("Delete unavailable"); }
    };
    const repository = repositoryStub({
      getRequest: async () => saved,
      decideRequest: async () => { decisions++; saved = { ...request, state: "confirmed" }; return { request: saved, changed: true }; },
      markReviewMessageDeleted: async () => { marks++; if (failure === "mark-deleted") throw new Error("Database unavailable"); }
    });
    const interaction = buttonInteraction(message, replies, ["reviewer-role"]);
    await handleSpecialisationButton(interaction as never, repository as never, reviewerStub() as never, loggerStub());
    assert.equal(saved.state, "confirmed");
    assert.equal(edits, failure === "retire" ? 2 : 1);
    assert.equal(sends, failure === "retire" ? 0 : 1);
    assert.equal(deletes, ["retire", "send"].includes(failure) ? 0 : 1);
    assert.equal(marks, failure === "mark-deleted" ? 1 : 0);
    assert.match(messageText(replies[0]), /request was confirmed/i);
    if (failure === "send") assert.match(messageText(replies[0]), /could not be confirmed.*will not be resent/);
    if (failure !== "retire") {
      const payload = retained[0] as { attachments: unknown[]; allowedMentions: unknown };
      assert.deepEqual(payload.attachments, []);
      assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
      assert.match(messageText(payload), /Confirmed/);
    }
    await handleSpecialisationButton(interaction as never, repository as never, reviewerStub() as never, loggerStub());
    assert.equal(decisions, 1);
    assert.equal(sends, failure === "retire" ? 0 : 1);
  }
});

test("a losing reviewer does not edit, publish, or delete the winning review", async () => {
  const replies: unknown[] = [];
  const message = {
    ...proofMessage(), id: request.reviewMessageId,
    fetch: async function () { return this; },
    edit: async () => assert.fail("The losing reviewer cannot edit"),
    channel: { isSendable: () => true, send: async () => assert.fail("The losing reviewer cannot send") },
    delete: async () => assert.fail("The losing reviewer cannot delete")
  };
  await handleSpecialisationButton(buttonInteraction(message, replies, ["reviewer-role"]) as never, repositoryStub({
    decideRequest: async () => ({ request: { ...request, state: "dismissed" }, changed: false })
  }) as never, reviewerStub() as never, loggerStub());
  assert.match(messageText(replies[0]), /Another reviewer completed this request first/);
});

test("a card already gone during retirement or deletion does not repeat a result or fail cleanup", async () => {
  for (const missingAt of ["edit", "delete"] as const) {
    let sends = 0;
    let marks = 0;
    const replies: unknown[] = [];
    const message = {
      ...proofMessage(), id: request.reviewMessageId,
      fetch: async function () { return this; },
      edit: async () => { if (missingAt === "edit") throw Object.assign(new Error("Unknown Message"), { code: 10008 }); },
      channel: { isSendable: () => true, send: async () => { sends++; } },
      delete: async () => {
        assert.equal(missingAt, "delete");
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      }
    };
    await handleSpecialisationButton(buttonInteraction(message, replies, ["reviewer-role"]) as never, repositoryStub({
      markReviewMessageDeleted: async () => { marks++; }
    }) as never, reviewerStub() as never, loggerStub());
    assert.equal(sends, 1); assert.equal(marks, 1);
    assert.match(messageText(replies[0]), /original review card is gone/);
  }
});

test("review card editing makes exactly one immediate retry", async () => {
  let attempts = 0;
  const replies: unknown[] = [];
  const message = {
    ...proofMessage(),
    id: "message-1",
    fetch: async function () { return this; },
    edit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient edit failure");
    }
  };
  assert.equal(await handleSpecialisationButton(
    buttonInteraction(message, replies, ["reviewer-role"]) as never,
    repositoryStub() as never,
    reviewerStub() as never,
    loggerStub()
  ), true);
  assert.equal(attempts, 2);
});

test("button review rejects a visible card when the member lacks the configured reviewer role", async () => {
  const replies: unknown[] = [];
  const interaction = buttonInteraction({
    ...proofMessage(),
    id: "message-1",
    fetch: async function () { return this; },
    edit: async () => assert.fail("unauthorized reviewer must not edit")
  }, replies, []);
  assert.equal(await handleSpecialisationButton(interaction as never, repositoryStub() as never, reviewerStub([]) as never, loggerStub()), true);
  assert.equal(replies.length, 1);
  const payload = replies[0] as { embeds: Array<{ data: { title?: string } }> };
  assert.equal(messageSummary(payload), "You need a configured weapon specialisation manager role or Discord Administrator permission to use this action.");
});

test("every reviewer chat command is blocked before its repository action for a non-reviewer", async () => {
  const replies: unknown[] = [];
  let listed = 0;
  const interaction = {
    commandName: "specialisation",
    guildId: "guild-1",
    guild: guildStub(),
    member: memberStub([]),
    memberPermissions: { has: () => false },
    inCachedGuild: () => true,
    options: { getSubcommand: () => "requests" },
    reply: async (payload: unknown) => { replies.push(payload); }
  };
  await handleWeaponCommand(interaction as never, {} as never, {
    getReviewerConfig: async () => ({ reviewerRoleId: "reviewer-role" }),
    listRequests: async () => { listed += 1; return []; }
  } as never, reviewerStub([]) as never, loggerStub());
  assert.equal(listed, 0);
  assert.equal(messageSummary(replies[0]), "You need a configured weapon specialisation manager role or Discord Administrator permission to use this action.");
});

test("Discord Administrator remains the recovery reviewer when the configured role is missing", async () => {
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const message = {
    ...proofMessage(),
    id: "message-1",
    fetch: async function () { return this; },
    edit: async (payload: unknown) => { edits.push(payload); }
  };
  const interaction = {
    ...buttonInteraction(message, replies, []),
    memberPermissions: { has: () => true }
  };
  assert.equal(await handleSpecialisationButton(interaction as never, repositoryStub() as never, reviewerStub([]) as never, loggerStub()), true);
  assert.equal(edits.length, 1);
});

test("command-led review uses the same outcome publication and original-card cleanup as a button", async () => {
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  const order: string[] = [];
  const message = {
    ...proofMessage(),
    id: "message-1",
    edit: async (payload: unknown) => { order.push("edit"); edits.push(payload); },
    channel: { isSendable: () => true, send: async () => { order.push("send"); } },
    delete: async () => { order.push("delete"); }
  };
  const interaction = {
    commandName: "specialisation",
    guildId: "guild-1",
    guild: {
      ...guildStub(),
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: { fetch: async () => message }
        })
      }
    },
    member: memberStub(["reviewer-role"]),
    memberPermissions: { has: () => false },
    user: { id: "reviewer-user" },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => "review",
      getString: (name: string) => name === "response" ? "confirmed" : request.specialisationRequestId
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { replies.push(payload); }
  };
  await handleWeaponCommand(interaction as never, {} as never, repositoryStub() as never, reviewerStub() as never, loggerStub());
  assert.equal(edits.length, 1);
  assert.deepEqual((edits[0] as { attachments: unknown[] }).attachments, []);
  assert.equal(replies.length, 1);
  assert.deepEqual(order, ["edit", "send", "delete"]);
  assert.match(messageText(replies[0]), /original review card is gone/);
});

test("missing proof blocks Confirm while Dismiss can still publish in the original channel", async () => {
  for (const unavailable of ["missing", "forbidden", "proof"] as const) {
    for (const decision of ["confirmed", "dismissed"] as const) {
      let decisions = 0;
      let sends = 0;
      const replies: unknown[] = [];
      const channel = {
        isTextBased: () => true,
        isSendable: () => true,
        messages: { fetch: async (): Promise<unknown> => {
          if (unavailable === "proof") return { ...proofMessage(), id: request.reviewMessageId, components: [], channel, edit: async () => undefined };
          throw Object.assign(new Error("Unavailable"), { code: unavailable === "missing" ? 10008 : 50001 });
        } },
        send: async (payload: unknown) => { sends++; assert.match(messageText(payload), /was dismissed\./); }
      };
      const interaction = {
        commandName: "specialisation", guildId: request.discordGuildId,
        guild: { ...guildStub(), channels: { fetch: async (id: string) => { assert.equal(id, request.reviewChannelId); return channel; } } },
        member: memberStub(["reviewer-role"]), memberPermissions: { has: () => false }, user: { id: "reviewer-user" },
        inCachedGuild: () => true,
        options: { getSubcommand: () => "review", getString: (name: string) => name === "response" ? decision : request.specialisationRequestId },
        deferReply: async () => undefined, editReply: async (payload: unknown) => { replies.push(payload); }
      };
      await handleWeaponCommand(interaction as never, {} as never, repositoryStub({
        decideRequest: async () => { decisions++; return { request: { ...request, state: decision }, changed: true }; }
      }) as never, reviewerStub() as never, loggerStub());
      assert.equal(decisions, decision === "dismissed" ? 1 : 0);
      assert.equal(sends, decision === "dismissed" && unavailable !== "forbidden" ? 1 : 0);
      if (decision === "confirmed") assert.match(messageText(replies[0]), /Confirm is blocked/);
      else if (unavailable === "forbidden") assert.match(messageText(replies[0]), /request was dismissed.*could not access/);
      else assert.match(messageText(replies[0]), /original review card is gone/);
    }
  }
});

test("inactive guild state blocks a stale review button before authorization or database mutation", async () => {
  const replies: unknown[] = [];
  const interaction = buttonInteraction({ ...proofMessage(), id: "message-1" }, replies, ["reviewer-role"]);
  let fetched = 0;
  assert.equal(await handleSpecialisationButton(
    interaction as never,
    repositoryStub({ getRequest: async () => { fetched++; return request; } }) as never,
    reviewerStub() as never,
    loggerStub(),
    async () => false
  ), true);
  assert.equal(fetched, 0);
  assert.equal(messageSummary(replies[0]), "Guild Manager is not active on this server.");
});

test("weapon autocomplete distinguishes weapons at 100 from trees at 800 and excludes disabled entries", async () => {
  const availableRepository = {
    getEligibleCharacter: async () => ({ albionCharacterId: "character-1" }),
    listSpecialisations: async () => [],
    listRequests: async () => []
  };
  const weaponResponses: unknown[] = [];
  const weaponInteraction = autocompleteInteraction("weapon", "100", "weapon", "bow", weaponResponses, [], { character: "europe:character-1" });
  assert.equal(await handleWeaponAutocomplete(weaponInteraction as never, {} as never, {
    ...availableRepository,
    exclusionKeys: async () => new Set(["weapon:warbow"])
  } as never, reviewerStub() as never), true);
  const weaponChoices = weaponResponses[0] as Array<{ name: string }>;
  assert.ok(weaponChoices.some((choice) => choice.name === "Bow"));
  assert.ok(weaponChoices.every((choice) => choice.name !== "Warbow"));

  const allWeaponResponses: unknown[] = [];
  assert.equal(await handleWeaponAutocomplete(
    autocompleteInteraction("weapon", "100", "weapon", "", allWeaponResponses, [], { character: "europe:character-1" }) as never,
    {} as never,
    { ...availableRepository, exclusionKeys: async () => new Set() } as never,
    reviewerStub() as never
  ), true);
  assert.ok((allWeaponResponses[0] as Array<{ value: string }>).every((choice) => choice.value.startsWith("weapon:")));

  const treeResponses: unknown[] = [];
  assert.equal(await handleWeaponAutocomplete(
    autocompleteInteraction("weapon", "800", "tree", "", treeResponses, [], { character: "europe:character-1" }) as never,
    {} as never,
    { ...availableRepository, exclusionKeys: async () => new Set() } as never,
    reviewerStub() as never
  ), true);
  assert.ok((treeResponses[0] as Array<{ value: string }>).every((choice) => choice.value.startsWith("tree:")));
});

test("weapon autocomplete hides held and Pending targets for the selected character", async () => {
  const repository = {
    exclusionKeys: async () => new Set(),
    getEligibleCharacter: async () => ({ albionCharacterId: "character-1" }),
    listSpecialisations: async () => [
      { targetKey: "weapon:battleaxe", targetKind: "weapon" },
      { targetKey: "tree:bow", targetKind: "tree" }
    ],
    listRequests: async () => [
      { targetKey: "weapon:claymore", targetKind: "weapon" },
      { targetKey: "tree:cursed-staff", targetKind: "tree" }
    ]
  };
  const choicesFor = async (subcommand: "100" | "800", focusedName: "weapon" | "tree", query: string) => {
    const responses: unknown[] = [];
    await handleWeaponAutocomplete(autocompleteInteraction(
      "weapon",
      subcommand,
      focusedName,
      query,
      responses,
      [],
      { character: "europe:character-1" }
    ) as never, {} as never, repository as never, reviewerStub() as never);
    return responses[0] as Array<{ name: string; value: string }>;
  };

  assert.deepEqual(await choicesFor("100", "weapon", "battleaxe"), []);
  assert.deepEqual(await choicesFor("100", "weapon", "warbow"), []);
  assert.deepEqual(await choicesFor("100", "weapon", "claymore"), []);
  assert.deepEqual(await choicesFor("100", "weapon", "shadowcaller"), []);
  assert.deepEqual(await choicesFor("100", "weapon", "greataxe"), [
    { name: "Greataxe", value: "weapon:greataxe" }
  ]);

  assert.ok((await choicesFor("800", "tree", "bows")).every((choice) => choice.value !== "tree:bow"));
  assert.deepEqual(await choicesFor("800", "tree", "swords"), []);
  assert.deepEqual(await choicesFor("800", "tree", "cursed"), []);
  assert.deepEqual(await choicesFor("800", "tree", "axes"), [
    { name: "Axes", value: "tree:axe" }
  ]);
});

test("weapon target autocomplete requires an eligible selected character", async () => {
  const responses: unknown[] = [];
  let queriedTargets = false;
  assert.equal(await handleWeaponAutocomplete(
    autocompleteInteraction("weapon", "100", "weapon", "axe", responses, []) as never,
    {} as never,
    {
      exclusionKeys: async () => new Set(),
      getEligibleCharacter: async () => undefined,
      listSpecialisations: async () => { queriedTargets = true; return []; },
      listRequests: async () => { queriedTargets = true; return []; }
    } as never,
    reviewerStub() as never
  ), true);
  assert.deepEqual(responses[0], []);
  assert.equal(queriedTargets, false);
});

test("remove autocomplete is character-scoped and lists trees before weapons", async () => {
  const responses: unknown[] = [];
  const interaction = autocompleteInteraction(
    "specialisation",
    "remove",
    "specialisation",
    "",
    responses,
    ["reviewer-role"],
    { character: "europe:character-1" }
  );
  assert.equal(await handleWeaponAutocomplete(interaction as never, {} as never, {
    exclusionKeys: async () => new Set(),
    listSpecialisations: async () => [
      { albionServer: "europe", albionCharacterId: "character-1", targetKey: "weapon:battleaxe", targetKind: "weapon", targetDisplayName: "Battleaxe", level: 100 },
      { albionServer: "asia", albionCharacterId: "character-2", targetKey: "tree:bow", targetKind: "tree", targetDisplayName: "Bows", level: 800 },
      { albionServer: "europe", albionCharacterId: "character-1", targetKey: "tree:axe", targetKind: "tree", targetDisplayName: "Axes", level: 800 },
      { albionServer: "europe", albionCharacterId: "character-1", targetKey: "weapon:warbow", targetKind: "weapon", targetDisplayName: "Warbow", level: 100 }
    ]
  } as never, reviewerStub() as never), true);
  assert.deepEqual(responses[0], [
    { name: "Tree • Axes", value: "tree:axe" },
    { name: "Weapon • Battleaxe", value: "weapon:battleaxe" },
    { name: "Weapon • Warbow", value: "weapon:warbow" }
  ]);
});

test("remove resolves the selected active specialisation without a level option", async () => {
  const replies: unknown[] = [];
  const removedIds: string[] = [];
  const record = {
    characterSpecialisationId: "specialisation-1",
    discordGuildId: "guild-1",
    albionServer: "europe",
    albionCharacterId: "character-1",
    characterName: "Example",
    targetKey: "tree:axe",
    targetKind: "tree",
    targetDisplayName: "Axes",
    level: 800,
    source: "manual",
    recordedByDiscordUserId: "reviewer-user",
    recordedAt: new Date("2026-08-23T00:00:00.000Z")
  };
  const interaction = {
    commandName: "specialisation",
    guildId: "guild-1",
    guild: guildStub(),
    member: memberStub(["reviewer-role"]),
    memberPermissions: { has: () => false },
    user: { id: "reviewer-user" },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => "remove",
      getString: (name: string) => name === "character" ? "europe:character-1" : "tree:axe"
    },
    reply: async (payload: unknown) => { replies.push(payload); }
  };
  await handleWeaponCommand(interaction as never, {} as never, {
    listSpecialisations: async () => [record],
    removeSpecialisation: async (_guildId: string, specialisationId: string) => {
      removedIds.push(specialisationId);
      return record;
    }
  } as never, reviewerStub() as never, loggerStub());
  assert.deepEqual(removedIds, ["specialisation-1"]);
  assert.equal(messageSummary(replies[0]), "Removed Axes at 800 for Example.");
  assert.equal(messageDescription(replies[0]), "Removed Axes at 800 for Example.");
});

test("reviewer autocomplete hides data from non-reviewers", async () => {
  const reviewerResponses: unknown[] = [];
  const reviewerInteraction = autocompleteInteraction("specialisation", "review", "request", "", reviewerResponses, []);
  assert.equal(await handleWeaponAutocomplete(reviewerInteraction as never, {} as never, {} as never, reviewerStub([]) as never), true);
  assert.deepEqual(reviewerResponses, [[]]);
});

test("specialisation reviewer autocomplete includes requests from every Albion Online server", async () => {
  const responses: unknown[] = [];
  const interaction = autocompleteInteraction("specialisation", "review", "request", "", responses, ["europe-reviewer"]);
  interaction.guild.roles.cache.set("europe-reviewer", { id: "europe-reviewer", managed: false });
  await handleWeaponAutocomplete(interaction as never, {} as never, {
    exclusionKeys: async () => new Set(),
    listRequests: async () => [request, { ...request, specialisationRequestId: "asia-request", albionServer: "asia", characterName: "Asia Example" }]
  } as never, {
    effectiveRoleIds: async (guildId: string, domain: string) => {
      assert.equal(guildId, "guild-1"); assert.equal(domain, "specialisation"); return ["europe-reviewer"];
    }
  } as never);
  assert.deepEqual(responses[0], [{ name: "Example • Battleaxe", value: request.specialisationRequestId }, { name: "Asia Example • Battleaxe", value: "asia-request" }]);
});

test("catalogue edit and reset prefill reviewable modals without changing saved exclusions", async () => {
  for (const action of ["reset", "edit"] as const) {
    for (const excludedKeys of [new Set(["tree:axe", "weapon:battleaxe"]), new Set(SPECIALISATION_CATALOGUE.map((entry) => entry.key))]) {
      const modals: ModalBuilder[] = [];
      const reads: string[] = [];
      const interaction = catalogueInteraction(action, modals);
      await handleWeaponCommand(interaction as never, {} as never, {
        exclusionKeys: async (guildId: string) => { reads.push(guildId); return excludedKeys; },
        replaceCatalogueExclusions: async () => assert.fail("Opening or cancelling a modal must not write exclusions")
      } as never, reviewerStub() as never, loggerStub());
      assert.equal(modals.length, 1);
      const modal = modals[0]!.toJSON();
      assert.equal(modal.custom_id, "specialisation:catalogue");
      assert.equal(modal.title, action === "reset" ? "Restore Specialisation Catalogue" : "Specialisation Catalogue");
      const input = catalogueModalInput(modals[0]!);
      assert.equal(input.custom_id, "enabled-catalogue");
      assert.equal(input.required, false);
      assert.equal(input.value ?? "", catalogueModalValue(action === "reset" ? new Set() : excludedKeys));
      assert.deepEqual(reads, action === "reset" ? [] : ["guild-1"]);
    }
  }
});

test("catalogue opening allows any configured specialisation reviewer or Administrator for both actions", async () => {
  for (const action of ["reset", "edit"] as const) {
    for (const scenario of ["reviewer", "none", "administrator"] as const) {
      const modals: ModalBuilder[] = [];
      const replies: unknown[] = [];
      const interaction = catalogueInteraction(action, modals, replies);
      interaction.memberPermissions.has = () => scenario === "administrator";
      await handleWeaponCommand(interaction as never, {} as never, {
        exclusionKeys: async () => new Set()
      } as never, {
        effectiveRoleIds: async () => scenario === "reviewer" ? ["reviewer-role"] : []
      } as never, loggerStub());
      const allowed = scenario === "reviewer" || scenario === "administrator";
      assert.equal(modals.length, allowed ? 1 : 0);
      assert.equal(replies.length, allowed ? 0 : 1);
    }
  }
});

test("reset submission restores only the submitting guild and accepts edits before submission", async () => {
  for (const customise of [false, true]) {
    const modals: ModalBuilder[] = [];
    const replies: unknown[] = [];
    const saved = new Map([
      ["guild-1", new Set(["tree:axe", "weapon:battleaxe"])],
      ["guild-2", new Set(["weapon:battleaxe"])]
    ]);
    const writes: unknown[][] = [];
    const interaction = catalogueInteraction("reset", modals, replies);
    await handleWeaponCommand(interaction as never, {} as never, {} as never, reviewerStub() as never, loggerStub());
    let value = catalogueModalInput(modals[0]!).value!;
    if (customise) value = value.split("\n").filter((name) => name !== "Battleaxe").join("\n");
    assert.equal(await handleSpecialisationModalSubmit({
      ...interaction,
      customId: modals[0]!.toJSON().custom_id,
      fields: { getTextInputValue: () => value }
    } as never, {
      replaceCatalogueExclusions: async (guildId: string, keys: string[], actor: string) => {
        writes.push([guildId, keys, actor]);
        saved.set(guildId, new Set(keys));
      }
    } as never, reviewerStub() as never), true);
    assert.deepEqual(writes, [["guild-1", customise ? ["weapon:battleaxe"] : [], "reviewer-user"]]);
    assert.deepEqual(saved.get("guild-2"), new Set(["weapon:battleaxe"]));
    assert.deepEqual(saved.get("guild-1"), customise ? new Set(["weapon:battleaxe"]) : new Set());
    const embed = replies[0];
    assert.equal(messageSummary(embed), "Specialisation Catalogue Updated");
    assert.equal(messageDescription(embed), `Enabled: ${SPECIALISATION_CATALOGUE.length - Number(customise)}\nDisabled: ${Number(customise)}\nDuplicates: 0\nDiscarded invalid: 0`);
  }
});

test("catalogue submission rechecks reviewer authority after either modal opens", async () => {
  for (const action of ["reset", "edit"] as const) {
    for (const scenario of ["revoked", "reviewer", "administrator"] as const) {
      const modals: ModalBuilder[] = [];
      const replies: unknown[] = [];
      const interaction = catalogueInteraction(action, modals, replies);
      await handleWeaponCommand(interaction as never, {} as never, {
        exclusionKeys: async () => new Set()
      } as never, reviewerStub() as never, loggerStub());
      interaction.memberPermissions.has = () => scenario === "administrator";
      let writes = 0;
      await handleSpecialisationModalSubmit({
        ...interaction, customId: "specialisation:catalogue",
        fields: { getTextInputValue: () => catalogueModalInput(modals[0]!).value ?? "" }
      } as never, {
        replaceCatalogueExclusions: async () => { writes += 1; }
      } as never, {
        effectiveRoleIds: async () => scenario === "reviewer" ? ["reviewer-role"] : []
      } as never);
      assert.equal(writes, scenario === "revoked" ? 0 : 1);
      const embed = replies[0];
      assert.equal(messageSummary(embed), scenario === "revoked" ? "You need a configured weapon specialisation manager role or Discord Administrator permission to use this action." : "Specialisation Catalogue Updated");
    }
  }
});

test("catalogue modal replacement canonicalizes names and reports duplicates and invalid input", async () => {
  const replies: unknown[] = [];
  let exclusions: string[] = [];
  const interaction = {
    customId: "specialisation:catalogue",
    guildId: "guild-1",
    guild: guildStub(),
    member: memberStub(["reviewer-role"]),
    memberPermissions: { has: () => false },
    user: { id: "reviewer-user" },
    fields: { getTextInputValue: () => "Battleaxe\n battleaxe \nUnknown Weapon" },
    inCachedGuild: () => true,
    reply: async (payload: unknown) => { replies.push(payload); }
  };
  assert.equal(await handleSpecialisationModalSubmit(interaction as never, {
    replaceCatalogueExclusions: async (_guildId: string, keys: string[]) => { exclusions = keys; }
  } as never, reviewerStub() as never), true);
  assert.equal(exclusions.includes("weapon:battleaxe"), false);
  assert.equal(exclusions.length, 152);
  const embed = replies[0];
  assert.equal(messageSummary(embed), "Specialisation Catalogue Updated");
  assert.match(messageDescription(embed) ?? "", /Duplicates: 1/);
  assert.match(messageDescription(embed) ?? "", /Unknown Weapon/);
});

test("message deletion routing delegates the exact guild and review message ids", async () => {
  const calls: unknown[][] = [];
  await handleSpecialisationMessageDeleted("guild-1", "message-1", {
    markReviewMessageDeleted: async (...args: unknown[]) => { calls.push(args); }
  } as never);
  assert.deepEqual(calls, [["guild-1", "message-1"]]);
});

test("a failed card upload removes the unattached Pending reservation so resubmission is possible", async () => {
  const replies: unknown[] = [];
  const deleted: string[] = [];
  const errors: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
  const interaction = {
    commandName: "weapon",
    guildId: "guild-1",
    guild: guildStub(),
    channelId: "channel-1",
    channel: {
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      messages: {},
      send: async () => { throw new Error("upload failed"); }
    },
    user: { id: "submitter-1" },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => "100",
      getString: (name: string) => name === "character" ? "europe:character-1" : "weapon:battleaxe",
      getAttachment: () => ({ name: "proof.png", contentType: "image/png", url: "https://upload.test/proof.png" })
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { replies.push(payload); }
  };
  const repository = {
    exclusionKeys: async () => new Set<string>(),
    getEligibleCharacter: async () => ({
      discordGuildId: "guild-1",
      discordUserId: "submitter-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example"
    }),
    getReviewerConfig: async () => undefined,
    reserveRequest: async () => ({ ...request, reviewMessageId: undefined }),
    deleteUnattachedPendingRequest: async (_guildId: string, requestId: string) => {
      deleted.push(requestId);
      return true;
    }
  };
  await handleWeaponCommand(interaction as never, {} as never, repository as never, reviewerStub([]) as never, {
    ...loggerStub(),
    error: (message: string, context?: Record<string, unknown>) => { errors.push({ message, context }); }
  }, entryContext(interaction.channel));
  assert.deepEqual(deleted, [request.specialisationRequestId]);
  assert.equal(replies.length, 1);
  assert.deepEqual(errors, [{
    message: "specialisation submission failed",
    context: {
      discordGuildId: "guild-1",
      specialisationRequestId: request.specialisationRequestId,
      reviewMessageId: undefined,
      error: "upload failed"
    }
  }]);
});

test("submission refuses a detached proof card and removes both the card and reservation", async () => {
  let cardDeleted = 0;
  let reservationDeleted = 0;
  let attached = 0;
  const detachedCard = {
    id: "detached-message",
    components: [{ type: ComponentType.Container, components: [] }],
    attachments: new Map(),
    delete: async () => { cardDeleted += 1; }
  };
  const channel = {
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => detachedCard },
    send: async () => detachedCard
  };
  const interaction = {
    commandName: "weapon",
    guildId: "guild-1",
    guild: guildStub(),
    channelId: "channel-1",
    channel,
    user: { id: "submitter-1" },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => "100",
      getString: (name: string) => name === "character" ? "europe:character-1" : "weapon:battleaxe",
      getAttachment: () => ({ name: "proof.png", contentType: "image/png", url: "https://upload.test/proof.png" })
    },
    deferReply: async () => undefined,
    editReply: async () => undefined
  };
  await handleWeaponCommand(interaction as never, {} as never, {
    exclusionKeys: async () => new Set<string>(),
    getEligibleCharacter: async () => ({
      discordGuildId: "guild-1",
      discordUserId: "submitter-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example"
    }),
    getReviewerConfig: async () => undefined,
    reserveRequest: async () => ({ ...request, reviewMessageId: undefined }),
    attachReviewMessage: async () => { attached += 1; return request; },
    deleteUnattachedPendingRequest: async () => { reservationDeleted += 1; return true; }
  } as never, reviewerStub([]) as never, loggerStub(), entryContext(channel));
  assert.equal(attached, 0);
  assert.equal(cardDeleted, 1);
  assert.equal(reservationDeleted, 1);
});

test("submission accepts a fetched Components V2 proof card without Message attachments", async () => {
  let cardDeleted = 0;
  let reservationDeleted = 0;
  let attached = 0;
  const replies: unknown[] = [];
  const sentCard = {
    id: "pending-message",
    components: [{ type: ComponentType.Container, components: [] }],
    attachments: new Map(),
    delete: async () => { cardDeleted += 1; }
  };
  const fetchedCard = {
    id: "pending-message",
    attachments: new Map(),
    components: [{
      type: ComponentType.Container,
      components: [{
        type: ComponentType.MediaGallery,
        items: [{
          description: "Weapon specialisation proof",
          media: { data: { id: "attachment-1", url: "https://cdn.discord.test/proof.png", content_type: "image/png" } }
        }]
      }]
    }],
    delete: async () => { cardDeleted += 1; }
  };
  const channel = {
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => fetchedCard },
    send: async () => sentCard
  };
  const interaction = weaponSubmissionInteraction(channel, replies);
  await handleWeaponCommand(interaction as never, {} as never, {
    exclusionKeys: async () => new Set<string>(),
    getEligibleCharacter: async () => eligibleCharacter(),
    getReviewerConfig: async () => undefined,
    reserveRequest: async () => ({ ...request, reviewMessageId: undefined }),
    attachReviewMessage: async (_guildId: string, _requestId: string, messageId: string) => {
      attached += 1;
      assert.equal(messageId, "pending-message");
      return { ...request, reviewMessageId: messageId };
    },
    deleteUnattachedPendingRequest: async () => { reservationDeleted += 1; return true; }
  } as never, reviewerStub([]) as never, loggerStub(), entryContext(channel));
  assert.equal(attached, 1);
  assert.equal(cardDeleted, 0);
  assert.equal(reservationDeleted, 0);
  assert.equal(messageSummary(replies[0]), "Your weapon specialisation request has been submitted. [View Request](https://discord.com/channels/guild-1/configured-channel/pending-message).");
});

test("pending request report verifies a deleted card, stores missing state, and omits its stale link", async () => {
  const edits: unknown[] = [];
  const marked: string[] = [];
  const interaction = {
    commandName: "specialisation",
    guildId: "guild-1",
    guild: {
      ...guildStub(),
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: { fetch: async () => { throw Object.assign(new Error("Unknown Message"), { code: 10008 }); } }
        })
      }
    },
    member: memberStub(["reviewer-role"]),
    memberPermissions: { has: () => false },
    user: { id: "reviewer-user" },
    deferred: false,
    inCachedGuild: () => true,
    options: { getSubcommand: () => "requests" },
    deferReply: async function () { this.deferred = true; },
    editReply: async (payload: unknown) => { edits.push(payload); },
    followUp: async () => undefined
  };
  await handleWeaponCommand(interaction as never, {} as never, {
    getReviewerConfig: async () => ({ reviewerRoleId: "reviewer-role" }),
    listRequests: async () => [request],
    markReviewMessageDeleted: async (_guildId: string, messageId: string) => { marked.push(messageId); }
  } as never, reviewerStub() as never, loggerStub());
  assert.deepEqual(marked, ["message-1"]);
  const embed = edits[0];
  assert.equal(messageDescription(embed), "Example • Battleaxe");
  assert.match(messageTexts(embed).at(-1) ?? "", /missing review message/);
});

test("member reports paginate beyond ten character cards without mention parsing", async () => {
  const replies: unknown[] = [];
  const followUps: unknown[] = [];
  const characters = Array.from({ length: 11 }, (_, index) => ({
    discordGuildId: "guild-1",
    discordUserId: "member-1",
    albionServer: "europe" as const,
    albionCharacterId: `character-${index}`,
    characterName: `Character ${String(index).padStart(2, "0")}`
  }));
  const interaction = {
    commandName: "weapons",
    guildId: "guild-1",
    user: { id: "member-1" },
    inCachedGuild: () => true,
    reply: async (payload: unknown) => { replies.push(payload); },
    followUp: async (payload: unknown) => { followUps.push(payload); }
  };
  await handleWeaponCommand(interaction as never, {
    listRegisteredCharacters: async () => characters
  } as never, {
    listSpecialisationsForOwner: async () => [],
    exclusionKeys: async () => new Set()
  } as never, reviewerStub() as never, loggerStub());
  assert.equal((messageText(replies[0]).match(/# /g) ?? []).length, 10);
  assert.equal((messageText(followUps[0]).match(/# /g) ?? []).length, 1);
  assert.deepEqual((replies[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], repliedUser: false });
});

function proofMessage() {
  return {
    channel: { isSendable: () => true, send: async () => ({ id: "outcome-1" }) },
    delete: async () => undefined,
    attachments: new Map([["attachment-1", {
      id: "attachment-1",
      name: "specialisation-proof.png",
      url: "https://cdn.discord.test/proof.png",
      contentType: "image/png"
    }]]),
    components: [{
      type: ComponentType.Container,
      components: [{
        type: ComponentType.MediaGallery,
        items: [{
          description: "Weapon specialisation proof",
          media: { data: { id: "attachment-1", url: "https://cdn.discord.test/proof.png", content_type: "image/png" } }
        }]
      }]
    }]
  };
}

function eligibleCharacter() {
  return {
    discordGuildId: "guild-1",
    discordUserId: "submitter-1",
    albionServer: "europe" as const,
    albionCharacterId: "character-1",
    characterName: "Example"
  };
}

function weaponSubmissionInteraction(channel: object, replies: unknown[]) {
  return {
    commandName: "weapon",
    guildId: "guild-1",
    guild: guildStub(),
    channelId: "channel-1",
    channel,
    user: { id: "submitter-1" },
    inCachedGuild: () => true,
    options: {
      getSubcommand: () => "100",
      getString: (name: string) => name === "character" ? "europe:character-1" : "weapon:battleaxe",
      getAttachment: () => ({ name: "proof.png", contentType: "image/png", url: "https://upload.test/proof.png" })
    },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { replies.push(payload); }
  };
}

function repositoryStub(overrides: Record<string, unknown> = {}) {
  return {
    getReviewerConfig: async () => ({ reviewerRoleId: "reviewer-role" }),
    getRequest: async () => request,
    decideRequest: async () => ({ request: { ...request, state: "confirmed" }, changed: true }),
    markReviewMessageDeleted: async () => undefined,
    ...overrides
  };
}

function buttonInteraction(message: object, replies: unknown[], roleIds: string[]) {
  return {
    customId: `specialisation:confirmed:${request.specialisationRequestId}`,
    guildId: "guild-1",
    guild: guildStub(),
    member: memberStub(roleIds),
    memberPermissions: { has: () => false },
    message,
    user: { id: "reviewer-user" },
    inCachedGuild: () => true,
    deferReply: async () => undefined,
    reply: async (payload: unknown) => { replies.push(payload); },
    editReply: async (payload: unknown) => { replies.push(payload); }
  };
}

function autocompleteInteraction(
  commandName: string,
  subcommand: string,
  focusedName: string,
  focusedValue: string,
  responses: unknown[],
  roleIds: string[],
  stringOptions: Record<string, string> = {}
) {
  return {
    commandName,
    guildId: "guild-1",
    guild: guildStub(),
    user: { id: "user-1" },
    member: memberStub(roleIds),
    memberPermissions: { has: () => false },
    inCachedGuild: () => true,
    options: {
      getFocused: () => ({ name: focusedName, value: focusedValue }),
      getSubcommand: () => subcommand,
      getInteger: () => null,
      getString: (name: string) => stringOptions[name] ?? null
    },
    respond: async (payload: unknown) => { responses.push(payload); }
  };
}

function guildStub() {
  return {
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    roles: {
      cache: new Map([["reviewer-role", { id: "reviewer-role", managed: false }]]),
      fetch: async () => null
    }
  };
}

function memberStub(roleIds: string[]) {
  return { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } };
}

function loggerStub() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function reviewerStub(roleIds: string[] = ["reviewer-role"]) {
  return {
    effectiveRoleIds: async () => roleIds,
    listBindings: async () => roleIds.map((discordRoleId) => ({ discordRoleId }))
  };
}

function componentJson(component: unknown): unknown {
  return component && typeof component === "object" && "toJSON" in component
    ? (component as { toJSON(): unknown }).toJSON()
    : component;
}

function catalogueInteraction(action: "reset" | "edit", modals: ModalBuilder[], replies: unknown[] = []) {
  return {
    commandName: "specialisation",
    guildId: "guild-1",
    guild: guildStub(),
    member: memberStub(["reviewer-role"]),
    memberPermissions: { has: () => false },
    user: { id: "reviewer-user" },
    inCachedGuild: () => true,
    options: { getSubcommand: () => action, getSubcommandGroup: () => "catalogue" },
    showModal: async (modal: ModalBuilder) => { modals.push(modal); },
    reply: async (payload: unknown) => { replies.push(payload); }
  };
}

function catalogueModalInput(modal: ModalBuilder) {
  return (modal.toJSON().components[0] as {
    components: Array<{ custom_id: string; required?: boolean; value?: string }>;
  }).components[0]!;
}

function entryContext(channel: object): never {
  return {
    checkAccess: async () => ({ channel: { ...channel, id: "configured-channel" }, discordChannelId: "configured-channel", configurationRevision: "revision" }),
    runExclusive: async (_g: string, work: () => Promise<unknown>) => work(),
    refresh: async () => undefined
  } as never;
}

test("restored specialisation requests present and notify the current owner while unowned requests stay silent", () => {
  const restored = { ...request, currentOwnerDiscordUserId: "new-owner" };
  const outcome = buildSpecialisationOutcome(restored, "confirmed");
  assert.match(outcome.content ?? "", /^<@new-owner>/);
  assert.deepEqual(outcome.allowedMentions, { parse: [], users: ["new-owner"], repliedUser: false });
  const card = componentJson(buildPendingSpecialisationCard(restored, "attachment://proof").components?.[0]);
  assert.match(JSON.stringify(card), /<@new-owner>/);
  assert.doesNotMatch(JSON.stringify(card), /<@submitter-1>/);
  const orphanOutcome = buildSpecialisationOutcome({ ...request, currentOwnerDiscordUserId: undefined }, "dismissed");
  assert.deepEqual(orphanOutcome.allowedMentions, { parse: [], users: [], repliedUser: false });
  assert.doesNotMatch(orphanOutcome.content ?? "", /<@submitter-1>/);
});
