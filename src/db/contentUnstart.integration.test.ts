import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { createContentRepository } from "./contentRepository.js";
import { createContentPanelRepository } from "./contentPanelRepository.js";
import { MIGRATION_047_CONTENT_UNSTART, migrateDatabaseSchema } from "./schema.js";
import { getContentCleanupAt } from "../services/content/lifecycle.js";

// Explicitly disposable Local PostgreSQL only; never loads application secrets.
const url = process.env.CONTENT_APPROVAL_TEST_DATABASE_URL;
test("PostgreSQL Unstart migration, repeated starts, deadlines, authorization and concurrent consumption", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_approval_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `unstart-${randomUUID()}`, other = `other-${randomUUID()}`;
  const repo = createContentRepository(pool), panels = createContentPanelRepository(pool);
  const base = new Date("2099-01-01T00:00:00Z");
  const at = (hours: number) => new Date(base.getTime() + hours * 3600000);
  const create = (scheduled = false) => repo.createContent({
    discordGuildId: guild, sourceChannelId: "source", threadChannelId: randomUUID(), hostDiscordUserId: "host",
    title: "Party", description: "Description", roleLabels: ["Tank", "DPS"], approvalRequired: true,
    scheduledStartAt: scheduled ? at(4) : null, postedAt: base
  });
  try {
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    for (const id of [guild, other]) await pool.query(
      "insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [id]);

    // Apply the migration itself to a retained v46 row, without touching the
    // disposable database's shared schema or unrelated fixture records.
    const legacy = await create();
    const legacyStart = await repo.markStarted(guild, legacy.content.contentId, at(1), "host");
    await repo.setStartNotificationMessage(guild, legacy.content.contentId, "old-message", legacyStart!.startRevision);
    const upgrade = await pool.connect();
    try {
      await upgrade.query("begin");
      const schema = `unstart_upgrade_${randomUUID().replaceAll("-", "")}`;
      await upgrade.query(`create schema ${schema}`);
      await upgrade.query(`set local search_path to ${schema}, public`);
      await upgrade.query("create table content_items (like public.content_items including defaults including constraints)");
      await upgrade.query("insert into content_items select * from public.content_items where content_id=$1", [legacy.content.contentId]);
      await upgrade.query("alter table content_items drop column first_started_at, drop column started_by_discord_user_id, drop column start_revision");
      const before = (await upgrade.query("select to_jsonb(c) as record from content_items c")).rows[0].record;
      await upgrade.query(MIGRATION_047_CONTENT_UNSTART);
      const after = (await upgrade.query("select to_jsonb(c) as record from content_items c")).rows[0].record;
      assert.ok(after.start_revision);
      assert.deepEqual(after, { ...before, first_started_at: before.started_at, started_by_discord_user_id: null, start_revision: after.start_revision });
    } finally { await upgrade.query("rollback"); upgrade.release(); }

    for (const scheduled of [false, true]) {
      const party = await create(scheduled), id = party.content.contentId;
      await repo.setContentMessageIds(guild, id, "announcement", "roles", "details");
      await repo.requestSignup({ discordGuildId: guild, contentId: id, discordUserId: "member", roleSlotId: party.slots[0].contentRoleSlotId, actorDiscordUserId: "host" });
      await repo.requestSignup({ discordGuildId: guild, contentId: id, discordUserId: "pending", roleSlotId: null });
      const before = (await repo.getContentSnapshot(guild, id))!;
      const requests = (await pool.query("select * from content_signup_requests where content_id=$1", [id])).rows;
      const first = (await repo.markStarted(guild, id, at(1), "host"))!;
      assert.equal(first.startedByDiscordUserId, "host");
      assert.ok(first.startRevision);
      assert.equal(await repo.claimStartNotification(guild, id, first.startRevision), true);
      assert.equal(await repo.setStartNotificationMessage(guild, id, "first-message", first.startRevision), true);
      const undo = (g = guild, host = "host", token = first.startRevision!, message = "first-message", time = at(2)) =>
        repo.markUnstarted(g, id, host, token, message, time);
      assert.equal(await undo(other), undefined);
      assert.equal(await undo(guild, "outsider"), undefined);
      assert.equal(await undo(guild, "host", randomUUID()), undefined);
      assert.equal(await undo(guild, "host", first.startRevision!, "wrong-message"), undefined);
      if (scheduled) assert.equal(await undo(guild, "host", first.startRevision!, "first-message", at(4)), undefined);
      const winners = await Promise.all([undo(), undo()]);
      assert.equal(winners.filter(Boolean).length, 1);
      const waiting = winners.find(Boolean)!;
      assert.equal(waiting.state, scheduled ? "scheduled" : "unscheduled");
      assert.equal(waiting.startedAt, null);
      assert.equal(waiting.startRevision, null);
      assert.equal(waiting.startNotificationMessageId, null);
      assert.equal(waiting.startNotificationClaimedAt, null);
      assert.deepEqual(waiting.firstStartedAt, at(1));
      assert.deepEqual(getContentCleanupAt(waiting), scheduled ? at(10) : at(7));
      assert.deepEqual((await repo.getContentSnapshot(guild, id))!.signups, before.signups);
      assert.deepEqual((await pool.query("select * from content_signup_requests where content_id=$1", [id])).rows, requests);
      assert.equal((await panels.listPanelContent(guild, "source", at(2))).find(e => e.content.contentId === id)?.content.state, waiting.state);
      assert.equal(await repo.claimStartNotification(guild, id, first.startRevision), false);
      assert.equal(await repo.setStartNotificationMessage(guild, id, "late-first-message", first.startRevision), false);

      // Restart the repository to prove the expiry anchor and notification
      // consumption live in PostgreSQL, not only in process memory.
      const restarted = createContentRepository(pool);
      const second = (await restarted.markStarted(guild, id, at(3), "host"))!;
      assert.notEqual(second.startRevision, first.startRevision);
      assert.deepEqual(second.startedAt, at(3));
      assert.deepEqual(second.firstStartedAt, at(1));
      assert.deepEqual(getContentCleanupAt(second), getContentCleanupAt(first));
      assert.equal(await undo(), undefined, "An old Unstart cannot consume the second start");
      assert.equal(await repo.claimStartNotification(guild, id, first.startRevision), false);
      assert.equal(await repo.setStartNotificationMessage(guild, id, "stale-save", first.startRevision), false);
      assert.equal(await repo.claimStartNotification(guild, id, second.startRevision), true);
      assert.equal(await repo.setStartNotificationMessage(guild, id, "second-message", second.startRevision), true);
      await repo.setHost(guild, id, "new-host", "host");
      assert.equal(await repo.markUnstarted(guild, id, "host", second.startRevision!, "second-message", at(3.5)), undefined);
      assert.ok(await repo.markUnstarted(guild, id, "new-host", second.startRevision!, "second-message", at(3.5)));
      if (scheduled) {
        assert.ok((await repo.listContentDueStart(at(4))).some(c => c.contentId === id));
        const automatic = (await repo.markStarted(guild, id, at(4)))!;
        assert.equal(automatic.startedByDiscordUserId, null);
        await repo.setStartNotificationMessage(guild, id, "auto-message", automatic.startRevision);
        assert.equal(await repo.markUnstarted(guild, id, "new-host", automatic.startRevision!, "auto-message", at(4.1)), undefined);
      } else {
        assert.equal((await repo.listContentDueStart(at(4))).some(c => c.contentId === id), false);
        assert.ok((await repo.listContentDueCleanup(at(7))).some(c => c.contentId === id));
        assert.equal(await repo.markStarted(guild, id, at(7), "new-host"), undefined);
      }
      assert.ok(await repo.claimContentDueCleanup(guild, id, scheduled ? at(10) : at(7)));
    }
    const late = await create(), lateId = late.content.contentId;
    const start = (await repo.markStarted(guild, lateId, at(11), "host"))!;
    await repo.setStartNotificationMessage(guild, lateId, "late", start.startRevision);
    const waiting = (await repo.markUnstarted(guild, lateId, "host", start.startRevision!, "late", at(11.1)))!;
    assert.deepEqual(getContentCleanupAt(waiting), at(17), "Undo retains the first start's deadline, even after the old waiting deadline");
    assert.ok(await repo.markStarted(guild, lateId, at(13), "host"));
    assert.equal(await repo.claimContentDueCleanup(guild, lateId, at(16)), undefined);
    assert.ok(await repo.claimContentDueCleanup(guild, lateId, at(17)));

    // A request can wait for a row lock until after the scheduled boundary.
    // Its earlier caller timestamp must not make an already-due start undoable.
    const requestedAt = new Date();
    const near = await repo.createContent({ discordGuildId: guild, sourceChannelId: "source", threadChannelId: randomUUID(),
      hostDiscordUserId: "host", title: "Boundary", description: "", roleLabels: ["Tank"],
      scheduledStartAt: new Date(requestedAt.getTime() + 100) });
    const nearStart = (await repo.markStarted(guild, near.content.contentId, requestedAt, "host"))!;
    await repo.setStartNotificationMessage(guild, near.content.contentId, "near", nearStart.startRevision);
    await pool.query("select pg_sleep(0.15)");
    assert.equal(await repo.markUnstarted(guild, near.content.contentId, "host", nearStart.startRevision!, "near", requestedAt), undefined);
  } finally {
    await pool.query("delete from content_items where discord_guild_id = any($1::text[])", [[guild, other]]);
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id = any($1::text[])", [[guild, other]]);
    await pool.end();
  }
});
