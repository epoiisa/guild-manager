import assert from "node:assert/strict";
import test from "node:test";
import { withApplicationOperationLock } from "../services/applications/applicationOperationLock.js";
import { buildApplicationIntakeCard } from "../services/applications/rendering.js";
import { handleApplicationIntakeCharacterSelect, handleApplicationIntakeModalSubmit, refreshUnresolvedApplicationSearch } from "./applicationIntake.js";

function fixture() {
  const app: any = { applicationClassId: "class", discordGuildId: "guild", name: "Test", albionServer: "europe", reviewerRoleId: "reviewer", questions: [] };
  let open: any = { applicationId: "app", applicationClassId: "class", discordGuildId: "guild", albionServer: "europe", applicantDiscordUserId: "applicant", submittedCharacterName: "Query", status: "open", channelStatus: "open", characterSearchAttemptCount: 1, characterResolutionState: "unresolved", applicationControlMessageId: "first", characterResolutionMessageId: "first", ticketChannelId: "channel", modalAnswers: [] };
  const edits: any[] = [], replies: any[] = [], writes: string[] = [];
  const canonical: any = { id: "first", author: { id: "bot" }, components: buildApplicationIntakeCard(app, open, undefined, { players: [{ id: "exact", name: "Canonical" }] }).components, edit: async (payload: any) => { edits.push(payload); canonical.components = payload.components; } };
  const sent: any[] = [], deleted: string[] = [];
  const messages = new Map<string, any>([[canonical.id, canonical]]);
  canonical.delete = async () => { deleted.push(canonical.id); messages.delete(canonical.id); };
  const channel: any = { id: "channel", client: { user: { id: "bot" } }, messages: { fetch: async (id: any) => {
    if (typeof id !== "string") return messages;
    const message = messages.get(id); if (!message) throw { code: 10008 }; return message;
  } }, send: async (payload: any) => {
    sent.push(payload); const id = `sent-${sent.length}`;
    const message: any = { id, author: { id: "bot" }, content: payload.content, embeds: payload.embeds ?? [], components: payload.components ?? [], nonce: payload.nonce,
      edit: async (next: any) => { edits.push(next); message.components = next.components; }, delete: async () => { deleted.push(id); messages.delete(id); } };
    messages.set(id, message); return message;
  } };
  const snapshot = () => { if (!open.legacyReviewPublication && open.characterResolutionState === "selected" && !open.reviewPublication) open = { ...open, reviewPublication: { reviewerRoleId: app.reviewerRoleId, initialMessage: app.initialMessage, answerMessageIds: [], notificationClaimed: false } }; return open; };
  const repo: any = {
    getOpenApplication: async () => open, getApplicationClass: async () => app,
    selectApplicationCharacter: async (_guild: string, _id: string, id: string, state: string) => { writes.push("select"); open = { ...open, selectedAlbionCharacterId: id, selectedCharacterName: "Canonical", characterResolutionState: state }; return snapshot(); },
    markApplicationCharacterNotListed: async () => { writes.push("not-listed"); open = { ...open, selectedAlbionCharacterId: undefined, characterResolutionState: "not_listed" }; return open; },
    beginApplicationCharacterSearch: async () => { writes.push("search"); open = { ...open, characterSearchAttemptCount: open.characterSearchAttemptCount + 1, characterResolutionState: "unresolved", selectedAlbionCharacterId: undefined }; return open; },
    ensureApplicationReviewPublication: async () => snapshot(),
    updateApplicationReviewPublication: async (_guild: string, _app: string, expected: any, next: any) => { assert.deepEqual(open.reviewPublication, expected); open = { ...open, reviewPublication: next }; return true; },
    claimApplicationFirstMessageId: async (_guild: string, _app: string, expected: string, id: string) => { if (open.applicationControlMessageId !== expected) return false; open = { ...open, applicationControlMessageId: id, characterResolutionMessageId: id }; return true; },
  };
  const membership: any = { upsertVerifiedCharacter: async () => { writes.push("verify"); }, getRegisteredCharacter: async () => undefined, listRegisteredCharactersByName: async () => [{ albionServer: "europe", albionCharacterId: "own", characterName: "Own", discordUserId: "applicant" }] };
  const client: any = { getPlayer: async () => ({ id: "exact", name: "Canonical" }), searchCharacters: async () => ({ players: [{ id: "exact", name: "Canonical" }] }) };
  const interaction: any = { customId: "app:character:app:1", guildId: "guild", channelId: "channel", channel, message: canonical, client: channel.client, user: { id: "applicant" }, member: { roles: { cache: new Map() } }, values: ["exact"], inCachedGuild: () => true, deferUpdate: async () => undefined, followUp: async (payload: any) => { replies.push(payload); }, editReply: async (payload: any) => { replies.push(payload); } };
  return { app, get open() { return open; }, set open(value) { open = value; }, edits, replies, writes, canonical, channel, repo, membership, client, interaction, sent, deleted, messages };
}
for (const [name, mutate] of [
  ["forged option", (f: ReturnType<typeof fixture>) => { f.interaction.values = ["forged"]; }],
  ["stale attempt", (f: ReturnType<typeof fixture>) => { f.interaction.customId = "app:character:app:0"; }],
  ["legacy menu", (f: ReturnType<typeof fixture>) => { f.interaction.customId = "app:character:app"; }],
  ["unauthorized actor", (f: ReturnType<typeof fixture>) => { f.interaction.user.id = "outsider"; }],
  ["wrong channel", (f: ReturnType<typeof fixture>) => { f.interaction.channelId = "other"; }],
] as const) test(`selection rejects ${name} before verification or mutation`, async () => {
  const f = fixture(); mutate(f); await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, []); assert.equal(f.replies.length, 1); assert.equal(f.edits.length, 0);
});
test("explicit selection replaces and deletes selection card and notifies both conversation roles", async () => {
  const f = fixture(); await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, ["verify", "select"]); assert.equal(f.open.characterResolutionState, "selected"); assert.equal(f.edits.length, 0);
  assert.deepEqual(f.deleted, ["first"]);
  assert.equal(f.open.applicationControlMessageId, "sent-1"); assert.equal(f.open.characterResolutionMessageId, "sent-1");
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false, users: ["applicant"], roles: ["reviewer"] });
  assert.equal(f.sent.length, 1);
  const json = JSON.stringify(f.sent); assert.match(json, /Canonical/); assert.doesNotMatch(json, /Character Selected/); assert.match(json, /app:accept:app/);
});
test("ownership conflict retains selection stage without target membership checks", async () => {
  const f = fixture(); f.membership.getRegisteredCharacter = async () => ({ discordUserId: "someone" });
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.equal(f.open.characterResolutionState, "registered_to_other_user"); assert.doesNotMatch(JSON.stringify(f.edits), /app:accept|app:reject/); assert.match(JSON.stringify(f.edits), /ownership conflict/);
});
for (const mismatch of [false, true]) test(`verification ${mismatch ? "mismatch" : "outage"} preserves count and state`, async () => {
  const f = fixture(); f.client.getPlayer = async () => { if (mismatch) return { id: "other", name: "Other" }; throw new Error("unavailable"); };
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, []); assert.equal(f.open.characterSearchAttemptCount, 1); assert.equal(f.open.characterResolutionState, "unresolved"); assert.doesNotMatch(JSON.stringify(f.edits), /app:character:app/);
});
test("new search offers own registration without selecting it", async () => {
  const f = fixture(); await refreshUnresolvedApplicationSearch(f.channel, f.repo, f.membership, f.client, f.app, f.open);
  assert.deepEqual(f.writes, ["search"]); assert.equal(f.open.characterResolutionState, "unresolved"); assert.match(JSON.stringify(f.edits), /Own/); assert.match(JSON.stringify(f.edits), /app:character:app:2/); assert.doesNotMatch(JSON.stringify(f.edits), /app:accept|app:reject/);
});
test("initial search permits Close during HTTP and discards result after closure", async () => {
  const f = fixture(); let resolve!: (value: any) => void;
  f.client.searchCharacters = () => new Promise((done) => { resolve = done; });
  const searching = refreshUnresolvedApplicationSearch(f.channel, f.repo, f.membership, f.client, f.app, f.open);
  await withApplicationOperationLock("guild", "app", async () => { f.open = { ...f.open, channelStatus: "closed" }; });
  resolve({ players: [{ id: "exact", name: "Canonical" }] }); await searching;
  assert.deepEqual(f.writes, []); assert.equal(f.edits.length, 0);
});

for (const stale of [false, true]) test(`remote selection ${stale ? "rejects stale attempt" : "validates canonical option and replaces first card"}`, async () => {
  const f = fixture();
  f.channel.type = 0;
  f.interaction.guild = { channels: { cache: new Map([["channel", f.channel]]) } };
  f.interaction.channelId = "outside";
  f.interaction.customId = `app:remote-character:app:applicant:${(Date.now() + 60_000).toString(36)}:${stale ? "0" : "1"}`;
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, stale ? [] : ["verify", "select"]);
  assert.equal(f.sent.length, stale ? 0 : 1); assert.equal(f.replies.length, 1);
});

test("selection publication keeps the application lock through Discord rendering", async () => {
  const f = fixture(); let started!: () => void, release!: () => void;
  const editing = new Promise<void>((resolve) => { started = resolve; });
  const send = f.channel.send;
  f.channel.send = async (payload: any) => { started(); await new Promise<void>((resolve) => { release = resolve; }); return send(payload); };
  const selecting = handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  await editing;
  let closed = false;
  const closing = withApplicationOperationLock("guild", "app", async () => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(closed, false);
  release(); await selecting; await closing; assert.equal(closed, true);
});

function legacyFixture(prefix = "app:character:") {
  const f = fixture();
  const oldEdits: unknown[] = [];
  const old: any = { id: "legacy-search", author: { id: "bot" }, components: [{ type: 1, components: [{ type: 3, custom_id: `${prefix}app`, options: [{ label: "Canonical", value: "exact" }] }] }], edit: async (payload: any) => { oldEdits.push(payload); old.components = payload.components; } };
  f.open = { ...f.open, legacyReviewPublication: true, characterResolutionMessageId: old.id };
  f.interaction.customId = `${prefix}app`; f.interaction.message = old;
  f.channel.messages.fetch = async (id: string) => id === old.id ? old : f.canonical;
  f.channel.send = async () => assert.fail("legacy adoption must not start fresh review publications or ping reviewers");
  f.repo.claimApplicationFirstMessageId = async (_guild: string, _app: string, _expected: string, id: string) => { f.open = { ...f.open, applicationControlMessageId: id, characterResolutionMessageId: id }; return true; };
  return { f, oldEdits };
}

for (const prefix of ["app:character:", "app:reviewer-character-select:"]) test(`legacy ${prefix} selection adopts first card and retires old source without notification`, async () => {
  const { f, oldEdits } = legacyFixture(prefix);
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, ["verify", "select"]);
  assert.equal(f.open.characterResolutionMessageId, "first");
  assert.equal(f.edits.length, 1); assert.equal(oldEdits.length, 1);
  assert.doesNotMatch(JSON.stringify(oldEdits), /app:character|app:reviewer-character/);
  f.writes.length = 0;
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, []); assert.equal(f.replies.length, 1);
});

test("legacy selection rejects forged options even from the stored bot-owned source", async () => {
  const { f } = legacyFixture(); f.interaction.values = ["forged"];
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, []); assert.equal(f.edits.length, 0);
});

test("legacy retry modal adopts first card and rejects subsequent submissions from retired source", async () => {
  const { f, oldEdits } = legacyFixture();
  f.interaction.customId = "app:character-search:app";
  f.interaction.isFromMessage = () => true;
  f.interaction.deferUpdate = async () => { f.interaction.deferred = true; };
  f.interaction.fields = { getTextInputValue: () => "New Query" };
  await handleApplicationIntakeModalSubmit(f.interaction, f.repo, f.membership, f.client, {} as never);
  assert.deepEqual(f.writes, ["search"]); assert.equal(f.open.characterResolutionMessageId, "first");
  assert.equal(f.edits.length, 1); assert.equal(oldEdits.length, 1);
  assert.match(JSON.stringify(f.edits), /app:character:app:2/);
  f.writes.length = 0;
  await handleApplicationIntakeModalSubmit(f.interaction, f.repo, f.membership, f.client, {} as never);
  assert.deepEqual(f.writes, []); assert.equal(f.replies.length, 1);
});

test("public reviewer selection sends summary then exact instructions Container then answers and invalidates deleted source", async () => {
  const f = fixture();
  f.app.initialMessage = "  **Exact configured instructions**\nKeep this line.  ";
  f.open = { ...f.open, modalAnswers: [{ question: "Why?", answer: "Because." }] };
  f.interaction.user.id = "reviewer-user";
  f.interaction.member.roles.cache.set("reviewer", {});
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.equal(f.open.applicationControlMessageId, "sent-1");
  assert.equal(f.open.characterResolutionMessageId, "sent-1");
  assert.equal(f.open.reviewPublication.reviewCardMessageId, "sent-1");
  assert.equal(f.messages.has("first"), false);
  assert.deepEqual(f.deleted, ["first"]);
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false, users: ["applicant"], roles: ["reviewer"] });
  const instructions = JSON.parse(JSON.stringify(f.sent[1]));
  assert.equal(instructions.components.length, 1);
  assert.equal(instructions.components[0].type, 17);
  assert.equal(typeof instructions.components[0].accent_color, "number");
  assert.deepEqual(instructions.components[0].components, [{ type: 10, content: f.app.initialMessage }]);
  assert.deepEqual(instructions.allowedMentions, { parse: [], repliedUser: false });
  assert.match(JSON.stringify(f.sent[2]), /Application Answers/);
  assert.doesNotMatch(JSON.stringify(f.sent), /this application is ready for review/);
  f.writes.length = 0;
  await handleApplicationIntakeCharacterSelect(f.interaction, f.repo, f.membership, f.client);
  assert.deepEqual(f.writes, []);
  assert.equal(f.sent.length, 3);
  assert.match(JSON.stringify(f.replies), /Use the controls on the current application card/ );
});
