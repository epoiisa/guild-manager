import type { PostgresPool } from "./postgres.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

const INACTIVE_RETENTION_DAYS = 15;

interface Queryable {
  query: PostgresPool["query"];
}

export type GuildLifecycleStatus = "active" | "inactive";

export interface GuildLifecycle {
  discordGuildId: string;
  status: GuildLifecycleStatus;
  guildName: string;
  activatedAt?: Date;
  activatedByDiscordUserId?: string;
  inactiveAt?: Date;
  inactiveByDiscordUserId?: string;
  purgeAfter?: Date;
}

interface GuildLifecycleRow {
  discord_guild_id: string;
  status: GuildLifecycleStatus;
  guild_name: string;
  activated_at: Date | null;
  activated_by_discord_user_id: string | null;
  inactive_at: Date | null;
  inactive_by_discord_user_id: string | null;
  purge_after: Date | null;
}

export interface ActivateGuildInput {
  discordGuildId: string;
  guildName: string;
  actorDiscordUserId: string;
}

export interface MarkGuildInactiveInput {
  discordGuildId: string;
  guildName: string;
  actorDiscordUserId?: string;
}

export function createGuildLifecycleRepository(pool: PostgresPool) {
  return {
    getGuildLifecycle: (discordGuildId: string) => getGuildLifecycle(pool, discordGuildId),
    isGuildActive: (discordGuildId: string) => isGuildActive(pool, discordGuildId),
    activateGuild: (input: ActivateGuildInput) => activateGuild(pool, input),
    markGuildInactive: (input: MarkGuildInactiveInput) => markGuildInactive(pool, input),
    clearInactiveState: (discordGuildId: string, guildName: string) => clearInactiveState(pool, discordGuildId, guildName),
    purgeGuildImmediately: (discordGuildId: string) => purgeGuildImmediately(pool, discordGuildId),
    purgeDueInactiveGuilds: (execute?: GuildPurgeExecutor) => purgeDueInactiveGuilds(pool, execute)
  };
}

export async function getGuildLifecycle(pool: Queryable, discordGuildId: string): Promise<GuildLifecycle | undefined> {
  const result = await pool.query<GuildLifecycleRow>(
    `
    select
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id,
      inactive_at,
      inactive_by_discord_user_id,
      purge_after
    from discord_guild_lifecycle
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );

  const row = result.rows[0];
  return row ? mapGuildLifecycle(row) : undefined;
}

export async function isGuildActive(pool: Queryable, discordGuildId: string): Promise<boolean> {
  const result = await pool.query(
    `
    select 1
    from discord_guild_lifecycle
    where discord_guild_id = $1
      and status = 'active'
    `,
    [discordGuildId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function activateGuild(pool: Queryable, input: ActivateGuildInput): Promise<GuildLifecycle> {
  const result = await pool.query<GuildLifecycleRow>(
    `
    insert into discord_guild_lifecycle (
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id,
      inactive_at,
      inactive_by_discord_user_id,
      purge_after,
      updated_at
    )
    values ($1, 'active', $2, now(), $3, null, null, null, now())
    on conflict (discord_guild_id) do update set
      status = 'active',
      guild_name = excluded.guild_name,
      activated_at = now(),
      activated_by_discord_user_id = excluded.activated_by_discord_user_id,
      inactive_at = null,
      inactive_by_discord_user_id = null,
      purge_after = null,
      updated_at = now()
    returning
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id,
      inactive_at,
      inactive_by_discord_user_id,
      purge_after
    `,
    [input.discordGuildId, input.guildName, input.actorDiscordUserId]
  );

  return mapGuildLifecycle(result.rows[0]);
}

async function markGuildInactive(pool: Queryable, input: MarkGuildInactiveInput): Promise<GuildLifecycle | undefined> {
  const result = await pool.query<GuildLifecycleRow>(
    `
    update discord_guild_lifecycle
    set
      status = 'inactive',
      guild_name = $2,
      inactive_at = now(),
      inactive_by_discord_user_id = $3,
      purge_after = now() + ($4::text || ' days')::interval,
      updated_at = now()
    where discord_guild_id = $1
      and status = 'active'
    returning
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id,
      inactive_at,
      inactive_by_discord_user_id,
      purge_after
    `,
    [input.discordGuildId, input.guildName, input.actorDiscordUserId ?? null, INACTIVE_RETENTION_DAYS]
  );

  const row = result.rows[0];
  return row ? mapGuildLifecycle(row) : undefined;
}

async function clearInactiveState(
  pool: Queryable,
  discordGuildId: string,
  guildName: string
): Promise<GuildLifecycle | undefined> {
  const result = await pool.query<GuildLifecycleRow>(
    `
    update discord_guild_lifecycle
    set
      status = 'active',
      guild_name = $2,
      inactive_at = null,
      inactive_by_discord_user_id = null,
      purge_after = null,
      updated_at = now()
    where discord_guild_id = $1
      and status = 'inactive'
      and purge_after > now()
    returning
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id,
      inactive_at,
      inactive_by_discord_user_id,
      purge_after
    `,
    [discordGuildId, guildName]
  );

  const row = result.rows[0];
  return row ? mapGuildLifecycle(row) : undefined;
}

async function purgeGuildImmediately(pool: PostgresPool, discordGuildId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await purgeGuildOwnedData(client, discordGuildId);
    await client.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [discordGuildId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type GuildPurgeExecutor = <T>(guildId: string, operation: () => Promise<T>) => Promise<T>;
async function purgeDueInactiveGuilds(pool: PostgresPool, execute?: GuildPurgeExecutor): Promise<string[]> {
  if (execute) {
    // Select candidates without retaining locks while waiting for Discord publication queues.
    const candidates = await pool.query<{ discord_guild_id: string }>(
      "select discord_guild_id from discord_guild_lifecycle where status = 'inactive' and purge_after <= now() order by purge_after asc"
    );
    const purged: string[] = [];
    for (const { discord_guild_id: guildId } of candidates.rows) {
      const deleted = await execute(guildId, async () => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const due = await client.query("select 1 from discord_guild_lifecycle where discord_guild_id = $1 and status = 'inactive' and purge_after <= now() for update", [guildId]);
          if (!due.rows.length) { await client.query("commit"); return false; }
          await purgeGuildOwnedData(client, guildId);
          await client.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [guildId]);
          await client.query("commit");
          return true;
        } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
        finally { client.release(); }
      });
      if (deleted) purged.push(guildId);
    }
    return purged;
  }
  const client = await pool.connect();

  try {
    await client.query("begin");
    const dueGuilds = await client.query<{ discord_guild_id: string }>(
      `
      select discord_guild_id
      from discord_guild_lifecycle
      where status = 'inactive'
        and purge_after <= now()
      order by purge_after asc
      for update
      `
    );

    for (const row of dueGuilds.rows) {
      await purgeGuildOwnedData(client, row.discord_guild_id);
      await client.query(
        "delete from discord_guild_lifecycle where discord_guild_id = $1",
        [row.discord_guild_id]
      );
    }

    await client.query("commit");
    return dueGuilds.rows.map((row) => row.discord_guild_id);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function mapGuildLifecycle(row: GuildLifecycleRow): GuildLifecycle {
  return {
    discordGuildId: row.discord_guild_id,
    status: row.status,
    guildName: row.guild_name,
    activatedAt: row.activated_at ?? undefined,
    activatedByDiscordUserId: row.activated_by_discord_user_id ?? undefined,
    inactiveAt: row.inactive_at ?? undefined,
    inactiveByDiscordUserId: row.inactive_by_discord_user_id ?? undefined,
    purgeAfter: row.purge_after ?? undefined
  };
}
