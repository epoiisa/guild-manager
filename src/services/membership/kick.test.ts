import assert from "node:assert/strict";
import test from "node:test";
import { Collection, PermissionsBitField, PermissionFlagsBits } from "discord.js";
import { createKickService } from "./kick.js";

function fixture(options: { absent?: boolean; fetchFailure?: boolean; roleFailure?: boolean; nicknameFailure?: boolean; activityPending?: boolean; owner?: boolean; stale?: boolean; completionStale?: boolean; authorityFailure?: boolean } = {}) {
  const events: string[] = [];
  let blocked = false, pending = true;
  const roles = new Collection<string, any>([
    ["manager", { id: "manager", permissions: new PermissionsBitField() }],
    ["member", { id: "member", permissions: new PermissionsBitField() }],
    ["admin", { id: "admin", permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }],
    ["unrelated", { id: "unrelated", permissions: new PermissionsBitField() }]
  ]);
  const state = { discordGuildId: "guild", discordUserId: "target", blocked: true, cleanupPending: true,
    revokedRoleIds: ["manager"], cleanupRoleIds: ["member"], revision: 4, updatedAt: new Date() };
  const member: any = { id: "target", nickname: "Custom", roles: { cache: roles,
    remove: async (id: string) => { events.push(`remove:${id}`); if (options.roleFailure && id === "manager") throw Error("role too high"); roles.delete(id); }
  }, get permissions() { return new PermissionsBitField(roles.has("admin") ? PermissionFlagsBits.Administrator : 0n); },
    setNickname: async () => { if (options.nicknameFailure) throw Error("forbidden"); member.nickname = null; events.push("nickname"); }
  };
  const guild: any = { id: "guild", client: { application: { id: "bot" }, user: { id: "bot" } },
    commands: { fetch: async () => new Collection(), permissions: { fetch: async () => new Collection() } },
    ownerId: options.owner ? "target" : "someone", members: { fetch: async () => {
    events.push("fetch"); if (options.absent) throw { code: 10007 }; if (options.fetchFailure) throw Error("network"); return member;
  } } };
  const access: any = {
    getMemberAccess: async () => blocked ? state : undefined,
    addRevokedRoleIds: async (guildId: string, userId: string, revision: number, ids: string[], cleanup: string[]) => {
      assert.equal(guildId, "guild"); assert.equal(userId, "target"); assert.equal(revision, 4);
      events.push("save-role-cleanup"); state.revokedRoleIds = ids; state.cleanupRoleIds = cleanup;
      pending = true; return !options.stale;
    },
    markKickCleanupComplete: async (_g: string, _u: string, revision: number) => { assert.equal(revision, 4); events.push("complete"); if (options.completionStale) return false; pending = false; return true; },
    listPendingKickCleanups: async () => blocked && pending ? [state] : []
  };
  const service = createKickService({
    membershipRepository: { kickUser: async (guildId: string, userId: string, revoked: string[], actor: string) => {
      assert.equal(guildId, "guild"); assert.equal(userId, "target"); assert.deepEqual(revoked, ["manager"]); assert.equal(actor, "officer");
      events.push("block-and-revoke"); blocked = true; return [];
    }, listConfiguredRoleIdsForGuild: async () => ["member"] } as any,
    memberAccessRepository: access, kickRolesRepository: { listAuthorityRoleIds: async () => { if (options.authorityFailure) throw Error("authority query unavailable"); return ["manager"]; } },
    activityCleanup: { reconcileUser: async () => { events.push("activities"); return { warnings: [], pending: !!options.activityPending }; } },
    activityRepository: { hasPendingCleanup: async () => !!options.activityPending }
  });
  return { service, guild, events, roles, member, state, pending: () => pending, blocked: () => blocked };
}

test("kick blocks zero-registration users before Discord cleanup, removes all authority, and preserves unrelated roles", async () => {
  const f = fixture(); const result = await f.service.kickMember(f.guild, "target", "officer");
  assert.deepEqual(result.characters, []); assert.deepEqual(result.warnings, []);
  assert.equal(f.events[0], "block-and-revoke");
  assert.ok(f.events.indexOf("save-role-cleanup") < f.events.indexOf("remove:manager"));
  assert.deepEqual([...f.roles.keys()], ["unrelated"]);
  assert.ok(f.state.revokedRoleIds.includes("admin"));
  assert.equal(f.member.nickname, null); assert.equal(f.pending(), false); assert.equal(f.blocked(), true);
});

test("permission failures, uncertain absence, native ownership and activity work keep cleanup pending", async () => {
  for (const options of [{ roleFailure: true }, { fetchFailure: true }, { nicknameFailure: true }, { owner: true }, { activityPending: true }]) {
    const f = fixture(options); const result = await f.service.kickMember(f.guild, "target", "officer");
    assert.ok(result.warnings.length, JSON.stringify(options)); assert.equal(f.pending(), true);
    assert.equal(f.blocked(), true); assert.ok(!f.events.includes("complete"));
  }
});

test("definitive absence still performs conversation cleanup, while stale kick revisions cannot complete cleanup", async () => {
  const absent = fixture({ absent: true }); const result = await absent.service.kickMember(absent.guild, "target", "officer");
  assert.deepEqual(result.warnings, []); assert.ok(absent.events.includes("activities")); assert.equal(absent.pending(), false);
  const stale = fixture({ stale: true }); await stale.service.kickMember(stale.guild, "target", "officer");
  assert.equal(stale.pending(), true); assert.ok(!stale.events.includes("complete"));
});

test("the maintenance pass resumes stored cleanup without repeating kick mutations", async () => {
  const f = fixture({ activityPending: true }); await f.service.kickMember(f.guild, "target", "officer");
  await f.service.reconcileGuild(f.guild);
  assert.equal(f.events.filter(event => event === "block-and-revoke").length, 1);
  assert.equal(f.events.filter(event => event === "activities").length, 2);
});


test("completed blocked-user cleanup is rearmed before remote or configuration failure", async () => {
  for (const failure of ["fetchFailure", "authorityFailure"] as const) {
    const options: { fetchFailure?: boolean; authorityFailure?: boolean } = {};
    const f = fixture(options);
    await f.service.kickMember(f.guild, "target", "officer");
    assert.equal(f.pending(), false);
    f.events.length = 0;
    options[failure] = true;
    const warnings = await f.service.reconcileUser(f.guild, "target");
    assert.equal(f.pending(), true, failure);
    assert.equal(f.events[0], "save-role-cleanup", failure);
    assert.ok(warnings.length > 0, failure);
    assert.ok(!f.events.includes("complete"), failure);
  }
});

test("a failed final cleanup revision check reports pending instead of silent completion", async () => {
  const f = fixture({ completionStale: true });
  const result = await f.service.kickMember(f.guild, "target", "officer");
  assert.equal(f.pending(), true);
  assert.ok(result.warnings.some(warning => /changed before cleanup/.test(warning.message)));
});
