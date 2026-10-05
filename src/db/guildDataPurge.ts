import type { PostgresPool } from "./postgres.js";
import { lockMembershipLifecycleTenant } from "./membershipLifecycleRepository.js";

interface Queryable {
  query: PostgresPool["query"];
}

export async function purgeGuildOwnedData(
  pool: Queryable,
  discordGuildId: string
): Promise<void> {
  await lockMembershipLifecycleTenant(pool, discordGuildId);
  await pool.query(
    "select set_config('guild_manager.account_purge_in_progress', 'on', true)"
  );
  await pool.query("delete from member_kick_activity_cleanup where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_kick_activity_revocations where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from character_kick_recovery where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from guild_member_access where discord_guild_id = $1", [discordGuildId]);

  // Acquire the same configuration fence as panel publication before deleting its records.
  await pool.query("delete from content_channel_configs where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from content_panel_messages where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from entry_panel_channels where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from entry_panel_messages where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from entry_panel_roles where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from character_specialisations where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from specialisation_requests where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from specialisation_catalogue_exclusions where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from specialisation_reviewer_configs where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from reviewer_role_bindings where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from content_signups where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from content_role_slots where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from content_items where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from content_templates where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from giveaway_winners where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from giveaway_reactions where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from giveaway_entries where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from giveaways where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from open_applications where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from application_classes where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from tickets where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from ticket_classes where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from reaction_role_subscriptions where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from reaction_role_emoji_placements where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from giveaway_notification_roles where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from reaction_role_configs where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from member_group_position_appointments where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_group_positions where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from membership_evidence_cleanup where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_registration_lifecycle where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from account_transactions where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from regear_claims where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from regear_contents where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from account_status_events where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from character_accounts where discord_guild_id = $1", [discordGuildId]);

  await pool.query("delete from discord_guild_defaults where discord_guild_id = $1", [discordGuildId]);
  await pool.query(
    `
    delete from member_group_role_configs
    where member_group_id in (
      select member_group_id
      from member_groups
      where discord_guild_id = $1
    )
    `,
    [discordGuildId]
  );
  await pool.query("delete from configured_albion_guilds where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from configured_albion_alliances where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_group_profiles where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from discord_user_main_characters where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from discord_user_characters where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from character_registration_history where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from discord_user_custom_nicknames where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from character_role_configs where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_update_schedules where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from temporary_voice_channels where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from temporary_voice_configs where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from utc_voice_channels where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from log_channel_configs where discord_guild_id = $1", [discordGuildId]);
  await pool.query("delete from member_groups where discord_guild_id = $1", [discordGuildId]);
}
