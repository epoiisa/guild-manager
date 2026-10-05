import type { PostgresPool } from "./postgres.js";

/** Configuration is shared; a kick revokes a member's roles, never these bindings. */
export function createKickRolesRepository(pool: Pick<PostgresPool, "query">) {
  return {
    async listAuthorityRoleIds(discordGuildId: string): Promise<string[]> {
      const result = await pool.query<{ discord_role_id: string }>(`
        select discord_role_id from entry_panel_roles where discord_guild_id = $1
        union select discord_role_id from reviewer_role_bindings where discord_guild_id = $1
        union select reviewer_role_id from application_classes where discord_guild_id = $1
        union select reviewer_role_id from ticket_classes where discord_guild_id = $1
        union select discord_role_id from member_group_positions where discord_guild_id = $1
      `, [discordGuildId]);
      return result.rows.map(row => row.discord_role_id);
    }
  };
}
