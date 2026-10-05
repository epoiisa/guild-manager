import { ChannelType, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationClass, OpenApplication } from "../db/applicationRepository.js";
import { createApplicationCommandLifecyclePresentation } from "../services/applications/controlPresentation.js";
import { buildApplicationControlReplacementEmbed, buildApplicationIntakeCard, buildApplicationV2Card } from "../services/applications/rendering.js";
import {
  applicationOpenComponents,
  buildApplicationCharacterSelectRow,
  buildCharacterMatchesEmbed,
  buildCharacterRecoveryButtons,
  buildClosedChannelButtons,
  buildRemoteApplicationCharacterSelectRow,
  buildUndecidedButtons,
  buildWaitingButtons,
  handleApplicationButton,
  handleApplicationCharacterSelect,
  handleApplicationModalSubmit
} from "./application.js";

const WAITING_MEMBERSHIP_FOOTER = "Reviewers can verify membership or cancel this application.";
const OUTCOME_CLOSE_FOOTER = "The applicant or reviewers can close this channel.";
const CLOSED_CHANNEL_FOOTER = "The applicant or reviewers can reopen this channel. Reviewers can delete it.";
const REVIEWER_ONLY_FOOTER = "Reviewers only.";

function labels(row: { toJSON(): unknown }): Array<string | undefined> {
  const json = row.toJSON() as { components: Array<{ label?: string }> };
  return json.components.map((component) => component.label);
}

test("application controls are limited to their owning state messages", () => {
  assert.deepEqual(labels(buildUndecidedButtons("1")), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);
  assert.deepEqual(labels(buildWaitingButtons("1")), ["Verify Membership", "Cancel"]);
  assert.deepEqual(labels(applicationOpenComponents("accepted", "1")[0]), ["Close"]);
  assert.deepEqual(labels(applicationOpenComponents("rejected", "1")[0]), ["Close"]);
  assert.deepEqual(labels(applicationOpenComponents("withdrawn", "1")[0]), ["Close"]);
  assert.deepEqual(labels(buildClosedChannelButtons("1")), ["Reopen", "Delete"]);
});

test("closing persists the canonical Application Closed message id", async () => {
  const harness = createHarness({ status: "accepted" });
  harness.interaction.customId = "app:close:1";
  harness.interaction.followUp = (async (payload: unknown) => {
    harness.followUps.push(payload);
    return { id: "closed-message" };
  }) as never;
  await runButton(harness);
  assert.equal(harness.openApplication.closedControlMessageId, "closed-message");
  assert.deepEqual(harness.closedControlMessageIdUpdates, ["closed-message"]);
});

test("reopening clears the canonical Application Closed message id", async () => {
  const harness = createHarness({ status: "accepted", channelStatus: "closed", closedControlMessageId: "source-message" });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("source-message", "Application Closed");
  await runButton(harness);
  assert.equal(harness.openApplication.closedControlMessageId, undefined);
  assert.deepEqual(harness.closedControlMessageIdUpdates, [undefined]);
});

test("a legacy Application Closed control is adopted when no canonical id is stored", async () => {
  const harness = createHarness({ status: "accepted", channelStatus: "closed" });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("legacy-closed", "Application Closed");
  await runButton(harness);
  assert.equal(harness.openApplication.closedControlMessageId, undefined);
  assert.deepEqual(harness.closedControlMessageIdUpdates, ["legacy-closed", undefined]);
  assert.equal(harness.reopenedBy, "applicant");
});

test("a mismatched canonical Application Closed id is stale for reopen and delete", async () => {
  for (const action of ["reopen", "delete"]) {
    const harness = createHarness(
      { status: "accepted", channelStatus: "closed", closedControlMessageId: "other" },
      { reviewer: action === "delete" }
    );
    harness.interaction.customId = `app:${action}:1`;
    harness.interaction.message = createSourceMessage("source-message", "Application Closed");
    await runButton(harness);
    assert.equal(embedTitle(harness.followUps[0] ?? harness.replies[0]), "Stale Application Control");
    assert.deepEqual(harness.permissionValues, []);
    assert.equal(harness.reopenedBy, undefined);
    assert.equal(harness.deletedBy, undefined);
  }
});

test("character controls distinguish unresolved and selected characters", () => {
  assert.deepEqual(labels(buildCharacterRecoveryButtons("1", "unresolved")), ["Retry Character Search"]);
  assert.deepEqual(labels(buildCharacterRecoveryButtons("1", "not_listed")), ["Retry Character Search"]);
  assert.deepEqual(labels(buildCharacterRecoveryButtons("1", "registered_to_other_user")), ["Retry Character Search"]);
  assert.deepEqual(labels(buildCharacterRecoveryButtons("1", "selected")), ["Retry Character Search"]);
});

test("initial and retried searches render the same public character menu", () => {
  const players = [{
    id: "character-1",
    name: "Applicant Character",
    guildName: "The Drop Bears",
    allianceName: "Funky Monke Fridays",
    allianceTag: "FUNKY"
  }];
  const json = buildApplicationCharacterSelectRow("europe", "1", players).toJSON();
  assert.equal(json.components[0].custom_id, "app:character:1");
  assert.equal(json.components[0].options[0]!.description, "The Drop Bears • Funky Monke Fridays [FUNKY] • Europe • character-1");
  assert.equal(json.components[0].options.at(-1)?.label, "My character is not shown here");
  assert.equal(
    buildCharacterMatchesEmbed("europe", "Applicant", players, 1).toJSON().description,
    "1. Applicant Character • Europe • `character-1`"
  );
  const remote = buildRemoteApplicationCharacterSelectRow("europe", "1", "applicant", Date.now() + 60_000, 1, players).toJSON();
  assert.equal(remote.components[0].options[0]!.description, json.components[0].options[0]!.description);
  const long = buildApplicationCharacterSelectRow("europe", "1", [{
    id: "character-1",
    name: "Applicant Character",
    guildName: "Very Long Guild Name ".repeat(5),
    allianceName: "Very Long Alliance Name ".repeat(5),
    allianceTag: "FUNKY"
  }]).toJSON().components[0].options[0]!.description!;
  assert.equal(long.length, 100);
  assert.match(long, /\.\.\. • Europe • character-1$/);
  const withoutMembership = [{ id: "character-2", name: "Unaffiliated Character" }];
  assert.equal(
    buildCharacterMatchesEmbed("europe", "Unaffiliated", withoutMembership, 1).toJSON().description,
    "1. Unaffiliated Character • Europe • `character-2`"
  );
  assert.equal(
    buildApplicationCharacterSelectRow("europe", "1", withoutMembership).toJSON().components[0].options[0]!.description,
    "Europe • character-2"
  );
});

test("selection shows the exact resolved name and leaves target membership validation to acceptance", async () => {
  const harness = createHarness({ status: "open", characterResolutionState: "unresolved", characterResolutionMessageId: "character-message" });
  harness.application.memberGroupId = "alliance-group";
  harness.openApplication.targetMemberGroupName = "Funky Monke Fridays";
  harness.openApplication.targetMemberGroupType = "alliance";
  harness.player = { id: "replacement-character", name: "Exact Character", allianceId: "different-alliance" };
  harness.interaction.customId = "app:character:1:1";
  harness.interaction.message = createSourceMessage("character-message", "Application");
  harness.interaction.values = ["replacement-character"];

  await runCharacterSelect(harness);

  assert.equal(harness.lifecycleEvents[0], "deferUpdate");
  assert.equal(harness.selectedCharacterId, "replacement-character");
  assert.equal(embedField(harness.sentMessages[0], "Character"), "Exact Character • Europe • `replacement-character` • [AlbionDB](https://europe.albiondb.net/player/Exact%20Character) • [Killboard1](https://killboard-1.com/eu/player/Exact%20Character)");
  assert.equal(embedField(harness.sentMessages[0], "Alliance"), "Funky Monke Fridays • alliance • Europe");
  assert.equal(harness.configuredAllianceLookups, 0);
  assert.equal(harness.guildLookups, 0);
});

test("remote character menus bind the actor, search attempt, and a bounded expiry without a retry control", () => {
  const row = buildRemoteApplicationCharacterSelectRow("europe", "application-123", "actor-456", Date.now() + 14 * 60_000, 3, [{ id: "character-1", name: "Applicant Character" }]);
  const menu = row.toJSON().components[0];
  assert.ok(menu.custom_id?.startsWith("app:remote-character:application-123:actor-456:"));
  assert.ok((menu.custom_id?.length ?? 0) <= 100);
  assert.deepEqual(menu.options?.map((option) => option.value), ["character-1", "__not_listed"]);
});

test("remote character selections acknowledge before validation and reject actors, expiry, authorization, and stale state", async () => {
  const cases: Array<{
    name: string;
    options: HarnessOptions;
    menuActor: string;
    expiry?: number;
    attempt?: number;
    mutate: (harness: ReturnType<typeof createHarness>) => void;
    title: string;
  }> = [
    { name: "another actor", options: { actorId: "outsider" }, menuActor: "applicant", mutate: () => undefined, title: "This search menu has expired or belongs to another user." },
    { name: "expired menu", options: {}, menuActor: "applicant", expiry: Date.now() - 1, mutate: () => undefined, title: "This search menu has expired or belongs to another user." },
    { name: "unauthorized initiator", options: { actorId: "outsider" }, menuActor: "outsider", mutate: () => undefined, title: "Only the applicant or a configured reviewer can choose the application character." },
    { name: "stale attempt", options: {}, menuActor: "applicant", attempt: 2, mutate: () => undefined, title: "Use the controls on the current application card." },
    { name: "changed lifecycle", options: {}, menuActor: "applicant", mutate: (harness: ReturnType<typeof createHarness>) => { harness.openApplication.channelStatus = "closed"; }, title: "That application is no longer open." }
  ];

  for (const scenario of cases) {
    const harness = createHarness({ status: "open", characterResolutionMessageId: "character-message", characterSearchAttemptCount: 1 }, scenario.options);
    scenario.mutate(harness);
    harness.interaction.customId = remoteCharacterCustomId("1", scenario.menuActor, scenario.expiry ?? Date.now() + 60_000, scenario.attempt ?? 1);
    harness.interaction.values = ["replacement-character"];
    await runCharacterSelect(harness);
    assert.equal(harness.deferredUpdates, 1, scenario.name);
    assert.equal(harness.lifecycleEvents[0], "deferUpdate", scenario.name);
    assert.equal(embedTitle(harness.editedReplies[0]), scenario.title, scenario.name);
    assert.deepEqual(harness.messageEdits["character-message"] ?? [], [], scenario.name);
  }
});

test("remote character selections require the current bot-authored canonical option", async () => {
  for (const scenario of ["missing", "wrong", "non-bot", "absent-option"] as const) {
    const harness = createHarness({ status: "open", characterResolutionMessageId: "character-message" });
    if (scenario === "missing") harness.storedMessages.delete("character-message");
    if (scenario === "wrong") harness.interaction.guild.channels.cache.get = () => undefined as never;
    if (scenario === "non-bot") harness.storedMessages.get("character-message")!.author.id = "someone-else";
    if (scenario === "absent-option") harness.storedMessages.get("character-message")!.components[0].components[0].options = [{ value: "different-character" }];
    harness.interaction.customId = remoteCharacterCustomId("1", "applicant", Date.now() + 60_000, 1);
    harness.interaction.values = ["replacement-character"];
    await runCharacterSelect(harness);
    assert.equal(harness.deferredUpdates, 1, scenario);
    assert.equal(embedTitle(harness.editedReplies[0]), "Use the controls on the current application card.", scenario);
    assert.deepEqual(harness.messageEdits["character-message"] ?? [], [], scenario);
  }
});

test("remote character selection replaces the canonical message and retires the temporary menu", async () => {
  const selected = createHarness({ status: "open", characterResolutionMessageId: "character-message" });
  selected.interaction.customId = remoteCharacterCustomId("1", "applicant", Date.now() + 60_000, 1);
  selected.interaction.values = ["replacement-character"];
  await runCharacterSelect(selected);
  assert.equal(selected.deferredUpdates, 1);
  assert.equal(selected.lifecycleEvents[0], "deferUpdate");
  assert.equal(selected.selectedCharacterId, "replacement-character");
  assert.equal(selected.selectedCharacterState, "selected");
  assert.deepEqual(payloadLabels(selected.sentMessages[0]), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);
  assert.deepEqual(selected.deletedMessages, ["character-message"]);
  assert.equal(embedTitle(selected.editedReplies[0]), "The application card in <#channel-1> was updated.");
  assert.deepEqual(payloadLabels(selected.editedReplies[0]), []);

  const reviewer = createHarness(
    { status: "open", characterResolutionMessageId: "character-message" },
    { actorId: "reviewer", reviewer: true }
  );
  reviewer.interaction.customId = remoteCharacterCustomId("1", "reviewer", Date.now() + 60_000, 1);
  reviewer.interaction.values = ["replacement-character"];
  await runCharacterSelect(reviewer);
  assert.equal(reviewer.selectedCharacterId, "replacement-character");
  assert.equal(embedTitle(reviewer.editedReplies[0]), "The application card in <#channel-1> was updated.");

  const notListed = createHarness({ status: "open", characterResolutionMessageId: "character-message" });
  notListed.interaction.customId = remoteCharacterCustomId("1", "applicant", Date.now() + 60_000, 1);
  notListed.interaction.values = ["__not_listed"];
  await runCharacterSelect(notListed);
  assert.equal(notListed.markedNotListed, true);
  assert.deepEqual(notListed.messageEdits["character-message"], [["Retry Character Search", "Close", "Withdraw"]]);
  assert.equal(embedTitle(notListed.editedReplies[0]), "The application card in <#channel-1> was updated.");
  assert.deepEqual(payloadLabels(notListed.editedReplies[0]), []);

  const conflict = createHarness({ status: "open", characterResolutionMessageId: "character-message" });
  conflict.membershipRegisteredCharacter = { discordUserId: "other-user" };
  conflict.interaction.customId = remoteCharacterCustomId("1", "applicant", Date.now() + 60_000, 1);
  conflict.interaction.values = ["replacement-character"];
  await runCharacterSelect(conflict);
  assert.equal(conflict.selectedCharacterState, "registered_to_other_user");
  assert.equal(embedTitle(conflict.editedReplies[0]), "The application card in <#channel-1> was updated.");
  assert.deepEqual(payloadLabels(conflict.editedReplies[0]), []);
});

test("selecting a character replaces the first card and retires legacy duplicate controls", async () => {
  const selected = createHarness({
    status: "open",
    characterResolutionState: "unresolved",
    characterResolutionMessageId: "character-message",
    applicationControlMessageId: "initial-message"
  });
  selected.interaction.customId = "app:character:1:1";
  selected.interaction.message = createSourceMessage("initial-message", "Character Selection");
  selected.storedMessages.get("initial-message")!.components = selected.storedMessages.get("character-message")!.components;
  selected.interaction.values = ["replacement-character"];

  await runCharacterSelect(selected);

  assert.equal(embedField(selected.sentMessages[0], "Character"), "Replacement Character • Europe • `replacement-character` • [AlbionDB](https://europe.albiondb.net/player/Replacement%20Character) • [Killboard1](https://killboard-1.com/eu/player/Replacement%20Character)");
  assert.deepEqual(payloadLabels(selected.sentMessages[0]), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);
  assert.deepEqual(selected.deletedMessages, ["initial-message"]);
  assert.deepEqual(selected.messageEdits["character-message"], [[]]);
});

test("Retry Character Search remains available to the applicant and reviewer after selection, while outsiders are denied", async () => {
  for (const actor of [
    { actorId: "applicant", reviewer: false },
    { actorId: "reviewer", reviewer: true }
  ]) {
    const harness = createHarness({
      status: "open",
      characterResolutionState: "selected",
      characterResolutionMessageId: "character-message"
    }, actor);
    const modals: Array<{ toJSON(): { custom_id?: string; title?: string } }> = [];
    harness.interaction.customId = "app:retry-character:1";
    harness.interaction.message = createSourceMessage("character-message", "Character Selected");
    harness.interaction.showModal = async (modal: unknown) => { modals.push(modal as { toJSON(): { custom_id?: string; title?: string } }); };

    await runButton(harness);

    assert.equal(modals.length, 1);
    assert.equal(modals[0].toJSON().custom_id, "app:character-search:1");
    assert.equal(modals[0].toJSON().title, "Retry Character Search");
  }

  const outsider = createHarness({ status: "open", characterResolutionMessageId: "character-message" }, { actorId: "outsider" });
  outsider.interaction.customId = "app:retry-character:1";
  outsider.interaction.message = createSourceMessage("character-message", "Choose Your Character");
  await runButton(outsider);
  assert.equal(embedTitle(outsider.replies[0]), "Only the applicant or a configured reviewer can retry the character search.");
});

test("character search modal acknowledges before application and Albion Online I/O", async () => {
  const harness = createHarness({
    status: "open",
    characterResolutionState: "selected",
    characterResolutionMessageId: "character-message"
  });
  const originalGetOpenApplication = harness.repository.getOpenApplication;
  const originalGetApplicationClass = harness.repository.getApplicationClass;
  harness.interaction.customId = "app:character-search:1";
  harness.interaction.message = createSourceMessage("character-message", "Character Selected");
  Object.assign(harness.interaction, {
    isFromMessage: () => true,
    fields: { getTextInputValue: () => "Applicant Character" }
  });
  harness.repository.getOpenApplication = async (...args: Parameters<typeof originalGetOpenApplication>) => {
    harness.lifecycleEvents.push("getOpenApplication");
    return originalGetOpenApplication(...args);
  };
  harness.repository.getApplicationClass = async (...args: Parameters<typeof originalGetApplicationClass>) => {
    harness.lifecycleEvents.push("getApplicationClass");
    return originalGetApplicationClass(...args);
  };

  await handleApplicationModalSubmit(
    harness.interaction as unknown as ModalSubmitInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationModalSubmit>[1],
    { listMemberGroups: async () => [] } as unknown as Parameters<typeof handleApplicationModalSubmit>[2],
    {
      searchCharacters: async () => {
        harness.lifecycleEvents.push("searchCharacters");
        throw new Error("unavailable");
      }
    } as unknown as Parameters<typeof handleApplicationModalSubmit>[3]
  );

  assert.equal(harness.lifecycleEvents[0], "deferUpdate");
  assert.ok(harness.lifecycleEvents.indexOf("getOpenApplication") > 0);
  assert.ok(harness.lifecycleEvents.indexOf("getApplicationClass") > 0);
  assert.ok(harness.lifecycleEvents.indexOf("searchCharacters") > 0);
  assert.equal(embedTitle(harness.followUps[0]), "Albion Online character search is temporarily unavailable. Try again.");
});

test("the shared character menu lets the applicant or reviewer select or replace, but denies outsiders", async () => {
  for (const actor of [
    { actorId: "applicant", reviewer: false },
    { actorId: "reviewer", reviewer: true }
  ]) {
    const harness = createHarness({
      status: "open",
      characterResolutionState: "selected",
      characterResolutionMessageId: "character-message"
    }, actor);
    const selected: string[] = [];
    harness.interaction.customId = "app:character:1:1";
    harness.interaction.message = createSourceMessage("character-message", "Character Selected");
    harness.interaction.values = ["replacement-character"];
    harness.repository.selectApplicationCharacter = async (_guildId: string, _applicationId: string, characterId: string) => {
      selected.push(characterId);
      return harness.openApplication;
    };

    await runCharacterSelect(harness);

    assert.deepEqual(selected, ["replacement-character"]);
    assert.equal(embedField(harness.sentMessages[0], "Character"), "Applicant Character • Europe • `character-1` • [AlbionDB](https://europe.albiondb.net/player/Applicant%20Character) • [Killboard1](https://killboard-1.com/eu/player/Applicant%20Character)");
    assert.deepEqual(payloadLabels(harness.sentMessages[0]), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);

    const notListed: string[] = [];
    harness.interaction.values = ["__not_listed"];
    harness.repository.markApplicationCharacterNotListed = async (_guildId: string, applicationId: string) => {
      notListed.push(applicationId);
      return harness.openApplication;
    };
    await runCharacterSelect(harness);
    assert.deepEqual(notListed, []);
    assert.equal(embedTitle(harness.followUps[0]), "Use the controls on the current application card.");
    assert.deepEqual(harness.editedReplies, []);
  }

  const outsider = createHarness({ status: "open", characterResolutionMessageId: "character-message" }, { actorId: "outsider" });
  outsider.interaction.customId = "app:character:1:1";
  outsider.interaction.message = createSourceMessage("character-message", "Choose Your Character");
  outsider.interaction.values = ["replacement-character"];
  await runCharacterSelect(outsider);
  assert.equal(embedTitle(outsider.followUps[0]), "Only the applicant or a configured reviewer can choose the application character.");
});

test("canonical character-selection validation follows up ephemerally without changing the public message", async () => {
  for (const scenario of [
    { name: "not open", overrides: { status: "accepted" as const }, actor: { actorId: "applicant", reviewer: false }, sourceId: "character-message", title: "Application Not Open", description: "That application is no longer open." },
    { name: "stale source", overrides: { status: "open" as const }, actor: { actorId: "applicant", reviewer: false }, sourceId: "stale-message", title: "Stale Character Control", description: "Use the controls on the current application card." },
    { name: "outsider", overrides: { status: "open" as const }, actor: { actorId: "outsider", reviewer: false }, sourceId: "character-message", title: "Selection Not Allowed", description: "Only the applicant or a configured reviewer can choose the application character." }
  ]) {
    const harness = createHarness({ ...scenario.overrides, characterResolutionMessageId: "character-message" }, scenario.actor);
    harness.interaction.customId = "app:character:1:1";
    harness.interaction.message = createSourceMessage(scenario.sourceId, "Choose Your Character");
    harness.interaction.values = ["replacement-character"];
    await runCharacterSelect(harness);

    assert.equal(harness.deferredUpdates, 1, scenario.name);
    assert.equal(harness.lifecycleEvents[0], "deferUpdate", scenario.name);
    assert.equal(embedTitle(harness.followUps[0]), scenario.description, scenario.name);
    assert.equal(embedDescription(harness.followUps[0]), scenario.description, scenario.name);
    assert.equal(((harness.followUps[0] as { flags?: number }).flags ?? 0) & MessageFlags.Ephemeral, MessageFlags.Ephemeral, scenario.name);
    assert.deepEqual(harness.editedReplies, [], scenario.name);
    assert.deepEqual(harness.messageEdits["character-message"] ?? [], [], scenario.name);
  }
});

test("rejection and withdrawal retire the earlier decision and character controls", async () => {
  for (const scenario of [
    { action: "reject", actorId: "reviewer", reviewer: true, title: "Application Rejected", description: "Application rejected by <@reviewer>." },
    { action: "withdraw", actorId: "applicant", reviewer: false, title: "Application Withdrawn", description: "<@applicant> withdrew this application." }
  ]) {
    const harness = createHarness({
      status: "open",
      applicationControlMessageId: "review-message",
      characterResolutionMessageId: "character-message"
    }, { actorId: scenario.actorId, reviewer: scenario.reviewer });
    const reviewEdits: unknown[] = [];
    harness.interaction.customId = `app:${scenario.action}:1`;
    harness.interaction.message = {
      ...createSourceMessage("review-message", "Guild Application"),
      edit: async (payload: unknown) => { reviewEdits.push(payload); }
    };

    await runButton(harness);

    assert.deepEqual(payloadLabels(reviewEdits[0]), []);
    assert.deepEqual(harness.messageEdits["character-message"], [[]]);
    const response = harness.followUps[0];
    assert.equal(embedTitle(response), scenario.title);
    assert.equal(embedDescription(response), scenario.description);
    assert.equal(embedFooter(response), `*${OUTCOME_CLOSE_FOOTER}*`);
    assert.deepEqual(payloadLabels(response), ["Close"]);
    assert.equal(harness.storedApplicationControlMessageId, "response-message");
  }
});

for (const action of ["withdraw", "close"] as const) {
  test(`${action} before first selection deletes the prompt after posting its replacement`, async () => {
    for (const characterResolutionState of ["unresolved", "not_listed", "registered_to_other_user"] as const) {
      const { harness, prompt } = createInitialPromptHarness(action, { characterResolutionState });
      const remove = prompt.delete;
      prompt.delete = async () => {
        assert.equal(embedTitle(harness.followUps[0]), action === "withdraw" ? "Application Withdrawn" : "Application Closed");
        if (action === "withdraw") assert.equal(harness.storedApplicationControlMessageId, "response-message");
        await remove();
      };
      await runButton(harness);
      assert.deepEqual(harness.deletedMessages, ["initial-message"]);
      assert.equal(harness.storedMessages.has("initial-message"), false);
      assert.deepEqual(harness.openApplication.modalAnswers, [{ question: "Why?", answer: "To join." }]);
      assert.equal(harness.openApplication.status, action === "withdraw" ? "withdrawn" : "open");
      assert.equal(harness.openApplication.channelStatus, action === "close" ? "closed" : "open");
      assert.deepEqual(payloadLabels(harness.followUps[0]), action === "withdraw" ? ["Close"] : ["Reopen", "Delete"]);
    }
  });
}

test("reopening before first selection recreates and links a silent selection prompt", async () => {
  const { harness } = createInitialPromptHarness("close");
  await runButton(harness);
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("response-message", "Application Closed");
  await runButton(harness);
  assert.equal(harness.openApplication.channelStatus, "open");
  assert.notEqual(harness.openApplication.applicationControlMessageId, "initial-message");
  assert.equal(harness.openApplication.applicationControlMessageId, harness.openApplication.characterResolutionMessageId);
  const prompt = harness.sentMessages[0];
  assert.deepEqual(payloadLabels(prompt), ["Retry Character Search", "Close", "Withdraw"]);
  assert.deepEqual((prompt as { allowedMentions: unknown }).allowedMentions, { parse: [], repliedUser: false });
});

test("command closure also deletes the initial prompt after publishing the closed card", async () => {
  const { harness, prompt } = createInitialPromptHarness("close");
  harness.openApplication.channelStatus = "closed";
  const remove = prompt.delete;
  prompt.delete = async () => {
    assert.deepEqual(payloadLabels(harness.sentMessages[0]), ["Reopen", "Delete"]);
    await remove();
  };
  const presentation = createApplicationCommandLifecyclePresentation(harness.channel as never, harness.repository as never);
  assert.equal(await presentation.renderClosed("1", "Closed by <@reviewer>."), "replacement-message");
  assert.deepEqual(harness.deletedMessages, ["initial-message"]);
});

test("closing a withdrawal before selection retains its outcome message", async () => {
  const { harness } = createInitialPromptHarness("withdraw");
  await runButton(harness);
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = Object.assign(createSourceMessage("response-message", "Application Withdrawn"), {
    delete: async () => assert.fail("The withdrawal history must remain"),
  });
  await runButton(harness);
  assert.deepEqual(harness.deletedMessages, ["initial-message"]);
  assert.equal(embedTitle(harness.followUps[1]), "Application Closed");
});

test("selection and earlier review or legacy history are retained on close and withdrawal", async () => {
  for (const action of ["close", "withdraw"] as const) {
    for (const retained of [
      { characterResolutionState: "selected", selectedAlbionCharacterId: "character-1", selectedCharacterName: "Applicant Character" },
      { reviewPublication: { reviewerRoleId: "reviewer-role", answerMessageIds: [], notificationClaimed: true } },
      { legacyReviewPublication: true },
    ] satisfies Partial<OpenApplication>[]) {
      const { harness } = createInitialPromptHarness(action, retained);
      await runButton(harness);
      assert.deepEqual(harness.deletedMessages, []);
      assert.deepEqual(harness.messageEdits["initial-message"], [[]]);
    }
  }
});

test("failed prompt deletion retires its controls without losing the withdrawal message", async () => {
  const { harness, prompt } = createInitialPromptHarness("withdraw");
  prompt.delete = async () => { throw Object.assign(new Error("Cannot delete message"), { code: 50013 }); };
  await runButton(harness);
  assert.equal(harness.openApplication.status, "withdrawn");
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Close"]);
  assert.deepEqual(harness.messageEdits["initial-message"], [[]]);
  assert.equal(messageText(harness.messagePayloads["initial-message"][0]).some((text) => text.startsWith("*The applicant")), false);
});

test("failed withdrawal publication keeps the initial prompt available", async () => {
  const { harness } = createInitialPromptHarness("withdraw");
  harness.interaction.followUp = async () => { throw new Error("Cannot send withdrawal message"); };
  await assert.rejects(runButton(harness), /Cannot send withdrawal message/);
  assert.deepEqual(harness.deletedMessages, []);
  assert.equal(harness.storedMessages.has("initial-message"), true);
});

test("final acceptance retires the earlier decision and character controls and owns Close on its confirmation", async () => {
  const harness = createHarness({
    status: "open",
    applicationControlMessageId: "review-message",
    characterResolutionMessageId: "character-message",
    selectedAlbionCharacterId: "character-1"
  }, { actorId: "reviewer", reviewer: true });
  const reviewEdits: unknown[] = [];
  harness.interaction.customId = "app:accept:1";
  harness.interaction.message = {
    ...createSourceMessage("review-message", "Guild Application"),
    edit: async (payload: unknown) => { reviewEdits.push(payload); }
  };
  const originalCard = JSON.parse(JSON.stringify(buildApplicationIntakeCard(harness.application, harness.openApplication)));
  Object.assign(harness.interaction.message, { embeds: [], components: originalCard.components });
  const member = {
    id: "applicant",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: () => false },
      add: async () => undefined,
      remove: async () => undefined
    },
    setNickname: async () => undefined
  };
  harness.interaction.guild.members = { fetch: async () => member };
  harness.interaction.guild.channels.fetch = async () => undefined;

  await handleApplicationButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
    {
      listMemberGroups: async () => [],
      listConfiguredAlbionGuilds: async () => [],
      listConfiguredAlbionAlliances: async () => [],
      upsertVerifiedCharacter: async () => undefined,
      listProfilesForCharacter: async () => [],
      getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined,
      listRegisteredCharacters: async () => [],
      completeApplicationAcceptance: async (input: { reviewerDiscordUserId: string }) => {
        harness.acceptedBy = input.reviewerDiscordUserId;
        return {
          discordGuildId: "guild-1",
          discordUserId: "applicant",
          albionServer: "europe",
          albionCharacterId: "character-1",
          characterName: "Applicant Character"
        };
      },
      setMainCharacter: async () => undefined,
      listDormantReactionRoleSubscriptions: async () => [],
      listConfiguredRoleIdsForGuild: async () => [],
      listQualifiedRoleIdsForUser: async () => [],
      getEffectiveNickname: async () => undefined
    } as unknown as Parameters<typeof handleApplicationButton>[2],
    {
      getPlayer: async () => ({
        id: "character-1",
        name: "Applicant Character"
      })
    } as unknown as Parameters<typeof handleApplicationButton>[3]
  );

  assert.deepEqual(payloadLabels(reviewEdits[0]), []);
  assert.deepEqual(harness.messageEdits["character-message"], [[]]);
  assert.equal(harness.acceptedBy, "reviewer");
  assert.deepEqual(messageText(reviewEdits[0]), messageText(originalCard).slice(0, -1));
  assert.equal(embedTitle(harness.followUps[0]), "Application Accepted");
  assert.equal(embedDescription(harness.followUps[0]), "Application accepted by <@reviewer>.\n\nApplicant Character • <@applicant> was registered.");
  assert.equal(embedFooter(harness.followUps[0]), `*${OUTCOME_CLOSE_FOOTER}*`);
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Close"]);
  assert.equal(harness.storedApplicationControlMessageId, "response-message");
});

test("acceptance is blocked before character or membership writes when the applicant left Discord", async () => {
  const harness = createHarness({
    status: "open",
    applicationControlMessageId: "review-message",
    selectedAlbionCharacterId: "character-1"
  }, { actorId: "reviewer", reviewer: true });
  harness.interaction.customId = "app:accept:1";
  harness.interaction.message = createSourceMessage("review-message", "Guild Application");
  harness.interaction.guild.members.fetch = async () => Promise.reject({ code: 10_007 });
  let characterLookups = 0;

  await handleApplicationButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
    {} as Parameters<typeof handleApplicationButton>[2],
    {
      getPlayer: async () => {
        characterLookups += 1;
        return { id: "character-1", name: "Applicant Character" };
      }
    } as unknown as Parameters<typeof handleApplicationButton>[3]
  );

  assert.equal(characterLookups, 0);
  assert.equal(harness.acceptedBy, undefined);
  assert.equal(embedTitle(harness.followUps[0]), "Applicant Not In Server: This application cannot be accepted because the applicant is no longer in this Discord server. Reject the application if no further review is needed.");
  assert.equal(
    embedDescription(harness.followUps[0]),
    "Applicant Not In Server: This application cannot be accepted because the applicant is no longer in this Discord server. Reject the application if no further review is needed."
  );
});

test("accept and verify acknowledge before reviewer and lifecycle validation", async () => {
  for (const scenario of [
    { name: "outsider", action: "accept", options: { reviewer: false }, overrides: { status: "open", selectedAlbionCharacterId: "character-1" }, title: "Reviewer Role Required: Only members with <@&reviewer-role> can use this control." },
    { name: "Administrator-like outsider", action: "accept", options: { roleIds: ["administrator"] }, overrides: { status: "open", selectedAlbionCharacterId: "character-1" }, title: "Reviewer Role Required: Only members with <@&reviewer-role> can use this control." },
    { name: "closed application", action: "accept", options: { reviewer: true }, overrides: { status: "open", channelStatus: "closed", selectedAlbionCharacterId: "character-1" }, title: "Application Closed: Reopen the application before using decision controls." },
    { name: "wrong accept state", action: "accept", options: { reviewer: true }, overrides: { status: "accepted", selectedAlbionCharacterId: "character-1" }, title: "Application Already Decided: That application can no longer be accepted." },
    { name: "unresolved accept character", action: "accept", options: { reviewer: true }, overrides: { status: "open", characterResolutionState: "unresolved" }, title: "Character Not Resolved: Approval is blocked until the applicant's intended character is verified and selected." },
    { name: "wrong verify state", action: "verify", options: { reviewer: true }, overrides: { status: "open", selectedAlbionCharacterId: "character-1" }, title: "Application Already Decided: That application can no longer be accepted." },
    { name: "unresolved verify character", action: "verify", options: { reviewer: true }, overrides: { status: "awaiting_ingame_membership", characterResolutionState: "unresolved" }, title: "Character Not Resolved: Approval is blocked until the applicant's intended character is verified and selected." }
  ] as const) {
    const harness = createHarness({ applicationControlMessageId: "review-message", ...scenario.overrides }, { actorId: "reviewer", ...scenario.options });
    harness.interaction.customId = `app:${scenario.action}:1`;
    harness.interaction.message = createSourceMessage("review-message", scenario.action === "verify" ? "Waiting For In-Game Membership" : "Guild Application");
    await runButton(harness);
    assert.equal(embedTitle(harness.followUps[0]), scenario.title, scenario.name);
    assert.equal(harness.deferredUpdates, 1, scenario.name);
    assert.equal(harness.lifecycleEvents[0], "deferUpdate", scenario.name);
    assert.equal(harness.acceptedBy, undefined, scenario.name);
    assert.equal(harness.membershipFailure, undefined, scenario.name);
  }
});

test("successful accept and verify defer before invoking service effects", async () => {
  for (const [action, status, title] of [["accept", "open", "Guild Application"], ["verify", "awaiting_ingame_membership", "Waiting For In-Game Membership"]] as const) {
    const harness = createHarness({ status, applicationControlMessageId: "review-message", selectedAlbionCharacterId: "character-1" }, { actorId: "reviewer", reviewer: true });
    harness.interaction.customId = `app:${action}:1`;
    harness.interaction.message = createSourceMessage("review-message", title);
    await handleApplicationButton(
      harness.interaction as unknown as ButtonInteraction,
      harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
      {
        listMemberGroups: async () => [],
        listConfiguredAlbionGuilds: async () => [],
        listConfiguredAlbionAlliances: async () => [],
        upsertVerifiedCharacter: async () => undefined,
        listProfilesForCharacter: async () => [],
        getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined,
        completeApplicationAcceptance: async (input: { reviewerDiscordUserId: string }) => {
          harness.acceptedBy = input.reviewerDiscordUserId;
          return { albionServer: "europe", albionCharacterId: "character-1", characterName: "Applicant Character" };
        }
      } as unknown as Parameters<typeof handleApplicationButton>[2],
      { getPlayer: async () => ({ id: "character-1", name: "Applicant Character" }) } as unknown as Parameters<typeof handleApplicationButton>[3]
    );
    assert.equal(harness.deferredUpdates, 1, action);
    assert.equal(harness.acceptedBy, "reviewer", action);
  }
});

test("accepted Close clears its outcome message and puts lifecycle controls only on Application Closed", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: "accepted-message" });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");

  await runButton(harness);

  assert.equal(harness.closedBy, "applicant");
  assert.deepEqual(harness.permissionValues, [false, false]);
  assert.equal(harness.deferredUpdates, 1);
  assert.deepEqual(harness.editedReplies, []);
  assert.equal(embedTitle(harness.followUps[0]), "Application Closed");
  assert.equal(embedFooter(harness.followUps[0]), `*${CLOSED_CHANNEL_FOOTER}*`);
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Reopen", "Delete"]);
});

test("application lifecycle controls acknowledge before reading or changing remote state", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: "accepted-message" });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");

  await runButton(harness);

  assert.deepEqual(harness.lifecycleEvents.slice(0, 2), ["deferUpdate", "getOpenApplication"]);
});

test("an already-closed application repairs a stale outcome Close control", async () => {
  const harness = createHarness({
    status: "accepted",
    channelStatus: "closed",
    applicationControlMessageId: "accepted-message"
  });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");

  await runButton(harness);

  assert.equal(harness.closedBy, undefined);
  assert.deepEqual(harness.permissionValues, [false, false]);
  assert.deepEqual(harness.editedReplies, []);
  assert.equal(embedTitle(harness.followUps[0]), "Application Closed");
  assert.equal(embedDescription(harness.followUps[0]), "This application channel is closed.");
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Reopen", "Delete"]);
});

test("a lost concurrent application close transition does not present a second closure", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: "accepted-message" });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");
  (harness.repository as unknown as Parameters<typeof handleApplicationButton>[1]).markApplicationClosed = async (_guildId: string, _applicationId: string, actorId: string) => {
    harness.closedBy = actorId;
    harness.openApplication.channelStatus = "closed";
    return undefined;
  };

  await runButton(harness);

  assert.equal(harness.closedBy, "applicant");
  assert.equal(harness.openApplication.channelStatus, "closed");
  assert.equal(embedTitle(harness.followUps[0]), "Channel Not Open: This application channel is not open.");
  assert.equal(embedDescription(harness.followUps[0]), "Channel Not Open: This application channel is not open.");
});

test("a presentation failure after closing is recoverable from the retained stale Close control", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: "accepted-message" });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");
  let failPresentation = true;
  const followUp = harness.interaction.followUp;
  harness.interaction.followUp = async (payload: unknown) => {
    if (failPresentation) {
      failPresentation = false;
      throw new Error("Unknown interaction");
    }
    return followUp(payload);
  };

  await assert.rejects(runButton(harness), /Unknown interaction/);
  assert.equal(harness.openApplication.channelStatus, "closed");
  assert.deepEqual(harness.editedReplies, []);

  await runButton(harness);

  assert.deepEqual(harness.editedReplies, []);
  assert.equal(embedDescription(harness.followUps.at(-1)), "This application channel is closed.");
  assert.deepEqual(payloadLabels(harness.followUps.at(-1)), ["Reopen", "Delete"]);
});

test("application deletion failure leaves the lifecycle closed and retryable", async () => {
  const harness = createHarness(
    { status: "accepted", channelStatus: "closed" },
    { actorId: "reviewer", reviewer: true }
  );
  harness.interaction.customId = "app:delete:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  harness.channel.delete = async () => { throw new Error("Missing Permissions"); };

  await assert.rejects(runButton(harness), /Missing Permissions/);

  assert.equal(harness.openApplication.channelStatus, "closed");
  assert.equal(harness.deletedBy, undefined);
  assert.equal(harness.channelDeleted, false);
});

test("a reviewer can close an accepted application after the applicant left Discord", async () => {
  const harness = createHarness(
    { status: "accepted", applicationControlMessageId: "accepted-message" },
    { actorId: "reviewer", reviewer: true }
  );
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("accepted-message", "Application Accepted");
  harness.interaction.guild.members.fetch = async () => Promise.reject({ code: 10_007 });

  await runButton(harness);

  assert.equal(harness.closedBy, "reviewer");
  assert.deepEqual(harness.permissionValues, [false]);
  assert.equal(embedTitle(harness.followUps[0]), "Application Closed");
});

for (const status of ["accepted", "rejected", "withdrawn"] as const) {
  test(`${status} close/reopen cycles move Close and guidance to the newest reopened message`, async () => {
    const harness = createHarness(
      { status, applicationControlMessageId: "accepted-message" },
      { followUpMessageIds: ["closed-message-0", "reopened-message-0", "closed-message-1", "reopened-message-1"] }
    );
    const original = harness.storedMessages.get("accepted-message")!;
    const outcome = buildApplicationControlReplacementEmbed(harness.application, harness.openApplication);
    outcome.setDescription("Original outcome and registration feedback.");
    Object.assign(original, { embeds: [], components: JSON.parse(JSON.stringify(buildApplicationV2Card(outcome, applicationOpenComponents(status, "1")))).components });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const previous = harness.storedMessages.get(harness.openApplication.applicationControlMessageId!)!;
      harness.interaction.customId = "app:close:1";
      harness.interaction.message = previous;
      await runButton(harness);
      assert.deepEqual(payloadLabels(previous), []);
      assert.equal(messageText(previous).includes(`*${OUTCOME_CLOSE_FOOTER}*`), false);

      const closed = harness.storedMessages.get(`closed-message-${cycle}`)!;
      harness.interaction.customId = "app:reopen:1";
      harness.interaction.message = closed;
      await runButton(harness);

      assert.equal(harness.openApplication.applicationControlMessageId, `reopened-message-${cycle}`);
      assert.deepEqual(payloadLabels(harness.followUps.at(-1)), ["Close"]);
      assert.equal(embedFooter(harness.followUps.at(-1)), `*${OUTCOME_CLOSE_FOOTER}*`);
      assert.deepEqual(payloadLabels(previous), []);
      assert.deepEqual(payloadLabels(closed), []);
      assert.equal(messageText(closed).includes(`*${CLOSED_CHANNEL_FOOTER}*`), false);
      assert.equal(harness.openApplication.status, status);
    }

    assert.equal(messageText(original).includes("Original outcome and registration feedback."), true);
    assert.deepEqual(harness.permissionValues, [false, false, true, true, false, false, true, true]);
    assert.equal(harness.sentMessages.length, 0);
    assert.deepEqual(harness.followUps.map(embedTitle), ["Application Closed", "Application Reopened", "Application Closed", "Application Reopened"]);
  });

  test(`${status} command reopening stores the new lifecycle card and retires old guidance`, async () => {
    const harness = createHarness({ status, applicationControlMessageId: "accepted-message", closedControlMessageId: "closed-message" });
    const closed = createStoredMessage("closed-message", "Application Closed", harness.messageEdits, harness.messagePayloads);
    harness.storedMessages.set(closed.id, closed);
    const presentation = createApplicationCommandLifecyclePresentation(harness.channel as never, harness.repository as never);
    await presentation.renderOpen(harness.application, harness.openApplication, "1", "Reopened by <@applicant>.");
    assert.equal(harness.storedApplicationControlMessageId, "replacement-message");
    assert.equal(embedTitle(harness.sentMessages[0]), "Application Reopened");
    assert.equal(embedFooter(harness.sentMessages[0]), `*${OUTCOME_CLOSE_FOOTER}*`);
    assert.deepEqual(payloadLabels(harness.sentMessages[0]), ["Close"]);
    assert.deepEqual(harness.messageEdits["accepted-message"], [[]]);
    assert.deepEqual(harness.messageEdits["closed-message"], [[]]);
    assert.deepEqual((harness.sentMessages[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], repliedUser: false });
  });
}

test("withdrawal before selection followed by close and reopen leaves Close on Application Reopened", async () => {
  const { harness } = createInitialPromptHarness("withdraw", {}, { followUpMessageIds: ["withdrawn-message", "closed-message", "reopened-message"] });
  await runButton(harness);
  assert.equal(harness.storedMessages.has("initial-message"), false);
  const withdrawn = harness.storedMessages.get("withdrawn-message")!;
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = withdrawn;
  await runButton(harness);
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = harness.storedMessages.get("closed-message")!;
  await runButton(harness);
  assert.equal(harness.openApplication.status, "withdrawn");
  assert.equal(harness.openApplication.channelStatus, "open");
  assert.equal(harness.openApplication.applicationControlMessageId, "reopened-message");
  assert.equal(harness.sentMessages.length, 0);
  assert.deepEqual(payloadLabels(withdrawn), []);
  assert.equal(messageText(withdrawn).includes(`*${OUTCOME_CLOSE_FOOTER}*`), false);
  assert.equal(messageText(withdrawn).includes("<@applicant> withdrew this application."), true);
  assert.deepEqual(payloadLabels(harness.followUps[2]), ["Close"]);
  assert.equal(embedFooter(harness.followUps[2]), `*${OUTCOME_CLOSE_FOOTER}*`);
});

test("a failed reopen publication keeps the old controls and can be repaired", async () => {
  const harness = createHarness({ status: "withdrawn", channelStatus: "closed", applicationControlMessageId: "accepted-message", closedControlMessageId: "closed-message" });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  const send = harness.interaction.followUp;
  harness.interaction.followUp = async () => { throw new Error("Send failed"); };
  await assert.rejects(runButton(harness), /Send failed/);
  assert.equal(harness.openApplication.applicationControlMessageId, "accepted-message");
  assert.equal(harness.openApplication.closedControlMessageId, "closed-message");
  assert.equal(harness.messageEdits["accepted-message"], undefined);
  harness.interaction.followUp = send;
  await runButton(harness);
  assert.equal(harness.openApplication.applicationControlMessageId, "response-message");
  assert.equal(harness.openApplication.closedControlMessageId, undefined);
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Close"]);
});

test("failure to persist the reopened control retires the unclaimed candidate", async () => {
  const harness = createHarness({ status: "withdrawn", channelStatus: "closed", applicationControlMessageId: "accepted-message", closedControlMessageId: "closed-message" });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  harness.repository.setApplicationControlMessageId = async () => { throw new Error("Persistence failed"); };
  await assert.rejects(runButton(harness), /Persistence failed/);
  assert.equal(harness.openApplication.applicationControlMessageId, "accepted-message");
  assert.equal(harness.openApplication.closedControlMessageId, "closed-message");
  assert.deepEqual(harness.messageEdits["response-message"], [[]]);
  assert.equal(messageText(harness.messagePayloads["response-message"][0]).includes(`*${OUTCOME_CLOSE_FOOTER}*`), false);
  assert.equal(harness.messageEdits["accepted-message"], undefined);
});

test("Cancel is reviewer-only and closes while retaining the waiting decision", async () => {
  const applicantHarness = createHarness({
    status: "awaiting_ingame_membership",
    applicationControlMessageId: "waiting-message"
  });
  applicantHarness.interaction.customId = "app:cancel:1";
  applicantHarness.interaction.message = createSourceMessage("waiting-message", "Waiting For In-Game Membership");
  await runButton(applicantHarness);
  assert.equal(applicantHarness.closedBy, undefined);
  assert.equal(embedTitle(applicantHarness.followUps[0]), "Reviewer Role Required: Only members with <@&reviewer-role> can use this control.");

  const reviewerHarness = createHarness({
    status: "awaiting_ingame_membership",
    applicationControlMessageId: "waiting-message"
  }, { actorId: "reviewer", reviewer: true });
  reviewerHarness.interaction.customId = "app:cancel:1";
  reviewerHarness.interaction.message = createSourceMessage("waiting-message", "Waiting For In-Game Membership");
  await runButton(reviewerHarness);
  assert.equal(reviewerHarness.closedBy, "reviewer");
  assert.equal(reviewerHarness.openApplication.status, "awaiting_ingame_membership");
  assert.deepEqual(reviewerHarness.permissionValues, [false, false]);
  assert.equal(embedFooter(reviewerHarness.followUps[0]), `*${CLOSED_CHANNEL_FOOTER}*`);
  assert.deepEqual(payloadLabels(reviewerHarness.followUps[0]), ["Reopen", "Delete"]);
});

test("an applicant can reopen a cancelled waiting application and restore only Verify Membership and Cancel", async () => {
  const harness = createHarness({
    status: "awaiting_ingame_membership",
    channelStatus: "closed",
    applicationControlMessageId: "waiting-message"
  });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");

  await runButton(harness);

  assert.equal(harness.reopenedBy, "applicant");
  assert.deepEqual(harness.permissionValues, [true, true]);
  assert.deepEqual(harness.messageEdits["waiting-message"], [["Verify Membership", "Cancel"]]);
  assert.deepEqual(harness.editedReplies, []);
  assert.equal(embedTitle(harness.followUps[0]), "Application Reopened");
  assert.deepEqual(payloadLabels(harness.followUps[0]), []);
});

test("unsuccessful verification keeps one canonical waiting control row and adds no controls to its response", async () => {
  const harness = createHarness({
    status: "awaiting_ingame_membership",
    applicationControlMessageId: "waiting-message",
    selectedAlbionCharacterId: "character-1"
  }, { actorId: "reviewer", reviewer: true });
  harness.application.memberGroupId = "group-1";
  const canonicalEdits: unknown[] = [];
  harness.interaction.customId = "app:verify:1";
  harness.interaction.message = {
    ...createSourceMessage("waiting-message", "Waiting For In-Game Membership"),
    edit: async (payload: unknown) => { canonicalEdits.push(payload); }
  };

  await handleApplicationButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
    {
      listMemberGroups: async () => [{
        memberGroupId: "group-1",
        groupType: "guild",
        groupName: "Guild One",
        albionServer: "europe"
      }],
      getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined,
      getConfiguredAlbionGuild: async () => ({
        memberGroupId: "group-1",
        groupName: "Guild One",
        albionGuildId: "required-guild",
        albionGuildName: "Guild One",
        albionServer: "europe"
      })
    } as unknown as Parameters<typeof handleApplicationButton>[2],
    {
      getPlayer: async () => ({
        id: "character-1",
        name: "Applicant Character",
        guildId: "different-guild"
      }),
      searchCharacters: async () => ({ players: [{ id: "character-1", name: "Applicant Character", guildId: "different-guild" }], guilds: [] }),
      getGuildMembers: async () => []
    } as unknown as Parameters<typeof handleApplicationButton>[3]
  );

  assert.deepEqual(payloadLabels(canonicalEdits[0]), ["Verify Membership", "Cancel"]);
  assert.equal(embedFooter(canonicalEdits[0]), `*${WAITING_MEMBERSHIP_FOOTER}*`);
  assert.equal(messageText(harness.followUps[0]).includes(`*${WAITING_MEMBERSHIP_FOOTER}*`), false);
  assert.deepEqual(payloadLabels(harness.followUps[0]), []);
  assert.equal(harness.membershipFailure, "Character is not in the configured guild.");
  assert.equal(harness.storedApplicationControlMessageId, undefined);
});

test("first acceptance mismatch retires undecided controls and makes the waiting message canonical", async () => {
  const harness = createHarness({
    status: "open",
    applicationControlMessageId: "review-message",
    characterResolutionMessageId: "character-message",
    selectedAlbionCharacterId: "character-1"
  }, { actorId: "reviewer", reviewer: true });
  harness.application.memberGroupId = "group-1";
  const reviewEdits: unknown[] = [];
  harness.interaction.customId = "app:accept:1";
  harness.interaction.message = {
    ...createSourceMessage("review-message", "Guild Application"),
    edit: async (payload: unknown) => { reviewEdits.push(payload); }
  };

  await handleApplicationButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
    {
      listMemberGroups: async () => [{
        memberGroupId: "group-1",
        groupType: "guild",
        groupName: "Guild One",
        albionServer: "europe"
      }],
      getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined,
      getConfiguredAlbionGuild: async () => ({
        memberGroupId: "group-1",
        groupName: "Guild One",
        albionGuildId: "required-guild",
        albionGuildName: "Guild One",
        albionServer: "europe"
      })
    } as unknown as Parameters<typeof handleApplicationButton>[2],
    {
      getPlayer: async () => ({
        id: "character-1",
        name: "Applicant Character",
        guildId: "different-guild"
      }),
      searchCharacters: async () => ({ players: [{ id: "character-1", name: "Applicant Character", guildId: "different-guild" }], guilds: [] }),
      getGuildMembers: async () => []
    } as unknown as Parameters<typeof handleApplicationButton>[3]
  );

  assert.deepEqual(payloadLabels(reviewEdits[0]), []);
  assert.deepEqual(harness.messageEdits["character-message"], [[]]);
  assert.equal(embedTitle(harness.followUps[0]), "Waiting For In-Game Membership");
  assert.equal(embedFooter(harness.followUps[0]), `*${WAITING_MEMBERSHIP_FOOTER}*`);
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Verify Membership", "Cancel"]);
  assert.equal(harness.storedApplicationControlMessageId, "response-message");
});

test("reopen restores missing outcome history and stores the reopened card as canonical", async () => {
  const harness = createHarness({
    status: "rejected",
    channelStatus: "closed",
    applicationControlMessageId: "deleted-outcome-message",
    reviewerDiscordUserId: "reviewer"
  }, { missingMessageIds: ["deleted-outcome-message"] });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");

  await runButton(harness);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(embedTitle(harness.sentMessages[0]), "Application Rejected");
  assert.equal(embedDescription(harness.sentMessages[0]), "Application rejected by <@reviewer>.");
  assert.equal(messageText(harness.sentMessages[0]).includes(`*${OUTCOME_CLOSE_FOOTER}*`), false);
  assert.deepEqual(payloadLabels(harness.sentMessages[0]), []);
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Close"]);
  assert.equal(harness.storedApplicationControlMessageId, "response-message");
});

test("a replacement accepted outcome preserves reviewer attribution and configured copy", async () => {
  for (const scenario of [
    { acceptanceMessage: undefined, expectedDescription: "Application accepted by <@reviewer>." },
    { acceptanceMessage: "Welcome aboard.", expectedDescription: "Application accepted by <@reviewer>.\n\nWelcome aboard." }
  ]) {
    const harness = createHarness({
      status: "accepted",
      channelStatus: "closed",
      applicationControlMessageId: "deleted-outcome-message",
      reviewerDiscordUserId: "reviewer"
    }, { missingMessageIds: ["deleted-outcome-message"] });
    harness.application.acceptanceMessage = scenario.acceptanceMessage;
    harness.interaction.customId = "app:reopen:1";
    harness.interaction.message = createSourceMessage("closed-message", "Application Closed");

    await runButton(harness);

    assert.equal(embedTitle(harness.sentMessages[0]), "Application Accepted");
    assert.equal(embedDescription(harness.sentMessages[0]), scenario.expectedDescription);
    assert.equal(messageText(harness.sentMessages[0]).includes(`*${OUTCOME_CLOSE_FOOTER}*`), false);
    assert.deepEqual(payloadLabels(harness.sentMessages[0]), []);
  }
});

test("a replacement outcome reports unavailable reviewer information for a historical record", async () => {
  const harness = createHarness({
    status: "accepted",
    channelStatus: "closed",
    applicationControlMessageId: "deleted-outcome-message",
    reviewerDiscordUserId: undefined
  }, { missingMessageIds: ["deleted-outcome-message"] });
  harness.interaction.customId = "app:reopen:1";
  harness.interaction.message = createSourceMessage("closed-message", "Application Closed");

  await runButton(harness);

  assert.equal(
    embedDescription(harness.sentMessages[0]),
    "Reviewer information is unavailable for this retained application."
  );
});

test("a legacy outcome control with a mismatched title cannot become canonical", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: undefined });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("legacy-message", "Application Rejected");

  await runButton(harness);

  assert.equal(harness.closedBy, undefined);
  assert.equal(harness.storedApplicationControlMessageId, undefined);
  assert.equal(embedTitle(harness.followUps[0]), "Stale Application Control");
});

test("a legacy bot-authored outcome with the matching retained decision can become canonical", async () => {
  const harness = createHarness({ status: "accepted", applicationControlMessageId: undefined });
  harness.interaction.customId = "app:close:1";
  harness.interaction.message = createSourceMessage("legacy-accepted-message", "Application Accepted");

  await runButton(harness);

  assert.equal(harness.storedApplicationControlMessageId, "legacy-accepted-message");
  assert.equal(harness.closedBy, "applicant");
  assert.deepEqual(payloadLabels(harness.followUps[0]), ["Reopen", "Delete"]);
});

test("Delete remains reviewer-only and closed-only, then deletes immediately", async () => {
  const applicantHarness = createHarness({ status: "accepted", channelStatus: "closed" });
  applicantHarness.interaction.customId = "app:delete:1";
  applicantHarness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  await runButton(applicantHarness);
  assert.equal(embedTitle(applicantHarness.followUps[0]), "Reviewer Role Required: Only members with <@&reviewer-role> can use this control.");

  const openHarness = createHarness(
    { status: "accepted", channelStatus: "open" },
    { actorId: "reviewer", reviewer: true }
  );
  openHarness.interaction.customId = "app:delete:1";
  openHarness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  await runButton(openHarness);
  assert.equal(embedTitle(openHarness.followUps[0]), "Close Channel First: This application channel must be closed before it can be deleted.");

  const reviewerHarness = createHarness(
    { status: "accepted", channelStatus: "closed" },
    { actorId: "reviewer", reviewer: true }
  );
  reviewerHarness.interaction.customId = "app:delete:1";
  reviewerHarness.interaction.message = createSourceMessage("closed-message", "Application Closed");
  await runButton(reviewerHarness);
  assert.equal(reviewerHarness.deletedBy, "reviewer");
  assert.equal(reviewerHarness.channelDeleted, true);
});

test("an archived application remains reviewer-deletable only from its target-removed control", async () => {
  const harness = createHarness(
    { status: "accepted", channelStatus: "closed", closedControlMessageId: "archived-message" },
    { actorId: "reviewer", reviewer: true, archived: true }
  );
  harness.interaction.customId = "app:delete:1";
  harness.interaction.message = createSourceMessage("archived-message", "Application Target Removed");

  await runButton(harness);

  assert.equal(harness.deletedBy, "reviewer");
  assert.equal(harness.channelDeleted, true);
  assert.equal(harness.reopenedBy, undefined);
});

type HarnessOptions = {
  actorId?: string;
  reviewer?: boolean;
  roleIds?: readonly string[];
  missingMessageIds?: string[];
  archived?: boolean;
  followUpMessageIds?: string[];
};

function createHarness(
  applicationOverrides: Partial<OpenApplication>,
  options: HarnessOptions = {}
) {
  const application: ApplicationClass = {
    applicationClassId: "class-1",
    discordGuildId: "guild-1",
    name: "Guild Application",
    outcomeType: "member_group",
    albionServer: "europe",
    ticketCategoryId: "category",
    reviewerRoleId: "reviewer-role",
    questions: [],
    enabled: true,
    createdByDiscordUserId: "creator",
    archivedAt: options.archived ? new Date("2026-08-20T05:00:00.000Z") : undefined
  };
  const openApplication: OpenApplication = {
    applicationId: "1",
    applicationClassId: application.applicationClassId,
    discordGuildId: application.discordGuildId,
    applicantDiscordUserId: "applicant",
    ticketChannelId: "channel-1",
    submittedCharacterName: "Applicant Character",
    modalAnswers: [],
    albionServer: "europe",
    characterResolutionState: "selected",
    characterSearchAttemptCount: 1,
    selectedAlbionCharacterId: "character-1",
    selectedCharacterName: "Applicant Character",
    applicationControlMessageId: applicationOverrides.characterResolutionMessageId,
    status: "accepted",
    channelStatus: "open",
    ...applicationOverrides
  };
  const replies: unknown[] = [];
  const updates: unknown[] = [];
  const followUps: unknown[] = [];
  const editedReplies: unknown[] = [];
  const sentMessages: unknown[] = [];
  const permissionValues: boolean[] = [];
  const lifecycleEvents: string[] = [];
  const messageEdits: Record<string, Array<Array<string | undefined>>> = {};
  const messagePayloads: Record<string, unknown[]> = {};
  const storedMessages = new Map<string, ReturnType<typeof createStoredMessage>>();
  const deletedMessages: string[] = [];
  let followUpMessageIndex = 0;
  for (const [id, title] of [
    ["initial-message", "Application"],
    ["accepted-message", "Application Accepted"],
    ["waiting-message", "Waiting For In-Game Membership"],
    ["character-message", "Character Selected"]
  ] as const) {
    const message = createStoredMessage(id, title, messageEdits, messagePayloads);
    message.delete = async () => { deletedMessages.push(id); storedMessages.delete(id); };
    storedMessages.set(id, message);
  }
  for (const id of options.missingMessageIds ?? []) storedMessages.delete(id);

  const guild = {
    channels: {
      cache: { get: () => channel },
      fetch: async (): Promise<unknown> => undefined
    },
    members: {
      fetch: async (memberOptions: { user?: string } = {}): Promise<unknown> => ({
        id: memberOptions.user ?? "applicant",
        roles: {
          cache: { has: () => false },
          add: async () => undefined,
          remove: async () => undefined
        },
        setNickname: async () => undefined
      })
    }
  };
  const channel = {
    id: "channel-1",
    type: ChannelType.GuildText,
    guild,
    client: { user: { id: "bot" } },
    permissionOverwrites: {
      edit: async (_id: string, permissions: { SendMessages: boolean }) => {
        permissionValues.push(permissions.SendMessages);
      }
    },
    messages: {
      fetch: async (id: string | { limit: number }) => {
        if (typeof id !== "string") return storedMessages;
        const message = storedMessages.get(id);
        if (!message) throw { code: 10008 };
        return message;
      }
    },
    send: async (payload: unknown) => {
      sentMessages.push(payload);
      const id = sentMessages.length === 1 ? "replacement-message" : `replacement-message-${sentMessages.length}`;
      const message = createStoredMessage(id, "", messageEdits, messagePayloads);
      message.components = ((payload as { components?: unknown[] }).components ?? []) as typeof message.components;
      message.embeds = [];
      message.delete = async () => { deletedMessages.push(id); storedMessages.delete(id); };
      storedMessages.set(id, message);
      return message;
    },
    delete: async () => {
      harness.channelDeleted = true;
    }
  };
  const interaction = {
    customId: "",
    guildId: "guild-1",
    channelId: "channel-1",
    channel,
    client: { user: { id: "bot" } },
    user: {
      id: options.actorId ?? "applicant",
      toString: () => `<@${options.actorId ?? "applicant"}>`
    },
    member: {
      roles: { cache: { has: (roleId: string) => (options.roleIds ?? (options.reviewer ? ["reviewer-role"] : [])).includes(roleId), keys: () => options.roleIds ?? (options.reviewer ? ["reviewer-role"] : []) } }
    },
    guild,
    message: createSourceMessage("source-message", "Application Accepted"),
    values: [] as string[],
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    reply: async (payload: unknown) => { interaction.replied = true; replies.push(payload); },
    deferUpdate: async () => { interaction.deferred = true; harness.deferredUpdates += 1; lifecycleEvents.push("deferUpdate"); },
    update: async (payload: unknown) => { updates.push(payload); },
    showModal: async (_modal: unknown) => undefined,
    followUp: async (payload: unknown) => {
      followUps.push(payload);
      const id = options.followUpMessageIds?.[followUpMessageIndex++] ?? "response-message";
      const message = createStoredMessage(id, "", messageEdits, messagePayloads);
      Object.assign(message, { embeds: [], components: JSON.parse(JSON.stringify(payload)).components ?? [] });
      storedMessages.set(id, message);
      return message;
    },
    deferReply: async () => {
      interaction.deferred = true;
      harness.deferredReplies += 1;
      lifecycleEvents.push("deferReply");
    },
    editReply: async (payload: unknown) => {
      lifecycleEvents.push("editReply");
      editedReplies.push(payload);
      return { id: "response-message" };
    }
  };

  const harness = {
    application,
    openApplication,
    channel,
    interaction,
    replies,
    updates,
    followUps,
    editedReplies,
    sentMessages,
    permissionValues,
    lifecycleEvents,
    deferredUpdates: 0,
    deferredReplies: 0,
    messageEdits,
    messagePayloads,
    closedBy: undefined as string | undefined,
    reopenedBy: undefined as string | undefined,
    membershipFailure: undefined as string | undefined,
    rejectedBy: undefined as string | undefined,
    withdrawn: false,
    acceptedBy: undefined as string | undefined,
    deletedBy: undefined as string | undefined,
    channelDeleted: false,
    storedApplicationControlMessageId: undefined as string | undefined,
    closedControlMessageIdUpdates: [] as Array<string | undefined>,
    storedMessages,
    deletedMessages,
    selectedCharacterId: undefined as string | undefined,
    selectedCharacterState: undefined as string | undefined,
    markedNotListed: false,
    membershipRegisteredCharacter: undefined as { discordUserId: string } | undefined,
    configuredAlliance: undefined as {
      memberGroupId: string;
      groupType: "alliance";
      groupName: string;
      albionServer: "europe";
      albionAllianceId: string;
      albionAllianceName: string;
      albionAllianceTag?: string;
    } | undefined,
    configuredAllianceLookups: 0,
    guildLookups: 0,
    guildAllianceId: undefined as string | undefined,
    guildLookupError: undefined as Error | undefined,
    player: { id: "replacement-character", name: "Replacement Character" } as {
      id: string;
      name: string;
      guildId?: string;
      guildName?: string;
      allianceId?: string;
      allianceName?: string;
    },
    repository: {
      getOpenApplication: async () => { lifecycleEvents.push("getOpenApplication"); return { ...openApplication }; },
      getApplicationClass: async () => application,
      setApplicationControlMessageId: async (_guildId: string, _applicationId: string, messageId: string) => {
        harness.storedApplicationControlMessageId = messageId;
        openApplication.applicationControlMessageId = messageId;
        return openApplication;
      },
      ensureApplicationReviewPublication: async () => {
        if (!openApplication.legacyReviewPublication && openApplication.characterResolutionState === "selected") openApplication.reviewPublication ??= { reviewerRoleId: application.reviewerRoleId, answerMessageIds: [], notificationClaimed: false };
        return { ...openApplication };
      },
      updateApplicationReviewPublication: async (_guild: string, _id: string, expected: unknown, next: OpenApplication["reviewPublication"]) => {
        assert.deepEqual(openApplication.reviewPublication, expected); openApplication.reviewPublication = next; return true;
      },
      claimApplicationFirstMessageId: async (_guildId: string, _id: string, expected: string | undefined, candidate: string) => {
        if (openApplication.applicationControlMessageId !== expected) return false;
        openApplication.applicationControlMessageId = candidate;
        openApplication.characterResolutionMessageId = candidate;
        return true;
      },
      setClosedControlMessageId: async (_guildId: string, _applicationId: string, messageId: string | undefined) => {
        harness.closedControlMessageIdUpdates.push(messageId);
        openApplication.closedControlMessageId = messageId;
        return openApplication;
      },
      claimClosedControlMessageId: async (_guildId: string, _applicationId: string, expectedMessageId: string | undefined, candidateMessageId: string) => {
        if (openApplication.closedControlMessageId !== expectedMessageId) return false;
        harness.closedControlMessageIdUpdates.push(candidateMessageId);
        openApplication.closedControlMessageId = candidateMessageId;
        return true;
      },
      markApplicationClosed: async (_guildId: string, _applicationId: string, actorId: string) => {
        harness.closedBy = actorId;
        openApplication.channelStatus = "closed";
        return openApplication;
      },
      markApplicationReopened: async (_guildId: string, _applicationId: string, actorId: string) => {
        harness.reopenedBy = actorId;
        openApplication.channelStatus = "open";
        return openApplication;
      },
      markApplicationAwaitingMembership: async (
        _guildId: string,
        _applicationId: string,
        _actorId: string,
        failure: string
      ) => {
        harness.membershipFailure = failure;
        return openApplication;
      },
      markApplicationRejected: async (_guildId: string, _applicationId: string, actorId: string) => {
        harness.rejectedBy = actorId;
        openApplication.status = "rejected";
        return openApplication;
      },
      markApplicationWithdrawn: async () => {
        harness.withdrawn = true;
        openApplication.status = "withdrawn";
        return openApplication;
      },
      markApplicationAccepted: async (_guildId: string, _applicationId: string, actorId: string) => {
        harness.acceptedBy = actorId;
        openApplication.status = "accepted";
        return openApplication;
      },
      selectApplicationCharacter: async (_guildId: string, _applicationId: string, characterId: string, state?: string) => {
        harness.selectedCharacterId = characterId;
        harness.selectedCharacterState = state ?? "selected";
        openApplication.selectedAlbionCharacterId = characterId;
        openApplication.selectedCharacterName = harness.player.name;
        openApplication.characterResolutionState = (state ?? "selected") as OpenApplication["characterResolutionState"];
        return openApplication;
      },
      markApplicationCharacterNotListed: async (_guildId: string, _applicationId: string) => {
        harness.markedNotListed = true;
        openApplication.selectedAlbionCharacterId = undefined;
        openApplication.characterResolutionState = "not_listed";
        return openApplication;
      },
      markApplicationDeleted: async (_guildId: string, _applicationId: string, actorId: string) => {
        harness.deletedBy = actorId;
        openApplication.channelStatus = "deleted";
        return openApplication;
      }
    }
  };
  return harness;
}

function createInitialPromptHarness(action: "close" | "withdraw", overrides: Partial<OpenApplication> = {}, options: { followUpMessageIds?: string[] } = {}) {
  const harness = createHarness({
    status: "open", characterResolutionState: "unresolved",
    selectedAlbionCharacterId: undefined, selectedCharacterName: undefined,
    applicationControlMessageId: "initial-message", characterResolutionMessageId: "initial-message",
    modalAnswers: [{ question: "Why?", answer: "To join." }],
    ...overrides,
  }, { actorId: action === "close" ? "reviewer" : "applicant", reviewer: action === "close", ...options });
  const prompt = harness.storedMessages.get("initial-message")!;
  Object.assign(prompt, { embeds: [], components: JSON.parse(JSON.stringify(buildApplicationIntakeCard(harness.application, harness.openApplication))).components });
  harness.interaction.customId = `app:${action}:1`;
  harness.interaction.message = prompt;
  return { harness, prompt };
}

function createSourceMessage(id: string, title: string) {
  return {
    id,
    author: { id: "bot" },
    embeds: [{ title, toJSON: () => ({ title }) }],
    edit: async (_payload: unknown): Promise<void> => undefined
  };
}

function createStoredMessage(
  id: string,
  title: string,
  edits: Record<string, Array<Array<string | undefined>>>,
  payloads: Record<string, unknown[]>
) {
  const message = {
    id,
    author: { id: "bot" },
    embeds: [{ title, toJSON: () => ({ title }) }],
    components: id === "character-message"
      ? [{ components: [{ customId: "app:character:1:1", options: [{ value: "replacement-character" }, { value: "__not_listed" }] }] }]
      : [],
    delete: async (): Promise<void> => undefined,
    edit: async (payload: unknown): Promise<void> => {
      (edits[id] ??= []).push(payloadLabels(payload));
      (payloads[id] ??= []).push(payload);
      const json = JSON.parse(JSON.stringify(payload));
      if (json.components) message.components = json.components;
      if (json.embeds) message.embeds = json.embeds;
    }
  };
  return message;
}

async function runButton(harness: ReturnType<typeof createHarness>): Promise<void> {
  await handleApplicationButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationButton>[1],
    {} as Parameters<typeof handleApplicationButton>[2],
    {} as Parameters<typeof handleApplicationButton>[3]
  );
}

async function runCharacterSelect(harness: ReturnType<typeof createHarness>): Promise<void> {
  await handleApplicationCharacterSelect(
    harness.interaction as unknown as import("discord.js").StringSelectMenuInteraction,
    harness.repository as unknown as Parameters<typeof handleApplicationCharacterSelect>[1],
    {
      upsertVerifiedCharacter: async () => undefined,
      getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => harness.membershipRegisteredCharacter,
      listMemberGroups: async () => [],
      getConfiguredAlbionAlliance: async () => {
        harness.configuredAllianceLookups += 1;
        return harness.configuredAlliance;
      }
    } as unknown as Parameters<typeof handleApplicationCharacterSelect>[2],
    {
      getPlayer: async () => harness.player,
      getGuild: async () => {
        harness.guildLookups += 1;
        if (harness.guildLookupError) throw harness.guildLookupError;
        return {
          id: harness.player.guildId,
          name: "The Drop Bears",
          allianceId: harness.guildAllianceId
        };
      }
    } as unknown as Parameters<typeof handleApplicationCharacterSelect>[3]
  );
}

function remoteCharacterCustomId(applicationId: string, actorId: string, expiry: number, attempt: number): string {
  return `app:remote-character:${applicationId}:${actorId}:${expiry.toString(36)}:${attempt.toString(36)}`;
}

function embedTitle(payload: unknown): string | undefined {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  const embed = (payload as { embeds?: Array<{ toJSON?: () => { title?: string }; data?: { title?: string } }> }).embeds?.[0];
  const title = embed?.toJSON?.().title ?? embed?.data?.title;
  if (title) return title;
  const first = (payload as { components?: Array<{ toJSON?: () => { components?: Array<{ content?: string }> } }> }).components?.[0]?.toJSON?.().components?.[0]?.content;
  return first?.replace(/^# /, "");
}

function embedDescription(payload: unknown): string | undefined {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  const embed = (payload as { embeds?: Array<{ toJSON?: () => { description?: string }; data?: { description?: string } }> }).embeds?.[0];
  return embed?.toJSON?.().description ?? embed?.data?.description
    ?? messageText(payload).find((text, index) => index > 0 && !text.startsWith("**"));
}

function embedFooter(payload: unknown): string | undefined {
  const embed = (payload as { embeds?: Array<{ toJSON?: () => { footer?: { text?: string } }; data?: { footer?: { text?: string } } }> }).embeds?.[0];
  return embed?.toJSON?.().footer?.text ?? embed?.data?.footer?.text ?? messageText(payload).at(-1);
}

function embedField(payload: unknown, name: string): string | undefined {
  const embed = (payload as { embeds?: Array<{ toJSON?: () => { fields?: Array<{ name: string; value: string }> }; data?: { fields?: Array<{ name: string; value: string }> } }> }).embeds?.[0];
  return (embed?.toJSON?.().fields ?? embed?.data?.fields)?.find((field) => field.name === name)?.value
    ?? messageText(payload).find((text) => text.startsWith(`**${name}**\n`))?.slice(name.length + 5);
}

function messageText(payload: unknown): string[] {
  if (typeof (payload as { content?: unknown })?.content === "string") return [(payload as { content: string }).content];
  const components = JSON.parse(JSON.stringify((payload as { components?: unknown[] }).components ?? [])) as Array<{ components?: Array<{ content?: string }> }>;
  return components[0]?.components?.flatMap((component) => component.content ? [component.content] : []) ?? [];
}

function payloadLabels(payload: unknown): Array<string | undefined> {
  const components = JSON.parse(JSON.stringify((payload as { components?: unknown[] }).components ?? [])) as Array<{ components?: Array<{ label?: string; components?: Array<{ label?: string }> }> }>;
  return components.flatMap((component) => (component.components ?? []).flatMap((child) => child.components?.map((item) => item.label) ?? (child.label ? [child.label] : [])));
}
