import type { PostgresPool } from "./postgres.js";

interface Queryable { query: PostgresPool["query"]; }

export type ReviewerDomain = "regears" | "specialisation";

export interface ReviewerBinding {
  reviewerBindingId: string;
  discordGuildId: string;
  domain: ReviewerDomain;
  discordRoleId: string;
  createdByDiscordUserId: string;
  createdAt: Date;
}

interface BindingRow {
  reviewer_binding_id: string;
  discord_guild_id: string;
  domain: ReviewerDomain;
  discord_role_id: string;
  created_by_discord_user_id: string;
  created_at: Date;
}

export function createReviewerRepository(pool: PostgresPool) {
  return {
    addBinding: (guildId: string, domain: ReviewerDomain, roleId: string, actorId: string) =>
      addBinding(pool, guildId, domain, roleId, actorId),
    removeBinding: (guildId: string, domain: ReviewerDomain, roleId: string, actorId: string) =>
      removeBinding(pool, guildId, domain, roleId, actorId),
    listBindings: (guildId: string, domain?: ReviewerDomain) =>
      listBindings(pool, guildId, domain),
    effectiveRoleIds: (guildId: string, domain: ReviewerDomain) =>
      effectiveRoleIds(pool, guildId, domain)
  };
}

export type ReviewerRepository = ReturnType<typeof createReviewerRepository>;

async function addBinding(pool: PostgresPool, guildId: string, domain: ReviewerDomain, roleId: string, actorId: string): Promise<ReviewerBinding> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<BindingRow>(`insert into reviewer_role_bindings
      (discord_guild_id, domain, discord_role_id, created_by_discord_user_id)
      values ($1, $2, $3, $4)
      on conflict (discord_guild_id, domain, discord_role_id) do update
        set created_by_discord_user_id = excluded.created_by_discord_user_id
      returning *`, [guildId, domain, roleId, actorId]);
    await client.query("commit");
    return mapBinding(result.rows[0]);
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; } finally { client.release(); }
}

async function removeBinding(pool: Queryable, guildId: string, domain: ReviewerDomain, roleId: string, actorId: string): Promise<boolean> {
  const result = await pool.query(`delete from reviewer_role_bindings
    where discord_guild_id = $1 and domain = $2 and discord_role_id = $3`, [guildId, domain, roleId]);
  // Audit metadata is retained in the binding row creation/update history.
  void actorId;
  return (result.rowCount ?? 0) > 0;
}

async function listBindings(pool: Queryable, guildId: string, domain?: ReviewerDomain): Promise<ReviewerBinding[]> {
  const result = await pool.query<BindingRow>(`select * from reviewer_role_bindings
    where discord_guild_id = $1 and ($2::text is null or domain = $2)
    order by domain, discord_role_id`, [guildId, domain ?? null]);
  return result.rows.map(mapBinding);
}

async function effectiveRoleIds(pool: Queryable, guildId: string, domain: ReviewerDomain): Promise<string[]> {
  const result = await pool.query<{ discord_role_id: string }>(`select discord_role_id from reviewer_role_bindings
    where discord_guild_id = $1 and domain = $2
    order by discord_role_id`, [guildId, domain]);
  return result.rows.map((row) => row.discord_role_id);
}

function mapBinding(row: BindingRow): ReviewerBinding {
  return { reviewerBindingId: row.reviewer_binding_id, discordGuildId: row.discord_guild_id, domain: row.domain,
    discordRoleId: row.discord_role_id,
    createdByDiscordUserId: row.created_by_discord_user_id, createdAt: row.created_at };
}
