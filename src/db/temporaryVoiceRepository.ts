import type { PostgresPool } from "./postgres.js";

interface Queryable {
  query: PostgresPool["query"];
}

export interface TemporaryVoiceConfig {
  discordGuildId: string;
  baseChannelId: string;
}

export interface TemporaryVoiceChannelRecord {
  discordGuildId: string;
  discordChannelId: string;
  ownerDiscordUserId: string;
  baseChannelId: string;
}

interface TemporaryVoiceConfigRow {
  discord_guild_id: string;
  base_channel_id: string;
}

interface TemporaryVoiceChannelRow {
  discord_guild_id: string;
  discord_channel_id: string;
  owner_discord_user_id: string;
  base_channel_id: string;
}

export function createTemporaryVoiceRepository(pool: PostgresPool) {
  return {
    getConfig: (discordGuildId: string) => getConfig(pool, discordGuildId),
    setBaseChannel: (discordGuildId: string, baseChannelId: string) =>
      setBaseChannel(pool, discordGuildId, baseChannelId),
    clearConfig: (discordGuildId: string) => clearConfig(pool, discordGuildId),
    getChannelByOwner: (discordGuildId: string, ownerDiscordUserId: string) =>
      getChannelByOwner(pool, discordGuildId, ownerDiscordUserId),
    getChannel: (discordGuildId: string, discordChannelId: string) =>
      getChannel(pool, discordGuildId, discordChannelId),
    listChannels: (discordGuildId: string) => listChannels(pool, discordGuildId),
    addChannel: (record: TemporaryVoiceChannelRecord) => addChannel(pool, record),
    removeChannel: (discordGuildId: string, discordChannelId: string) =>
      removeChannel(pool, discordGuildId, discordChannelId)
  };
}

async function getConfig(pool: Queryable, discordGuildId: string): Promise<TemporaryVoiceConfig | undefined> {
  const result = await pool.query<TemporaryVoiceConfigRow>(
    `
    select discord_guild_id, base_channel_id
    from temporary_voice_configs
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
  return result.rows[0] ? mapConfig(result.rows[0]) : undefined;
}

async function setBaseChannel(pool: Queryable, discordGuildId: string, baseChannelId: string): Promise<void> {
  await pool.query(
    `
    insert into temporary_voice_configs (discord_guild_id, base_channel_id, updated_at)
    values ($1, $2, now())
    on conflict (discord_guild_id) do update set
      base_channel_id = excluded.base_channel_id,
      updated_at = excluded.updated_at
    `,
    [discordGuildId, baseChannelId]
  );
}

async function clearConfig(pool: Queryable, discordGuildId: string): Promise<boolean> {
  const result = await pool.query(
    "delete from temporary_voice_configs where discord_guild_id = $1",
    [discordGuildId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function getChannelByOwner(
  pool: Queryable,
  discordGuildId: string,
  ownerDiscordUserId: string
): Promise<TemporaryVoiceChannelRecord | undefined> {
  const result = await pool.query<TemporaryVoiceChannelRow>(
    `
    select discord_guild_id, discord_channel_id, owner_discord_user_id, base_channel_id
    from temporary_voice_channels
    where discord_guild_id = $1 and owner_discord_user_id = $2 and ownership_revoked_at is null
    `,
    [discordGuildId, ownerDiscordUserId]
  );
  return result.rows[0] ? mapChannel(result.rows[0]) : undefined;
}

async function getChannel(
  pool: Queryable,
  discordGuildId: string,
  discordChannelId: string
): Promise<TemporaryVoiceChannelRecord | undefined> {
  const result = await pool.query<TemporaryVoiceChannelRow>(
    `
    select discord_guild_id, discord_channel_id, owner_discord_user_id, base_channel_id
    from temporary_voice_channels
    where discord_guild_id = $1 and discord_channel_id = $2
    `,
    [discordGuildId, discordChannelId]
  );
  return result.rows[0] ? mapChannel(result.rows[0]) : undefined;
}

async function listChannels(pool: Queryable, discordGuildId: string): Promise<TemporaryVoiceChannelRecord[]> {
  const result = await pool.query<TemporaryVoiceChannelRow>(
    `
    select discord_guild_id, discord_channel_id, owner_discord_user_id, base_channel_id
    from temporary_voice_channels
    where discord_guild_id = $1
    order by created_at, discord_channel_id
    `,
    [discordGuildId]
  );
  return result.rows.map(mapChannel);
}

async function addChannel(pool: Queryable, record: TemporaryVoiceChannelRecord): Promise<void> {
  await pool.query(
    `
    insert into temporary_voice_channels (
      discord_guild_id,
      discord_channel_id,
      owner_discord_user_id,
      base_channel_id
    )
    values ($1, $2, $3, $4)
    `,
    [record.discordGuildId, record.discordChannelId, record.ownerDiscordUserId, record.baseChannelId]
  );
}

async function removeChannel(
  pool: Queryable,
  discordGuildId: string,
  discordChannelId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    delete from temporary_voice_channels
    where discord_guild_id = $1 and discord_channel_id = $2
    `,
    [discordGuildId, discordChannelId]
  );
  return (result.rowCount ?? 0) > 0;
}

function mapConfig(row: TemporaryVoiceConfigRow): TemporaryVoiceConfig {
  return {
    discordGuildId: row.discord_guild_id,
    baseChannelId: row.base_channel_id
  };
}

function mapChannel(row: TemporaryVoiceChannelRow): TemporaryVoiceChannelRecord {
  return {
    discordGuildId: row.discord_guild_id,
    discordChannelId: row.discord_channel_id,
    ownerDiscordUserId: row.owner_discord_user_id,
    baseChannelId: row.base_channel_id
  };
}
