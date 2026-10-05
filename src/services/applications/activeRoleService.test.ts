import assert from "node:assert/strict";
import test from "node:test";
import { reconcileApplicationActiveRole } from "./activeRoleService.js";
import { reconcileDeletedApplicationChannel } from "./channelDeletionService.js";
import { deleteApplicationChannel } from "./deleteService.js";
import { withdrawApplication } from "./withdrawService.js";
import { ChannelType } from "discord.js";

function fixture() {
  const roles = new Set(["applicant", "unrelated"]);
  let qualified: string[] = [];
  let failure: "fetch" | "query" | "remove" | undefined;
  const changes: string[] = [];
  const member = { roles: { cache: roles,
    add: async (id: string) => { changes.push(`add:${id}`); roles.add(id); },
    remove: async (id: string) => { if (failure === "remove") throw Error("Missing permissions"); changes.push(`remove:${id}`); roles.delete(id); }
  } };
  const guild = { id: "guild", members: { fetch: async () => { if (failure === "fetch") throw Error("fetch unavailable"); return member; } } } as any;
  const state = { applicationId: "application", applicationClassId: "class", applicantDiscordUserId: "user", ticketChannelId: "channel", status: "open", channelStatus: "open" };
  const application = { activeRoleId: "applicant", reviewerRoleId: "reviewer" };
  const repo = {
    listQualifiedRoleIdsForUser: async (guildId: string, userId: string) => { assert.deepEqual([guildId, userId], ["guild", "user"]); if (failure === "query") throw Error("query unavailable"); return qualified; },
    getOpenApplication: async () => state,
    getApplicationClass: async () => application,
    markApplicationChannelDeleted: async () => { state.channelStatus = "deleted"; return state; },
    markApplicationDeleted: async () => { state.channelStatus = "deleted"; return state; },
    markApplicationWithdrawn: async () => { state.status = "withdrawn"; return state; }
  };
  return { guild, repo, application, state, roles, changes,
    required: (values: string[]) => { qualified = values; },
    fail: (value: typeof failure) => { failure = value; },
    sync: () => reconcileApplicationActiveRole(guild, repo, application, "user") };
}

test("cleanup preserves shared entitlements and unrelated roles, and repeated cleanup is harmless", async () => {
  const f = fixture(); f.required(["applicant"]);
  assert.deepEqual(await f.sync(), []); assert.deepEqual(f.changes, []);
  f.required([]); assert.deepEqual(await f.sync(), []);
  assert.deepEqual([...f.roles], ["unrelated"]);
  assert.deepEqual(await f.sync(), []); assert.deepEqual(f.changes, ["remove:applicant"]);
  f.required(["applicant"]); assert.deepEqual(await f.sync(), []);
  assert.deepEqual(f.changes, ["remove:applicant", "add:applicant"]);
});

for (const failure of ["fetch", "query", "remove"] as const) {
  test(`failed ${failure} preserves the role and is recoverable on reconciliation`, async () => {
    const f = fixture(); f.fail(failure);
    assert.equal((await f.sync()).length, 1); assert.ok(f.roles.has("applicant"));
    f.fail(undefined); assert.deepEqual(await f.sync(), []); assert.ok(!f.roles.has("applicant"));
  });
}

test("concurrent removal and new entitlement converge using fresh queued state", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const member = await f.guild.members.fetch();
  const remove = member.roles.remove;
  member.roles.remove = async (id: string) => { entered(); await gate; await remove(id); };
  const removing = f.sync(); await started;
  f.required(["applicant"]); const restoring = f.sync(); release();
  await Promise.all([removing, restoring]);
  assert.ok(f.roles.has("applicant")); assert.deepEqual(f.changes, ["remove:applicant", "add:applicant"]);
});

test("direct channel deletion marks the retained state before cleanup and reports failure for later recovery", async () => {
  const f = fixture(); f.state.status = "awaiting_ingame_membership"; f.fail("remove");
  const result = await reconcileDeletedApplicationChannel(f.guild, "channel", f.repo as any);
  assert.equal(result.application?.channelStatus, "deleted"); assert.equal(result.warnings.length, 1);
  f.fail(undefined); await f.sync(); assert.ok(!f.roles.has("applicant"));
});

test("bot deletion preserves its completed lifecycle when role cleanup fails", async () => {
  const f = fixture(); f.state.status = "accepted"; f.state.channelStatus = "closed"; f.fail("remove");
  let deleted = false;
  const result = await deleteApplicationChannel({ guild: f.guild, guildId: "guild", applicationId: "application", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, applicationRepository: f.repo as any, channel: { id: "channel", type: ChannelType.GuildText, name: "application", delete: async () => { deleted = true; } } as any });
  assert.equal(result.kind, "deleted"); assert.equal(f.state.channelStatus, "deleted"); assert.ok(deleted);
  if (result.kind === "deleted") assert.equal(result.warnings?.length, 1);
});

test("withdrawal reports failed cleanup without repeating its decision on retry", async () => {
  const f = fixture(); f.fail("remove");
  const input = { guild: f.guild, guildId: "guild", applicationId: "application", applicantDiscordUserId: "user", application: f.application as any, applicationRepository: f.repo as any };
  const result = await withdrawApplication(input);
  assert.equal(result.kind, "withdrawn"); assert.equal(f.state.status, "withdrawn");
  if (result.kind === "withdrawn") assert.equal(result.warnings.length, 1);
  assert.equal((await withdrawApplication(input)).kind, "error");
  f.fail(undefined); await f.sync(); assert.ok(!f.roles.has("applicant"));
});
