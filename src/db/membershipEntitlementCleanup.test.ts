import assert from "node:assert/strict";
import test from "node:test";
import { expireCharacterEntitlements } from "./membershipEntitlementCleanup.js";

const ref = { discordGuildId: "guild", albionServer: "asia" as const, albionCharacterId: "character" };

test("another preserved membership prevents all pending-entitlement deletion", async () => {
  const calls: string[] = [];
  const queryable = { query: async (sql: string) => {
    calls.push(sql);
    return { rows: sql.includes("character_has_preserved_membership") ? [{ preserved: true }] : [] };
  } };
  assert.deepEqual(await expireCharacterEntitlements(queryable as never, ref), { removedRegears: 0, removedSpecialisations: 0 });
  assert.equal(calls.some(sql => /delete|insert/.test(sql)), false);
});

test("final expiry atomically queues proof deletion from deleted Pending rows while leaving permanent history", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const queryable = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("character_has_preserved_membership")) return { rows: [{ preserved: false }] };
    return { rows: [{ removed_count: sql.includes("delete from regear_claims") ? "2" : "1" }] };
  } };
  assert.deepEqual(await expireCharacterEntitlements(queryable as never, ref), { removedRegears: 2, removedSpecialisations: 1 });
  const deletes = calls.filter(call => call.sql.includes("delete from"));
  assert.equal(deletes.length, 2);
  assert.match(deletes[0].sql, /status = 'pending'/);
  assert.match(deletes[1].sql, /state = 'pending'/);
  assert.ok(deletes.every(call => call.sql.includes("insert into membership_evidence_cleanup") && call.sql.includes("from removed")));
  assert.ok(calls.every(call => JSON.stringify(call.values) === JSON.stringify(["guild", "asia", "character"])));
  assert.equal(calls.some(call => /account_transactions|character_specialisations/.test(call.sql)), false);
});
