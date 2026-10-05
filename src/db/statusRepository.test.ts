import assert from "node:assert/strict";
import test from "node:test";
import { createStatusRepository } from "./statusRepository.js";

test("status snapshot reads only configuration, adds templates and categories, and scopes every query", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("from member_groups mg")) return rows([{ member_group_id: "group", albion_server: "asia", group_type: "guild", group_name: "Dreamweavers", managed: true, albion_alliance_tag: null, is_default_albion_guild: true }]);
    if (sql.includes("from member_group_role_configs")) return rows([{ member_group_id: "group", discord_role_id: "role" }]);
    if (sql.includes("from member_group_positions")) return rows([{ member_group_position_id: "position", member_group_id: "group", name: "Queen", discord_role_id: "position-role" }]);
    if (sql.includes("from character_role_configs")) return rows([{ character_role_config_id: "character", albion_server: null, discord_role_id: "character-role" }]);
    if (sql.includes("from reaction_role_configs")) return rows([{ reaction_role_config_id: "reaction", discord_role_id: "reaction-role", reaction_role_emoji_placement_id: "placement", channel_id: "channel", message_id: "message", emoji_display_value: "🎁" }]);
    if (sql.includes("from reviewer_role_bindings")) return rows([{ reviewer_binding_id: "reviewer", domain: "regears", discord_role_id: "reviewer-role" }]);
    if (sql.includes("from content_templates")) return rows([{ content_template_id: "template", name: "Roam" }]);
    if (sql.includes("from application_classes class")) return rows([{ application_class_id: "application", name: "Members", enabled: true, albion_server: "asia", member_group_id: "group", member_group_name: "Dreamweavers", member_group_type: "guild", ticket_category_id: "category", reviewer_role_id: "reviewer-role", active_role_id: "active-role" }]);
    if (sql.includes("from ticket_classes")) return rows([{ ticket_class_id: "ticket", name: "Ticket", enabled: true, ticket_category_id: "ticket-category", reviewer_role_id: "reviewer-role" }]);
    if (sql.includes("from member_update_schedules")) return rows([{ cadence: "daily", weekday: null, hour_utc: 2, minute_utc: 0 }]);
    if (sql.includes("from content_channel_configs")) return rows([{ discord_channel_id: "content" }]);
    if (sql.includes("from log_channel_configs")) return rows([{ discord_channel_id: "log" }]);
    if (sql.includes("from utc_voice_channels")) return rows([{ discord_channel_id: "utc" }]);
    if (sql.includes("from temporary_voice_configs")) return rows([{ base_channel_id: "temporary" }]);
    if (sql.includes("from specialisation_catalogue_exclusions")) return rows([{ catalogue_key: "tree:axe" }]);
    if (sql.includes("from entry_panel_channels")) return rows([{ feature: "accounts", discord_channel_id: "accounts" }]);
    if (sql.includes("from entry_panel_roles")) return rows([{ role_kind: "accounts_manager", discord_role_id: "managers" }]);
    throw new Error(`Unexpected SQL: ${sql}`);
  } } as never;
  const snapshot = await createStatusRepository(pool).getSnapshot("guild");
  assert.equal(calls.length, 17);
  assert.equal(snapshot.logChannelId, "log");
  assert.ok(calls.every((call) => call.values.length === 1 && call.values[0] === "guild"));
  assert.deepEqual(snapshot.memberGroups[0], { memberGroupId: "group", albionServer: "asia", groupType: "guild", groupName: "Dreamweavers", managed: true, isDefaultAlbionGuild: true, discordRoleIds: ["role"], albionAllianceTag: undefined });
  assert.deepEqual(snapshot.positions, [{ memberGroupPositionId: "position", memberGroupId: "group", name: "Queen", discordRoleId: "position-role" }]);
  assert.deepEqual(snapshot.partyTemplates, [{ contentTemplateId: "template", name: "Roam" }]);
  assert.equal(snapshot.applicationClasses[0].ticketCategoryId, "category");
  assert.equal(snapshot.ticketClasses[0].ticketCategoryId, "ticket-category");
  assert.deepEqual(snapshot.memberUpdateSchedule, { cadence: "daily", weekday: null, hourUtc: 2, minuteUtc: 0 });
});

test("status SQL excludes population, appointments, legacy grants, and run-history reads", async () => {
  const calls: string[] = [];
  const pool = { query: async (sql: string) => { calls.push(sql); return rows([]); } } as never;
  await createStatusRepository(pool).getSnapshot("guild");
  const all = calls.join("\n");
  assert.doesNotMatch(all, /registered_user_count|member_group_profiles|position_appointments|regear_admin_grants|last_run_at|last_success_at|last_error|tracked_channel_count/);
  assert.match(all, /from content_templates/);
  assert.match(all, /ticket_category_id/);
  assert.match(all, /class\.archived_at is null/);
});

function rows<T>(value: T[]) { return { rows: value, rowCount: value.length }; }
