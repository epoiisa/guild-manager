import assert from "node:assert/strict";
import test from "node:test";
import { createContentPanelRepository } from "./contentPanelRepository.js";

function fake(respond: (sql: string, values?: unknown[]) => unknown[]) {
  const calls: string[] = [];
  let released = false;
  const client = { query: async (sql: string, values?: unknown[]) => { calls.push(sql); return { rows: respond(sql, values) }; }, release: () => { released = true; } };
  return { pool: { ...client, connect: async () => client } as unknown as Parameters<typeof createContentPanelRepository>[0], calls, released: () => released };
}
const input = { discordGuildId: "g", discordChannelId: "c", configurationRevision: "rev", generation: "next", previousGeneration: "old", renderHash: "hash", now: new Date() };

test("publication cannot begin after configuration deletion and releases transaction", async () => {
  const f = fake(() => []);
  assert.equal(await createContentPanelRepository(f.pool).beginPublication(input), undefined);
  assert.equal(f.calls.some(sql => sql.includes("insert into")), false);
  assert.equal(f.calls.at(-1), "commit");
  assert.equal(f.released(), true);
});
test("publication commit rejects stale config and wrong canonical without retiring the working panel", async () => {
  for (const scenario of ["missing", "revision", "channel", "canonical"]) {
    const f = fake(sql => {
      if (sql.includes("from content_channel_configs")) return scenario === "missing" ? [] : [{ configuration_revision: scenario === "revision" ? "new" : "rev", discord_channel_id: scenario === "channel" ? "new" : "c" }];
      if (sql.includes("state = 'pending'")) return [{ configuration_revision: "rev", discord_channel_id: "c", previous_generation: "old" }];
      if (sql.includes("state = 'current'")) return [{ generation: "other" }];
      return [];
    });
    assert.equal(await createContentPanelRepository(f.pool).commitPublication("g", "next", "m"), false);
    assert.equal(f.calls.some(sql => sql.startsWith("update")), false);
  }
});
test("successful publication retires previous generation and promotes pending in the same transaction", async () => {
  const f = fake(sql => {
    if (sql.includes("from content_channel_configs")) return [{ configuration_revision: "rev", discord_channel_id: "c" }];
    if (sql.startsWith("select *")) return [{ configuration_revision: "rev", discord_channel_id: "c", previous_generation: "old" }];
    if (sql.startsWith("select generation")) return [{ generation: "old" }];
    return [];
  });
  assert.equal(await createContentPanelRepository(f.pool).commitPublication("g", "next", "m"), true);
  assert.equal(f.calls[0], "begin");
  assert.match(f.calls[4], /state = 'retired'/);
  assert.match(f.calls[5], /state = 'current', message_id/);
  assert.equal(f.calls[6], "commit");
});
test("aggregate query separates counts, scopes every join, and excludes expired or terminal parties and standby", async () => {
  const f = fake(() => []);
  await createContentPanelRepository(f.pool).listPanelContent("g", "c", input.now);
  const sql = f.calls[0];
  assert.match(sql, /source_channel_id = \$2/);
  assert.match(sql, /state in \('scheduled', 'unscheduled', 'active'\)/);
  assert.match(sql, /end\) > \$3/);
  assert.match(sql, /count\(distinct s.content_role_slot_id\)/);
  assert.match(sql, /s.state = 'active' and s.signup_type = 'role'/);
  assert.match(sql, /r.content_id = s.content_id and r.content_role_slot_id = s.content_role_slot_id/);
  assert.match(sql, /left join slots using \(discord_guild_id, content_id\)/);
  assert.match(sql, /left join filled using \(discord_guild_id, content_id\)/);
});
test("nonce validation rejects oversized tokens before any write", async () => {
  const f = fake(() => []);
  await assert.rejects(createContentPanelRepository(f.pool).beginPublication({ ...input, generation: "a".repeat(26) }), /Invalid/);
  assert.equal(f.calls.length, 0);
});
