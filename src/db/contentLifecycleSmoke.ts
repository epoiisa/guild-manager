import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PostgresPool } from "./postgres.js";
import { createContentRepository } from "./contentRepository.js";
import { migrateDatabaseSchema } from "./schema.js";
import { getContentCleanupAt } from "../services/content/lifecycle.js";

// Runs only against the caller's smoke database, with all fixtures in a private
// schema. No Discord services or application runtime are started.
export async function runContentLifecycleSmoke(databaseUrl: string, adminPool: PostgresPool): Promise<void> {
  const schema = `smoke_content_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await adminPool.query(`create schema "${schema}"`);
  try {
    await migrateDatabaseSchema(pool);
    // Reconstruct v38 before seeding the legacy scheduled row and its signups.
    await pool.query(`alter table content_items drop constraint content_items_waiting_mode_check;
      alter table content_items drop constraint content_items_state_check;
      alter table content_items add constraint content_items_state_check
        check (state in ('scheduled', 'active', 'ended', 'cancelled', 'archived'));
      alter table content_items alter column scheduled_start_at set not null;
      delete from guild_manager_schema_migrations where version = 39`);
    await pool.query(`insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
      values ('party-guild', 'active', 'Party Smoke', now()), ('other-guild', 'active', 'Other', now())`);
    const repository = createContentRepository(pool);
    const base = new Date("2030-01-01T00:00:00Z");
    const at = (hours: number) => new Date(base.getTime() + hours * 3600000);
    let nextThread = 0;
    const create = (scheduledStartAt: Date | null, postedAt = base) => repository.createContent({
      discordGuildId: "party-guild", sourceChannelId: "source", threadChannelId: `thread-${++nextThread}`,
      hostDiscordUserId: "host", title: "Party", description: "Description", scheduledStartAt,
      postedAt, roleLabels: ["Tank", "Healer"]
    });
    const legacy = await create(at(1));
    await repository.setContentMessageIds("party-guild", legacy.content.contentId, "announcement", "controls", "details");
    await repository.upsertSignup("party-guild", legacy.content.contentId, legacy.slots[0].contentRoleSlotId, "tank");
    const before = await repository.getContentSnapshot("party-guild", legacy.content.contentId);
    const legacyStarted = await create(at(2));
    await repository.markStarted("party-guild", legacyStarted.content.contentId, at(1));
    await repository.setStartNotificationMessage("party-guild", legacyStarted.content.contentId, "legacy-start-notification");
    await pool.query("alter table content_items drop column start_notification_claimed_at");
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    assert.ok((await repository.getContentSnapshot("party-guild", legacyStarted.content.contentId))?.content.startNotificationClaimedAt);
    assert.equal(await repository.claimStartNotification("party-guild", legacyStarted.content.contentId), false);
    assert.deepEqual(await repository.getContentSnapshot("party-guild", legacy.content.contentId), before);
    const waiting = await create(null);
    assert.equal(waiting.content.state, "unscheduled");
    assert.equal(waiting.content.scheduledStartAt, null);
    assert.deepEqual(waiting.content.createdAt, base);
    assert.deepEqual(getContentCleanupAt(waiting.content), at(12));
    const id = waiting.content.contentId;
    assert.equal((await repository.listContentDueStart(at(1))).some(item => item.contentId === id), false);
    assert.equal((await repository.listContentDueStart(at(7))).some(item => item.contentId === legacy.content.contentId), false);
    assert.equal((await repository.listContentDueCleanup(at(11.99))).some(item => item.contentId === id), false);
    assert.equal((await repository.listContentDueCleanup(at(12))).some(item => item.contentId === id), true);
    assert.equal(await repository.markStarted("other-guild", id, at(1)), undefined);
    assert.equal(await repository.claimContentDueCleanup("other-guild", id, at(12)), undefined);
    assert.equal(await repository.getContentSnapshot("other-guild", id), undefined);
    assert.deepEqual(await repository.listUnarchivedContent("other-guild"), []);
    await assert.rejects(pool.query(`update content_items set state = 'scheduled' where content_id = $1`, [id]), /content_items_waiting_mode_check/);
    await assert.rejects(pool.query(`update content_items set state = 'unscheduled' where content_id = $1`, [legacy.content.contentId]), /content_items_waiting_mode_check/);
    assert.equal(await repository.updateContentDetails({ discordGuildId: "party-guild", contentId: id,
      title: "Cannot schedule", description: "", roleLabels: ["Tank"], scheduledStartAt: at(20) }), undefined);
    await repository.upsertSignup("party-guild", id, waiting.slots[1].contentRoleSlotId, "healer");
    const edited = await repository.updateContentDetails({ discordGuildId: "party-guild", contentId: id,
      title: "Updated", description: "", roleLabels: ["Tank"], graphicAttachmentName: "builds.png", requireScheduledState: true });
    assert.equal(edited?.movedToStandbyCount, 1);
    assert.equal(edited?.snapshot.signups[0].signupType, "standby");
    assert.deepEqual(edited?.snapshot.content.createdAt, base);
    await repository.setHost("party-guild", id, "next-host");
    const starts = await Promise.all([repository.markStarted("party-guild", id, at(1)), repository.markStarted("party-guild", id, at(2))]);
    assert.equal(starts.filter(Boolean).length, 1);
    const winner = starts.find(Boolean)!;
    assert.deepEqual(getContentCleanupAt(winner), new Date(winner.startedAt!.getTime() + 6 * 3600000));
    assert.ok(getContentCleanupAt(winner) < at(12), "Early start replaces and shortens the initial waiting window");
    assert.equal(await repository.claimStartNotification("other-guild", id), false);
    const claims = await Promise.all([
      repository.claimStartNotification("party-guild", id), repository.claimStartNotification("party-guild", id)
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok((await repository.getContentSnapshot("party-guild", id))?.content.startNotificationClaimedAt);
    assert.equal(await createContentRepository(pool).claimStartNotification("party-guild", id), false,
      "An ambiguous send remains claimed across process/repository restart");
    const pastPublication = new Date(Date.now() - 20 * 3600000);
    const expiredDelivery = await create(null, pastPublication);
    assert.ok(await repository.markStarted("party-guild", expiredDelivery.content.contentId,
      new Date(pastPublication.getTime() + 7 * 3600000)));
    assert.equal(await repository.claimStartNotification("party-guild", expiredDelivery.content.contentId), false,
      "An expired active party cannot claim a delayed announcement before cleanup runs");
    assert.equal(await repository.markStarted("party-guild", id, at(3)), undefined);
    assert.equal(await repository.updateContentDetails({ discordGuildId: "party-guild", contentId: id,
      title: "Active", description: "", roleLabels: ["Tank"], graphicAttachmentName: "replacement.png", requireScheduledState: true }), undefined);
    // A stale cleanup selection made at the waiting deadline cannot close a
    // party that won Start just beforehand and now has a later deadline.
    const late = await create(null);
    assert.ok((await repository.listContentDueCleanup(at(12))).some(item => item.contentId === late.content.contentId));
    const lateStart = await repository.markStarted("party-guild", late.content.contentId, at(11));
    assert.ok(lateStart);
    assert.equal(await repository.claimContentDueCleanup("party-guild", late.content.contentId, at(12)), undefined);
    assert.deepEqual(getContentCleanupAt(lateStart), at(17));
    // Cleanup first blocks a stale Start, even if its supplied time predates expiry.
    const expired = await create(null);
    assert.equal(await repository.markStarted("party-guild", expired.content.contentId, at(12)), undefined);
    assert.equal((await repository.claimContentDueCleanup("party-guild", expired.content.contentId, at(12)))?.state, "ended");
    assert.equal(await repository.markStarted("party-guild", expired.content.contentId, at(11)), undefined);
    assert.ok(await repository.claimContentDueCleanup("party-guild", expired.content.contentId, at(13)), "Failed Discord cleanup remains retryable");
    await repository.markArchived("party-guild", expired.content.contentId);
    assert.equal(await repository.claimContentDueCleanup("party-guild", expired.content.contentId, at(14)), undefined);
    // Exercise actual PostgreSQL row-lock contention in both orders. The loser
    // begins its UPDATE against the old visible row, then must recheck the
    // winner's committed state/deadline after the lock is released.
    for (const first of ["start", "cleanup"] as const) {
      const racing = await create(null);
      const owner = await pool.connect();
      const contender = await pool.connect();
      const ownerRepo = createPinnedLifecycleRepository(owner, true);
      const contenderRepo = createPinnedLifecycleRepository(contender, false);
      let pending: ReturnType<typeof repository.markStarted> | undefined;
      try {
        const pid = (await contender.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
        await owner.query("begin");
        if (first === "start") {
          assert.ok(await ownerRepo.markStarted("party-guild", racing.content.contentId, at(11)));
          pending = contenderRepo.claimContentDueCleanup("party-guild", racing.content.contentId, at(12));
        } else {
          assert.ok(await ownerRepo.claimContentDueCleanup("party-guild", racing.content.contentId, at(12)));
          pending = contenderRepo.markStarted("party-guild", racing.content.contentId, at(11));
        }
        // Attach immediately while observing the lock, then await the original
        // promise below so SQL failures still fail the smoke rather than escape.
        void pending.catch(() => undefined);
        const timeout = Date.now() + 5000;
        for (;;) {
          const activity = await pool.query<{ wait_event_type: string | null }>(
            "select wait_event_type from pg_stat_activity where pid = $1", [pid]);
          if (activity.rows[0]?.wait_event_type === "Lock") break;
          assert.ok(Date.now() < timeout, "The competing lifecycle update must reach the row lock");
        }
        await owner.query("commit");
        assert.equal(await pending, undefined);
      } finally {
        await owner.query("rollback");
        try {
          await pending;
        } finally {
          owner.release();
          contender.release();
        }
      }
    }
    const scheduled = await create(at(20));
    const scheduledStart = await repository.markStarted("party-guild", scheduled.content.contentId, at(1));
    assert.deepEqual(getContentCleanupAt(scheduledStart!), at(26));
    assert.equal(await repository.claimContentDueCleanup("party-guild", scheduled.content.contentId, at(25)), undefined);
    assert.ok(await repository.claimContentDueCleanup("party-guild", scheduled.content.contentId, at(26)));
    const cancelled = await create(null);
    await repository.markCancelled("party-guild", cancelled.content.contentId);
    const claimedCancelled = await repository.claimContentDueCleanup("party-guild", cancelled.content.contentId, at(12));
    assert.equal(claimedCancelled?.state, "cancelled");
    assert.equal(claimedCancelled?.endedAt, null);
    // Closed parties retain final-card retries until archiving. Archived history
    // must never enter ordinary card repair, even with an unrendered revision.
    for (const state of ["ended", "cancelled"] as const) {
      const retained = await create(null);
      const retainedId = retained.content.contentId;
      if (state === "ended") {
        await repository.setContentMessageIds("party-guild", retainedId, "announcement", "controls", "details");
        await repository.markEnded("party-guild", retainedId);
      } else {
        await repository.markCancelled("party-guild", retainedId);
      }
      assert.ok((await repository.listContentNeedingControlMessage()).some(item => item.contentId === retainedId),
        `${state} parties retain unfinished final-card repair`);
      await repository.markArchived("party-guild", retainedId);
      const archived = (await repository.getContentSnapshot("party-guild", retainedId))!.content;
      assert.notEqual(archived.renderedRevision, archived.renderRevision);
      assert.equal((await repository.listContentNeedingControlMessage()).some(item => item.contentId === retainedId), false,
        "Archived parties are excluded even when their render revision is unfinished");
    }
  } finally {
    await pool.end();
    await adminPool.query(`drop schema "${schema}" cascade`);
  }
}

// Pin each repository to the backend whose lock is observed above. The winner's
// method-owned transaction becomes a savepoint inside the harness transaction,
// retaining its real row locks until the harness explicitly commits. The loser
// uses an ordinary BEGIN/COMMIT on its separate backend.
function createPinnedLifecycleRepository(client: pg.PoolClient, insideTransaction: boolean) {
  const query = client.query.bind(client);
  const connection = {
    query: async (sql: string, values?: unknown[]) => {
      if (insideTransaction) {
        const command = sql.trim().toLowerCase();
        if (command === "begin") return query("savepoint lifecycle_repository");
        if (command === "commit") return query("release savepoint lifecycle_repository");
        if (command === "rollback") {
          await query("rollback to savepoint lifecycle_repository");
          return query("release savepoint lifecycle_repository");
        }
      }
      return query(sql, values);
    },
    release: () => undefined
  };
  return createContentRepository({ query, connect: async () => connection } as unknown as PostgresPool);
}
