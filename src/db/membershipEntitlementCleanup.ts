import type { PostgresPool } from "./postgres.js";
import type { AccountRef } from "./accountRepository.js";

export interface EntitlementQueryable { query: PostgresPool["query"] }

// This queue retries only deletion of expired evidence. It never replays a
// financial operation or sends/replays an audit-feed entry.
export const MEMBERSHIP_ENTITLEMENT_CLEANUP_SCHEMA_SQL = `
create table if not exists membership_evidence_cleanup (
  cleanup_id bigserial primary key,
  discord_guild_id text not null,
  channel_id text not null,
  message_id text not null,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  unique (discord_guild_id, channel_id, message_id)
);
create index if not exists membership_evidence_cleanup_guild
  on membership_evidence_cleanup (discord_guild_id, cleanup_id);
`;

export async function lockCharacterEntitlements(queryable: EntitlementQueryable, ref: AccountRef): Promise<void> {
  await queryable.query(
    "select pg_advisory_xact_lock(hashtextextended('membership-entitlements:' || $1 || ':' || $2 || ':' || $3, 0))",
    [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]
  );
}

/** Caller owns the transaction and obtains this character's entitlement lock before removing membership. */
export async function expireCharacterEntitlements(queryable: EntitlementQueryable, ref: AccountRef): Promise<{ removedRegears: number; removedSpecialisations: number }> {
  await lockCharacterEntitlements(queryable, ref);
  const eligibility = await queryable.query<{ preserved: boolean }>(
    "select character_has_preserved_membership($1, $2, $3) as preserved",
    [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]
  );
  if (eligibility.rows[0]?.preserved) return { removedRegears: 0, removedSpecialisations: 0 };
  const values = [ref.discordGuildId, ref.albionServer, ref.albionCharacterId];
  const regears = await queryable.query<{ removed_count: string }>(`
    with removed as (
      delete from regear_claims where discord_guild_id = $1 and albion_server = $2
        and albion_character_id = $3 and status = 'pending'
      returning discord_guild_id, review_channel_id, review_message_id
    ), queued as (
      insert into membership_evidence_cleanup (discord_guild_id, channel_id, message_id)
      select discord_guild_id, review_channel_id, review_message_id from removed
      on conflict (discord_guild_id, channel_id, message_id) do nothing
    ) select count(*)::text as removed_count from removed`, values);
  const specialisations = await queryable.query<{ removed_count: string }>(`
    with removed as (
      delete from specialisation_requests where discord_guild_id = $1 and albion_server = $2
        and albion_character_id = $3 and state = 'pending'
      returning discord_guild_id, review_channel_id, review_message_id, review_message_deleted_at
    ), queued as (
      insert into membership_evidence_cleanup (discord_guild_id, channel_id, message_id)
      select discord_guild_id, review_channel_id, review_message_id from removed
      where review_message_id is not null and review_message_deleted_at is null
      on conflict (discord_guild_id, channel_id, message_id) do nothing
    ) select count(*)::text as removed_count from removed`, values);
  return { removedRegears: Number(regears.rows[0]?.removed_count ?? 0), removedSpecialisations: Number(specialisations.rows[0]?.removed_count ?? 0) };
}

export interface MembershipEvidenceCleanup {
  cleanupId: string;
  discordGuildId: string;
  channelId: string;
  messageId: string;
}

export function createMembershipEvidenceCleanupRepository(pool: EntitlementQueryable) {
  return {
    async listPending(discordGuildId: string): Promise<MembershipEvidenceCleanup[]> {
      const result = await pool.query<{ cleanup_id: string; discord_guild_id: string; channel_id: string; message_id: string }>(
        "select cleanup_id, discord_guild_id, channel_id, message_id from membership_evidence_cleanup where discord_guild_id = $1 order by last_attempt_at nulls first, cleanup_id limit 100",
        [discordGuildId]
      );
      return result.rows.map(row => ({ cleanupId: row.cleanup_id, discordGuildId: row.discord_guild_id, channelId: row.channel_id, messageId: row.message_id }));
    },
    async markAttempted(discordGuildId: string, cleanupId: string): Promise<void> {
      await pool.query("update membership_evidence_cleanup set last_attempt_at = now() where discord_guild_id = $1 and cleanup_id = $2", [discordGuildId, cleanupId]);
    },
    async complete(discordGuildId: string, cleanupId: string): Promise<void> {
      await pool.query("delete from membership_evidence_cleanup where discord_guild_id = $1 and cleanup_id = $2", [discordGuildId, cleanupId]);
    }
  };
}
