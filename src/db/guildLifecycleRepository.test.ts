import assert from "node:assert/strict";
import test from "node:test";
import { createGuildLifecycleRepository } from "./guildLifecycleRepository.js";

test("immediate guild purge deletes retained application and ticket data before deactivation", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    connect: async () => client
  } as unknown as Parameters<typeof createGuildLifecycleRepository>[0];

  await createGuildLifecycleRepository(pool).purgeGuildImmediately("guild-1");

  const normalizedSql = queries.map((query) => query.sql.replace(/\s+/g, " ").trim().toLowerCase());
  const openApplicationsIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from open_applications"));
  const applicationClassesIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from application_classes"));
  const ticketsIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from tickets"));
  const ticketClassesIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from ticket_classes"));
  const reactionSubscriptionsIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from reaction_role_subscriptions"));
  const reactionConfigsIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from reaction_role_configs"));
  const memberGroupsIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from member_groups"));
  const lifecycleIndex = normalizedSql.findIndex((sql) => sql.startsWith("delete from discord_guild_lifecycle"));

  assert.equal(normalizedSql[0], "begin");
  assert.match(normalizedSql[1] ?? "", /membership-lifecycle-tenant/);
  assert.match(normalizedSql[2] ?? "", /account_purge_in_progress/);
  assert.ok(openApplicationsIndex > 0);
  assert.ok(applicationClassesIndex > openApplicationsIndex);
  assert.ok(ticketsIndex > applicationClassesIndex);
  assert.ok(ticketClassesIndex > ticketsIndex);
  assert.ok(reactionSubscriptionsIndex > ticketClassesIndex);
  assert.ok(reactionConfigsIndex > reactionSubscriptionsIndex);
  assert.ok(memberGroupsIndex > ticketClassesIndex);
  assert.ok(lifecycleIndex > memberGroupsIndex);
  assert.equal(normalizedSql.at(-1), "commit");
  assert.deepEqual(queries[lifecycleIndex]?.values, ["guild-1"]);
  assert.equal(released, true);
});

test("immediate guild purge rolls back without deleting the lifecycle row after a data deletion failure", async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      queries.push(normalized);
      if (normalized.startsWith("delete from open_applications")) {
        throw new Error("application purge failed");
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    connect: async () => client
  } as unknown as Parameters<typeof createGuildLifecycleRepository>[0];

  await assert.rejects(
    createGuildLifecycleRepository(pool).purgeGuildImmediately("guild-1"),
    /application purge failed/
  );

  assert.equal(queries.at(-1), "rollback");
  assert.equal(
    queries.some((sql) => sql.startsWith("delete from discord_guild_lifecycle")),
    false
  );
  assert.equal(released, true);
});

test("queued inactive purge rechecks status after waiting and never opens a transaction while waiting", async () => {
  for (const stillDue of [false, true]) {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: sql.startsWith("select 1") && stillDue ? [{}] : [] }; }, release() {} };
    const pool = { query: async () => ({ rows: [{ discord_guild_id: "guild-1" }] }), connect: async () => { calls.push("connect"); return client; } } as never;
    const result = await createGuildLifecycleRepository(pool).purgeDueInactiveGuilds(async (guildId, operation) => {
      assert.equal(guildId, "guild-1");
      assert.deepEqual(calls, []);
      return operation();
    });
    assert.deepEqual(result, stillDue ? ["guild-1"] : []);
    assert.equal(calls.some(sql => sql.startsWith("delete from content_panel_messages")), stillDue);
    assert.equal(calls.at(-1), "commit");
  }
});
