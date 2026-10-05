import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ChannelType, type Guild } from "discord.js";
import { createApplicationRepository } from "./applicationRepository.js";
import { createTicketRepository } from "./ticketRepository.js";
import { createMembershipRepository } from "./membershipRepository.js";
import { createConversationClassRemovalRepository } from "./conversationClassRemovalRepository.js";
import { createResetRepository } from "./resetRepository.js";
import type { PostgresPool } from "./postgres.js";
import { removeConversationClass } from "../services/conversationClassRemoval.js";

/** Real PostgreSQL coverage for removal order, rollback, history and tenant isolation. */
export async function runConversationClassRemovalSmoke(pool: PostgresPool): Promise<void> {
  const guildId = `smoke-class-removal-${randomUUID()}`;
  const otherGuildId = `${guildId}-other`;
  const characterId = `${guildId}-character`;
  const applications = createApplicationRepository(pool);
  const tickets = createTicketRepository(pool);
  const memberships = createMembershipRepository(pool);
  try {
    await pool.query(`insert into discord_guild_lifecycle (discord_guild_id,status,guild_name,activated_at) values ($1,'active','Class Removal Smoke',now()),($2,'active','Class Removal Other',now())`, [guildId, otherGuildId]);
    const memberGroup = await memberships.createGroup({ discordGuildId: guildId, albionServer: "asia", groupName: "Retained Group" });
    await memberships.registerCharacter({ discordGuildId: guildId, discordUserId: "member", albionServer: "asia", player: { id: characterId, name: "Smoke Character" } });
    await memberships.addRegisteredProfile({ memberGroupId: memberGroup.memberGroupId, discordGuildId: guildId, albionServer: "asia", albionCharacterId: characterId, discordUserId: "member" });
    await runArchivedApplicationClassRemovalSmoke(pool, guildId, otherGuildId);
    for (const kind of ["application", "ticket"] as const) {
      const removal = kind === "application" ? applications.classRemoval : tickets.classRemoval;
      const createClass = async (tenant: string, name: string) => kind === "application"
        ? (await applications.createApplicationClass({ discordGuildId: tenant, name, outcomeType: tenant === guildId ? "member_group" : "register_character", memberGroupId: tenant === guildId ? memberGroup.memberGroupId : undefined, albionServer: "asia", ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "admin" })).applicationClassId
        : (await tickets.createTicketClass({ discordGuildId: tenant, name, ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "admin" })).ticketClassId;
      const createRecord = async (id: string, index: number, tenant = guildId) => {
        if (kind === "application") {
          return (await applications.createOpenApplication({ applicationClassId: id, discordGuildId: tenant, applicantDiscordUserId: "member", ticketChannelId: `${guildId}-${kind}-${index}`, submittedCharacterName: "Smoke Character", modalAnswers: [], albionServer: "asia" })).applicationId;
        }
        const ticket = await tickets.createTicket({ ticketClassId: id, discordGuildId: tenant, openerDiscordUserId: "member" });
        await tickets.setTicketChannel(tenant, ticket.ticketId, `${guildId}-${kind}-${index}`);
        return ticket.ticketId;
      };
      const id = await createClass(guildId, "Removal Class");
      const keptId = await createClass(guildId, "Kept Class");
      const otherId = await createClass(otherGuildId, "Removal Class");
      const keptRecord = await createRecord(keptId, 20);
      const otherRecord = await createRecord(otherId, 30, otherGuildId);
      const ids = [await createRecord(id, 0), await createRecord(id, 1), await createRecord(id, 2)];
      if (kind === "application") {
        await applications.markApplicationClosed(guildId, ids[1], "member");
        // Decision state does not determine whether a channel counts as open.
        await pool.query("update open_applications set status='accepted' where discord_guild_id=$1 and application_id=$2", [guildId, ids[0]]);
      } else await tickets.markTicketClosed(guildId, ids[1], "member");
      await removal.markDeleted(guildId, ids[2], "prior-reviewer");
      assert.deepEqual((await removal.getSnapshot(guildId, id))?.conversations.map((record) => record.status), ["open", "closed", "deleted"]);
      assert.equal(await removal.getSnapshot(otherGuildId, id), undefined);
      await removal.disable(otherGuildId, id);
      await removal.markDeleted(otherGuildId, ids[0], "wrong-user");
      assert.equal(await removal.remove(otherGuildId, id), false);
      await assert.rejects(removal.remove(guildId, id), /intake must be disabled/);
      await removal.disable(guildId, id);
      // Retrying an already-disabled class must not rewrite its configuration.
      const table = kind === "application" ? "application_classes" : "ticket_classes";
      const key = kind === "application" ? "application_class_id" : "ticket_class_id";
      const readDisabledClass = () => pool.query(`select * from ${table} where discord_guild_id=$1 and ${key}=$2`, [guildId, id]);
      const disabledClass = (await readDisabledClass()).rows;
      await removal.disable(guildId, id);
      assert.deepEqual((await readDisabledClass()).rows, disabledClass);
      await assert.rejects(createRecord(id, 99), /disabled/);
      await assert.rejects(removal.remove(guildId, id), /conversations must be deleted/);
      assert.equal((await removal.getSnapshot(guildId, id))?.conversations.length, 3);
      for (const recordId of ids) await removal.markDeleted(guildId, recordId, "admin");
      // A failure after deleting child rows must roll them back with the class.
      const failingPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (sql: string, values?: unknown[]) => {
              if (sql.startsWith(`delete from ${kind === "application" ? "application_classes" : "ticket_classes"}`)) throw new Error("Simulated class-delete failure");
              return client.query(sql, values);
            },
            release: () => client.release()
          };
        }
      } as unknown as PostgresPool;
      await assert.rejects(createConversationClassRemovalRepository(failingPool, kind).remove(guildId, id), /Simulated/);
      assert.equal((await removal.getSnapshot(guildId, id))?.conversations.length, 3);
      if (kind === "application") assert.equal((await applications.getOpenApplication(guildId, ids[2]))?.deletedByDiscordUserId, "prior-reviewer");
      else assert.equal((await tickets.getTicket(guildId, ids[2]))?.deletedByDiscordUserId, "prior-reviewer");
      assert.equal(await removal.remove(guildId, id), true);
      assert.equal(await removal.getSnapshot(guildId, id), undefined);
      assert.equal(await removal.remove(guildId, id), false);
      assert.equal((await removal.getSnapshot(guildId, keptId))?.conversations[0].id, keptRecord);
      assert.equal((await removal.getSnapshot(otherGuildId, otherId))?.conversations[0].id, otherRecord);
      const replacement = await createClass(guildId, "Removal Class");
      assert.notEqual(replacement, id);
      assert.deepEqual((await removal.getSnapshot(guildId, replacement))?.conversations, []);
      await removal.disable(guildId, replacement);
      assert.equal(await removal.remove(guildId, replacement), true);
    }
    assert.equal((await memberships.listRegisteredCharacters(guildId, "member"))[0]?.albionCharacterId, characterId);
    assert.equal((await memberships.getActiveMemberGroupForUser(guildId, memberGroup.memberGroupId, "member"))?.memberGroupId, memberGroup.memberGroupId);
  } finally {
    const cleanup = createResetRepository(pool);
    await cleanup.purgeGuildData(guildId);
    await cleanup.purgeGuildData(otherGuildId);
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id in ($1,$2)", [guildId, otherGuildId]);
    await pool.query("delete from albion_characters where albion_server='asia' and albion_character_id=$1", [characterId]);
  }
}

async function runArchivedApplicationClassRemovalSmoke(pool: PostgresPool, guildId: string, otherGuildId: string): Promise<void> {
  const applications = createApplicationRepository(pool);
  const memberships = createMembershipRepository(pool);
  const removal = applications.classRemoval;
  const group = await memberships.createGroup({ discordGuildId: guildId, albionServer: "asia", groupName: "Archived Removal Group" });
  const name = "Archived Removal Class";
  const applicationClass = await applications.createApplicationClass({
    discordGuildId: guildId, name, outcomeType: "member_group", memberGroupId: group.memberGroupId,
    albionServer: "asia", ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "admin"
  });
  const classId = applicationClass.applicationClassId;
  const records = [];
  for (let index = 0; index < 3; index += 1) {
    records.push(await applications.createOpenApplication({
      applicationClassId: classId, discordGuildId: guildId, applicantDiscordUserId: "member",
      ticketChannelId: `${guildId}-archived-${index}`, submittedCharacterName: "Smoke Character", modalAnswers: [], albionServer: "asia"
    }));
  }
  await applications.markApplicationClosed(guildId, records[1].applicationId, "admin");
  await removal.markDeleted(guildId, records[2].applicationId, "prior-reviewer");
  // Use the real archival path so its database trigger and historical state apply.
  await memberships.removeMemberGroup({ discordGuildId: guildId, memberGroupId: group.memberGroupId, archivedByDiscordUserId: "admin" });
  const readArchivedClass = () => pool.query("select * from application_classes where discord_guild_id=$1 and application_class_id=$2", [guildId, classId]);
  const archivedClass = (await readArchivedClass()).rows;
  assert.ok(archivedClass[0].archived_at);
  assert.equal(archivedClass[0].enabled, false);
  assert.equal(archivedClass[0].member_group_id, null);
  await assert.rejects(pool.query("update application_classes set name='Changed' where discord_guild_id=$1 and application_class_id=$2", [guildId, classId]), { code: "55000" });
  await removal.disable(guildId, classId);
  assert.deepEqual((await readArchivedClass()).rows, archivedClass);

  // Reusing the archived name must not reconnect removal to either live class.
  const keptClasses = [];
  for (const tenant of [guildId, otherGuildId]) {
    const kept = await applications.createApplicationClass({ discordGuildId: tenant, name, outcomeType: "register_character", albionServer: "asia", ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "admin" });
    keptClasses.push({ guildId: tenant, classId: kept.applicationClassId, snapshot: await removal.getSnapshot(tenant, kept.applicationClassId) });
  }
  const snapshot = (await removal.getSnapshot(guildId, classId))!;
  assert.deepEqual(snapshot.conversations.map((record) => record.status), ["closed", "closed", "deleted"]);
  const channels = new Set(snapshot.conversations.filter((record) => record.status !== "deleted").map((record) => record.channelId!));
  const blockedChannel = snapshot.conversations[1].channelId!;
  let failChannelDeletion = true;
  const deletedChannels: string[] = [];
  const guild = {
    id: guildId,
    channels: { fetch: async (id: string) => channels.has(id) ? {
      id, type: ChannelType.GuildText, guild: { id: guildId },
      delete: async () => {
        if (failChannelDeletion && id === blockedChannel) throw new Error("Simulated channel deletion failure");
        channels.delete(id);
        deletedChannels.push(id);
      }
    } : null }
  } as unknown as Guild;
  const firstAttempt = await removeConversationClass({ guild, actorId: "admin", snapshot, repository: removal });
  assert.deepEqual(firstAttempt, { removed: false, deletedChannels: 1, failures: 1, entryWarning: false });
  assert.deepEqual((await readArchivedClass()).rows, archivedClass);
  const retrySnapshot = (await removal.getSnapshot(guildId, classId))!;
  assert.deepEqual(retrySnapshot.conversations.map((record) => record.status), ["deleted", "closed", "deleted"]);
  failChannelDeletion = false;
  assert.deepEqual(await removeConversationClass({ guild, actorId: "admin", snapshot: retrySnapshot, repository: removal }), {
    removed: true, deletedChannels: 1, failures: 0, entryWarning: false
  });
  assert.deepEqual(deletedChannels, [snapshot.conversations[0].channelId, blockedChannel]);
  assert.equal(await removal.getSnapshot(guildId, classId), undefined);
  assert.equal((await pool.query("select 1 from open_applications where discord_guild_id=$1 and application_class_id=$2", [guildId, classId])).rowCount, 0);
  for (const kept of keptClasses) assert.deepEqual(await removal.getSnapshot(kept.guildId, kept.classId), kept.snapshot);
}
