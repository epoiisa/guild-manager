import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { createApplicationRepository } from "./applicationRepository.js";
import { createMembershipRepository } from "./membershipRepository.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";
import { planConfiguredRoleChangesForGuild, reconcileConfiguredRolesForGuild } from "../services/membership/discordMemberUpdates.js";

const url = process.env.APPLICATION_ROLE_TEST_DATABASE_URL;
test("application role entitlement matrix, shared membership, tenant isolation and audit/update recovery in PostgreSQL", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_application_role_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `roles-${randomUUID()}`, other = `other-${randomUUID()}`, user = "applicant", role = "temporary";
  const characterId = `character-${randomUUID()}`;
  const applications = createApplicationRepository(pool), memberships = createMembershipRepository(pool);
  try {
    await migrateDatabaseSchema(pool);
    for (const id of [guild, other]) await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [id]);
    async function create(guildId: string, name: string, activeRoleId = role) {
      const application = await applications.createApplicationClass({ discordGuildId: guildId, name, outcomeType: "register_character", albionServer: "europe", activeRoleId, ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "operator" });
      const open = await applications.createOpenApplication({ discordGuildId: guildId, applicationClassId: application.applicationClassId, applicantDiscordUserId: user, submittedCharacterName: "Character", modalAnswers: [], albionServer: "europe" });
      await applications.setOpenApplicationTicketChannel(guildId, open.applicationId, `channel-${open.applicationId}`);
      return { application, open };
    }
    const first = await create(guild, "First"), second = await create(guild, "Second"), foreign = await create(other, "Foreign");
    const qualified = () => memberships.listQualifiedRoleIdsForUser(guild, user);
    const set = async (id: string, status: string, channel: string) => {
      await pool.query("update open_applications set status=$2, channel_status=$3 where application_id=$1", [id, status, channel]);
    };
    await set(second.open.applicationId, "accepted", "deleted");
    for (const status of ["open", "awaiting_ingame_membership", "accepted", "rejected", "withdrawn"]) {
      for (const channel of ["open", "closed", "deleted"]) {
        await set(first.open.applicationId, status, channel);
        assert.deepEqual(await qualified(), channel === "open" && ["open", "awaiting_ingame_membership"].includes(status) ? [role] : [], `${status}/${channel}`);
        assert.deepEqual(await applications.listQualifiedRoleIdsForUser(guild, user), await qualified());
      }
    }
    // Another Discord server's application never authorizes this server's role.
    assert.deepEqual(await memberships.listQualifiedRoleIdsForUser(other, user), [role]);
    assert.deepEqual(await qualified(), []);
    await set(second.open.applicationId, "open", "open"); assert.deepEqual(await qualified(), [role]);
    await applications.setApplicationEnabled(guild, second.application.applicationClassId, false);
    assert.deepEqual(await qualified(), [role], "disabling intake preserves existing applications");
    await pool.query("update application_classes set archived_at=now(),archived_by_discord_user_id='operator',archive_reason='application_class_removed',enabled=false where application_class_id=$1", [second.application.applicationClassId]);
    assert.deepEqual(await qualified(), []);
    assert.ok((await memberships.listConfiguredRoleIdsForGuild(guild)).includes(role), "archived role remains discoverable for cleanup");
    await memberships.registerCharacter({ discordGuildId: guild, discordUserId: user, albionServer: "europe", player: { id: characterId, name: "Character" } });
    await memberships.addCharacterRoleConfig(guild, "europe", role);
    assert.deepEqual(await qualified(), [role], "completed applications cannot remove a membership entitlement");
    await memberships.removeCharacterRoleConfig(guild, "europe", role);
    const held = new Set([role, "unrelated"]);
    const member = { id: user, guild: { id: guild }, roles: { cache: held, remove: async (id: string) => held.delete(id), add: async (id: string) => held.add(id) } };
    const discord = { id: guild, members: { fetch: async (request?: unknown) => request ? member : new Map([[user, member]]) } } as any;
    const audit = await planConfiguredRoleChangesForGuild(discord, memberships);
    assert.deepEqual(audit.plans, [{ discordUserId: user, addRoleIds: [], removeRoleIds: [role] }]);
    assert.ok(held.has(role), "audit is read-only");
    const updated = await reconcileConfiguredRolesForGuild(discord, memberships);
    assert.equal(updated.warnings.length, 0); assert.equal(updated.outcomes.length, 1);
    assert.deepEqual([...held], ["unrelated"]);
    assert.deepEqual((await reconcileConfiguredRolesForGuild(discord, memberships)).outcomes, []);
    assert.equal(foreign.open.discordGuildId, other);
  } finally {
    for (const id of [guild, other]) await purgeGuildOwnedData(pool, id);
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id=any($1::text[])", [[guild, other]]);
    await pool.query("delete from albion_characters where albion_character_id=$1", [characterId]);
    await pool.end();
  }
});
