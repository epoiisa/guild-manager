import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { createMembershipRepository, CharacterRecoveryRequiredError, MembershipLifecycleConflictError } from "./membershipRepository.js";
import { MemberAccessBlockedError, KickCleanupPendingError } from "./memberAccessRepository.js";
import { createAccountRepository } from "./accountRepository.js";
import { createRegearRepository } from "./regearRepository.js";
import { createSpecialisationRepository } from "./specialisationRepository.js";
import { expireCharacterEntitlements } from "./membershipEntitlementCleanup.js";
import { catalogueByKey } from "../services/specialisations/catalogue.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

const url = process.env.MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL;
async function fixture() {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_membership_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `kick-${randomUUID()}`, otherGuild = `${guild}-other`;
  const ids = Array.from({ length: 8 }, (_, i) => `${guild}-${i}`);
  const membership = createMembershipRepository(pool);
  const input = (index = 0, user = "original", tenant = guild) => ({ discordGuildId: tenant,
    discordUserId: user, albionServer: "europe" as const, player: { id: ids[index], name: `Kick Character ${index}` } });
  const ref = (index = 0, tenant = guild) => ({ discordGuildId: tenant, albionServer: "europe" as const, albionCharacterId: ids[index] });
  const recovery = async (index = 0, user = "original", groups: string[] = []) => ({ ...input(index, user), recovery: {
    expectedRegistrationRevision: null, expectedProfileRevisions: {}, verifiedMemberGroupIds: groups, unavailableMemberGroupIds: [],
    ...await membership.getKickRecoverySnapshot(guild, user, "europe", ids[index])
  } });
  const clean = async (user = "original") => {
    const access = (await membership.getMemberAccess(guild, user))!;
    assert.equal(await membership.markKickCleanupComplete(guild, user, access.revision), true);
  };
  await migrateDatabaseSchema(pool);
  for (const tenant of [guild, otherGuild]) await pool.query(
    "insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [tenant]);
  return { pool, guild, otherGuild, ids, membership, input, ref, recovery, clean, close: async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const tenant of [guild, otherGuild]) await purgeGuildOwnedData(client, tenant);
      await client.query("delete from albion_characters where albion_character_id = any($1::text[])", [ids]);
      await client.query("commit");
    } finally { client.release(); await pool.end(); }
  } };
}

test("kick preserves character financial and specialisation records, revokes memberships and requires fenced officer recovery", { skip: !url }, async () => {
  const f = await fixture();
  const { pool, guild, membership: m, ref, input } = f;
  const accounts = createAccountRepository(pool), regears = createRegearRepository(pool), specs = createSpecialisationRepository(pool);
  const reviewerRoles = ["__guild_manager_discord_administrator__"];
  try {
    const automatic = await m.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-a`, albionGuildName: "Automatic", managed: true });
    const custom = await m.createGroup({ discordGuildId: guild, albionServer: "europe", groupName: "Custom" });
    await m.addMemberGroupRoleConfig(automatic.memberGroupId, "normal-role");
    await m.addMemberGroupRoleConfig(automatic.memberGroupId, "authority-overlap");
    await m.registerCharacter(input());
    for (const group of [automatic, custom]) await m.addRegisteredProfile({ ...ref(), memberGroupId: group.memberGroupId, discordUserId: "original" });
    const position = (await m.createGroupPosition({ discordGuildId: guild, memberGroupId: automatic.memberGroupId, name: "Officer", discordRoleId: "authority-overlap" }))!;
    const profile = (await m.listProfilesForCharacter(guild, "europe", f.ids[0])).find(p => p.memberGroupId === automatic.memberGroupId)!;
    await m.appointGroupPosition(guild, position.memberGroupPositionId, profile.memberGroupProfileId);
    await m.setCustomNickname(guild, "original", "Saved nickname");
    const reaction = (await pool.query("insert into reaction_role_configs(discord_guild_id,discord_role_id,created_by_discord_user_id) values($1,'reaction-role','officer') returning reaction_role_config_id", [guild])).rows[0];
    await pool.query("insert into reaction_role_subscriptions(reaction_role_config_id,discord_guild_id,discord_user_id) values($1,$2,'original')", [reaction.reaction_role_config_id, guild]);
    const content = await regears.createContent({ discordGuildId: guild, albionServer: "europe", name: "Content", contentDate: "2026-09-28", channelId: "review", actorDiscordUserId: "reviewer", actorDiscordRoleIds: reviewerRoles });
    const claim = async (message: string) => regears.createPendingClaim({ ...ref(), regearClaimId: randomUUID(), regearContentId: content.regearContentId, expectedOwnerDiscordUserId: "original", requestedValue: 100n, reviewChannelId: "review", reviewMessageId: message });
    const accepted = await claim("accepted"), pending = await claim("pending");
    await regears.acceptPendingClaim(guild, accepted.regearClaimId, "reviewer", reviewerRoles);
    const spec = async (key: string, message: string) => {
      const request = await specs.reserveRequest({ ...ref(), submittedByDiscordUserId: "original", target: catalogueByKey.get(key)!, level: 100, reviewChannelId: "review" });
      return specs.attachReviewMessage(guild, request.specialisationRequestId, message);
    };
    const confirmed = await spec("weapon:battleaxe", "confirmed"), pendingSpec = await spec("weapon:greataxe", "pending");
    await specs.decideRequest({ discordGuildId: guild, specialisationRequestId: confirmed.specialisationRequestId, reviewerDiscordUserId: "reviewer", decision: "confirmed", proofAvailable: true });
    await accounts.setFrozen(ref(), true, "reviewer", "Retained manual freeze");
    const before = (await accounts.getAccount(ref()))!, ledger = await accounts.listTransactions(before.accountId);
    assert.equal((await m.kickUser(guild, "original", ["authority-overlap"])).length, 1);
    assert.ok((await m.getMemberAccess(guild, "original"))?.lastKickedAt);
    assert.deepEqual(await m.listRegisteredCharacters(guild, "original"), []);
    assert.deepEqual(await m.listProfilesForCharacter(guild, "europe", f.ids[0]), []);
    assert.deepEqual(await m.listGroupPositionAppointments(guild), []);
    assert.deepEqual(await m.listQualifiedRoleIdsForUser(guild, "original"), []);
    for (const table of ["reaction_role_subscriptions", "discord_user_custom_nicknames"]) assert.equal((await pool.query(`select 1 from ${table} where discord_guild_id=$1`, [guild])).rowCount, 0);
    const kickedAccount = (await accounts.getAccount(ref()))!;
    assert.equal(kickedAccount.accountId, before.accountId); assert.equal(kickedAccount.balance, before.balance); assert.equal(kickedAccount.status, "frozen");
    assert.deepEqual(await accounts.listTransactions(before.accountId), ledger);
    assert.deepEqual(await expireCharacterEntitlements(pool, ref()), { removedRegears: 0, removedSpecialisations: 0 });
    assert.equal((await regears.getClaim(guild, accepted.regearClaimId))?.status, "accepted");
    assert.equal((await regears.getClaim(guild, pending.regearClaimId))?.status, "pending");
    assert.equal((await specs.getRequest(guild, confirmed.specialisationRequestId))?.state, "confirmed");
    assert.equal((await specs.getRequest(guild, pendingSpec.specialisationRequestId))?.state, "pending");
    assert.ok((await m.listKnownCharactersForGuild(guild)).some(c => c.albionCharacterId === f.ids[0]));
    await assert.rejects(m.registerCharacter(input(1)), MemberAccessBlockedError);
    await assert.rejects(m.registerCharacter(input(0, "intruder")), CharacterRecoveryRequiredError);
    await assert.rejects(m.completeApplicationAcceptance({ ...input(1), applicationId: "1", reviewerDiscordUserId: "reviewer", expectedApplicationStatus: "open" }), MemberAccessBlockedError);
    await assert.rejects(m.switchRegisteredCharacter({ discordGuildId: guild, discordUserId: "original", fromAlbionServer: "europe", fromAlbionCharacterId: f.ids[0], toAlbionServer: "europe", player: input(1).player }), MemberAccessBlockedError);
    await assert.rejects(m.registerCharacterAndAdoptOrphans(await f.recovery(0, "original", [automatic.memberGroupId])), KickCleanupPendingError);
    await assert.rejects(m.registerCharacterAndAdoptOrphans(await f.recovery(0, "replacement", [automatic.memberGroupId])), KickCleanupPendingError);
    await assert.rejects(pool.query("insert into reaction_role_subscriptions(reaction_role_config_id,discord_guild_id,discord_user_id) values($1,$2,'original')", [reaction.reaction_role_config_id, guild]), { constraint: "guild_member_access_allowed" });
    await assert.rejects(pool.query("insert into discord_user_characters(discord_guild_id,discord_user_id,albion_server,albion_character_id) values($1,'intruder','europe',$2)", [guild, f.ids[0]]), { constraint: "character_kick_recovery_required" });
    const stale = await f.recovery(0, "original", [automatic.memberGroupId]);
    const firstAccess = (await m.getMemberAccess(guild, "original"))!;
    await m.kickUser(guild, "original", ["second-authority"]);
    assert.equal(await m.markKickCleanupComplete(guild, "original", firstAccess.revision), false);
    await f.clean();
    await assert.rejects(m.registerCharacterAndAdoptOrphans(stale), MembershipLifecycleConflictError);
    // A failed registration transaction must not unblock the Discord user.
    await assert.rejects(m.registerCharacterAndAdoptOrphans(await f.recovery(0, "original", [custom.memberGroupId])), MembershipLifecycleConflictError);
    assert.equal(await m.isMemberBlocked(guild, "original"), true);
    await accounts.setFrozen(ref(), false, "reviewer", "Officer adjustment");
    await accounts.adjust(ref(), "reset_adjustment", -before.balance, "reviewer");
    assert.equal((await accounts.getAccount(ref()))?.balance, 0n, "officers may zero disconnected balances");
    await m.registerCharacterAndAdoptOrphans(await f.recovery(0, "original", [automatic.memberGroupId]));
    assert.equal(await m.isMemberBlocked(guild, "original"), false);
    assert.deepEqual((await m.listProfilesForCharacter(guild, "europe", f.ids[0])).map(p => p.memberGroupId), [automatic.memberGroupId]);
    assert.deepEqual(await m.listGroupPositionAppointments(guild), []);
    assert.deepEqual(await m.listQualifiedRoleIdsForUser(guild, "original"), ["normal-role"]);
    assert.equal((await accounts.getAccount(ref()))?.accountId, before.accountId);
    assert.equal((await accounts.listTransactions(before.accountId)).filter(t => t.transactionType === "regear_credit").length, 1);
    assert.equal((await specs.getRequest(guild, pendingSpec.specialisationRequestId))?.currentOwnerDiscordUserId, "original");
    const freshProfile = (await m.listProfilesForCharacter(guild, "europe", f.ids[0]))[0];
    await m.appointGroupPosition(guild, position.memberGroupPositionId, freshProfile.memberGroupProfileId);
    assert.deepEqual(new Set(await m.listQualifiedRoleIdsForUser(guild, "original")), new Set(["normal-role", "authority-overlap"]));
    assert.deepEqual((await m.getMemberAccess(guild, "original"))?.revokedRoleIds, ["second-authority"]);
    await m.kickUser(guild, "original", ["authority-overlap"]);
    await f.clean();
    const completed = (await m.getMemberAccess(guild, "original"))!;
    assert.equal(await m.addRevokedRoleIds(guild, "original", completed.revision, ["retry-authority"], ["late-cleanup-role"]), true);
    assert.equal((await m.getMemberAccess(guild, "original"))?.cleanupPending, true);
    await assert.rejects(m.registerCharacterAndAdoptOrphans(await f.recovery(0, "replacement", [automatic.memberGroupId])), KickCleanupPendingError);
    await f.clean();
    await m.registerCharacterAndAdoptOrphans(await f.recovery(0, "replacement", [automatic.memberGroupId]));
    assert.equal(await m.isMemberBlocked(guild, "original"), true);
    assert.equal(await m.isMemberBlocked(guild, "replacement"), false);
    assert.equal((await m.getMemberAccess(guild, "replacement"))?.lastKickedAt, null);
    assert.deepEqual(await m.listQualifiedRoleIdsForUser(guild, "replacement"), ["normal-role"]);
    assert.deepEqual(new Set((await m.getMemberAccess(guild, "replacement"))?.revokedRoleIds), new Set(["authority-overlap", "retry-authority", "second-authority"]));
    assert.equal((await specs.getRequest(guild, pendingSpec.specialisationRequestId))?.currentOwnerDiscordUserId, "replacement");
    assert.equal((await accounts.listTransactions(before.accountId)).filter(t => t.transactionType === "regear_credit").length, 1);

  } finally { await f.close(); }
});

test("kick covers former ownerless characters and empty users without affecting successors or another tenant", { skip: !url }, async () => {
  const f = await fixture();
  const { pool, guild, otherGuild, membership: m, input, ref } = f;
  try {
    const group = await m.createGroup({ discordGuildId: guild, albionServer: "europe", groupName: "Custom" });
    for (let i = 0; i < 3; i++) {
      await m.registerCharacter(input(i));
      await m.addRegisteredProfile({ ...ref(i), discordUserId: "original", memberGroupId: group.memberGroupId });
      await m.unregisterCharacter({ ...ref(i), discordUserId: "original" });
    }
    await m.registerCharacterAndAdoptOrphans(input(1, "successor"));
    await m.registerCharacterAndAdoptOrphans(input(2, "successor"));
    await m.unregisterCharacter({ ...ref(2), discordUserId: "successor" });
    await m.registerCharacter(input(0, "original", otherGuild));
    await m.registerCharacter(input(5));
    await m.unregisterCharacter({ ...ref(5), discordUserId: "original" });
    await pool.query(`insert into member_registration_lifecycle
      (discord_guild_id, albion_server, albion_character_id, previous_discord_user_id, source, state, detected_at, expires_at, purged_at)
      values ($1, 'europe', $2, 'original', 'purge', 'purged', now(), null, now())`, [guild, f.ids[5]]);
    const storedPurged = await m.getRegistrationLifecycle(guild, "europe", f.ids[5]);
    const history = (await pool.query("select * from character_registration_history where discord_guild_id=$1 order by registered_at", [guild])).rows;
    assert.deepEqual(await m.kickUser(guild, "original"), [], "the receipt counts only registrations removed now");
    assert.deepEqual(await m.listProfilesForCharacter(guild, "europe", f.ids[0]), []);
    assert.equal((await m.listProfilesForCharacter(guild, "europe", f.ids[1]))[0].discordUserId, "successor");
    assert.equal((await m.listProfilesForCharacter(guild, "europe", f.ids[2]))[0].previousDiscordUserId, "successor");
    assert.equal((await m.listRegisteredCharacters(otherGuild, "original")).length, 1);
    assert.equal(await m.isMemberBlocked(otherGuild, "original"), false);
    assert.deepEqual(await m.getRegistrationLifecycle(guild, "europe", f.ids[5]), storedPurged);
    assert.equal((await m.getKickRecoverySnapshot(guild, "original", "europe", f.ids[5])).expectedCharacterKickRevision, null);
    assert.deepEqual((await pool.query("select * from character_registration_history where discord_guild_id=$1 order by registered_at", [guild])).rows, history);
    await assert.rejects(m.registerCharacter(input(0, "intruder")), CharacterRecoveryRequiredError);
    await m.addOrphanProfile({ ...ref(), memberGroupId: group.memberGroupId });
    const rediscovered = (await m.listProfilesForCharacter(guild, "europe", f.ids[0]))[0];
    assert.equal(rediscovered.discordUserId, undefined);
    await assert.rejects(pool.query("update member_group_profiles set discord_user_id='intruder' where member_group_profile_id=$1", [rediscovered.memberGroupProfileId]), { constraint: "character_kick_recovery_required" });
    assert.equal(await m.appointGroupPosition(guild, (await m.createGroupPosition({ discordGuildId: guild, memberGroupId: group.memberGroupId, name: "Officer", discordRoleId: "officer" }))!.memberGroupPositionId, rediscovered.memberGroupProfileId), undefined);
    assert.equal((await m.kickUser(guild, "empty-user")).length, 0);
    await assert.rejects(m.registerCharacter(input(3, "empty-user")), MemberAccessBlockedError);
    await f.clean("empty-user");
    await m.registerCharacterAndAdoptOrphans(await f.recovery(3, "empty-user"));
    assert.equal(await m.isMemberBlocked(guild, "empty-user"), false);
    await f.clean();
    await m.registerCharacterAndAdoptOrphans(await f.recovery(4));
    assert.equal(await m.isMemberBlocked(guild, "original"), false);
    await assert.rejects(m.registerCharacter(input()), CharacterRecoveryRequiredError, "recovering another character never releases the old kicked identity");
  } finally { await f.close(); }
});


test("an in-flight registration commits before kick and cannot recreate membership after kick", { skip: !url }, async () => {
  const f = await fixture();
  const { pool, guild, membership: m } = f;
  const writer = await pool.connect();
  try {
    await m.upsertVerifiedCharacter("europe", f.input().player);
    await writer.query("begin");
    await writer.query("insert into discord_user_characters(discord_guild_id,discord_user_id,albion_server,albion_character_id) values($1,'original','europe',$2)", [guild, f.ids[0]]);
    const kicking = m.kickUser(guild, "original");
    await writer.query("commit");
    assert.equal((await kicking).length, 1);
    assert.deepEqual(await m.listRegisteredCharacters(guild, "original"), []);
    assert.equal(await m.isMemberBlocked(guild, "original"), true);
    await assert.rejects(m.registerCharacter(f.input()), MemberAccessBlockedError);
    assert.equal((await pool.query("select unregistered_at is not null as closed from character_registration_history where discord_guild_id=$1", [guild])).rows[0].closed, true);
  } finally { await writer.query("rollback"); writer.release(); await f.close(); }
});

test("kick recovery suppresses authority configured during disconnection without changing ordinary officer registration", { skip: !url }, async () => {
  const f = await fixture();
  const { pool, guild, membership: m } = f;
  try {
    const group = await m.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-a`, albionGuildName: "Automatic", managed: true });
    for (const role of ["normal-role", "became-manager", "became-admin"]) await m.addMemberGroupRoleConfig(group.memberGroupId, role);
    await m.registerCharacter(f.input());
    await m.addRegisteredProfile({ ...f.ref(), discordUserId: "original", memberGroupId: group.memberGroupId });
    await m.kickUser(guild, "original");
    await f.clean();
    assert.deepEqual((await m.getMemberAccess(guild, "original"))?.revokedRoleIds, []);
    const snapshot = await f.recovery(0, "original", [group.memberGroupId]);
    assert.equal(snapshot.recovery.characterKickRecoveryRequired, true);
    // The command snapshot predates a newly configured manager role. Recovery
    // must read live Guild Manager configuration inside its transaction too.
    await pool.query("insert into entry_panel_roles(discord_guild_id, role_kind, discord_role_id) values($1,'accounts_manager','became-manager')", [guild]);
    await m.registerCharacterAndAdoptOrphans({ ...snapshot, recovery: { ...snapshot.recovery, kickAuthorityRoleIds: ["became-admin"] } });
    assert.deepEqual(await m.listQualifiedRoleIdsForUser(guild, "original"), ["normal-role"]);
    assert.deepEqual(new Set((await m.getMemberAccess(guild, "original"))?.revokedRoleIds), new Set(["became-manager", "became-admin"]));
    const resolved = await m.getKickRecoverySnapshot(guild, "original", "europe", f.ids[0]);
    assert.equal(resolved.characterKickRecoveryRequired, false);
    assert.ok(resolved.expectedCharacterKickRevision, "a resolved guard retains its revision fence");
    const ordinary = await f.recovery(1, "original", [group.memberGroupId]);
    await m.registerCharacterAndAdoptOrphans({ ...ordinary, recovery: { ...ordinary.recovery, kickAuthorityRoleIds: ["normal-role"] } });
    assert.deepEqual(await m.listQualifiedRoleIdsForUser(guild, "original"), ["normal-role"]);
    assert.equal((await m.getMemberAccess(guild, "original"))?.revokedRoleIds.includes("normal-role"), false);
  } finally { await f.close(); }
});
