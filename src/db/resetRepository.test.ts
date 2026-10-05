import assert from "node:assert/strict";
import test from "node:test";
import { createResetRepository } from "./resetRepository.js";

const expectedGuildOwnedTables = [
  "member_kick_activity_cleanup",
  "member_kick_activity_revocations",
  "character_kick_recovery",
  "guild_member_access",
  "content_channel_configs",
  "content_panel_messages",
  "entry_panel_channels",
  "entry_panel_messages",
  "entry_panel_roles",
  "character_specialisations",
  "specialisation_requests",
  "specialisation_catalogue_exclusions",
  "specialisation_reviewer_configs",
  "reviewer_role_bindings",
  "content_signups",
  "content_role_slots",
  "content_items",
      "content_templates",
      "giveaway_winners",
      "giveaway_reactions",
      "giveaway_entries",
      "giveaways",
      "open_applications",
  "application_classes",
  "tickets",
  "ticket_classes",
  "reaction_role_subscriptions",
  "reaction_role_emoji_placements",
  "giveaway_notification_roles",
  "reaction_role_configs",
  "member_group_position_appointments",
  "member_group_positions",
  "membership_evidence_cleanup",
  "member_registration_lifecycle",
  "account_transactions",
  "regear_claims",
  "regear_contents",
  "account_status_events",
  "character_accounts",
  "discord_guild_defaults",
  "member_group_role_configs",
  "configured_albion_guilds",
  "configured_albion_alliances",
  "member_group_profiles",
  "discord_user_main_characters",
  "discord_user_characters",
  "character_registration_history",
  "discord_user_custom_nicknames",
  "character_role_configs",
  "member_update_schedules",
  "temporary_voice_channels",
  "temporary_voice_configs",
  "utc_voice_channels",
  "log_channel_configs",
  "member_groups"
];

test("guild reset deletes every guild-owned table without truncating or restarting sequences", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("from discord_guild_lifecycle")) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    connect: async () => client
  } as unknown as Parameters<typeof createResetRepository>[0];

  await createResetRepository(pool).purgeGuildData("guild-1");

  const normalizedSql = queries.map((query) => query.sql.replace(/\s+/g, " ").trim().toLowerCase());
  const deleteTables = normalizedSql
    .filter((sql) => sql.startsWith("delete from "))
    .map((sql) => sql.split(" ")[2]);

  assert.deepEqual(deleteTables, expectedGuildOwnedTables);
  assert.equal(normalizedSql[0], "begin");
  assert.match(normalizedSql[1] ?? "", /select status from discord_guild_lifecycle/);
  assert.equal(normalizedSql.at(-1), "commit");
  assert.equal(
    normalizedSql.some((sql) =>
      /\btruncate\b|\brestart identity\b|\balter sequence\b|\bpg_sequences\b/.test(sql)
    ),
    false
  );
  assert.equal(
    normalizedSql.some((sql) => sql.startsWith("delete from discord_guild_lifecycle")),
    false
  );
  for (const query of queries.filter((query) => query.sql.toLowerCase().includes("discord_guild_id = $1"))) {
    assert.deepEqual(query.values, ["guild-1"]);
  }
  assert.equal(released, true);
});

test("guild reset refuses to purge an inactive guild and preserves the transaction boundary", async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
      if (sql.includes("from discord_guild_lifecycle")) {
        return { rows: [{ status: "inactive" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    connect: async () => client
  } as unknown as Parameters<typeof createResetRepository>[0];

  await assert.rejects(
    createResetRepository(pool).purgeGuildData("guild-1"),
    /not active/
  );

  assert.equal(queries[0], "begin");
  assert.match(queries[1] ?? "", /from discord_guild_lifecycle/);
  assert.equal(queries[2], "rollback");
  assert.equal(released, true);
});

test("guild reset rolls back and releases its connection after a delete failure", async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      queries.push(normalized);
      if (sql.includes("from discord_guild_lifecycle")) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      if (normalized.startsWith("delete from open_applications")) {
        throw new Error("delete failed");
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    }
  };
  const pool = {
    connect: async () => client
  } as unknown as Parameters<typeof createResetRepository>[0];

  await assert.rejects(
    createResetRepository(pool).purgeGuildData("guild-1"),
    /delete failed/
  );

  assert.equal(queries.at(-1), "rollback");
  assert.equal(released, true);
});
