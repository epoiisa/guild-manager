import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMembershipRepository } from "./membershipRepository.js";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";
import { withLogChanges, type LogChange } from "../services/logFeed/events.js";

const url = process.env.LOG_FEED_TEST_DATABASE_URL;
test("confirmed membership capture executes against disposable PostgreSQL, including concurrent no-ops and cascades", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_log_feed_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `membership-log-${randomUUID()}`;
  const user = "log-member";
  const ids = ["one", "two", "three"].map(value => `${guild}-${value}`);
  const base = { discordGuildId: guild, discordUserId: user, albionServer: "europe" as const };
  const input = (index: number) => ({ ...base, player: { id: ids[index], name: `Character ${index + 1}` } });
  const repo = createMembershipRepository(pool);
  async function capture(operation: () => Promise<unknown>): Promise<LogChange[]> {
    return withLogChanges(guild, async changes => { await operation(); return changes; });
  }
  try {
    await migrateDatabaseSchema(pool);
    const group = await repo.createGroup({ discordGuildId: guild, albionServer: "europe", groupName: "Test Group" });
    const profile = { ...base, memberGroupId: group.memberGroupId, albionCharacterId: ids[0] };
    assert.equal((await capture(() => repo.registerCharacter(input(0)))).length, 1);
    assert.deepEqual(await capture(() => repo.registerCharacter(input(0))), []);
    const concurrent = await Promise.all([capture(() => repo.addRegisteredProfile(profile)), capture(() => repo.addRegisteredProfile(profile))]);
    assert.equal(concurrent.flat().length, 1);
    assert.equal((concurrent.flat()[0] as Extract<LogChange, {kind:"profile"}>).profile.characterName, "Character 1");
    const unregistered = await capture(() => repo.unregisterCharacter({ ...base, albionCharacterId: ids[0] }));
    assert.deepEqual(unregistered.map(change => change.kind), ["registration", "profile"]);
    assert.equal((unregistered[1] as Extract<LogChange, {kind:"profile"}>).action, "orphaned");
    assert.deepEqual(await capture(() => repo.unregisterCharacter({ ...base, albionCharacterId: ids[0] })), []);
    const adopted = await capture(() => repo.registerCharacterAndAdoptOrphans(input(0)));
    assert.deepEqual(adopted.map(change => change.kind), ["registration", "profile"]);
    assert.deepEqual(await capture(() => repo.registerCharacterAndAdoptOrphans(input(0))), []);
    const removed = await capture(() => repo.removeCustomGroupProfile(profile));
    assert.equal((removed[0] as Extract<LogChange, {kind:"profile"}>).action, "left");
    assert.deepEqual(await capture(() => repo.removeCustomGroupProfile(profile)), []);
    await repo.addRegisteredProfile(profile);
    const orphaned = await capture(() => repo.orphanProfilesNotInCharacterIds(guild, group.memberGroupId, "europe", []));
    assert.equal(orphaned.length, 1);
    assert.equal((orphaned[0] as Extract<LogChange, {kind:"profile"}>).profile.discordUserId, user);
    assert.deepEqual(await capture(() => repo.orphanProfilesNotInCharacterIds(guild, group.memberGroupId, "europe", [])), []);
    await repo.addRegisteredProfile(profile);
    const switched = await capture(() => repo.switchRegisteredCharacter({ discordGuildId: guild, discordUserId: user,
      fromAlbionServer: "europe", fromAlbionCharacterId: ids[0], toAlbionServer: "europe", player: input(1).player }));
    assert.deepEqual(switched.map(change => change.kind), ["switch"]);
    const kicked = await capture(() => repo.kickUser(guild, user));
    assert.deepEqual(kicked.map(change => change.kind), ["memberBlocked", "registration", "profile"]);
    await repo.upsertVerifiedCharacter("europe", input(2).player);
    const orphan = { ...profile, albionCharacterId: ids[2] };
    assert.equal((await capture(() => repo.addOrphanProfile(orphan))).length, 1);
    assert.deepEqual(await capture(() => repo.addOrphanProfile(orphan)), []);
    assert.ok((await pool.query("select discovered_at from member_group_profiles where member_group_id = $1", [group.memberGroupId])).rows[0].discovered_at);
    const removedGroup = await capture(() => repo.removeMemberGroup({ discordGuildId: guild, memberGroupId: group.memberGroupId, archivedByDiscordUserId: user }));
    assert.equal((removedGroup[0] as Extract<LogChange, {kind:"groupRemoved"}>).result.totalMembershipProfiles, 1);
    assert.deepEqual(await capture(() => repo.removeMemberGroup({ discordGuildId: guild, memberGroupId: group.memberGroupId, archivedByDiscordUserId: user })), []);
    const auto = await repo.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-configured`, albionGuildName: "Test Guild", managed: false });
    const access = (await repo.getMemberAccess(guild, user))!;
    assert.equal(await repo.markKickCleanupComplete(guild, user, access.revision), true);
    await repo.registerCharacterAndAdoptOrphans({ ...input(0), recovery: {
      expectedRegistrationRevision: null, expectedProfileRevisions: {}, verifiedMemberGroupIds: [], unavailableMemberGroupIds: [],
      ...await repo.getKickRecoverySnapshot(guild, user, "europe", ids[0])
    } });
    await repo.addRegisteredProfile({ ...profile, memberGroupId: auto.memberGroupId });
    const autoOrphan = await capture(() => repo.orphanAutoProfilesForCharacter(guild, "europe", ids[0], [auto.memberGroupId], []));
    assert.equal(autoOrphan.length, 1);
    assert.equal((autoOrphan[0] as Extract<LogChange, {kind:"profile"}>).profile.groupName, "Test Guild");
  } finally {
    await purgeGuildOwnedData(pool, guild);
    await pool.query("delete from albion_characters where albion_character_id = any($1::text[])", [ids]);
    await pool.end();
  }
});
