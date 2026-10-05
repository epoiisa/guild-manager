import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "./postgres.js";
import { createContentRepository } from "./contentRepository.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabaseSchema } from "./schema.js";

// Dedicated disposable database only; never reads Local credentials or .env.
const url = process.env.PARTY_LAYOUT_TEST_DATABASE_URL;
test("party message migration preserves existing graphics and signups, with tenant-scoped canonical IDs", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_party_layout_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  try {
    await migrateDatabaseSchema(pool);
    const repository = createContentRepository(pool);
    await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values('party-test','active','Party Test',now())");
    const create = (thread: string) => repository.createContent({
      discordGuildId: "party-test", sourceChannelId: "source", threadChannelId: thread,
      hostDiscordUserId: "host", title: "Party", description: "Description", scheduledStartAt: null,
      graphicAttachmentName: "builds.png", roleLabels: ["Tank"], approvalRequired: true
    });
    const party = await create("thread"), archived = await create("archived-thread");
    const signup = await repository.requestSignup({
      discordGuildId: "party-test", contentId: party.content.contentId,
      roleSlotId: party.slots[0].contentRoleSlotId, discordUserId: "member", actorDiscordUserId: "host"
    });
    assert.equal(signup.status, "signed_up");
    await repository.markEnded("party-test", archived.content.contentId);
    await repository.markArchived("party-test", archived.content.contentId);
    for (const row of [party, archived]) {
      await repository.setContentMessageIds("party-test", row.content.contentId, "announcement", "legacy-roles", "unused-details");
      await repository.markRendered("party-test", row.content.contentId);
    }
    // Reconstruct the exact pre-change column layout with real retained parties.
    await pool.query("alter table content_items drop column details_message_id");
    await pool.query("delete from guild_manager_schema_migrations where version = 45");
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    const migrated = (await repository.getContentSnapshot("party-test", party.content.contentId))!;
    assert.equal(migrated.content.announcementMessageId, "announcement");
    assert.equal(migrated.content.detailsMessageId, "legacy-roles");
    assert.equal(migrated.content.controlMessageId, null);
    assert.equal(migrated.content.graphicAttachmentName, "builds.png");
    assert.equal(migrated.content.approvalRequired, true);
    assert.equal(migrated.content.renderedRevision, null);
    assert.equal(migrated.signups[0].discordUserId, "member");
    assert.deepEqual(migrated.slots, party.slots);
    const retained = (await repository.getContentSnapshot("party-test", archived.content.contentId))!.content;
    assert.equal(retained.controlMessageId, "legacy-roles"); assert.equal(retained.detailsMessageId, null);
    assert.equal((await repository.listContentNeedingControlMessage()).some(row => row.contentId === party.content.contentId), true);

    await repository.setDetailsMessage("wrong-guild", party.content.contentId, "intruder");
    await repository.setControlMessage("wrong-guild", party.content.contentId, "intruder");
    assert.deepEqual(await repository.getContentSnapshot("party-test", party.content.contentId), migrated);
    await repository.setDetailsMessage("party-test", party.content.contentId, "details");
    await repository.setControlMessage("party-test", party.content.contentId, "roles");
    await repository.markRendered("party-test", party.content.contentId, migrated.content.renderRevision);
    const repaired = (await repository.getContentSnapshot("party-test", party.content.contentId))!.content;
    assert.equal(repaired.detailsMessageId, "details"); assert.equal(repaired.controlMessageId, "roles");
    assert.equal((await repository.listContentNeedingControlMessage()).some(row => row.contentId === party.content.contentId), false);
    const startupContent = await repository.listContentNeedingControlMessage(true);
    assert.equal(startupContent.some(row => row.contentId === party.content.contentId), true);
    assert.equal(startupContent.some(row => row.contentId === archived.content.contentId), false);
    await repository.markEnded("party-test", party.content.contentId);
    await repository.markRendered("party-test", party.content.contentId);
    assert.equal((await repository.listContentNeedingControlMessage(true)).some(row => row.contentId === party.content.contentId), false);
    await assert.rejects(pool.query("update content_items set details_message_id = '' where content_id = $1", [party.content.contentId]), /check constraint/);
    await migrateDatabaseSchema(pool);
    assert.equal((await repository.getContentSnapshot("party-test", party.content.contentId))!.content.controlMessageId, "roles");
    assert.equal((await pool.query("select max(version)::int as version from guild_manager_schema_migrations")).rows[0].version, CURRENT_SCHEMA_VERSION);
  } finally {
    await pool.query("delete from content_items where discord_guild_id = 'party-test'");
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id = 'party-test'");
    await pool.end();
  }
});
