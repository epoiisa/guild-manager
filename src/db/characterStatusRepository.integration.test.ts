import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from './postgres.js';
import { migrateDatabaseSchema } from './schema.js';
import { createCharacterStatusRepository } from './characterStatusRepository.js';
import { createMembershipRepository } from './membershipRepository.js';
import { purgeGuildOwnedData } from './guildDataPurge.js';
const url = process.env.MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL;
test('status SQL resolves lifecycle-only, history-only, exact servers, appointments and excludes cache/other tenant without writes', { skip: !url }, async () => {
  const target = new URL(url!); assert.equal(target.pathname, '/guild_manager_membership_test'); assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname));
  const pool = createPostgresPool(url!); const guild = `status-${randomUUID()}`, other = `${guild}-other`;
  const repo = createCharacterStatusRepository(pool), membership = createMembershipRepository(pool);
  try {
    await migrateDatabaseSchema(pool);
    for (const [server,id] of [['asia','held'],['europe','held'],['asia','purged'],['asia','history'],['asia','cache'],['asia','other'],['asia','kicked']]) {
      await pool.query('insert into albion_characters(albion_server,albion_character_id,character_name) values($1,$2,$3)', [server,`${guild}-${id}`,'SameName']);
    }
    await pool.query("insert into member_registration_lifecycle(discord_guild_id,albion_server,albion_character_id,source,state,detected_at,expires_at) values($1,'asia',$2,'discord_departure','hold',now(),now()+interval '72 hours')", [guild,`${guild}-held`]);
    await pool.query("insert into member_registration_lifecycle(discord_guild_id,albion_server,albion_character_id,source,state,detected_at,expires_at,purged_at) values($1,'asia',$2,'purge','purged',now(),null,now())", [guild,`${guild}-purged`]);
    await pool.query("insert into character_accounts(discord_guild_id,albion_server,albion_character_id,status,balance) values($1,'asia',$2,'closed',0)", [guild,`${guild}-history`]);
    await pool.query("insert into guild_member_access(discord_guild_id,discord_user_id) values($1,'kicked-owner')", [guild]);
    await pool.query("insert into character_kick_recovery(discord_guild_id,albion_server,albion_character_id,disconnected_discord_user_id) values($1,'asia',$2,'kicked-owner')", [guild,`${guild}-kicked`]);
    await pool.query("insert into discord_user_characters(discord_guild_id,discord_user_id,albion_server,albion_character_id) values($1,'elsewhere','asia',$2)", [other,`${guild}-other`]);
    await membership.registerCharacter({ discordGuildId: guild, discordUserId: 'owner', albionServer: 'europe', player: { id: `${guild}-held`, name: 'SameName' } });
    const group = await membership.createGroup({ discordGuildId: guild, albionServer: 'europe', groupName: 'Custom' });
    await membership.addRegisteredProfile({ discordGuildId: guild, discordUserId: 'owner', albionServer: 'europe', albionCharacterId: `${guild}-held`, memberGroupId: group.memberGroupId });
    const profile = (await membership.listProfilesForCharacter(guild,'europe',`${guild}-held`))[0]!;
    const position = await pool.query("insert into member_group_positions(discord_guild_id,member_group_id,name,discord_role_id) values($1,$2,'Leader','role') returning member_group_position_id", [guild,group.memberGroupId]);
    await pool.query('insert into member_group_position_appointments(discord_guild_id,member_group_position_id,member_group_profile_id) values($1,$2,$3)', [guild,position.rows[0].member_group_position_id,profile.memberGroupProfileId]);
    const held = await repo.getCharacterStatus(guild,'asia',`${guild}-held`); assert.equal(held?.registration,'hold'); assert.equal(held?.formerOwner,undefined); assert.equal(held?.memberships.length,0);
    const purged = await repo.getCharacterStatus(guild,'asia',`${guild}-purged`); assert.equal(purged?.registration,'purged'); assert.equal(purged?.expiresAt,undefined); assert.ok(purged?.purgedAt);
    assert.equal((await repo.getCharacterStatus(guild,'asia',`${guild}-history`))?.account?.status,'closed');
    const owned = await repo.getCharacterStatus(guild,'europe',`${guild}-held`); assert.equal(owned?.currentOwner,'owner'); assert.equal(owned?.memberships[0]?.appointments[0]?.name,'Leader'); assert.ok(owned?.memberships[0]?.appointments[0]?.appointedAt);
    for (const id of ['cache','other']) assert.equal(await repo.getCharacterStatus(guild,'asia',`${guild}-${id}`), undefined);
    const kicked = await repo.getCharacterStatus(guild,'asia',`${guild}-kicked`);
    assert.equal(kicked?.registration, 'kicked'); assert.equal(kicked?.formerOwner, 'kicked-owner'); assert.equal(kicked?.kickCleanupPending, true);
    assert.equal(kicked?.source, 'kick'); assert.equal(kicked?.currentOwner, undefined);
    const choices = await repo.listCharacterStatusChoices(guild,'SameName'); assert.equal(choices.length,5); assert.equal(choices.filter(c => c.albionCharacterId === `${guild}-held`).length,2);
    // Enforce read-only SQL at PostgreSQL itself, exercising both queries on an actual snapshot.
    const client = await pool.connect();
    try { await client.query('begin read only'); const read = createCharacterStatusRepository(client as never); assert.ok(await read.getCharacterStatus(guild,'europe',`${guild}-held`)); await read.listCharacterStatusChoices(guild,'SameName'); await client.query('rollback'); }
    finally { client.release(); }
  } finally { await purgeGuildOwnedData(pool,guild); await purgeGuildOwnedData(pool,other); await pool.query('delete from albion_characters where albion_character_id like $1', [`${guild}-%`]); await pool.end(); }
});
