import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterStatusRepository } from './characterStatusRepository.js';
test('one tenant-safe read admits lifecycle/history only and preserves bigint', async () => {
  let calls = 0;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls++; assert.deepEqual(values, ['guild', 'asia', 'exact-id']); assert.doesNotMatch(sql, /\b(insert|update|delete|pg_advisory)\b/i);
    for (const table of ['member_registration_lifecycle','character_accounts','regear_claims','specialisation_requests','character_specialisations']) assert.ok(sql.includes(`from ${table} where discord_guild_id = $1`));
    assert.match(sql, /where c.albion_server = \$2 and c.albion_character_id = \$3/);
    return { rows: [{ character_name: 'Name', state: 'purged', account_status: 'closed', balance: '9007199254740993123', memberships: [], pending_regears: 0, pending_specialisations: 0 }] };
  } };
  const s = await createCharacterStatusRepository(pool as never).getCharacterStatus('guild','asia','exact-id');
  assert.equal(calls, 1); assert.equal(s?.registration, 'purged'); assert.equal(s?.account?.balance, 9007199254740993123n); assert.equal(s?.currentOwner, undefined); assert.equal(s?.expiresAt, undefined);
});
test('cache-only or stale exact identity yields no status', async () => {
  assert.equal(await createCharacterStatusRepository({ query: async () => ({ rows: [] }) } as never).getCharacterStatus('guild','asia','id'), undefined);
});
test('autocomplete uses guild evidence and literal search and bounds exact identities', async () => {
  await createCharacterStatusRepository({ query: async (sql: string, values: unknown[]) => {
    assert.deepEqual(values, ['guild', '%_']); assert.match(sql, /from evidence e join albion_characters/); assert.match(sql, /strpos/); assert.match(sql, /c.albion_server, c.albion_character_id limit 25/); assert.doesNotMatch(sql, /\b(insert|update|delete)\b/i); return { rows: [] };
  } } as never).listCharacterStatusChoices('guild','%_');
});
