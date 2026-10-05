import { cleanupDeadlineSql, mapContent, type ContentItem, type ContentItemRow } from "./contentRepository.js";
import type { PostgresPool } from "./postgres.js";

export interface ContentPanelEntry { content: ContentItem; filledRoles: number; totalRoles: number; signedUpUsers?: number }
export type { ContentPanelPublication, BeginPanelPublicationInput } from "./panelPublicationRepository.js";
import { createPanelPublicationRepository } from "./panelPublicationRepository.js";

export function createContentPanelRepository(pool: PostgresPool) {
  return {
    async listPanelContent(discordGuildId: string, sourceChannelId: string, now: Date): Promise<ContentPanelEntry[]> {
      const result = await pool.query<ContentItemRow & { total_roles: number; filled_roles: number; signed_up_users: number }>(`
        with eligible as (
          select * from content_items where discord_guild_id = $1 and source_channel_id = $2
            and state in ('scheduled', 'unscheduled', 'active') and ${cleanupDeadlineSql} > $3
        ), slots as (
          select s.discord_guild_id, s.content_id, count(*)::int as total_roles
          from content_role_slots s join eligible c on c.discord_guild_id = s.discord_guild_id and c.content_id = s.content_id
          group by s.discord_guild_id, s.content_id
        ), filled as (
          select s.discord_guild_id, s.content_id, count(distinct s.content_role_slot_id)::int as filled_roles,
            count(*)::int as signed_up_users
          from content_signups s join eligible c on c.discord_guild_id = s.discord_guild_id and c.content_id = s.content_id
          where s.state = 'active' and s.signup_type = 'role'
            and exists (select 1 from content_role_slots r where r.discord_guild_id = s.discord_guild_id
              and r.content_id = s.content_id and r.content_role_slot_id = s.content_role_slot_id)
          group by s.discord_guild_id, s.content_id
        ) select c.*, coalesce(slots.total_roles, 0) as total_roles, coalesce(filled.filled_roles, 0) as filled_roles,
          coalesce(filled.signed_up_users, 0) as signed_up_users
        from eligible c left join slots using (discord_guild_id, content_id)
        left join filled using (discord_guild_id, content_id)
        order by c.content_id`, [discordGuildId, sourceChannelId, now]);
      return result.rows.map(row => ({ content: mapContent(row), filledRoles: row.filled_roles, totalRoles: row.total_roles, signedUpUsers: row.signed_up_users }));
    },
    ...createPanelPublicationRepository(pool, "content")
  };
}
export type ContentPanelRepository = ReturnType<typeof createContentPanelRepository>;
