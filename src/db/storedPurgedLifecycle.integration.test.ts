import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { MEMBERSHIP_PURGE_SCHEMA_SQL } from "./membershipLifecycleSchema.js";
import { createMembershipRepository, CharacterRecoveryRequiredError, MembershipLifecycleConflictError } from "./membershipRepository.js";
import { createAccountRepository } from "./accountRepository.js";
import { createRegearRepository } from "./regearRepository.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

const url = process.env.MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL;
test("stored purged registrations retain officer recovery and ordinary final-entitlement cleanup", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_membership_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `stored-purge-${randomUUID()}`, character = `${guild}-character`;
  const ref = { discordGuildId: guild, albionServer: "europe" as const, albionCharacterId: character };
  const registration = { discordGuildId: guild, discordUserId: "original", albionServer: "europe" as const, player: { id: character, name: "Entitlement Character" } };
  const membership = createMembershipRepository(pool), accounts = createAccountRepository(pool), regears = createRegearRepository(pool);
  const reviewerRoles = ["__guild_manager_discord_administrator__"];
  try {
    await migrateDatabaseSchema(pool);
    await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [guild]);
    const a = await membership.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-a`, albionGuildName: "A", managed: true });
    const b = await membership.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-b`, albionGuildName: "B", managed: false });
    await membership.upsertVerifiedCharacter(ref.albionServer, registration.player);
    // Fixture for records written before the character-purge command was retired.
    await pool.query(`insert into character_accounts (discord_guild_id, albion_server, albion_character_id, status, balance, closed_at)
      values ($1, $2, $3, 'closed', 0, now())`, [guild, ref.albionServer, character]);
    await pool.query(`insert into member_registration_lifecycle
      (discord_guild_id, albion_server, albion_character_id, previous_discord_user_id, source, state, detected_at, expires_at, purged_at)
      values ($1, $2, $3, 'original', 'purge', 'purged', now(), null, now())`, [guild, ref.albionServer, character]);
    const content = await regears.createContent({ discordGuildId: guild, albionServer: "europe", name: "Content", contentDate: "2026-09-28", channelId: "review", actorDiscordUserId: "reviewer", actorDiscordRoleIds: reviewerRoles });
    const marker = (await membership.getRegistrationLifecycle(guild, ref.albionServer, character))!;
    assert.equal(marker.state, 'purged'); assert.equal(marker.expiresAt, undefined); assert.ok(marker.purgedAt);
    assert.ok((await membership.listKnownCharactersForGuild(guild)).some(c => c.albionCharacterId === character));
    await assert.rejects(membership.registerCharacter(registration), CharacterRecoveryRequiredError);
    await assert.rejects(membership.registerCharacterAndAdoptOrphans({ ...registration, recovery: {
      expectedRegistrationRevision: null, expectedProfileRevisions: {},
      verifiedMemberGroupIds: [a.memberGroupId, b.memberGroupId], unavailableMemberGroupIds: []
    } }), MembershipLifecycleConflictError);
    // Roster observations cannot revive ownership or account entitlements.
    await membership.addOrphanProfile({ ...ref, memberGroupId: a.memberGroupId });
    assert.equal((await membership.listProfilesForCharacter(guild, ref.albionServer, character))[0].entitlementPreserved, false);
    assert.equal((await accounts.getAccount(ref))?.status, 'closed');
    await membership.addOrphanProfile({ ...ref, memberGroupId: b.memberGroupId });
    await membership.registerCharacterAndAdoptOrphans({ ...registration, discordUserId: 'fresh-owner', recovery: {
      expectedRegistrationRevision: marker.revision,
      expectedProfileRevisions: Object.fromEntries((await membership.listProfilesForCharacter(guild, ref.albionServer, character)).map(p => [p.memberGroupId, p.lifecycleRevision!])),
      verifiedMemberGroupIds: [a.memberGroupId], unavailableMemberGroupIds: [b.memberGroupId]
    } });
    assert.equal((await accounts.getAccount(ref))?.status, 'open', 'verified membership reopens the zero account');
    assert.equal((await accounts.getAccount(ref))?.balance, 0n);
    assert.deepEqual((await membership.listProfilesForCharacter(guild, ref.albionServer, character)).map(p => p.memberGroupId), [a.memberGroupId], 'unavailable observations are not adopted during recovery');
    // Deliberate custom-group removal preserves Pending work while another
    // membership qualifies, and expires it atomically on the last loss.
    const custom = await membership.createGroup({ discordGuildId: guild, albionServer: 'europe', groupName: 'Custom' });
    await membership.addRegisteredProfile({ ...ref, memberGroupId: custom.memberGroupId, discordUserId: 'fresh-owner' });
    const removalClaim = await regears.createPendingClaim({ ...ref, regearClaimId: randomUUID(), regearContentId: content.regearContentId,
      expectedOwnerDiscordUserId: 'fresh-owner', requestedValue: 25n, reviewChannelId: 'review', reviewMessageId: 'member-remove' });
    await membership.removeCustomGroupProfile({ ...ref, memberGroupId: custom.memberGroupId });
    assert.ok(await regears.getClaim(guild, removalClaim.regearClaimId));
    await membership.addRegisteredProfile({ ...ref, memberGroupId: custom.memberGroupId, discordUserId: 'fresh-owner' });
    const departed = await membership.markMembershipDeparted({ ...ref, memberGroupId: a.memberGroupId }, new Date('2020-01-01'));
    await membership.expireMembershipDeparture({ ...ref, memberGroupId: a.memberGroupId }, departed!.lifecycleRevision!, new Date('2020-01-10'));
    assert.ok(await regears.getClaim(guild, removalClaim.regearClaimId));
    await membership.removeCustomGroupProfile({ ...ref, memberGroupId: custom.memberGroupId });
    assert.equal(await regears.getClaim(guild, removalClaim.regearClaimId), undefined);
    assert.equal((await accounts.getAccount(ref))?.status, 'closed');
    await membership.addRegisteredProfile({ ...ref, memberGroupId: a.memberGroupId, discordUserId: 'fresh-owner' });
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("begin");
      await purgeGuildOwnedData(cleanupClient, guild);
      await cleanupClient.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [guild]);
      await cleanupClient.query("delete from albion_characters where albion_server = $1 and albion_character_id = $2", [ref.albionServer, character]);
      await cleanupClient.query("commit");
    } catch (error) {
      await cleanupClient.query("rollback");
      throw error;
    } finally { cleanupClient.release(); await pool.end(); }
  }
});

test("schema49 upgrades retained v48 lifecycles without inferred purges or changed deadlines", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_membership_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const client = await pool.connect();
  const fixtureSchema = 'purge_upgrade_' + randomUUID().replaceAll('-', '');
  try {
    await client.query('begin');
    await client.query(`create schema ${fixtureSchema}`);
    await client.query(`set local search_path = ${fixtureSchema}`);
    await client.query(`create table member_registration_lifecycle (
      discord_guild_id text not null, albion_server text not null, albion_character_id text not null,
      previous_discord_user_id text, source text not null check (source in ('discord_departure', 'legacy_review')),
      state text not null check (state in ('hold', 'abandoned')), detected_at timestamptz not null,
      expires_at timestamptz not null, abandoned_at timestamptz, revision bigint not null,
      check_failed_at timestamptz, primary key (discord_guild_id, albion_server, albion_character_id),
      check (expires_at = detected_at + interval '72 hours'));
      create table member_group_profiles (discord_guild_id text, albion_server text, albion_character_id text, entitlement_preserved boolean, lifecycle_state text);
      create table account_transactions (transaction_type text, amount bigint);
      insert into member_registration_lifecycle values
        ('tenant', 'europe', 'held', 'owner', 'discord_departure', 'hold', '2020-01-01', '2020-01-04', null, 42, null),
        ('tenant', 'europe', 'abandoned', 'owner', 'legacy_review', 'abandoned', '2020-02-01', '2020-02-04', '2020-02-05', 43, '2020-02-06');
      insert into member_group_profiles values ('tenant', 'europe', 'legacy', true, 'legacy');
      insert into account_transactions values ('purge_adjustment', -100);`);
    const retained = () => client.query('select discord_guild_id, albion_character_id, previous_discord_user_id, source, state, detected_at, expires_at, abandoned_at, revision, check_failed_at from member_registration_lifecycle order by albion_character_id');
    const before = (await retained()).rows;
    await client.query(MEMBERSHIP_PURGE_SCHEMA_SQL);
    assert.deepEqual((await retained()).rows, before);
    assert.equal((await client.query("select count(*)::int as total from member_registration_lifecycle where state = 'purged'")).rows[0].total, 0);
    assert.equal((await client.query('select * from member_group_profiles')).rows[0].lifecycle_state, 'legacy');
    assert.equal((await client.query('select * from account_transactions')).rows[0].amount, '-100');
    await client.query("insert into member_registration_lifecycle (discord_guild_id, albion_server, albion_character_id, source, state, detected_at, expires_at, purged_at, revision) values ('tenant', 'europe', 'purged', 'purge', 'purged', now(), null, now(), 44)");
    await client.query("insert into member_group_profiles values ('tenant', 'europe', 'purged', true, 'current')");
    assert.equal((await client.query("select character_has_preserved_membership('tenant', 'europe', 'purged') as preserved")).rows[0].preserved, false);
    for (const change of ["expires_at = detected_at + interval '72 hours'", "purged_at = null", "source = 'discord_departure'", "abandoned_at = now()"]) {
      await client.query('savepoint invalid_marker');
      await assert.rejects(client.query(`update member_registration_lifecycle set ${change} where albion_character_id = 'purged'`), (error: unknown) => (error as {code?: string}).code === '23514');
      await client.query('rollback to savepoint invalid_marker');
    }
  } finally {
    await client.query('rollback'); client.release(); await pool.end();
  }
});
