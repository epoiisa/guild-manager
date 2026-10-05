import type { PostgresPool } from "./postgres.js";

export interface LogChannelRecord {
  discordGuildId: string;
  discordChannelId: string;
  configuredByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface LogChannelRow {
  discord_guild_id: string;
  discord_channel_id: string;
  configured_by_discord_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export function createLogChannelRepository(pool: Pick<PostgresPool, "query">) {
  return {
    async get(discordGuildId: string): Promise<LogChannelRecord | undefined> {
      const result = await pool.query<LogChannelRow>(
        `select discord_guild_id, discord_channel_id, configured_by_discord_user_id, created_at, updated_at
         from log_channel_configs where discord_guild_id = $1`,
        [discordGuildId]
      );
      const row = result.rows[0];
      return row && {
        discordGuildId: row.discord_guild_id,
        discordChannelId: row.discord_channel_id,
        configuredByDiscordUserId: row.configured_by_discord_user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },
    async set(discordGuildId: string, discordChannelId: string, configuredByDiscordUserId: string): Promise<void> {
      await pool.query(
        `insert into log_channel_configs (discord_guild_id, discord_channel_id, configured_by_discord_user_id)
         values ($1, $2, $3)
         on conflict (discord_guild_id) do update set
           discord_channel_id = excluded.discord_channel_id,
           configured_by_discord_user_id = excluded.configured_by_discord_user_id,
           updated_at = now()`,
        [discordGuildId, discordChannelId, configuredByDiscordUserId]
      );
    },
    async clear(discordGuildId: string): Promise<void> {
      await pool.query("delete from log_channel_configs where discord_guild_id = $1", [discordGuildId]);
    }
  };
}

export type LogChannelRepository = ReturnType<typeof createLogChannelRepository>;
