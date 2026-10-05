import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PostgresPool } from "./postgres.js";
import { createReviewerRepository } from "./reviewerRepository.js";
import { migrateDatabaseSchema } from "./schema.js";

/** Exercise the populated schema-41 transition without touching application data. */
export async function runConfigurationMigrationSmoke(databaseUrl: string, admin: PostgresPool): Promise<void> {
  const schema = `smoke_configuration_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  await admin.query(`create schema "${schema}"`);
  try {
    await migrateDatabaseSchema(pool);
    // Reconstruct the three retired configuration surfaces from schema 41.
    await pool.query(`
      delete from guild_manager_schema_migrations where version = 42;
      drop index reviewer_role_bindings_unique_role;
      alter table reviewer_role_bindings add column albion_server text;
      alter table reviewer_role_bindings add constraint reviewer_role_bindings_server_check
        check (albion_server is null or albion_server in ('americas', 'asia', 'europe'));
      create unique index reviewer_role_bindings_unique_scope_role
        on reviewer_role_bindings (discord_guild_id, domain, coalesce(albion_server, 'all'), discord_role_id);
      alter table temporary_voice_configs add column channel_name_prefix text not null default '';
      alter table temporary_voice_configs add constraint temporary_voice_configs_prefix_length
        check (char_length(channel_name_prefix) <= 32);
      alter table entry_panel_roles drop constraint entry_panel_roles_role_kind_check;
      alter table entry_panel_roles add constraint entry_panel_roles_role_kind_check
        check (role_kind in ('accounts_manager', 'giveaway_host'));
      insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
        values ('one', 'active', 'First', now()), ('two', 'active', 'Second', now());
      insert into reviewer_role_bindings (discord_guild_id, domain, albion_server, discord_role_id, created_by_discord_user_id)
        values ('one', 'regears', null, 'shared', 'original'),
          ('one', 'regears', 'asia', 'shared', 'duplicate'),
          ('one', 'regears', 'europe', 'shared', 'duplicate'),
          ('one', 'regears', 'asia', 'asia-only', 'original'),
          ('one', 'specialisation', 'europe', 'shared', 'original'),
          ('two', 'regears', 'americas', 'shared', 'other');
      insert into temporary_voice_configs (discord_guild_id, base_channel_id, channel_name_prefix)
        values ('one', 'base-one', '🎙️┃'), ('two', 'base-two', 'Temporary ');
      insert into entry_panel_roles (discord_guild_id, role_kind, discord_role_id)
        values ('one', 'accounts_manager', 'account-role'), ('one', 'giveaway_host', 'host-role'),
          ('two', 'accounts_manager', 'other-account-role'), ('two', 'giveaway_host', 'other-host-role');
    `);
    await migrateDatabaseSchema(pool);
    const reviewers = createReviewerRepository(pool);
    assert.deepEqual(await reviewers.effectiveRoleIds("one", "regears"), ["asia-only", "shared"]);
    assert.deepEqual(await reviewers.effectiveRoleIds("one", "specialisation"), ["shared"]);
    assert.deepEqual(await reviewers.effectiveRoleIds("two", "regears"), ["shared"]);
    assert.equal((await reviewers.listBindings("one", "regears")).find(row => row.discordRoleId === "shared")?.createdByDiscordUserId, "original");
    await reviewers.addBinding("one", "regears", "shared", "updated");
    assert.equal((await reviewers.listBindings("one", "regears")).length, 2);
    assert.equal(await reviewers.removeBinding("one", "regears", "shared", "updated"), true);
    assert.deepEqual(await reviewers.effectiveRoleIds("one", "regears"), ["asia-only"]);
    assert.deepEqual(await reviewers.effectiveRoleIds("one", "specialisation"), ["shared"]);
    assert.deepEqual(await reviewers.effectiveRoleIds("two", "regears"), ["shared"]);
    assert.deepEqual((await pool.query("select discord_guild_id, base_channel_id from temporary_voice_configs order by discord_guild_id")).rows,
      [{ discord_guild_id: "one", base_channel_id: "base-one" }, { discord_guild_id: "two", base_channel_id: "base-two" }]);
    assert.deepEqual((await pool.query("select discord_role_id from entry_panel_roles order by discord_role_id")).rows,
      [{ discord_role_id: "account-role" }, { discord_role_id: "other-account-role" }]);
    assert.equal((await pool.query(`select 1 from information_schema.columns where table_schema = $1
      and ((table_name = 'reviewer_role_bindings' and column_name = 'albion_server')
        or (table_name = 'temporary_voice_configs' and column_name = 'channel_name_prefix'))`, [schema])).rowCount, 0);
    await assert.rejects(pool.query("insert into entry_panel_roles values ('one', 'giveaway_host', 'retired')"), { code: "23514" });
    await migrateDatabaseSchema(pool);
    assert.deepEqual(await reviewers.effectiveRoleIds("one", "regears"), ["asia-only"]);
  } finally {
    await pool.end();
    await admin.query(`drop schema "${schema}" cascade`);
  }
}
