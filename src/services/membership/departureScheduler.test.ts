import assert from "node:assert/strict";
import test from "node:test";
import { createMembershipDepartureScheduler } from "./departureScheduler.js";
import { withLogChanges } from "../logFeed/events.js";

const now = new Date("2026-09-28T12:00:00Z");
const expired = new Date(now.getTime() - 1);
function fixture() {
  const calls: string[] = [];
  const profile = { memberGroupProfileId: "profile", memberGroupId: "group", discordGuildId: "discord",
    albionServer: "europe", albionCharacterId: "character", characterName: "Character", lifecycleState: "departed",
    lifecycleRevision: 7, departureExpiresAt: expired, previousDiscordUserId: "owner" };
  const hold = { discordGuildId: "discord", albionServer: "europe", albionCharacterId: "character",
    previousDiscordUserId: "owner", state: "hold", revision: 8, detectedAt: new Date("2026-09-24"), expiresAt: expired };
  const repository: any = {
    listRegisteredUserIdsForGuild: async () => [],
    getDiscordRegistrationSnapshot: async () => ({ "europe:character": "12" }),
    listDueRegistrationHolds: async () => [],
    listDueMembershipDepartures: async () => [],
    listConfiguredAlbionGuilds: async () => [{ memberGroupId: "group", groupName: "Guild", albionGuildId: "guild", managed: true }],
    listConfiguredAlbionAlliances: async () => [],
    expireMembershipDeparture: async (_profile: unknown, revision: number) => { calls.push(`expire:${revision}`); return true; },
    abandonRegistration: async (_hold: unknown, revision: number) => { calls.push(`abandon:${revision}`); return true; },
    getRegisteredCharacter: async () => undefined,
    getCharacterRecord: async () => ({ characterName: "Character" }),
    beginDiscordDeparture: async () => { calls.push("hold"); return { characters: [], holds: [] }; },
    addRegisteredProfile: async () => { calls.push("active"); },
    addOrphanProfile: async () => { calls.push("observation"); },
    noteLifecycleCheckFailure: async () => { calls.push("defer"); },
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => [],
    listQualifiedRoleIdsForUser: async () => []
  };
  const guild: any = { id: "discord", members: { fetch: async () => { throw { code: 10007 }; } } };
  const options = { membershipRepository: repository,
    lifecycleRepository: { isGuildActive: async () => true }, reactionRoleRepository: { deleteUserSubscriptions: async () => { calls.push("subscriptions"); } } as any,
    logger: { warn() {}, error() {} } as any, cleanupEvidence: async () => { calls.push("evidence"); } };
  const scheduler = createMembershipDepartureScheduler(options);
  return { calls, profile, hold, repository, guild, options, scheduler };
}

test("missed Discord departures require a forced definitive absence", async () => {
  const f = fixture();
  let captured = false;
  f.repository.getDiscordRegistrationSnapshot = async () => { captured = true; return { "europe:character": "12" }; };
  f.repository.beginDiscordDeparture = async (_guild: string, _user: string, _now: Date, snapshot: unknown) => {
    assert.deepEqual(snapshot, { "europe:character": "12" });
    f.calls.push("hold"); return { characters: [], holds: [] };
  };
  f.repository.listRegisteredUserIdsForGuild = async () => ["absent", "unavailable", "present"];
  f.guild.members.fetch = async (request: any) => {
    assert.equal(captured, true);
    assert.equal(request.force, true);
    if (request.user === "absent") throw { code: 10007 };
    if (request.user === "unavailable") throw Error("timeout");
    return {};
  };
  await f.scheduler.runDueDepartures([f.guild], now);
  assert.deepEqual(f.calls, ["hold", "evidence"]);
});

test("registration holds expire without guessing a missing former owner", async () => {
  const f = fixture();
  f.repository.listDueRegistrationHolds = async () => [{ ...f.hold, previousDiscordUserId: undefined }];
  f.guild.members.fetch = async () => { throw Error("must not look up an unknown owner"); };
  await f.scheduler.runDueDepartures([f.guild], now);
  assert.deepEqual(f.calls, ["abandon:8", "evidence"]);
});

test("a rejoined Discord account does not recover or renew an expired hold", async () => {
  const f = fixture(); f.repository.listDueRegistrationHolds = async () => [f.hold];
  f.guild.members.fetch = async () => ({ id: "owner", guild: f.guild,
    roles: { cache: { has: () => false } } });
  await withLogChanges("discord", async changes => {
    await f.scheduler.runDueDepartures([f.guild], now);
    assert.equal(changes.filter(change => change.kind === "membershipLifecycle" && change.action === "abandoned").length, 1);
  });
  assert.deepEqual(f.calls, ["abandon:8", "evidence"]);
});

test("maintenance and restart never process Albion Online departures, even after the buffer", async () => {
  const f = fixture();
  f.repository.listDueMembershipDepartures = async () => { throw Error("membership cleanup belongs to updates"); };
  f.repository.expireMembershipDeparture = async () => { throw Error("must not expire memberships"); };
  f.options.logger.error = () => { assert.fail("maintenance must not touch membership cleanup"); };
  await f.scheduler.runDueDepartures([f.guild], now);
  await createMembershipDepartureScheduler(f.options).runDueDepartures([f.guild], new Date(now.getTime() + 7 * 86400_000));
  assert.deepEqual(f.calls, ["evidence", "evidence"]);
});

test("deferred registration holds rotate beyond the first hundred rows", async () => {
  const f = fixture();
  const holds = Array.from({ length: 150 }, (_, index) => ({ ...f.hold,
    albionCharacterId: `character-${index}`, previousDiscordUserId: `owner-${index}` }));
  const failedAt = new Map<string, number>();
  const checked = new Set<string>();
  f.repository.listDueRegistrationHolds = async (_guild: string, _now: Date, limit: number) => [...holds]
    .sort((a, b) => (failedAt.get(a.albionCharacterId) ?? 0) - (failedAt.get(b.albionCharacterId) ?? 0)).slice(0, limit);
  f.repository.noteLifecycleCheckFailure = async (ref: any, checkTime: Date) => { failedAt.set(ref.albionCharacterId, checkTime.getTime()); };
  f.guild.members.fetch = async (request: any) => { checked.add(request.user); throw Error("unavailable"); };
  for (let tick = 0; tick < 6; tick++) {
    await f.scheduler.runDueDepartures([f.guild], new Date(now.getTime() + tick * 60_000));
    assert.equal(checked.size, (tick + 1) * 25);
  }
});

test("inactive Discord servers do not discover, expire or clean up memberships", async () => {
  const f = fixture(); f.options.lifecycleRepository.isGuildActive = async () => false;
  await f.scheduler.runDueDepartures([f.guild], now);
  assert.deepEqual(f.calls, []);
});
