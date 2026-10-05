import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationRepository } from "./applicationRepository.js";
import type { PostgresPool } from "./postgres.js";
import { createTicketRepository } from "./ticketRepository.js";

test("manual application channel deletion marks any retained lifecycle state deleted", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = createCapturingPool(calls);

  await createApplicationRepository(pool).markApplicationChannelDeleted("guild-id", "channel-id");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /update open_applications/);
  assert.match(calls[0].sql, /ticket_channel_id = \$2/);
  assert.match(calls[0].sql, /channel_status <> 'deleted'/);
  assert.deepEqual(calls[0].values, ["guild-id", "channel-id"]);
});

test("manual general ticket channel deletion marks any retained lifecycle state deleted", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = createCapturingPool(calls);

  await createTicketRepository(pool).markTicketChannelDeleted("guild-id", "channel-id");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /update tickets/);
  assert.match(calls[0].sql, /ticket_channel_id = \$2/);
  assert.match(calls[0].sql, /status <> 'deleted'/);
  assert.deepEqual(calls[0].values, ["guild-id", "channel-id"]);
});

test("application deletion records an actor after direct channel reconciliation", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = createCapturingPool(calls);

  await createApplicationRepository(pool).markApplicationDeleted("guild-id", "application-id", "reviewer-id");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /channel_status in \('closed', 'deleted'\)/);
  assert.match(calls[0].sql, /deleted_by_discord_user_id=coalesce\(deleted_by_discord_user_id, \$3\)/);
  assert.match(calls[0].sql, /returning \*/);
  assert.deepEqual(calls[0].values, ["guild-id", "application-id", "reviewer-id"]);
});

test("general ticket deletion records an actor after direct channel reconciliation", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = createCapturingPool(calls);

  await createTicketRepository(pool).markTicketDeleted("guild-id", "ticket-id", "reviewer-id");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /status in \('closed', 'deleted'\)/);
  assert.match(calls[0].sql, /deleted_by_discord_user_id=coalesce\(deleted_by_discord_user_id, \$3\)/);
  assert.match(calls[0].sql, /returning \*/);
  assert.deepEqual(calls[0].values, ["guild-id", "ticket-id", "reviewer-id"]);
});

function createCapturingPool(calls: Array<{ sql: string; values: unknown[] }>): PostgresPool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [] };
    }
  } as unknown as PostgresPool;
}
