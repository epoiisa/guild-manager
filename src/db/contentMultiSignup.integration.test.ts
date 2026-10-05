import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresPool } from "./postgres.js";
import { createContentRepository } from "./contentRepository.js";
import { createContentPanelRepository } from "./contentPanelRepository.js";
import { CURRENT_SCHEMA_VERSION, MIGRATION_046_CONTENT_MULTI_SIGNUP, migrateDatabaseSchema } from "./schema.js";

// Shares the existing explicitly disposable test target; never loads Local credentials.
const url = process.env.CONTENT_APPROVAL_TEST_DATABASE_URL;
test("PostgreSQL multi-signup migration, conditional capacity races, moves and complete counts", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_approval_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  const guild = `multi-${randomUUID()}`, other = `other-${randomUUID()}`;
  const repository = createContentRepository(pool), panels = createContentPanelRepository(pool);
  const create = (multiSignupEnabled = false, approvalRequired = false, scheduled = false) => repository.createContent({
    discordGuildId: guild, sourceChannelId: "source", threadChannelId: randomUUID(), hostDiscordUserId: "host",
    title: "Party", description: "Retained description", roleLabels: ["Tank", "Healer", "DPS"],
    scheduledStartAt: scheduled ? new Date(Date.now() + 3600000) : null,
    graphicAttachmentName: "builds.png", multiSignupEnabled, approvalRequired
  });
  try {
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    assert.equal((await pool.query("select max(version) as version from guild_manager_schema_migrations")).rows[0].version, CURRENT_SCHEMA_VERSION);
    for (const id of [guild, other]) await pool.query(
      "insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [id]);

    const legacy = await create(false, true, true), legacyId = legacy.content.contentId;
    await repository.setContentMessageIds(guild, legacyId, "announcement", "roles", "details");
    await repository.requestSignup({ discordGuildId: guild, contentId: legacyId, discordUserId: "confirmed", roleSlotId: legacy.slots[0].contentRoleSlotId, actorDiscordUserId: "host" });
    await repository.requestSignup({ discordGuildId: guild, contentId: legacyId, discordUserId: "pending", roleSlotId: null });
    await repository.markRendered(guild, legacyId);
    const upgrade = await pool.connect();
    try {
      await upgrade.query("begin");
      const schema = `multi_upgrade_${randomUUID().replaceAll("-", "")}`;
      await upgrade.query(`create schema ${schema}`);
      await upgrade.query(`set local search_path to ${schema}, public`);
      const tables = ["content_items", "content_role_slots", "content_signups", "content_signup_requests"];
      for (const table of tables) {
        await upgrade.query(`create table ${table} (like public.${table} including defaults including constraints)`);
        await upgrade.query(`insert into ${table} select * from public.${table} where content_id=$1`, [legacyId]);
      }
      await upgrade.query("alter table content_items drop column multi_signup_enabled");
      await upgrade.query("create unique index content_signups_one_active_user_per_slot on content_signups(content_role_slot_id) where state='active'");
      await upgrade.query("create unique index content_signups_one_active_user_per_content on content_signups(content_id,discord_user_id) where state='active'");
      const before = [];
      for (const table of tables) before.push(await upgrade.query(`select to_jsonb(t) as record from ${table} t order by to_jsonb(t)::text`));
      await upgrade.query(MIGRATION_046_CONTENT_MULTI_SIGNUP);
      for (const [index, table] of tables.entries()) {
        const after = await upgrade.query(`select to_jsonb(t) as record from ${table} t order by to_jsonb(t)::text`);
        const expected: { record: Record<string, unknown> }[] = before[index].rows.map(row => ({ record: table === "content_items"
          ? { ...row.record, multi_signup_enabled: false, rendered_revision: null } : row.record }));
        assert.deepEqual(after.rows, expected, `${table} retained without losing identities, timestamps, media or requests`);
      }
      const indexes = await upgrade.query(`select c.relname, i.indisunique from pg_index i join pg_class c on c.oid=i.indexrelid
        join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 order by c.relname`, [schema]);
      assert.deepEqual(indexes.rows, [
        { relname: "content_signups_active_role_slot", indisunique: false },
        { relname: "content_signups_one_active_user_per_content", indisunique: true }
      ]);
    } finally {
      await upgrade.query("rollback");
      upgrade.release();
    }

    for (const multi of [false, true]) for (const approval of [false, true]) for (const scheduled of [false, true]) {
      const party = await create(multi, approval, scheduled), contentId = party.content.contentId;
      const role = party.slots[0].contentRoleSlotId;
      assert.equal(party.content.multiSignupEnabled, multi);
      assert.equal(party.content.approvalRequired, approval);
      const claims = await Promise.all(["one", "two"].map(discordUserId => repository.requestSignup({
        discordGuildId: guild, contentId, discordUserId, roleSlotId: role,
        ...(!approval && discordUserId === "two" ? { actorDiscordUserId: "host" } : {})
      })));
      if (approval) {
        assert.deepEqual(claims.map(r => r.status), ["requested", "requested"]);
        assert.equal((await repository.getContentSnapshot(guild, contentId))!.signups.length, 0);
        const decisions = await Promise.all(["one", "two"].map(discordUserId => repository.decideSignupRequest({
          discordGuildId: guild, contentId, discordUserId, actorDiscordUserId: "host", decision: "accept"
        })));
        assert.deepEqual(decisions.map(r => r.status).sort(), multi ? ["accepted", "accepted"] : ["accepted", "slot_filled"]);
        assert.equal((await repository.listSignupRequests(guild, contentId)).filter(r => r.status === "pending").length, multi ? 0 : 1);
      } else assert.deepEqual(claims.map(r => r.status).sort(), multi ? ["signed_up", "signed_up"] : ["signed_up", "slot_filled"]);
      const active = (await repository.getContentSnapshot(guild, contentId))!.signups;
      assert.equal(active.length, multi ? 2 : 1);
      // One-place uniqueness stays a database guarantee even when role capacity is conditional.
      await assert.rejects(pool.query(`insert into content_signups(content_id,discord_guild_id,discord_user_id,signup_type,content_role_slot_id)
        values($1,$2,$3,'standby',null)`, [contentId, guild, active[0].discordUserId]), /content_signups_one_active_user_per_content/);
      assert.equal((await repository.requestSignup({ discordGuildId: other, contentId, discordUserId: "intruder", roleSlotId: role })).status, "closed");
      await repository.requestSignup({ discordGuildId: guild, contentId, discordUserId: "standby", roleSlotId: null });
      if (approval) assert.equal((await repository.decideSignupRequest({
        discordGuildId: guild, contentId, discordUserId: "standby", actorDiscordUserId: "host", decision: "accept"
      })).status, "accepted");
      const count = (await panels.listPanelContent(guild, "source", new Date())).find(row => row.content.contentId === contentId)!;
      assert.equal(count.filledRoles, 1);
      assert.equal(count.totalRoles, 3);
      assert.equal(count.signedUpUsers, multi ? 2 : 1);
      assert.equal(count.content.multiSignupEnabled, multi);
      // Both immediate host exemptions still obey capacity.
      assert.equal((await repository.requestSignup({ discordGuildId: guild, contentId, discordUserId: "host", roleSlotId: party.slots[1].contentRoleSlotId })).status, "signed_up");
      assert.equal((await repository.requestSignup({ discordGuildId: guild, contentId, discordUserId: "assigned", roleSlotId: role, actorDiscordUserId: "host" })).status, multi ? "signed_up" : "slot_filled");
    }

    const shared = await create(true, true), contentId = shared.content.contentId;
    const first = shared.slots[0].contentRoleSlotId, last = shared.slots[2].contentRoleSlotId;
    const request = (user: string, roleSlotId: string | null) => repository.requestSignup({ discordGuildId: guild, contentId, discordUserId: user, roleSlotId });
    const assign = (user: string, roleSlotId: string) => repository.requestSignup({ discordGuildId: guild, contentId, discordUserId: user, roleSlotId, actorDiscordUserId: "host" });
    const decide = (user: string, decision: "accept" | "decline", actor = "host") => repository.decideSignupRequest({ discordGuildId: guild, contentId, discordUserId: user, actorDiscordUserId: actor, decision });
    const snapshot = async () => (await repository.getContentSnapshot(guild, contentId))!;
    await Promise.all([assign("resident", first), ...["a", "b", "c"].map(user => assign(user, last))]);
    const moving = await request("a", first);
    assert.equal((await request("a", first)).request!.requestId, moving.request!.requestId);
    assert.equal((await snapshot()).signups.find(s => s.discordUserId === "a")!.contentRoleSlotId, last);
    await decide("a", "decline");
    assert.equal((await snapshot()).signups.find(s => s.discordUserId === "a")!.contentRoleSlotId, last);
    await request("a", first);
    await request("removed-target", last);
    const removed = await repository.updateContentDetails({ discordGuildId: guild, contentId, actorDiscordUserId: "host", title: "Party", description: "", roleLabels: ["Tank", "Healer"] });
    assert.equal(removed!.movedToStandbyCount, 3);
    assert.equal(removed!.invalidatedRequestIds.length, 1);
    assert.ok(await repository.getPendingSignupRequest(guild, contentId, "a"));
    assert.deepEqual((await snapshot()).signups.filter(s => s.signupType === "standby").map(s => s.discordUserId).sort(), ["a", "b", "c"]);
    await repository.setHost(guild, contentId, "new-host", "host");
    assert.equal((await decide("a", "accept")).status, "not_host");
    assert.equal((await decide("a", "accept", "new-host")).status, "accepted");
    assert.deepEqual((await snapshot()).signups.filter(s => s.contentRoleSlotId === first).map(s => s.discordUserId).sort(), ["a", "resident"]);
    // Same-place reselection cancels a move without losing the confirmed place.
    await request("a", null);
    assert.equal((await request("a", first)).status, "already_signed_up");
    assert.equal(await repository.getPendingSignupRequest(guild, contentId, "a"), undefined);
    await request("a", null);
    await decide("a", "accept", "new-host");
    assert.equal((await snapshot()).signups.find(s => s.discordUserId === "a")!.signupType, "standby");
    await Promise.all([request("a", first), request("a", shared.slots[1].contentRoleSlotId)]);
    assert.equal((await repository.listSignupRequests(guild, contentId)).filter(r => r.discordUserId === "a" && r.status === "pending").length, 1);
    assert.equal((await snapshot()).signups.filter(s => s.discordUserId === "a").length, 1);
    await repository.markStarted(guild, contentId, new Date(), "new-host");
    assert.ok(await repository.getPendingSignupRequest(guild, contentId, "a"));
    const reopenedRepository = createContentRepository(pool);
    assert.equal((await reopenedRepository.getContentSnapshot(guild, contentId))!.content.multiSignupEnabled, true);
    await repository.markEnded(guild, contentId, "new-host");
    assert.equal(await repository.getPendingSignupRequest(guild, contentId, "a"), undefined);
    assert.equal((await request("new", null)).status, "closed");

    const immediate = await create(true), immediateId = immediate.content.contentId;
    await Promise.all(["a", "b"].map(user => repository.upsertSignup(guild, immediateId, immediate.slots[0].contentRoleSlotId, user)));
    await Promise.all(immediate.slots.slice(1).map(slot => repository.upsertSignup(guild, immediateId, slot.contentRoleSlotId, "a")));
    const occupants = (await repository.getContentSnapshot(guild, immediateId))!.signups;
    assert.equal(occupants.length, 2);
    assert.equal(occupants.filter(s => s.discordUserId === "a").length, 1);
    assert.equal(occupants.find(s => s.discordUserId === "b")!.contentRoleSlotId, immediate.slots[0].contentRoleSlotId);
  } finally {
    await pool.query("delete from content_items where discord_guild_id=any($1)", [[guild, other]]);
    await pool.query("delete from discord_guild_lifecycle where discord_guild_id=any($1)", [[guild, other]]);
    await pool.end();
  }
});
