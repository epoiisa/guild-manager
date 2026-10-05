import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { createMembershipRepository } from "./membershipRepository.js";
import { MEMBERSHIP_GRACE_MS } from "./membershipLifecycleRepository.js";
import { createAccountRepository, AccountOperationError } from "./accountRepository.js";
import { createRegearRepository, RegearOperationError } from "./regearRepository.js";
import { createSpecialisationRepository, SpecialisationOperationError } from "./specialisationRepository.js";
import { createMembershipEvidenceCleanupRepository } from "./membershipEntitlementCleanup.js";
import { createTasksRepository } from "./tasksRepository.js";
import { catalogueByKey } from "../services/specialisations/catalogue.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

const url = process.env.MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL;
test("PostgreSQL recovery gates financial changes, follows verified ownership, and expires only Pending entitlements with durable evidence cleanup", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_membership_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `entitlements-${randomUUID()}`, character = `${guild}-character`;
  const ref = { discordGuildId: guild, albionServer: "europe" as const, albionCharacterId: character };
  const registration = { discordGuildId: guild, discordUserId: "original", albionServer: "europe" as const, player: { id: character, name: "Entitlement Character" } };
  const membership = createMembershipRepository(pool), accounts = createAccountRepository(pool), regears = createRegearRepository(pool), specs = createSpecialisationRepository(pool);
  const reviewerRoles = ["__guild_manager_discord_administrator__"];
  try {
    await migrateDatabaseSchema(pool);
    await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [guild]);
    const a = await membership.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-a`, albionGuildName: "A", managed: true });
    const b = await membership.configureAlbionGuild({ discordGuildId: guild, albionServer: "europe", albionGuildId: `${guild}-b`, albionGuildName: "B", managed: false });
    await membership.registerCharacter(registration);
    for (const group of [a, b]) await membership.addRegisteredProfile({ ...ref, memberGroupId: group.memberGroupId, discordUserId: "original" });
    const content = await regears.createContent({ discordGuildId: guild, albionServer: "europe", name: "Content", contentDate: "2026-09-28", channelId: "review", actorDiscordUserId: "reviewer", actorDiscordRoleIds: reviewerRoles });
    const claim = async (message: string) => regears.createPendingClaim({ ...ref, regearClaimId: randomUUID(), regearContentId: content.regearContentId, expectedOwnerDiscordUserId: "original", requestedValue: 100n, reviewChannelId: "review", reviewMessageId: message });
    const accepted = await claim("accepted-regear");
    await regears.acceptPendingClaim(guild, accepted.regearClaimId, "reviewer", reviewerRoles);
    const pending = await claim("pending-regear");
    const spec = async (key: string, message: string) => {
      const request = await specs.reserveRequest({ ...ref, submittedByDiscordUserId: "original", target: catalogueByKey.get(key)!, level: 100, reviewChannelId: "review" });
      return specs.attachReviewMessage(guild, request.specialisationRequestId, message);
    };
    const confirmed = await spec("weapon:battleaxe", "confirmed-spec");
    await specs.decideRequest({ discordGuildId: guild, specialisationRequestId: confirmed.specialisationRequestId, reviewerDiscordUserId: "reviewer", decision: "confirmed", proofAvailable: true });
    const pendingSpec = await spec("weapon:greataxe", "pending-spec");
    await accounts.setFrozen(ref, true, "reviewer", "Manual freeze");
    const departure = await membership.beginDiscordDeparture(guild, "original");
    assert.equal(departure.holds.length, 1);
    assert.equal((await accounts.getAccount(ref))?.status, "frozen");
    await accounts.setFrozen(ref, false, "reviewer", "Manual unfreeze does not bypass membership hold");
    await assert.rejects(accounts.adjust(ref, "credit", 10n, "reviewer"), (error: unknown) => error instanceof AccountOperationError && error.code === "membership_suspended");
    await assert.rejects(regears.acceptPendingClaim(guild, pending.regearClaimId, "reviewer", reviewerRoles), (error: unknown) => error instanceof RegearOperationError && error.code === "character_ineligible");
    await assert.rejects(specs.decideRequest({ discordGuildId: guild, specialisationRequestId: pendingSpec.specialisationRequestId, reviewerDiscordUserId: "reviewer", decision: "confirmed", proofAvailable: true }), (error: unknown) => error instanceof SpecialisationOperationError && error.code === "submitter_ineligible");
    const profiles = await membership.listProfilesForCharacter(guild, ref.albionServer, character);
    await membership.registerCharacterAndAdoptOrphans({ ...registration, discordUserId: "restored", recovery: {
      expectedRegistrationRevision: departure.holds[0].revision,
      expectedProfileRevisions: Object.fromEntries(profiles.map(profile => [profile.memberGroupId, profile.lifecycleRevision!])),
      verifiedMemberGroupIds: [a.memberGroupId, b.memberGroupId], unavailableMemberGroupIds: []
    } });
    const restored = await specs.getRequest(guild, pendingSpec.specialisationRequestId);
    assert.equal(restored?.currentOwnerDiscordUserId, "restored");
    assert.equal(restored?.submittedByDiscordUserId, "original");
    const tasks = await createTasksRepository(pool).getSnapshot(guild);
    assert.equal(tasks.specialisations[0].currentOwnerDiscordUserId, "restored");
    assert.equal(tasks.specialisations[0].submittedByDiscordUserId, "original");
    await accounts.adjust(ref, "credit", 10n, "reviewer");
    assert.equal((await accounts.getAccount(ref))?.balance, 110n);
    const now = new Date(), due = new Date(now.getTime() + MEMBERSHIP_GRACE_MS);
    const departedA = await membership.markMembershipDeparted({ ...ref, memberGroupId: a.memberGroupId }, now);
    await accounts.adjust(ref, "credit", 10n, "reviewer");
    await membership.expireMembershipDeparture({ ...ref, memberGroupId: a.memberGroupId }, departedA!.lifecycleRevision!, due);
    assert.ok(await regears.getClaim(guild, pending.regearClaimId));
    assert.ok(await specs.getRequest(guild, pendingSpec.specialisationRequestId));
    const departedB = await membership.markMembershipDeparted({ ...ref, memberGroupId: b.memberGroupId }, now);
    await assert.rejects(accounts.adjust(ref, "credit", 10n, "reviewer"), (error: unknown) => error instanceof AccountOperationError && error.code === "membership_suspended");
    const concurrent = await Promise.allSettled([
      membership.expireMembershipDeparture({ ...ref, memberGroupId: b.memberGroupId }, departedB!.lifecycleRevision!, due),
      regears.acceptPendingClaim(guild, pending.regearClaimId, "reviewer", reviewerRoles),
      specs.decideRequest({ discordGuildId: guild, specialisationRequestId: pendingSpec.specialisationRequestId, reviewerDiscordUserId: "reviewer", decision: "confirmed", proofAvailable: true })
    ]);
    assert.equal(concurrent[0].status, "fulfilled");
    assert.equal(concurrent[1].status, "rejected");
    assert.equal(concurrent[2].status, "rejected");
    assert.equal(await regears.getClaim(guild, pending.regearClaimId), undefined);
    assert.equal(await specs.getRequest(guild, pendingSpec.specialisationRequestId), undefined);
    assert.equal((await regears.getClaim(guild, accepted.regearClaimId))?.status, "accepted");
    assert.equal((await specs.getRequest(guild, confirmed.specialisationRequestId))?.state, "confirmed");
    assert.equal((await specs.listSpecialisations(guild)).length, 1);
    const closed = await accounts.getAccount(ref);
    assert.equal(closed?.status, "closed"); assert.equal(closed?.balance, 0n);
    assert.equal((await accounts.listTransactions(closed!.accountId)).filter(item => item.transactionType === "regear_credit").length, 1);
    const cleanup = createMembershipEvidenceCleanupRepository(pool);
    assert.deepEqual(new Set((await cleanup.listPending(guild)).map(job => job.messageId)), new Set(["pending-regear", "pending-spec"]));
    const job = (await cleanup.listPending(guild))[0];
    await cleanup.markAttempted(guild, job.cleanupId);
    await cleanup.complete("other-guild", job.cleanupId);
    assert.equal((await cleanup.listPending(guild)).length, 2, "cleanup acknowledgement is tenant scoped");
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("begin");
      await purgeGuildOwnedData(cleanupClient, guild);
      await cleanupClient.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [guild]);
      await cleanupClient.query("delete from albion_characters where albion_character_id = $1", [character]);
      await cleanupClient.query("commit");
    } catch (error) {
      await cleanupClient.query("rollback");
      throw error;
    } finally { cleanupClient.release(); await pool.end(); }
  }
});
