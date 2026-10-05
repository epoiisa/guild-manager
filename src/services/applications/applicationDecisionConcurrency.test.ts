import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { runApplicationLifecycleOperation } from "../../commands/application.js";
import { acceptOrVerifyApplication } from "./acceptVerificationService.js";
import { rejectApplication } from "./rejectService.js";

test("accept races serialize: one accept claims and presents", async () => {
  const h = fixture();
  const gate = barrier();
  h.playerGate = gate.wait;
  const first = acceptOrVerifyApplication(h.acceptInput());
  await gate.entered;
  const second = acceptOrVerifyApplication(h.acceptInput());
  gate.release();
  assert.deepEqual(await first, { kind: "accepted" });
  assert.equal((await second).kind, "error");
  assert.deepEqual(h.effects, ["register", "profile", "mark:accepted", "accepted"]);
});

test("accept versus reject has one decision and no losing membership or presentation effects", async () => {
  const h = fixture();
  const gate = barrier();
  h.playerGate = gate.wait;
  const accepting = acceptOrVerifyApplication(h.acceptInput());
  await gate.entered;
  const rejecting = rejectApplication(h.rejectInput());
  gate.release();
  assert.deepEqual(await accepting, { kind: "accepted" });
  assert.equal((await rejecting).kind, "error");
  assert.equal(h.status, "accepted");
  assert.deepEqual(h.effects, ["register", "profile", "mark:accepted", "accepted"]);
});

test("a lost conditional accept claim has no registration, Discord, or presentation effects", async () => {
  const h = fixture();
  h.claimReturnsUndefined = true;
  const result = await acceptOrVerifyApplication(h.acceptInput());
  assert.equal(result.kind, "error");
  assert.deepEqual(h.effects, []);
});

test("cancel winning over verify prevents registration and accepted or waiting presentation", async () => {
  const h = fixture({ status: "awaiting_ingame_membership" });
  const gate = barrier();
  h.closeGate = gate.wait;
  const cancelling = runApplicationLifecycleOperation(h.cancelInput());
  await gate.entered;
  const verifying = acceptOrVerifyApplication(h.acceptInput(true));
  gate.release();
  assert.equal((await cancelling).kind, "closed");
  assert.equal((await verifying).kind, "error");
  assert.equal(h.status, "awaiting_ingame_membership");
  assert.equal(h.channelStatus, "closed");
  assert.deepEqual(h.effects, ["mark:closed", "closed"]);
});

test("verify winning over cancel completes acceptance and cancel does not close or present", async () => {
  const h = fixture({ status: "awaiting_ingame_membership" });
  const gate = barrier();
  h.playerGate = gate.wait;
  const verifying = acceptOrVerifyApplication(h.acceptInput(true));
  await gate.entered;
  const cancelling = runApplicationLifecycleOperation(h.cancelInput());
  gate.release();
  assert.deepEqual(await verifying, { kind: "accepted" });
  assert.equal((await cancelling).kind, "error");
  assert.equal(h.status, "accepted");
  assert.deepEqual(h.effects, ["register", "profile", "mark:accepted", "accepted"]);
});

function barrier() {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait: async () => { entered(); await wait; }, entered: new Promise<void>((resolve) => { entered = resolve; }), release };
}

function fixture(options: { status?: "open" | "awaiting_ingame_membership" } = {}) {
  let status: "open" | "awaiting_ingame_membership" | "accepted" | "rejected" = options.status ?? "open";
  let channelStatus: "open" | "closed" = "open";
  const effects: string[] = [];
  const state = () => ({ applicationId: "application", applicationClassId: "class", discordGuildId: "guild", applicantDiscordUserId: "applicant", ticketChannelId: "channel", submittedCharacterName: "Applicant", modalAnswers: [], albionServer: "europe", selectedAlbionCharacterId: "character", characterResolutionState: "selected", characterSearchAttemptCount: 1, status, channelStatus });
  let playerGate: (() => Promise<void>) | undefined;
  let closeGate: (() => Promise<void>) | undefined;
  let claimReturnsUndefined = false;
  const app = { applicationClassId: "class", discordGuildId: "guild", name: "Raiders", outcomeType: "member_group", memberGroupId: "group", albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: "reviewer", questions: [], enabled: true, createdByDiscordUserId: "owner" };
  const repository = {
    getOpenApplication: async () => state(), getApplicationClass: async () => app,
    markApplicationAwaitingMembership: async (_g: string, _id: string, _actor: string, _failure: string, expected: string) => { if (status !== expected || channelStatus !== "open") return undefined; status = "awaiting_ingame_membership"; effects.push("mark:waiting"); return state(); },
    markApplicationRejected: async () => { if (status !== "open" || channelStatus !== "open") return undefined; status = "rejected"; effects.push("mark:rejected"); return state(); },
    markApplicationClosed: async () => { await closeGate?.(); if (channelStatus !== "open") return undefined; channelStatus = "closed"; effects.push("mark:closed"); return state(); },
    setApplicationControlMessageId: async () => state(), setClosedControlMessageId: async () => state(), claimClosedControlMessageId: async () => true
  };
  let channel: { type: ChannelType.GuildText; guild: unknown; permissionOverwrites: { edit: () => Promise<void> } };
  const guild = { id: "guild", members: { fetch: async () => ({ id: "applicant", roles: { cache: new Map(), remove: async () => undefined } }) }, channels: { cache: new Map(), fetch: async () => channel } };
  channel = { type: ChannelType.GuildText, guild, permissionOverwrites: { edit: async () => undefined } };
  const membership = {
    listConfiguredAlbionGuilds: async () => [],
    listConfiguredAlbionAlliances: async () => [],
    upsertVerifiedCharacter: async () => undefined,
    listProfilesForCharacter: async () => [],
    listMemberGroups: async () => [{ memberGroupId: "group", groupType: "custom", albionServer: "europe" }], getCharacterRegistrationLifecycle: async () => undefined,
      getRegisteredCharacter: async () => undefined, completeApplicationAcceptance: async (input: { expectedApplicationStatus: string }) => { if (claimReturnsUndefined || status !== input.expectedApplicationStatus || channelStatus !== "open") return undefined; effects.push("register", "profile", "mark:accepted"); status = "accepted"; return { albionServer: "europe", albionCharacterId: "character", characterName: "Applicant" }; }, listDormantReactionRoleSubscriptions: async () => [], listConfiguredRoleIdsForGuild: async () => [], listQualifiedRoleIdsForUser: async () => [], getEffectiveNickname: async () => undefined };
  return {
    get status() { return status; }, get channelStatus() { return channelStatus; }, effects,
    set playerGate(value: (() => Promise<void>) | undefined) { playerGate = value; }, set closeGate(value: (() => Promise<void>) | undefined) { closeGate = value; }, set claimReturnsUndefined(value: boolean) { claimReturnsUndefined = value; },
    acceptInput: (verification = false) => ({ verification, guild: guild as never, guildId: "guild", channelId: "channel", applicationId: "application", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, applicationRepository: repository as never, membershipRepository: membership as never, albionClient: { getPlayer: async () => { await playerGate?.(); return { id: "character", name: "Applicant" }; } } as never, presentation: { retireUndecidedControls: async () => undefined, retainWaitingControls: async () => { effects.push("waiting"); }, renderWaiting: async () => { effects.push("waiting"); return "waiting"; }, renderAccepted: async () => { effects.push("accepted"); return "accepted"; } } }),
    rejectInput: () => ({ guild: guild as never, guildId: "guild", channelId: "channel", applicationId: "application", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, applicationRepository: repository as never, presentation: { retireUndecidedControls: async () => undefined, renderRejected: async () => { effects.push("rejected"); return "rejected"; } } }),
    cancelInput: () => ({ action: "cancel" as const, guild: guild as never, guildId: "guild", applicationId: "application", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, channel: channel as never, applicationRepository: repository as never, presentation: { renderClosed: async () => { effects.push("closed"); return "closed"; }, renderOpen: async () => undefined, retireClosedCandidate: async () => undefined } })
  };
}
