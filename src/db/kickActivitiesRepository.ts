import type { PostgresPool } from "./postgres.js";

type Queryable = Pick<PostgresPool, "query">;
export type KickActivityKind = "content" | "giveaway" | "application" | "ticket" | "voice";
export type KickRevocationKind = "content_host" | "giveaway_host" | "application" | "ticket" | "voice";
export interface KickActivityCleanup {
  cleanupId: string; discordGuildId: string; discordUserId: string;
  kind: KickActivityKind; targetId: string; channelId: string; messageIds: string[];
}

export async function isKickActivityRevoked(db: Queryable, guild: string, user: string, kind: KickRevocationKind, target: string): Promise<boolean> {
  const result = await db.query(`select 1 from member_kick_activity_revocations
    where discord_guild_id = $1 and discord_user_id = $2 and kind = $3 and target_id = $4`, [guild, user, kind, target]);
  return result.rows.length > 0;
}

/** Caller holds the kick's guild/member fence and owns the transaction. */
export async function revokeKickActivities(db: Queryable, guild: string, user: string, actor?: string): Promise<void> {
  const values = [guild, user, actor ?? null];
  const contents = await db.query<{ content_id: string; thread_channel_id: string; leader_discord_user_id: string; state: string }>(`
    select content_id, thread_channel_id, leader_discord_user_id, state from content_items c
    where discord_guild_id = $1 and (leader_discord_user_id = $2
      or (state in ('scheduled', 'unscheduled', 'active') and (
        exists (select 1 from content_signups s where s.discord_guild_id = c.discord_guild_id
          and s.content_id = c.content_id and s.discord_user_id = $2 and s.state = 'active')
        or exists (select 1 from content_signup_requests r where r.discord_guild_id = c.discord_guild_id
          and r.content_id = c.content_id and r.discord_user_id = $2 and r.status = 'pending'))))
    order by content_id for update`, [guild, user]);
  for (const item of contents.rows) {
    const host = item.leader_discord_user_id === user;
    if (host) await revoke(db, guild, user, "content_host", item.content_id);
    if (!["scheduled", "unscheduled", "active"].includes(item.state)) continue;
    await db.query(`update content_signups set state = 'removed', removed_at = now(), removed_by_discord_user_id = $4
      where discord_guild_id = $1 and content_id = $2 and discord_user_id = $3 and state = 'active'`, [guild, item.content_id, user, actor ?? null]);
    await db.query(`update content_signup_requests set status = $4, resolved_at = now()
      where discord_guild_id = $1 and content_id = $2 and status = 'pending' and ($5 or discord_user_id = $3)`,
      [guild, item.content_id, user, host ? "closed" : "withdrawn", host]);
    if (host) await db.query(`update content_items set state = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
      where discord_guild_id = $1 and content_id = $2 and state in ('scheduled', 'unscheduled', 'active')`, [guild, item.content_id]);
    await enqueue(db, guild, user, "content", item.content_id, item.thread_channel_id);
  }

  const giveaways = await db.query<{ giveaway_id: string; channel_id: string; creator_discord_user_id: string; state: string }>(`
    select giveaway_id, channel_id, creator_discord_user_id, state from giveaways g
    where discord_guild_id = $1 and (creator_discord_user_id = $2 or (state = 'open' and (
      exists (select 1 from giveaway_entries e where e.discord_guild_id = g.discord_guild_id and e.giveaway_id = g.giveaway_id and e.discord_user_id = $2)
      or exists (select 1 from giveaway_reactions r where r.discord_guild_id = g.discord_guild_id and r.giveaway_id = g.giveaway_id and r.discord_user_id = $2))))
    order by giveaway_id for update`, [guild, user]);
  for (const item of giveaways.rows) {
    if (item.creator_discord_user_id === user) await revoke(db, guild, user, "giveaway_host", item.giveaway_id);
    if (item.state !== "open") continue;
    await db.query("delete from giveaway_reactions where discord_guild_id = $1 and giveaway_id = $2 and discord_user_id = $3", [guild, item.giveaway_id, user]);
    await db.query("delete from giveaway_entries where discord_guild_id = $1 and giveaway_id = $2 and discord_user_id = $3", [guild, item.giveaway_id, user]);
    if (item.creator_discord_user_id === user) await db.query(`update giveaways
      set state = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), cancelled_by_discord_user_id = $3, updated_at = now()
      where discord_guild_id = $1 and giveaway_id = $2 and state = 'open'`, [guild, item.giveaway_id, actor ?? null]);
    await enqueue(db, guild, user, "giveaway", item.giveaway_id, item.channel_id);
  }

  const applications = await db.query<{ application_id: string; ticket_channel_id: string | null; character_resolution_message_id: string | null; application_control_message_id: string | null; closed_control_message_id: string | null }>(`
    update open_applications set channel_status = 'closed', access_revoked_at = coalesce(access_revoked_at, now()),
      closed_at = case when channel_status = 'open' then now() else coalesce(closed_at, now()) end,
      closed_by_discord_user_id = case when channel_status = 'open' then $3 else closed_by_discord_user_id end, updated_at = now()
    where discord_guild_id = $1 and applicant_discord_user_id = $2 and channel_status <> 'deleted'
    returning application_id, ticket_channel_id, character_resolution_message_id, application_control_message_id, closed_control_message_id`, values);
  for (const item of applications.rows) {
    await revoke(db, guild, user, "application", item.application_id);
    if (item.ticket_channel_id) await enqueue(db, guild, user, "application", item.application_id, item.ticket_channel_id,
      [item.character_resolution_message_id, item.application_control_message_id, item.closed_control_message_id]);
  }
  const tickets = await db.query<{ ticket_id: string; ticket_channel_id: string | null; control_message_id: string | null }>(`
    update tickets set status = 'closed', access_revoked_at = coalesce(access_revoked_at, now()),
      closed_at = case when status = 'open' then now() else coalesce(closed_at, now()) end,
      closed_by_discord_user_id = case when status = 'open' then $3 else closed_by_discord_user_id end, updated_at = now()
    where discord_guild_id = $1 and opener_discord_user_id = $2 and status <> 'deleted'
    returning ticket_id, ticket_channel_id, control_message_id`, values);
  for (const item of tickets.rows) {
    await revoke(db, guild, user, "ticket", item.ticket_id);
    if (item.ticket_channel_id) await enqueue(db, guild, user, "ticket", item.ticket_id, item.ticket_channel_id, [item.control_message_id]);
  }
  const voice = await db.query<{ discord_channel_id: string }>(`update temporary_voice_channels
    set ownership_revoked_at = coalesce(ownership_revoked_at, now())
    where discord_guild_id = $1 and owner_discord_user_id = $2 returning discord_channel_id`, [guild, user]);
  for (const item of voice.rows) {
    await revoke(db, guild, user, "voice", item.discord_channel_id);
    await enqueue(db, guild, user, "voice", item.discord_channel_id, item.discord_channel_id);
  }
}

async function revoke(db: Queryable, guild: string, user: string, kind: KickRevocationKind, target: string): Promise<void> {
  await db.query(`insert into member_kick_activity_revocations (discord_guild_id, discord_user_id, kind, target_id)
    values ($1, $2, $3, $4) on conflict do nothing`, [guild, user, kind, target]);
}

async function enqueue(db: Queryable, guild: string, user: string, kind: KickActivityKind, target: string, channel: string, messages: Array<string | null> = []): Promise<void> {
  await db.query(`insert into member_kick_activity_cleanup (discord_guild_id, discord_user_id, kind, target_id, channel_id, message_ids)
    values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (discord_guild_id, discord_user_id, kind, target_id)
    do update set message_ids = coalesce((select jsonb_agg(distinct item) from jsonb_array_elements(member_kick_activity_cleanup.message_ids || excluded.message_ids) item), '[]'::jsonb),
      channel_id = excluded.channel_id`, [guild, user, kind, target, channel, JSON.stringify([...new Set(messages.filter((id): id is string => !!id))])]);
}

export function createKickActivitiesRepository(db: Queryable) {
  return {
    isRevoked: (guild: string, user: string, kind: KickRevocationKind, target: string) => isKickActivityRevoked(db, guild, user, kind, target),
    async listPending(guild: string, user: string): Promise<KickActivityCleanup[]> {
      const result = await db.query<{ cleanup_id: string; discord_guild_id: string; discord_user_id: string; kind: KickActivityKind; target_id: string; channel_id: string; message_ids: string[] }>(
        `select * from member_kick_activity_cleanup where discord_guild_id = $1 and discord_user_id = $2 order by cleanup_id`, [guild, user]);
      return result.rows.map(row => ({ cleanupId: row.cleanup_id, discordGuildId: row.discord_guild_id, discordUserId: row.discord_user_id,
        kind: row.kind, targetId: row.target_id, channelId: row.channel_id, messageIds: row.message_ids }));
    },
    async hasPendingCleanup(guild: string, user: string): Promise<boolean> {
      const result = await db.query("select 1 from member_kick_activity_cleanup where discord_guild_id = $1 and discord_user_id = $2 limit 1", [guild, user]);
      return result.rows.length > 0;
    },
    async markAttempted(guild: string, user: string, id: string): Promise<void> {
      await db.query("update member_kick_activity_cleanup set last_attempt_at = now() where discord_guild_id = $1 and discord_user_id = $2 and cleanup_id = $3", [guild, user, id]);
    },
    async complete(guild: string, user: string, id: string): Promise<void> {
      await db.query("delete from member_kick_activity_cleanup where discord_guild_id = $1 and discord_user_id = $2 and cleanup_id = $3", [guild, user, id]);
    }
  };
}
