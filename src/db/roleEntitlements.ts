import type { PostgresPool } from "./postgres.js";

interface Queryable { query: PostgresPool["query"]; }

/** All current Discord role entitlements, scoped to one Discord server and member. */
export async function listQualifiedRoleIdsForUser(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string
): Promise<string[]> {
  const result = await pool.query<{ discord_role_id: string }>(
    `
    select entitlement.discord_role_id from (
    select application_class.active_role_id as discord_role_id
    from open_applications application
    join application_classes application_class
      on application_class.discord_guild_id = application.discord_guild_id
      and application_class.application_class_id = application.application_class_id
    where application.discord_guild_id = $1
      and application.applicant_discord_user_id = $2
      and application.channel_status = 'open'
      and application.status in ('open', 'awaiting_ingame_membership')
      and application_class.archived_at is null
      and application_class.active_role_id is not null
    union
    select crc.discord_role_id
    from discord_user_characters duc
    join character_role_configs crc
      on crc.discord_guild_id = duc.discord_guild_id
      and (crc.albion_server is null or crc.albion_server = duc.albion_server)
    where duc.discord_guild_id = $1
      and duc.discord_user_id = $2
    union
    select mgrc.discord_role_id
    from member_group_profiles mgp
    join member_group_role_configs mgrc
      on mgrc.member_group_id = mgp.member_group_id
    where mgp.discord_guild_id = $1
      and mgp.discord_user_id = $2
    union
    select position.discord_role_id
    from member_group_profiles mgp
    join member_group_position_appointments appointment
      on appointment.member_group_profile_id = mgp.member_group_profile_id
      and appointment.discord_guild_id = mgp.discord_guild_id
    join member_group_positions position
      on position.member_group_position_id = appointment.member_group_position_id
      and position.discord_guild_id = appointment.discord_guild_id
    where mgp.discord_guild_id = $1
      and mgp.discord_user_id = $2
    union
    select distinct config.discord_role_id
    from reaction_role_configs config
    join reaction_role_subscriptions subscription
      on subscription.reaction_role_config_id = config.reaction_role_config_id
      and subscription.discord_guild_id = config.discord_guild_id
      and subscription.discord_user_id = $2
    where config.discord_guild_id = $1
      and exists (
        select 1
        from member_group_profiles profile
        join member_groups member_group
          on member_group.member_group_id = profile.member_group_id
          and member_group.discord_guild_id = profile.discord_guild_id
        where profile.discord_guild_id = config.discord_guild_id
          and profile.discord_user_id = subscription.discord_user_id
      )
    ) entitlement
    where not exists (
      select 1 from guild_member_access access
      where access.discord_guild_id = $1 and access.discord_user_id = $2
        and (access.blocked or entitlement.discord_role_id = any(access.revoked_role_ids))
    )
    `,
    [discordGuildId, discordUserId]
  );
  return result.rows.map((row) => row.discord_role_id);
}
