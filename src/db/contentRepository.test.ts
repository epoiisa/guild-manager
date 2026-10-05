import assert from "node:assert/strict";
import test from "node:test";
import { createContentRepository } from "./contentRepository.js";

test("due start work includes active pre-send failures but excludes claimed delivery and expired parties", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values }); return { rows: [] };
  } } as unknown as Parameters<typeof createContentRepository>[0];
  const now = new Date("2026-10-02T13:01:00Z");
  await createContentRepository(pool).listContentDueStart(now);
  const sql = calls[0].sql.replace(/\s+/g, " ");
  assert.match(sql, /state = 'scheduled'.*scheduled_start_at <= \$1/);
  assert.match(sql, /or \(state = 'active' and start_notification_message_id is null and start_notification_claimed_at is null\)/);
  assert.match(sql, /end\) > \$1/);
  assert.deepEqual(calls[0].values, [now]);
});

test("party list reads are tenant-scoped and exclude archived content", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    }
  } as unknown as Parameters<typeof createContentRepository>[0];

  const content = await createContentRepository(pool).listUnarchivedContent("guild-1");

  assert.deepEqual(content, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /discord_guild_id = \$1 and state <> 'archived'/);
  assert.match(calls[0].sql, /order by coalesce\(scheduled_start_at, started_at, created_at\) asc, content_id asc/);
  assert.deepEqual(calls[0].values, ["guild-1"]);
});

test("party edits move signups from every trailing removed role to standby", async () => {
  for (const [oldRoleCount, newRoleCount] of [[10, 5], [25, 1], [3, 2]]) {
    const contentRow = {
      content_id: "content-1",
      discord_guild_id: "guild-1",
      source_channel_id: "source-1",
      thread_channel_id: "thread-1",
      leader_discord_user_id: "host-1",
      title: "Updated Party",
      description: "Updated description.",
      scheduled_start_at: new Date("2026-08-21T12:00:00.000Z"),
      graphic_attachment_name: null,
      state: "scheduled",
      initial_message_id: "announcement-1",
      control_message_id: "control-1",
      start_notification_message_id: null,
      last_rendered_at: null,
      started_at: null,
      ended_at: null,
      cancelled_at: null,
      archived_at: null,
      created_at: new Date("2026-08-20T12:00:00.000Z"),
      updated_at: new Date("2026-08-20T12:00:00.000Z")
    };
    let slots = Array.from({ length: oldRoleCount }, (_, index) => ({
      content_role_slot_id: `slot-${index + 1}`,
      content_id: "content-1",
      discord_guild_id: "guild-1",
      slot_index: index + 1,
      label: `Role ${index + 1}`
    }));
    const signups = Array.from({ length: oldRoleCount - newRoleCount }, (_, index) => {
      const slotIndex = newRoleCount + index + 1;
      return {
        content_signup_id: `signup-${slotIndex}`,
        content_id: "content-1",
        content_role_slot_id: `slot-${slotIndex}` as string | null,
        discord_guild_id: "guild-1",
        discord_user_id: `user-${slotIndex}`,
        signup_type: "role" as "role" | "standby",
        state: "active",
        removed_at: null,
        removed_by_discord_user_id: null
      };
    });

    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized === "begin" || normalized === "commit" || normalized === "rollback") return { rows: [], rowCount: 0 };
        if (normalized.includes("from content_role_slots") && normalized.endsWith("for update")) return { rows: slots, rowCount: slots.length };
        if (normalized.startsWith("select content_id from content_items")) return { rows: [contentRow], rowCount: 1 };
        if (normalized.startsWith("update content_signup_requests")) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("update content_items")) return { rows: [contentRow], rowCount: 1 };
        if (normalized.startsWith("update content_role_slots")) {
          const slot = slots.find((candidate) => candidate.slot_index === values[2]);
          if (slot) slot.label = String(values[3]);
          return { rows: [], rowCount: slot ? 1 : 0 };
        }
        if (normalized.startsWith("update content_signups as signup")) {
          const removedAfter = Number(values[2]);
          let moved = 0;
          for (const signup of signups) {
            const slotIndex = Number(signup.content_role_slot_id?.replace("slot-", ""));
            if (signup.signup_type === "role" && slotIndex > removedAfter) {
              signup.content_role_slot_id = null;
              signup.signup_type = "standby";
              moved += 1;
            }
          }
          return { rows: [], rowCount: moved };
        }
        if (normalized.startsWith("delete from content_role_slots")) {
          slots = slots.filter((slot) => slot.slot_index <= Number(values[2]));
          return { rows: [], rowCount: oldRoleCount - slots.length };
        }
        throw new Error(`Unexpected transaction query: ${normalized}`);
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("from content_items")) return { rows: [contentRow], rowCount: 1 };
        if (normalized.includes("from content_role_slots")) return { rows: slots, rowCount: slots.length };
        if (normalized.includes("from content_signups")) return { rows: signups, rowCount: signups.length };
        throw new Error(`Unexpected snapshot query: ${normalized}`);
      }
    } as unknown as Parameters<typeof createContentRepository>[0];

    const result = await createContentRepository(pool).updateContentDetails({
      discordGuildId: "guild-1",
      contentId: "content-1",
      title: "Updated Party",
      description: "Updated description.",
      roleLabels: Array.from({ length: newRoleCount }, (_, index) => `Updated Role ${index + 1}`)
    });

    assert.equal(result?.movedToStandbyCount, oldRoleCount - newRoleCount);
    assert.equal(result?.snapshot.slots.length, newRoleCount);
    assert.deepEqual(result?.snapshot.slots.map((slot) => slot.slotIndex), Array.from({ length: newRoleCount }, (_, index) => index + 1));
    assert.ok(result?.snapshot.signups.every((signup) => signup.signupType === "standby" && signup.contentRoleSlotId === null));
  }
});

test("party edits require at least one role before opening a transaction", async () => {
  let connectCalled = false;
  const pool = {
    connect: async () => {
      connectCalled = true;
      throw new Error("The repository should reject before connecting.");
    }
  } as unknown as Parameters<typeof createContentRepository>[0];

  await assert.rejects(
    createContentRepository(pool).updateContentDetails({
      discordGuildId: "guild-1",
      contentId: "content-1",
      title: "Party",
      description: "",
      roleLabels: []
    }),
    /Provide at least one role line/
  );
  assert.equal(connectCalled, false);
});
