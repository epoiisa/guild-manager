import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool, type PostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { CHARACTER_REGISTRATION_HISTORY_SCHEMA_SQL } from "./characterRegistrationHistorySchema.js";
import { createMembershipRepository } from "./membershipRepository.js";
import { createAccountRepository } from "./accountRepository.js";
import { createCharacterStatusRepository } from "./characterStatusRepository.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

// Explicit disposable localhost database only; never loads application credentials.
const url = process.env.MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL;

function testPool(): PostgresPool {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_membership_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  return createPostgresPool(url!);
}

interface Period {
  discord_user_id: string | null;
  registered_at: string;
  unregistered_at: string | null;
  started_us: string;
  ended_us: string | null;
}

// PostgreSQL text preserves microseconds that JavaScript Date would truncate.
const periodColumns = `discord_user_id, registered_at::text, unregistered_at::text,
  (extract(epoch from registered_at) * 1000000)::numeric(30, 0)::text as started_us,
  (extract(epoch from unregistered_at) * 1000000)::numeric(30, 0)::text as ended_us`;

test("registration history follows committed ownership changes without changing retained entitlements", { skip: !url }, async () => {
  const pool = testPool();
  const guild = `registration-history-${randomUUID()}`;
  const otherGuild = `${guild}-other`;
  const ids = ["member", "switch-from", "switch-to", "rapid", "race", "rollback", "history-only"].map(name => `${guild}-${name}`);
  const repo = createMembershipRepository(pool);
  const base = { discordGuildId: guild, discordUserId: "original", albionServer: "europe" as const };
  const input = (index: number, owner = base.discordUserId) => ({ ...base, discordUserId: owner, player: { id: ids[index], name: `History ${index}` } });
  const ref = { discordGuildId: guild, albionServer: "europe" as const, albionCharacterId: ids[0] };
  const history = async (id = ids[0], tenant = guild, server = "europe"): Promise<Period[]> => (
    await pool.query<Period>(`select ${periodColumns} from character_registration_history
      where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3 order by registered_at`, [tenant, server, id])
  ).rows;
  const registrationTime = async (id: string) => (await pool.query<{ registered_at: string }>(
    "select registered_at::text from discord_user_characters where discord_guild_id = $1 and albion_server = 'europe' and albion_character_id = $2", [guild, id]
  )).rows[0]?.registered_at;
  const cleanupTenant = async (tenant: string) => {
    const client = await pool.connect();
    try { await client.query("begin"); await purgeGuildOwnedData(client, tenant); await client.query("commit"); }
    catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  };

  try {
    await migrateDatabaseSchema(pool);
    const group = await repo.createGroup({ discordGuildId: guild, albionServer: "europe", groupName: "History group" });
    await repo.registerCharacter(input(0));
    await repo.addRegisteredProfile({ ...ref, discordUserId: "original", memberGroupId: group.memberGroupId });
    const accounts = createAccountRepository(pool);
    await accounts.adjust(ref, "credit", 4321n, "officer", "Retained balance");
    const accountBefore = (await accounts.getAccount(ref))!;
    const ledgerBefore = await accounts.listTransactions(accountBefore.accountId);
    const first = await history();
    assert.equal(first.length, 1);
    assert.equal(first[0].discord_user_id, "original");
    assert.equal(first[0].unregistered_at, null);
    assert.equal(first[0].registered_at, await registrationTime(ids[0]));

    await Promise.all([repo.registerCharacter(input(0)), repo.registerCharacter(input(0))]);
    await repo.setMainCharacter({ ...base, albionCharacterId: ids[0] });
    assert.deepEqual(await history(), first, "upserts and hierarchy changes do not create ownership periods");

    await repo.unregisterCharacter({ ...base, albionCharacterId: ids[0] });
    const unregistered = await history();
    assert.equal(unregistered.length, 1);
    assert.ok(unregistered[0].unregistered_at);
    assert.equal(unregistered[0].registered_at, first[0].registered_at);
    assert.equal((await accounts.getAccount(ref))?.balance, 4321n);
    await repo.registerCharacterAndAdoptOrphans(input(0, "returning"));
    const returned = await history();
    assert.equal(returned.length, 2);
    assert.equal(returned[1].discord_user_id, "returning");
    assert.equal(returned[1].unregistered_at, null);
    assert.ok(BigInt(returned[1].started_us) >= BigInt(returned[0].ended_us!));
    assert.equal((await accounts.getAccount(ref))?.accountId, accountBefore.accountId);
    assert.deepEqual(await accounts.listTransactions(accountBefore.accountId), ledgerBefore);

    const departure = await repo.beginDiscordDeparture(guild, "returning");
    assert.equal(departure.holds.length, 1);
    const held = await history();
    assert.equal(held.length, 2);
    assert.ok(held[1].unregistered_at, "departure closes ownership immediately, before grace expiry");
    const lifecycle = await repo.getRegistrationLifecycle(guild, "europe", ids[0]);
    const profiles = await repo.listProfilesForCharacter(guild, "europe", ids[0]);
    await repo.registerCharacterAndAdoptOrphans({ ...input(0, "replacement"), recovery: {
      expectedRegistrationRevision: lifecycle!.revision,
      expectedProfileRevisions: Object.fromEntries(profiles.map(profile => [profile.memberGroupId, profile.lifecycleRevision!])),
      verifiedMemberGroupIds: [], unavailableMemberGroupIds: []
    } });
    const recovered = await history();
    assert.equal(recovered.length, 3);
    assert.deepEqual(recovered.slice(0, 2), held, "recovery never rewrites closed periods");
    assert.equal(recovered[2].discord_user_id, "replacement");
    assert.equal(recovered[2].unregistered_at, null);
    assert.equal((await accounts.getAccount(ref))?.balance, 4321n);
    assert.deepEqual(await accounts.listTransactions(accountBefore.accountId), ledgerBefore);
    await repo.kickUser(guild, "replacement");
    assert.ok((await history())[2].unregistered_at, "kick closes the ownership period");

    await repo.registerCharacter(input(1));
    const beforeSwitch = (await history(ids[1]))[0];
    await repo.switchRegisteredCharacter({ ...base, fromAlbionServer: "europe", fromAlbionCharacterId: ids[1], toAlbionServer: "europe", player: input(2).player });
    const oldIdentity = await history(ids[1]);
    const newIdentity = await history(ids[2]);
    assert.equal(oldIdentity.length, 1);
    assert.ok(oldIdentity[0].unregistered_at);
    assert.equal(oldIdentity[0].registered_at, beforeSwitch.registered_at);
    assert.equal(newIdentity.length, 1);
    assert.equal(newIdentity[0].unregistered_at, null);
    assert.ok(BigInt(newIdentity[0].started_us) > BigInt(beforeSwitch.started_us));
    assert.equal(newIdentity[0].registered_at, await registrationTime(ids[2]), "switch stamps a new registration start");

    await repo.upsertVerifiedCharacter("europe", input(3).player);
    const rapid = await pool.connect();
    try {
      await rapid.query("begin");
      for (let i = 0; i < 3; i++) {
        await rapid.query("insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, 'rapid-owner', 'europe', $2)", [guild, ids[3]]);
        if (i < 2) await rapid.query("delete from discord_user_characters where discord_guild_id = $1 and albion_server = 'europe' and albion_character_id = $2", [guild, ids[3]]);
      }
      await rapid.query("commit");
    } catch (error) { await rapid.query("rollback"); throw error; }
    finally { rapid.release(); }
    const rapidPeriods = await history(ids[3]);
    assert.equal(rapidPeriods.length, 3, "same-transaction re-registration retains every period without timestamp collisions");
    assert.equal(rapidPeriods.filter(period => period.unregistered_at === null).length, 1);
    for (let i = 1; i < rapidPeriods.length; i++) {
      assert.ok(BigInt(rapidPeriods[i].started_us) > BigInt(rapidPeriods[i - 1].started_us));
      assert.ok(BigInt(rapidPeriods[i].started_us) >= BigInt(rapidPeriods[i - 1].ended_us!));
    }

    const competitors = await Promise.allSettled([repo.registerCharacter(input(4, "contender-a")), repo.registerCharacter(input(4, "contender-b"))]);
    assert.equal(competitors.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(competitors.filter(result => result.status === "rejected").length, 1);
    const racingHistory = await history(ids[4]);
    assert.equal(racingHistory.length, 1, "failed competing ownership leaves no historical registration");
    const winner = (await repo.listRegisteredCharacters(guild)).find(character => character.albionCharacterId === ids[4]);
    assert.equal(racingHistory[0].discord_user_id, winner?.discordUserId);

    await repo.upsertVerifiedCharacter("europe", input(5).player);
    const rollback = await pool.connect();
    try {
      await rollback.query("begin");
      await rollback.query("insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, 'rolled-back', 'europe', $2)", [guild, ids[5]]);
      await rollback.query("delete from discord_user_characters where discord_guild_id = $1 and albion_server = 'europe' and albion_character_id = $2", [guild, ids[3]]);
      await rollback.query("rollback");
    } finally { rollback.release(); }
    assert.deepEqual(await history(ids[5]), []);
    assert.deepEqual(await history(ids[3]), rapidPeriods, "rolled-back deletion does not close history");

    await repo.registerCharacter({ ...input(0, "other-tenant"), discordGuildId: otherGuild });
    await repo.registerCharacter({ ...input(0, "other-server"), albionServer: "asia" });
    assert.equal((await history(ids[0], otherGuild))[0].discord_user_id, "other-tenant");
    assert.equal((await history(ids[0], guild, "asia"))[0].discord_user_id, "other-server");
    assert.equal((await history())[2].discord_user_id, "replacement");

    await repo.registerCharacter(input(6));
    await repo.unregisterCharacter({ ...base, albionCharacterId: ids[6] });
    assert.equal((await repo.listProfilesForCharacter(guild, "europe", ids[6])).length, 0);
    assert.ok((await repo.listKnownCharactersForGuild(guild)).some(character => character.albionCharacterId === ids[6]), "a registration-only former character remains discoverable through history");
    const status = createCharacterStatusRepository(pool);
    assert.ok((await status.listCharacterStatusChoices(guild, "History 6")).some(character => character.albionCharacterId === ids[6]), "stored-status choices include history-only characters");
    assert.ok(await status.getCharacterStatus(guild, "europe", ids[6]));

    const otherHistory = await history(ids[0], otherGuild);
    await cleanupTenant(guild);
    assert.equal((await pool.query("select count(*)::int as count from character_registration_history where discord_guild_id = $1", [guild])).rows[0].count, 0);
    assert.deepEqual(await history(ids[0], otherGuild), otherHistory, "reset cannot remove another tenant's history");
  } finally {
    try {
      await cleanupTenant(guild);
      await cleanupTenant(otherGuild);
      await pool.query("delete from albion_characters where albion_character_id = any($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});

test("history migration preserves current starts and normalizes former records without inventing owners", { skip: !url }, async () => {
  const pool = testPool();
  const client = await pool.connect();
  const schema = `registration_history_upgrade_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("begin");
    await client.query(`create schema ${schema}`);
    await client.query(`set local search_path = ${schema}`);
    await client.query(`
      create table albion_characters (
        albion_server text not null, albion_character_id text not null,
        primary key (albion_server, albion_character_id));
      create table discord_user_characters (
        discord_guild_id text not null, discord_user_id text not null,
        albion_server text not null, albion_character_id text not null,
        registered_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        primary key (discord_guild_id, discord_user_id, albion_server, albion_character_id));
      create table member_group_profiles (
        discord_guild_id text, albion_server text, albion_character_id text, discord_user_id text,
        previous_discord_user_id text, entitlement_preserved boolean,
        lifecycle_state text check (lifecycle_state in ('current', 'manual', 'legacy', 'unregistered', 'departed')));
      create table member_registration_lifecycle (
        discord_guild_id text, albion_server text, albion_character_id text, previous_discord_user_id text,
        source text check (source in ('discord_departure', 'legacy_review', 'purge')),
        state text, detected_at timestamptz, expires_at timestamptz);
      create table character_accounts (discord_guild_id text, albion_server text, albion_character_id text, balance bigint);
      create table regear_claims (discord_guild_id text, albion_server text, albion_character_id text, original_submitter_discord_user_id text);
      create table specialisation_requests (discord_guild_id text, albion_server text, albion_character_id text, submitted_by_discord_user_id text);
      create table character_specialisations (discord_guild_id text, albion_server text, albion_character_id text, recorded_by_discord_user_id text);
      insert into albion_characters select 'europe', id from unnest(array[
        'current', 'known', 'unknown', 'roster', 'cache', 'account', 'claim', 'request', 'specialisation', 'held', 'purged'
      ]) id;
      insert into discord_user_characters values
        ('tenant', 'current-owner', 'europe', 'current', '2024-01-02T03:04:05.123456Z', now()),
        ('other-tenant', 'other-owner', 'europe', 'current', '2025-02-03T04:05:06.234567Z', now());
      insert into member_group_profiles values
        ('tenant', 'europe', 'current', 'current-owner', 'former-current', true, 'current'),
        ('tenant', 'europe', 'current', 'current-owner', 'current-owner', true, 'current'),
        ('tenant', 'europe', 'known', null, 'past-a', true, 'legacy'),
        ('tenant', 'europe', 'known', null, 'past-a', true, 'legacy'),
        ('tenant', 'europe', 'known', null, 'past-b', true, 'manual'),
        ('tenant', 'europe', 'unknown', null, null, true, 'legacy'),
        ('tenant', 'europe', 'roster', null, null, false, 'unregistered'),
        ('tenant', 'europe', 'purged', null, 'purged-owner', false, 'unregistered');
      insert into member_registration_lifecycle values
        ('tenant', 'europe', 'current', 'former-current', 'discord_departure', 'abandoned', '2023-06-07T08:09:10.234567Z', '2023-06-10T08:09:10.234567Z'),
        ('tenant', 'europe', 'held', 'held-owner', 'legacy_review', 'hold', '2026-09-30T01:02:03Z', '2026-10-03T01:02:03Z'),
        ('tenant', 'europe', 'known', 'past-a', 'discord_departure', 'abandoned', '2026-09-01T01:02:03Z', '2026-09-04T01:02:03Z'),
        ('tenant', 'europe', 'purged', 'purged-owner', 'purge', 'purged', now(), null);
      insert into character_accounts values
        ('tenant', 'europe', 'current', 1234), ('tenant', 'europe', 'known', 5678),
        ('tenant', 'europe', 'account', 9012), ('tenant', 'europe', 'purged', 0);
      insert into regear_claims values ('tenant', 'europe', 'claim', 'submitter-is-not-owner');
      insert into specialisation_requests values ('tenant', 'europe', 'request', 'submitter-is-not-owner');
      insert into character_specialisations values ('tenant', 'europe', 'specialisation', 'reviewer-is-not-owner');
    `);
    const originalRegistrations = (await client.query("select * from discord_user_characters order by discord_guild_id")).rows;
    const originalAccounts = (await client.query("select * from character_accounts order by albion_character_id")).rows;
    const originalDeadlines = (await client.query("select albion_character_id, state, detected_at, expires_at from member_registration_lifecycle order by albion_character_id")).rows;
    const departureTimes = new Map((await client.query<{ albion_character_id: string; detected_at: string }>(
      "select albion_character_id, detected_at::text from member_registration_lifecycle"
    )).rows.map(row => [row.albion_character_id, row.detected_at]));
    const periodQuery = async (id: string, tenant = "tenant") => (await client.query<Period>(
      `select ${periodColumns} from character_registration_history where discord_guild_id = $1 and albion_character_id = $2 order by registered_at`, [tenant, id]
    )).rows;

    await client.query(CHARACTER_REGISTRATION_HISTORY_SCHEMA_SQL);

    assert.deepEqual((await client.query("select * from discord_user_characters order by discord_guild_id")).rows, originalRegistrations);
    assert.deepEqual((await client.query("select * from character_accounts order by albion_character_id")).rows, originalAccounts);
    assert.deepEqual((await client.query("select albion_character_id, state, detected_at, expires_at from member_registration_lifecycle order by albion_character_id")).rows, originalDeadlines);
    assert.equal((await client.query("select count(*)::int as count from member_group_profiles where lifecycle_state = 'legacy'")).rows[0].count, 0);
    assert.equal((await client.query("select count(*)::int as count from member_group_profiles where lifecycle_state = 'manual'")).rows[0].count, 4);
    assert.equal((await client.query("select source from member_registration_lifecycle where albion_character_id = 'held'")).rows[0].source, "discord_departure");

    const current = await periodQuery("current");
    assert.equal(current.length, 2);
    assert.equal(current[0].discord_user_id, "former-current");
    assert.equal(current[0].unregistered_at, departureTimes.get("current"), "a known former owner's departure end before the current registration is preserved");
    assert.ok(BigInt(current[0].started_us) <= BigInt(current[0].ended_us!));
    assert.equal(current[1].discord_user_id, "current-owner");
    assert.equal(current[1].unregistered_at, null);
    assert.equal(current[1].started_us, "1704164645123456", "usable existing registration microseconds survive exactly");
    assert.ok(BigInt(current[0].started_us) < BigInt(current[1].started_us));
    const other = await periodQuery("current", "other-tenant");
    assert.equal(other.length, 1);
    assert.equal(other[0].discord_user_id, "other-owner");
    assert.equal(other[0].unregistered_at, null);

    const known = await periodQuery("known");
    assert.equal(known.length, 2, "the same former owner in multiple profiles and lifecycle data is not duplicated");
    assert.deepEqual(known.map(period => period.discord_user_id).sort(), ["past-a", "past-b"]);
    assert.equal(known.find(period => period.discord_user_id === "past-a")!.unregistered_at, departureTimes.get("known"), "known Discord departure end dates survive migration");
    assert.ok(known.every(period => BigInt(period.started_us) <= BigInt(period.ended_us!)));
    const otherFormerOwner = known.find(period => period.discord_user_id === "past-b")!;
    assert.equal(otherFormerOwner.registered_at, otherFormerOwner.unregistered_at, "another owner's departure time cannot be borrowed");
    for (const id of ["unknown", "account", "claim", "request", "specialisation"]) {
      const periods = await periodQuery(id);
      assert.equal(periods.length, 1, `${id} has one unknown-owner closed period`);
      assert.equal(periods[0].discord_user_id, null, `${id} does not invent ownership from actors or submitters`);
      assert.equal(periods[0].registered_at, periods[0].unregistered_at);
    }
    const held = await periodQuery("held");
    assert.equal(held.length, 1);
    assert.equal(held[0].discord_user_id, "held-owner");
    assert.ok(held[0].unregistered_at);
    assert.notEqual(held[0].unregistered_at, departureTimes.get("held"), "normalizing a review source does not turn its timestamp into a real Discord departure");
    for (const id of ["roster", "cache", "purged"]) assert.deepEqual(await periodQuery(id), [], `${id} does not generate registration history`);

    const columns = (await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = $1 and table_name = 'character_registration_history' order by ordinal_position", [schema]
    )).rows.map(row => row.column_name);
    assert.deepEqual(columns, ["discord_guild_id", "albion_server", "albion_character_id", "discord_user_id", "registered_at", "unregistered_at"]);
    const rejected = async (sql: string, code: string) => {
      await client.query("savepoint invalid_history");
      try { await assert.rejects(client.query(sql), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code); }
      finally { await client.query("rollback to savepoint invalid_history"); await client.query("release savepoint invalid_history"); }
    };
    await rejected("insert into character_registration_history values ('tenant', 'europe', 'current', 'duplicate', now(), null)", "23505");
    await rejected("insert into character_registration_history values ('tenant', 'europe', 'cache', null, now(), null)", "23514");
    await rejected("insert into character_registration_history values ('tenant', 'europe', 'cache', 'owner', now(), now() - interval '1 second')", "23514");
  } finally {
    try { await client.query("rollback"); }
    finally { client.release(); await pool.end(); }
  }
});
