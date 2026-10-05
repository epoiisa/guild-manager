import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema, CURRENT_SCHEMA_VERSION, MIGRATION_043_CONTENT_SIGNUP_APPROVAL } from "./schema.js";
import { createContentRepository } from "./contentRepository.js";

// Explicit disposable localhost database only; never loads Local credentials.
const url = process.env.CONTENT_APPROVAL_TEST_DATABASE_URL;
test("isolated PostgreSQL approval migration, races, tenant fencing and durable presentation", {
  skip: !url
}, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_approval_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `approval-${randomUUID()}`, other = `other-${randomUUID()}`;
  try {
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    assert.equal((await pool.query<{
      version: number;
    }>("select max(version)::int as version from guild_manager_schema_migrations")).rows[0].version, CURRENT_SCHEMA_VERSION);
    for (const id of [guild, other])
      await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [id]);
    // Rebuild only the three pre-approval content tables in a transaction-local schema.
    // Applying the real migration proves existing parties acquire the default-off setting.
    const upgrade = await pool.connect();
    try {
      await upgrade.query("begin");
      const fixtureSchema = `approval_upgrade_${randomUUID().replaceAll("-", "")}`;
      await upgrade.query(`create schema ${fixtureSchema}`);
      await upgrade.query(`set local search_path to ${fixtureSchema}, public`);
      await upgrade.query("create table content_items (like public.content_items including all)");
      await upgrade.query("alter table content_items drop column approval_required, drop column render_revision, drop column rendered_revision");
      await upgrade.query("create table content_signups (like public.content_signups including all)");
      await upgrade.query("create table content_role_slots (like public.content_role_slots including all)");
      await upgrade.query("insert into content_items(discord_guild_id,source_channel_id,thread_channel_id,leader_discord_user_id,title,description,scheduled_start_at,state) values('legacy','source','thread','host','Legacy','',null,'unscheduled')");
      await upgrade.query(MIGRATION_043_CONTENT_SIGNUP_APPROVAL);
      assert.equal((await upgrade.query<{
        approval_required: boolean;
      }>("select approval_required from content_items where discord_guild_id='legacy'")).rows[0].approval_required, false);
    }
    finally {
      await upgrade.query("rollback");
      upgrade.release();
    }
    const repository = createContentRepository(pool);
    const create = (approvalRequired = false) => repository.createContent({
      discordGuildId: guild, sourceChannelId: "source", threadChannelId: randomUUID(), hostDiscordUserId: "host", title: "Party", description: "", scheduledStartAt: null, roleLabels: ["DPS", "DPS", "Heal"], approvalRequired
    });
    const ungated = await create();
    assert.equal(ungated.content.approvalRequired, false);
    const party = await create(true), contentId = party.content.contentId;
    const slot = (index: number) => party.slots[index].contentRoleSlotId;
    const request = (discordUserId: string, roleSlotId: string | null) => repository.requestSignup({
      discordGuildId: guild, contentId, discordUserId, roleSlotId
    });
    const accept = (discordUserId: string, actorDiscordUserId = "host") => repository.decideSignupRequest({
      discordGuildId: guild, contentId, discordUserId, actorDiscordUserId, decision: "accept"
    });
    const first = await request("one", slot(0));
    assert.equal(first.status, "requested");
    assert.equal((await request("one", slot(0))).request?.requestId, first.request?.requestId);
    await request("two", slot(0));
    assert.equal((await repository.getContentSnapshot(guild, contentId))!.signups.length, 0);
    assert.equal(await repository.getPendingSignupRequest(other, contentId, "one"), undefined);
    assert.equal((await repository.decideSignupRequest({
      discordGuildId: other, contentId, discordUserId: "one", actorDiscordUserId: "host", decision: "accept"
    })).status, "closed");
    assert.equal((await accept("one", "intruder")).status, "not_host");
    const results = await Promise.all([accept("one"), accept("two")]);
    assert.deepEqual(results.map(r => r.status).sort(), ["accepted", "slot_filled"]);
    const winner = results[0].status === "accepted" ? "one" : "two", loser = winner === "one" ? "two" : "one";
    assert.equal((await request(loser, slot(0))).status, "unchanged");
    const move = await request(winner, slot(1));
    assert.equal(move.status, "requested");
    await repository.requestSignup({
      discordGuildId: guild, contentId, discordUserId: "host-assigned", roleSlotId: slot(1), actorDiscordUserId: "host"
    });
    assert.equal((await accept(winner)).status, "slot_filled");
    assert.equal((await repository.getContentSnapshot(guild, contentId))!.signups.find(s => s.discordUserId === winner)?.contentRoleSlotId, slot(0));
    assert.equal((await request(winner, slot(0))).status, "already_signed_up");
    assert.equal(await repository.getPendingSignupRequest(guild, contentId, winner), undefined);
    await request(winner, null);
    assert.equal((await repository.decideSignupRequest({
      discordGuildId: guild, contentId, discordUserId: winner, actorDiscordUserId: "host", decision: "decline"
    })).status, "declined");
    assert.equal((await repository.getContentSnapshot(guild, contentId))!.signups.find(s => s.discordUserId === winner)?.contentRoleSlotId, slot(0));
    const old = (await repository.getPendingSignupRequest(guild, contentId, loser))!;
    const replacement = await request(loser, null);
    assert.equal(replacement.status, "requested");
    assert.equal((await repository.decideSignupRequest({
      discordGuildId: guild, contentId, requestId: old.requestId, actorDiscordUserId: "host", decision: "accept"
    })).status, "not_pending");
    const fulfilled = await repository.requestSignup({
      discordGuildId: guild, contentId, discordUserId: loser, roleSlotId: null, actorDiscordUserId: "host"
    });
    assert.equal(fulfilled.request?.status, "accepted");
    const outcomeId = fulfilled.request!.requestId;
    const notificationClaims = await Promise.all([
      repository.claimSignupRequestNotification(guild, contentId, outcomeId, "outcome"),
      repository.claimSignupRequestNotification(guild, contentId, outcomeId, "outcome")
    ]);
    assert.deepEqual(notificationClaims.sort(), [false, true], "Exactly one concurrent notification claim succeeds");
    assert.equal(await repository.setSignupRequestMessage(guild, contentId, outcomeId, "outcome", "message", null), true);
    assert.equal(await repository.setSignupRequestMessage(guild, contentId, outcomeId, "outcome", "duplicate", null), false);
    assert.equal((await createContentRepository(pool).getSignupRequest(guild, contentId, outcomeId))?.outcomeMessageId, "message");
    await request("rename", slot(2));
    const edit = await repository.updateContentDetails({
      discordGuildId: guild, contentId, actorDiscordUserId: "host", title: "Party", description: "", roleLabels: ["DPS", "DPS", "Tank"]
    });
    assert.equal(edit?.invalidatedRequestIds.length, 1);
    assert.equal(await repository.getPendingSignupRequest(guild, contentId, "rename"), undefined);
    await request("withdraw", null);
    const withdrawn = await repository.withdrawSignup({
      discordGuildId: guild, contentId, discordUserId: "withdraw"
    });
    assert.equal(withdrawn.removedRequest, true);
    assert.equal((await accept("withdraw")).status, "not_pending");
    await request("transfer", null);
    await repository.setHost(guild, contentId, "new-host", "host");
    assert.equal((await accept("transfer")).status, "not_host");
    assert.equal((await accept("transfer", "new-host")).status, "accepted");
    assert.equal((await repository.requestSignup({
      discordGuildId: guild, contentId, discordUserId: "host", roleSlotId: null, actorDiscordUserId: "host"
    })).status, "not_host");
    await request("closing", null);
    await repository.markEnded(guild, contentId);
    assert.equal((await accept("closing", "new-host")).status, "closed");
    assert.equal(await repository.getPendingSignupRequest(guild, contentId, "closing"), undefined);
    // Immediate competing moves also preserve the loser's existing signup.
    const immediate = await create(), immediateId = immediate.content.contentId;
    await repository.upsertSignup(guild, immediateId, immediate.slots[0].contentRoleSlotId, "a");
    await repository.upsertSignup(guild, immediateId, immediate.slots[1].contentRoleSlotId, "b");
    const moves = await Promise.allSettled([repository.upsertSignup(guild, immediateId, immediate.slots[2].contentRoleSlotId, "a"), repository.upsertSignup(guild, immediateId, immediate.slots[2].contentRoleSlotId, "b")]);
    assert.equal(moves.filter(r => r.status === "rejected").length, 1);
    assert.equal((await repository.getContentSnapshot(guild, immediateId))!.signups.length, 2);
    // A terminal party still permits existing confirmed signups to leave.
    const terminalLeave = await repository.withdrawSignup({
      discordGuildId: guild, contentId, discordUserId: winner
    });
    assert.equal(terminalLeave.removedSignup, true);
    // Database constraints reject incomplete target snapshots and cross-tenant owners.
    await assert.rejects(pool.query("insert into content_signup_requests(discord_guild_id,content_id,discord_user_id,role_slot_id) values($1,$2,'invalid',$3)", [guild, immediateId, immediate.slots[0].contentRoleSlotId]), /content_signup_request_target/);
    await assert.rejects(pool.query("insert into content_signup_requests(discord_guild_id,content_id,discord_user_id) values($1,$2,'invalid')", [other, immediateId]), /foreign key/);
    // A render of an older snapshot cannot clear a concurrent roster mutation.
    const beforeRender = (await repository.getContentSnapshot(guild, immediateId))!.content;
    await repository.markRendered(guild, immediateId, beforeRender.renderRevision);
    await repository.upsertSignup(guild, immediateId, null, "late-signup");
    await repository.markRendered(guild, immediateId, beforeRender.renderRevision);
    assert.ok((await repository.listContentNeedingControlMessage()).some(item => item.contentId === immediateId));
    const latestRender = (await repository.getContentSnapshot(guild, immediateId))!.content;
    assert.notEqual(latestRender.renderRevision, latestRender.renderedRevision);
    await repository.setControlMessage(guild, immediateId, "canonical");
    await repository.setDetailsMessage(guild, immediateId, "details");
    await repository.markRendered(guild, immediateId, latestRender.renderRevision);
    assert.ok(!(await repository.listContentNeedingControlMessage()).some(item => item.contentId === immediateId));
    for (const operation of ["withdraw", "edit", "transfer", "close"] as const) {
      const racing = await create(true), racingId = racing.content.contentId;
      const submitted = await repository.requestSignup({
        discordGuildId: guild, contentId: racingId, discordUserId: "racer", roleSlotId: racing.slots[2].contentRoleSlotId
      });
      const entered = deferred(), release = deferred();
      const accepting = repository.decideSignupRequest({
        discordGuildId: guild, contentId: racingId, requestId: submitted.request!.requestId,
        actorDiscordUserId: "host", decision: "accept",
        validateAvailability: async () => {
          entered.resolve();
          await release.promise;
          return true;
        }
      });
      await entered.promise;
      let competing: Promise<unknown>;
      if (operation === "withdraw")
        competing = repository.withdrawSignup({
          discordGuildId: guild, contentId: racingId, discordUserId: "racer"
        });
      else if (operation === "edit")
        competing = repository.updateContentDetails({
          discordGuildId: guild, contentId: racingId, actorDiscordUserId: "host", title: "Party", description: "", roleLabels: ["DPS"]
        });
      else if (operation === "transfer")
        competing = repository.setHost(guild, racingId, "new-host", "host");
      else
        competing = repository.markEnded(guild, racingId, "host");
      let competitorFinished = false;
      void competing.then(() => {
        competitorFinished = true;
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(competitorFinished, false, `${operation} waits for the acceptance content lock`);
      release.resolve();
      assert.equal((await accepting).status, "accepted");
      await competing;
      const final = (await repository.getContentSnapshot(guild, racingId))!;
      assert.equal(final.signups.length, operation === "withdraw" ? 0 : 1);
      if (operation === "edit")
        assert.equal(final.signups[0].signupType, "standby");
      if (operation === "transfer")
        assert.equal(final.content.hostDiscordUserId, "new-host");
      if (operation === "close")
        assert.equal(final.content.state, "ended");
      const replay = await repository.decideSignupRequest({
        discordGuildId: guild, contentId: racingId, requestId: submitted.request!.requestId, actorDiscordUserId: final.content.hostDiscordUserId, decision: "accept"
      });
      assert.equal(replay.status, operation === "close" ? "closed" : "not_pending");
    }
    // Waiting for the owning row must not retain transaction-start expiry time.
    const expiring = await create(true), blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("update content_items set created_at=clock_timestamp()-interval '12 hours'+interval '100 milliseconds' where discord_guild_id=$1 and content_id=$2", [guild, expiring.content.contentId]);
      const queued = repository.requestSignup({
        discordGuildId: guild, contentId: expiring.content.contentId, discordUserId: "too-late", roleSlotId: null
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      await blocker.query("commit");
      assert.equal((await queued).status, "closed");
      assert.equal((await repository.getContentSnapshot(guild, expiring.content.contentId))!.signups.length, 0);
    }
    finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }
  }
  finally {
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id=any($1)", [[guild, other]]).catch(() => undefined);
    await pool.end();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {
    promise, resolve
  };
}
