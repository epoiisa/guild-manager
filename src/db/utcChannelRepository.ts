import type { PostgresPool } from "./postgres.js";

interface Queryable {
  query: PostgresPool["query"];
}

export interface UtcChannelRecord {
  discordGuildId: string;
  discordChannelId: string;
}

interface UtcChannelRow {
  discord_guild_id: string;
  discord_channel_id: string;
}

export function createUtcChannelRepository(pool: PostgresPool) {
  return {
    getUtcChannel: (discordGuildId: string) => getUtcChannel(pool, discordGuildId),
    setUtcChannel: (discordGuildId: string, discordChannelId: string) =>
      setUtcChannel(pool, discordGuildId, discordChannelId),
    removeUtcChannel: (discordGuildId: string) => removeUtcChannel(pool, discordGuildId)
  };
}

async function getUtcChannel(pool: Queryable, discordGuildId: string): Promise<UtcChannelRecord | undefined> {
  const result = await pool.query<UtcChannelRow>(
    `
    select discord_guild_id, discord_channel_id
    from utc_voice_channels
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );

  const row = result.rows[0];
  return row ? mapUtcChannel(row) : undefined;
}

async function setUtcChannel(pool: Queryable, discordGuildId: string, discordChannelId: string): Promise<void> {
  await pool.query(
    `
    insert into utc_voice_channels (discord_guild_id, discord_channel_id, updated_at)
    values ($1, $2, now())
    on conflict (discord_guild_id) do update set
      discord_channel_id = excluded.discord_channel_id,
      updated_at = excluded.updated_at
    `,
    [discordGuildId, discordChannelId]
  );
}

async function removeUtcChannel(pool: Queryable, discordGuildId: string): Promise<void> {
  await pool.query(
    `
    delete from utc_voice_channels
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
}

function mapUtcChannel(row: UtcChannelRow): UtcChannelRecord {
  return {
    discordGuildId: row.discord_guild_id,
    discordChannelId: row.discord_channel_id
  };
}
