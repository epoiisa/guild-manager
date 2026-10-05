import { v2Text } from "../../testSupport/messageAssertions.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Collection, ComponentType, EmbedBuilder, type MessageCreateOptions, type TextChannel } from "discord.js";
import type { ApplicationClass, ApplicationReviewPublication, OpenApplication, createApplicationRepository } from "../../db/applicationRepository.js";
import { refreshApplicationIntakeCard, publicationNonce } from "./intakePresentation.js";
import { buildApplicationIntakeCard } from "./rendering.js";
import { INFO_COLOR } from "../../commands/configurationHelpers.js";
const json = (payload: unknown) => JSON.parse(JSON.stringify(payload));

function fixture(options: { legacy?: boolean; unresolved?: boolean } = {}) {
  const application = { applicationClassId: "class", discordGuildId: "guild", name: "Class", initialMessage: "Exact **instructions** <@&else>", reviewerRoleId: "reviewer", albionServer: "europe" } as ApplicationClass;
  let current = { applicationId: "app", applicationClassId: "class", discordGuildId: "guild", applicantDiscordUserId: "applicant", targetMemberGroupName: "Target", targetMemberGroupType: "guild", submittedCharacterName: "Query", selectedCharacterName: "Resolved", selectedAlbionCharacterId: "identity", characterResolutionState: "selected", characterSearchAttemptCount: 1, status: "open", channelStatus: "open", albionServer: "europe", modalAnswers: [{ question: "One", answer: "first" }, { question: "Two", answer: "x".repeat(4000) }], legacyReviewPublication: !!options.legacy } as OpenApplication;
  if (options.unresolved) Object.assign(current, { selectedCharacterName: undefined, selectedAlbionCharacterId: undefined, characterResolutionState: "unresolved" });
  else if (!options.legacy) current.reviewPublication = { initialMessage: application.initialMessage, reviewerRoleId: application.reviewerRoleId, answerMessageIds: [], notificationClaimed: false };
  const messages = new Collection<string, any>();
  const sent: any[] = [];
  const events: string[] = [];
  let failSave = false;
  let failClaim = false;
  let failSend = false;
  let failDelete = false;
  let sequence = 0;
  const make = (payload: any) => {
    const message: any = { id: String(++sequence), author: { id: "bot" }, ...json(payload), content: payload.content ?? "", embeds: payload.embeds ?? [], components: json(payload.components ?? []) };
    message.edit = async (update: any) => { events.push(`edit:${message.id}`); Object.assign(message, json(update)); return message; };
    message.delete = async () => {
      if (failDelete) { failDelete = false; throw new Error("Delete unavailable"); }
      events.push(`delete:${message.id}`); messages.delete(message.id); return message;
    };
    messages.set(message.id, message); return message;
  };
  const source = make(buildApplicationIntakeCard(application, { ...current, selectedAlbionCharacterId: undefined, selectedCharacterName: undefined, characterResolutionState: "unresolved" }));
  current.applicationControlMessageId = source.id; current.characterResolutionMessageId = source.id;
  const channel = { guild: { id: "guild" }, client: { user: { id: "bot" } }, messages: { fetch: async (input: any) => {
    if (typeof input !== "string") return new Collection([...messages].reverse());
    const found = messages.get(input);
    if (!found) throw Object.assign(new Error("Missing"), { code: 10008 });
    return found;
  } }, send: async (payload: MessageCreateOptions) => {
    if (failSend) { failSend = false; throw new Error("Send failed"); }
    sent.push(payload); const message = make(payload); events.push(`send:${message.id}`); return message;
  } } as unknown as TextChannel;
  const repository = {
    getOpenApplication: async () => structuredClone(current),
    claimApplicationFirstMessageId: async (_guild: string, _id: string, expected: string | undefined, id: string) => {
      if (failClaim) { failClaim = false; return false; }
      if (current.applicationControlMessageId !== expected) return false;
      current.applicationControlMessageId = id; current.characterResolutionMessageId = id; return true;
    },
    ensureApplicationReviewPublication: async () => {
      current.reviewPublication ??= { initialMessage: options.legacy ? undefined : application.initialMessage, reviewerRoleId: application.reviewerRoleId, notificationClaimed: !!options.legacy, answerMessageIds: [] };
      return structuredClone(current);
    },
    updateApplicationReviewPublication: async (_guild: string, _id: string, expected: ApplicationReviewPublication, next: ApplicationReviewPublication) => {
      if (failSave && next.reviewCardMessageId) { failSave = false; throw new Error("Database unavailable"); }
      assert.deepEqual(current.reviewPublication, expected);
      current.reviewPublication = structuredClone(next); return true;
    },
  } as unknown as ReturnType<typeof createApplicationRepository>;
  const refresh = (cardOptions = {}) => refreshApplicationIntakeCard(channel, repository, application, current, undefined, cardOptions);
  return { application, channel, repository, messages, sent, events, make, source, refresh, get current() { return current; }, setCurrent: (next: Partial<OpenApplication>) => { current = { ...current, ...next }; }, failNextSave: () => { failSave = true; }, failNextSend: () => { failSend = true; }, failNextClaim: () => { failClaim = true; }, failNextDelete: () => { failDelete = true; } };
}

function assertInstructions(payload: any, text: string) {
  assert.deepEqual(json(payload).components, [{ type: ComponentType.Container, accent_color: INFO_COLOR, components: [{ type: ComponentType.TextDisplay, content: text }] }]);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
}

test("first review sends a fresh summary notifying applicant/reviewer, deletes selection, then instructions and complete ordered answers", async () => {
  const f = fixture(); await f.refresh();
  assert.equal(f.sent.length, 4);
  assert.equal(json(f.sent[0]).components[0].components[0].content, "# Target Application");
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false, users: ["applicant"], roles: ["reviewer"] });
  assert.notEqual(f.current.applicationControlMessageId, f.source.id);
  assert.equal(f.current.applicationControlMessageId, f.current.reviewPublication!.reviewCardMessageId);
  assert.equal(f.current.characterResolutionMessageId, f.current.applicationControlMessageId);
  assert.equal(f.messages.has(f.source.id), false);
  assert.deepEqual(f.events.slice(0, 3), ["send:2", "delete:1", "send:3"]);
  assertInstructions(f.sent[1], "Exact **instructions** <@&else>");
  const answers = f.sent.slice(2).flatMap((payload) => json(payload).components[0].components.slice(1).map((c: any) => c.content)).join("");
  assert.equal(answers, "**One**\nfirst**Two**\n" + "x".repeat(4000));
  assert.equal(JSON.stringify(f.sent).includes("this application is ready for review"), false);
  assert.equal(f.current.reviewPublication!.notificationMessageId, undefined);
});

test("reselection, retry and reopen edit the new canonical card silently without duplicates", async () => {
  const f = fixture(); await f.refresh(); const canonical = f.current.applicationControlMessageId;
  f.setCurrent({ characterResolutionState: "unresolved", selectedAlbionCharacterId: undefined, selectedCharacterName: undefined, characterSearchAttemptCount: 2 });
  await f.refresh({ players: [{ id: "new", name: "New" }] });
  f.setCurrent({ characterResolutionState: "selected", selectedAlbionCharacterId: "new", selectedCharacterName: "New" });
  await f.refresh(); await f.refresh({ publishReview: false });
  assert.equal(f.sent.length, 4); assert.equal(f.current.applicationControlMessageId, canonical);
  assert.deepEqual(f.messages.get(canonical!).allowedMentions, { parse: [], repliedUser: false });
});

test("send failure retains original selection and retry finishes silently", async () => {
  const f = fixture(); f.failNextSend();
  await assert.rejects(f.refresh(), /Send failed/);
  assert.ok(f.messages.has(f.source.id)); assert.equal(f.current.applicationControlMessageId, f.source.id);
  assert.equal(f.current.reviewPublication!.notificationClaimed, true);
  assert.equal(f.current.reviewPublication!.reviewCardMessageId, undefined);
  await f.refresh({ publishReview: false });
  assert.equal(f.messages.has(f.source.id), false); assert.equal(f.sent.length, 4);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
});

test("lost database acknowledgement after summary send recovers it by history without duplicate ping", async () => {
  const f = fixture(); f.failNextSave();
  await assert.rejects(f.refresh(), /Database unavailable/);
  assert.equal(f.sent.length, 1); assert.ok(f.messages.has(f.source.id));
  await f.refresh(); assert.equal(f.sent.length, 4); assert.equal(f.messages.has(f.source.id), false);
});

test("lost canonical claim retires candidate controls and retry restores and claims the same summary", async () => {
  const f = fixture(); f.failNextClaim();
  await assert.rejects(f.refresh(), /could not become canonical/);
  const review = f.current.reviewPublication!.reviewCardMessageId!;
  assert.equal(f.current.applicationControlMessageId, f.source.id); assert.ok(f.messages.has(f.source.id));
  assert.equal(JSON.stringify(f.messages.get(review)).includes("The applicant can withdraw this application."), false);
  await f.refresh(); assert.equal(f.sent.length, 4); assert.equal(f.current.applicationControlMessageId, review);
  assert.deepEqual(json(f.messages.get(review)).components[0].components.at(-1).components.map((button: any) => button.label), ["Retry Character Search", "Withdraw", "Close", "Accept", "Reject"]);
  assert.ok(JSON.stringify(f.messages.get(review)).includes("The applicant can withdraw this application. Reviewers can close, accept, or reject it."));
});

test("failed deletion retires old selection controls and pending swap completes before instructions on retry", async () => {
  const f = fixture(); f.failNextDelete();
  await assert.rejects(f.refresh(), /Delete unavailable/);
  assert.equal(f.sent.length, 1); assert.ok(f.messages.has(f.source.id));
  assert.equal(json(f.source).components[0].components.some((c: any) => c.type === ComponentType.ActionRow), false);
  assert.equal(JSON.stringify(f.source).includes("The applicant can withdraw this application. Reviewers can close it."), false);
  assert.notEqual(f.current.applicationControlMessageId, f.source.id);
  await f.refresh({ publishReview: false });
  assert.equal(f.sent.length, 4); assert.equal(f.messages.has(f.source.id), false);
});

test("missing summary and instructions repair from snapshot without notifications", async () => {
  const f = fixture(); await f.refresh();
  f.application.initialMessage = "changed later"; f.messages.clear();
  await f.refresh(); assert.equal(f.sent.length, 8);
  assert.deepEqual(f.sent[4].allowedMentions, { parse: [], repliedUser: false });
  assertInstructions(f.sent[5], "Exact **instructions** <@&else>");
});

test("old review adoption preserves canonical summary, converts standalone instructions and deletes only recorded old notice", async () => {
  const f = fixture();
  const instructions = f.make(legacyStandaloneText("Originally posted"));
  const notice = f.make(legacyStandaloneText("<@&reviewer>, this application is ready for review."));
  f.setCurrent({ reviewPublication: { initialMessage: "Originally posted", initialMessageId: instructions.id, reviewerRoleId: "reviewer", answerMessageIds: [], notificationClaimed: true, notificationMessageId: notice.id } });
  await f.refresh();
  assert.equal(f.current.applicationControlMessageId, f.source.id); assert.ok(f.messages.has(f.source.id));
  assert.equal(f.messages.has(notice.id), false); assert.equal(f.sent.length, 2);
  assertInstructions(instructions, "Originally posted");
  assert.equal(f.current.reviewPublication!.initialMessageId, instructions.id);
});

test("identical old instruction/notice text with no nonce stays distinct during repair", async () => {
  const f = fixture(); const text = "<@&reviewer>, this application is ready for review.";
  const notice = f.make(legacyStandaloneText(text));
  f.setCurrent({ reviewPublication: { initialMessage: text, initialMessageId: "missing", notificationMessageId: notice.id, reviewerRoleId: "reviewer", answerMessageIds: [], notificationClaimed: true } });
  await f.refresh(); assert.equal(f.sent.length, 3);
  assertInstructions(f.sent[0], text); assert.notEqual(f.current.reviewPublication!.initialMessageId, notice.id);
  assert.equal(f.messages.has(notice.id), false);
});

test("old bare instructions without saved ID are recovered and converted without being copied", async () => {
  const f = fixture(); const instructions = f.make(legacyStandaloneText(f.application.initialMessage!));
  f.setCurrent({ reviewPublication: { ...f.current.reviewPublication!, reviewCardMessageId: f.source.id, notificationClaimed: true } });
  await f.refresh(); assert.equal(f.sent.length, 2); assert.equal(f.current.reviewPublication!.initialMessageId, instructions.id);
  assertInstructions(instructions, f.application.initialMessage!);
});

test("legacy adoption snapshots and retains actual original contents with no replacement or retrospective notification", async () => {
  const f = fixture({ legacy: true });
  const original = f.make({ embeds: [new EmbedBuilder().setTitle("Old title").setDescription("Actually posted")], components: [] });
  f.setCurrent({ applicationControlMessageId: original.id, characterResolutionMessageId: original.id });
  await f.refresh(); assert.equal(f.sent.length, 1); assert.ok(f.messages.has(original.id));
  assert.equal(v2Text(f.sent[0]), "# Old title\n\nActually posted");
  f.messages.delete(f.current.reviewPublication!.legacyHistoryMessageId!);
  await f.refresh(); assert.equal(f.sent.length, 2); assert.equal(v2Text(f.sent[1]), "# Old title\n\nActually posted");
});

test("unresolved state never starts publication or removes selection", async () => {
  const f = fixture({ unresolved: true }); await f.refresh({ players: [{ id: "identity", name: "Resolved" }] });
  assert.equal(f.sent.length, 0); assert.ok(f.messages.has(f.source.id)); assert.equal(f.current.reviewPublication, undefined);
});

test("newer search state cannot be overwritten by a stale candidate refresh", async () => {
  const f = fixture(); const old = structuredClone(f.current); f.setCurrent({ characterSearchAttemptCount: 3 });
  await refreshApplicationIntakeCard(f.channel, f.repository, f.application, old);
  assert.equal(f.sent.length, 0);
});

test("history recovery ignores reordered API keys and missing nonce", async () => {
  const f = fixture(); f.failNextSave(); await assert.rejects(f.refresh(), /Database unavailable/);
  const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  for (const message of f.messages.values()) { message.components = reverseKeys(json(message.components)); delete message.nonce; }
  await f.refresh(); assert.equal(f.sent.length, 4);
});

test("durable pending review nonce recovers summary after selection metadata changes without another send", async () => {
  const f = fixture(); f.failNextSave(); await assert.rejects(f.refresh(), /Database unavailable/);
  assert.equal(f.sent[0].nonce, publicationNonce("app", "review-card"));
  f.setCurrent({ selectedCharacterName: "Updated exact name", selectedCharacterGuildName: "Dreamweavers", selectedCharacterAllianceName: "GUCHI" });
  await f.refresh(); assert.equal(f.sent.length, 4);
  assert.equal(json(f.messages.get(f.current.applicationControlMessageId!)).components[0].components[2].content, "**Character**\nUpdated exact name • Dreamweavers • GUCHI • Europe • `identity` • [AlbionDB](https://europe.albiondb.net/player/Updated%20exact%20name) • [Killboard1](https://killboard-1.com/eu/player/Updated%20exact%20name)");
});

test("reopen after first selection crash publishes original snapshot and summary silently", async () => {
  const f = fixture(); f.application.initialMessage = "Later configuration";
  await f.refresh({ publishReview: false }); assert.equal(f.sent.length, 4);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
  assertInstructions(f.sent[1], "Exact **instructions** <@&else>");
});

test("retry clearing selection completes an already pending summary swap silently", async () => {
  const f = fixture(); f.failNextSave(); await assert.rejects(f.refresh(), /Database unavailable/);
  f.setCurrent({ characterResolutionState: "unresolved", selectedAlbionCharacterId: undefined, selectedCharacterName: undefined, characterSearchAttemptCount: 2 });
  await f.refresh({ players: [{ id: "new", name: "New" }] });
  assert.equal(f.sent.length, 4); assert.equal(f.messages.has(f.source.id), false);
  assert.deepEqual(json(f.messages.get(f.current.applicationControlMessageId!)).components[0].components.at(-1).components.map((button: any) => button.label), ["Retry Character Search", "Close", "Withdraw"]);
});

function legacyStandaloneText(content: string) { return { flags: 32768, components: [{ type: 10, content }] }; }
