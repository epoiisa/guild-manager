import assert from "node:assert/strict";
import test from "node:test";
import { createReviewerRepository } from "./reviewerRepository.js";

test("adding a reviewer preserves guild and domain scope with one role binding for all Albion Online servers", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const row = {
    reviewer_binding_id: "11111111-1111-4111-8111-111111111111", discord_guild_id: "guild-1",
    domain: "regears", discord_role_id: "role-1",
    created_by_discord_user_id: "admin-1", created_at: new Date()
  };
  const client = { query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows: [row], rowCount: 1 }; }, release: () => undefined };
  const repository = createReviewerRepository({ connect: async () => client } as never);
  const binding = await repository.addBinding("guild-1", "regears", "role-1", "admin-1");
  assert.equal(binding.discordGuildId, "guild-1");
  assert.equal(binding.domain, "regears");
  assert.equal("albionServer" in binding, false);
  const insert = calls.find(call => call.sql.includes("insert into reviewer_role_bindings"))!;
  assert.deepEqual(insert.values, ["guild-1", "regears", "role-1", "admin-1"]);
  assert.match(insert.sql, /on conflict \(discord_guild_id, domain, discord_role_id\)/);
  assert.doesNotMatch(insert.sql, /albion_server/);
});

test("effective reviewer roles cannot vary by Albion Online server or cross a guild/domain boundary", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const repository = createReviewerRepository({ query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values }); return { rows: [{ discord_role_id: "role-1" }, { discord_role_id: "role-2" }], rowCount: 2 };
  } } as never);
  assert.deepEqual(await repository.effectiveRoleIds("guild-1", "regears"), ["role-1", "role-2"]);
  assert.deepEqual(calls[0].values, ["guild-1", "regears"]);
  assert.match(calls[0].sql, /discord_guild_id = \$1 and domain = \$2/);
  assert.doesNotMatch(calls[0].sql, /albion_server/);
});

test("listing and removing reviewer roles retain the exact guild and system boundaries", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const repository = createReviewerRepository({ query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values }); return { rows: [], rowCount: 1 };
  } } as never);
  await repository.listBindings("guild-1", "specialisation");
  await repository.listBindings("guild-2");
  assert.equal(await repository.removeBinding("guild-1", "regears", "role-1", "admin-1"), true);
  assert.deepEqual(calls.map(call => call.values), [["guild-1", "specialisation"], ["guild-2", null], ["guild-1", "regears", "role-1"]]);
  assert.match(calls[2].sql, /discord_guild_id = \$1 and domain = \$2 and discord_role_id = \$3/);
  assert.ok(calls.every(call => !call.sql.includes("albion_server")));
});
