import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSHIP_GRACE_MS } from "../../db/membershipLifecycleRepository.js";
import type { MemberGroupProfile } from "../../db/membershipRepository.js";
import { createMemberUpdateScheduler } from "./memberUpdateScheduler.js";
import { auditMembershipForGuild, reconcileMembershipForGuild, reconcileRegisteredCharacterMembership } from "./reconciliation.js";
import { withLogChanges } from "../logFeed/events.js";

const monday = new Date("2026-09-28T12:00:00Z");
const thursday = new Date(monday.getTime() + MEMBERSHIP_GRACE_MS);
type GroupKind = "managed" | "guild" | "alliance";

for (const kind of ["managed", "guild", "alliance"] as const) {
  test(`${kind}: scheduled discovery on Monday waits until Thursday, including across restart`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: monday });
    const f = fixture(kind);
    await f.scheduler().runDueSchedules([f.guild], monday);
    assert.equal(f.profile()?.departureExpiresAt?.getTime(), thursday.getTime());
    for (const days of [1, 2, 3]) {
      const now = new Date(monday.getTime() + days * 86400_000);
      t.mock.timers.setTime(now.getTime());
      await f.scheduler().runDueSchedules([f.guild], now);
      assert.equal(f.expirations.length, days === 3 ? 1 : 0);
    }
    assert.equal(f.profile(), undefined);
  });

  test(`${kind}: no schedule waits for manual update, never before 72 hours`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: monday });
    const f = fixture(kind);
    await f.update();
    f.schedule.enabled = false;
    t.mock.timers.setTime(thursday.getTime() - 1);
    await f.update();
    assert.equal(f.expirations.length, 0);
    t.mock.timers.setTime(thursday.getTime() + 10 * 86400_000);
    await f.scheduler().runDueSchedules([f.guild], new Date());
    assert.ok(f.profile());
    const audit = await f.audit();
    assert.ok(audit.outcomes.some(o => o.kind === "profile" && o.action === "expire"));
    assert.equal(f.expirations.length, 0, "audit cannot process cleanup");
    await f.update();
    assert.equal(f.expirations.length, 1);
    await f.update();
    assert.equal(f.expirations.length, 1, "later updates cannot repeat forfeiture");
  });

  test(`${kind}: verified return after 72 hours keeps the exact profile`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: monday });
    const f = fixture(kind);
    await f.update();
    t.mock.timers.setTime(thursday.getTime() + 3600_000);
    f.evidence.present = true;
    const audit = await f.audit();
    assert.ok(audit.outcomes.some(o => o.kind === "profile" && o.action === "restore"));
    assert.equal(f.profile()?.lifecycleState, "departed");
    await f.scheduler().runDueSchedules([f.guild], new Date());
    assert.equal(f.profile()?.memberGroupProfileId, "profile");
    assert.equal(f.profile()?.discordUserId, "owner");
    assert.equal(f.profile()?.lifecycleState, "current");
    assert.equal(f.expirations.length, 0);
  });

  test(`${kind}: unavailable verification defers cleanup until another update`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: monday });
    const f = fixture(kind);
    await f.update();
    t.mock.timers.setTime(thursday.getTime());
    f.evidence.unavailable = true;
    const result = await f.update();
    assert.ok(result.warnings.length);
    assert.equal(f.expirations.length, 0);
    assert.equal(f.profile()?.departureExpiresAt?.getTime(), thursday.getTime());
    f.evidence.unavailable = false;
    await f.update();
    assert.equal(f.expirations.length, 1);
  });

  test(`${kind}: stale cleanup cannot claim removal after concurrent recovery`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: monday });
    const f = fixture(kind);
    await f.update();
    t.mock.timers.setTime(thursday.getTime());
    f.evidence.stale = true;
    await withLogChanges("discord", async changes => {
      const result = await f.update();
      assert.equal(result.outcomes.some(o => o.kind === "profile" && o.action === "expire"), false);
      assert.equal(changes.some(c => c.kind === "profile" && c.action === "removed"), false);
    });
    assert.equal(f.expirations.length, 0);
  });
}

test("weekly schedules and schedule removal do not create an independent expiry clock", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: monday });
  const f = fixture("managed");
  f.schedule.cadence = "weekly";
  f.schedule.weekday = 1;
  await f.scheduler().runDueSchedules([f.guild], monday);
  t.mock.timers.setTime(thursday.getTime());
  await f.scheduler().runDueSchedules([f.guild], thursday);
  assert.equal(f.expirations.length, 0);
  f.schedule.enabled = false;
  t.mock.timers.setTime(monday.getTime() + 7 * 86400_000);
  await f.scheduler().runDueSchedules([f.guild], new Date());
  assert.equal(f.expirations.length, 0);
  f.schedule.enabled = true;
  await f.scheduler().runDueSchedules([f.guild], new Date());
  assert.equal(f.expirations.length, 1);
});

test("character registration reconciliation cannot process due departures", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: monday });
  const f = fixture("alliance");
  await f.update();
  t.mock.timers.setTime(thursday.getTime());
  await reconcileRegisteredCharacterMembership(f.guild, f.albion as never, f.repository as never,
    "owner", await f.albion.getPlayer(), "europe");
  assert.equal(f.expirations.length, 0);
  await f.update();
  assert.equal(f.expirations.length, 1);
});

test("ownerless retained memberships use the same update-driven cleanup", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: monday });
  const f = fixture("alliance", false);
  await f.update();
  t.mock.timers.setTime(thursday.getTime());
  await f.update();
  assert.equal(f.expirations.length, 1);
});

function fixture(kind: GroupKind, registered = true) {
  let profile: MemberGroupProfile | undefined = {
    memberGroupProfileId: "profile", memberGroupId: "group", discordGuildId: "discord", albionServer: "europe",
    albionCharacterId: "character", characterName: "Character", discordUserId: registered ? "owner" : undefined,
    lifecycleState: registered ? "current" : "manual", entitlementPreserved: true, lifecycleRevision: 1
  };
  const evidence = { present: false, unavailable: false, stale: false };
  const expirations: Date[] = [];
  const group = { memberGroupId: "group", discordGuildId: "discord", albionServer: "europe", groupName: "Group",
    groupType: kind === "alliance" ? "alliance" : "guild", albionGuildId: "guild", albionGuildName: "Group",
    albionAllianceId: "alliance", albionAllianceName: "Group", managed: kind === "managed" };
  const character = { discordGuildId: "discord", discordUserId: "owner", albionServer: "europe", albionCharacterId: "character", characterName: "Character" };
  const rows = () => profile ? [{ ...profile }] : [];
  const repository = {
    listMemberGroups: async () => [group],
    listConfiguredAlbionGuilds: async () => kind === "alliance" ? [] : [group],
    listConfiguredAlbionAlliances: async () => kind === "alliance" ? [group] : [],
    listProfilesForGroups: async () => rows(), listProfilesForCharacter: async () => rows(),
    listRegisteredCharacters: async () => registered ? [character] : [],
    listRegisteredUserIdsForGuild: async () => registered ? ["owner"] : [],
    listActiveProfileUserIdsForGroups: async () => [],
    getRegisteredCharacter: async () => registered ? character : undefined,
    upsertVerifiedCharacter: async () => {}, getEffectiveNickname: async () => undefined,
    listConfiguredRoleIdsForGuild: async () => [], listQualifiedRoleIdsForUser: async () => [],
    listDormantReactionRoleSubscriptions: async () => [],
    markMembershipDeparted: async (ref: MemberGroupProfile, now = new Date()) => {
      assert.equal(ref.lifecycleRevision, profile?.lifecycleRevision);
      profile = { ...profile!, discordUserId: undefined, previousDiscordUserId: registered ? "owner" : undefined,
        lifecycleState: "departed", lifecycleRevision: 2, departureDetectedAt: now,
        departureExpiresAt: new Date(now.getTime() + MEMBERSHIP_GRACE_MS) };
      return { ...profile };
    },
    expireMembershipDeparture: async (_ref: MemberGroupProfile, revision: number, now: Date) => {
      if (evidence.stale) return false;
      assert.equal(revision, profile?.lifecycleRevision);
      assert.ok(now.getTime() >= profile!.departureExpiresAt!.getTime());
      expirations.push(now); profile = undefined; return true;
    },
    restoreDepartedMembership: async (_ref: MemberGroupProfile, revision: number) => {
      assert.equal(revision, profile?.lifecycleRevision);
      profile = { ...profile!, lifecycleState: "current", lifecycleRevision: 3,
        discordUserId: registered ? "owner" : undefined, departureExpiresAt: undefined };
      return { ...profile };
    }
  };
  const member = { id: "owner", guild: { id: "discord" }, nickname: null,
    roles: { cache: { has: () => false } } };
  const guild: any = { id: "discord", members: { fetch: async (id?: string) => id ? member : new Map([["owner", member]]) } };
  const player = () => ({ id: "character", name: "Character", guildId: evidence.present ? "guild" : "other",
    allianceId: evidence.present ? "alliance" : "other-alliance" });
  const available = () => { if (evidence.unavailable) throw Error("verification unavailable"); };
  const albion = {
    getPlayer: async () => { available(); return player(); },
    getGuildMembers: async () => { available(); return evidence.present ? [player()] : []; },
    searchCharacters: async () => { available(); return { players: [player()] }; },
    getGuild: async (_server: string, id: string) => { available(); return { id, name: "Group", allianceId: "other-alliance" }; }
  };
  const schedule = { enabled: true, discordGuildId: "discord", cadence: "daily", weekday: null as number | null,
    hourUtc: 12, minuteUtc: 0, lastRunKey: null as string | null };
  const scheduler = () => createMemberUpdateScheduler({
    listSchedules: async () => schedule.enabled ? [schedule] : [],
    markScheduleRun: async (_guild: string, key: string, success: boolean, error?: string) => {
      assert.equal(success, true, error); schedule.lastRunKey = key;
    }
  } as never, repository as never, albion as never, { info() {}, warn() {}, error(_message: string, context: unknown) { assert.fail(JSON.stringify(context)); } } as never);
  return { profile: () => profile, evidence, expirations, guild, albion, repository, schedule, scheduler,
    update: () => reconcileMembershipForGuild(guild, albion as never, repository as never),
    audit: () => auditMembershipForGuild(guild, albion as never, repository as never) };
}
