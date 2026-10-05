import type { PostgresPool } from './postgres.js';
import type { AlbionServer } from '../services/albion/servers.js';

export interface CharacterStatusMembership {
  groupId: string; groupName: string; groupType: 'group' | 'guild' | 'alliance';
  state: 'current' | 'manual' | 'unregistered' | 'departed';
  preserved: boolean; owner?: string; formerOwner?: string; detectedAt?: string; expiresAt?: string;
  appointments: Array<{ name: string; roleId: string; appointedAt: string }>;
}
export interface CharacterStatusSnapshot {
  discordGuildId: string; albionServer: AlbionServer; albionCharacterId: string; characterName: string;
  currentOwner?: string; formerOwner?: string;
  registration: 'registered' | 'unregistered' | 'hold' | 'abandoned' | 'purged' | 'kicked';
  kickCleanupPending?: boolean;
  source?: string; detectedAt?: Date; expiresAt?: Date; purgedAt?: Date;
  account?: { status: 'open' | 'frozen' | 'closed'; balance: bigint };
  activeMembership: boolean; financialSuspended: boolean; memberships: CharacterStatusMembership[];
  pendingRegears: number; pendingSpecialisations: number;
}
// Only guild-owned evidence admits a character. The global API cache alone is never sufficient.
const evidence = `
  select albion_server, albion_character_id from discord_user_characters where discord_guild_id = $1
  union select albion_server, albion_character_id from character_registration_history where discord_guild_id = $1
  union select albion_server, albion_character_id from member_registration_lifecycle where discord_guild_id = $1
  union select albion_server, albion_character_id from character_kick_recovery where discord_guild_id = $1
  union select albion_server, albion_character_id from member_group_profiles where discord_guild_id = $1
  union select albion_server, albion_character_id from character_accounts where discord_guild_id = $1
  union select albion_server, albion_character_id from regear_claims where discord_guild_id = $1
  union select albion_server, albion_character_id from specialisation_requests where discord_guild_id = $1
  union select albion_server, albion_character_id from character_specialisations where discord_guild_id = $1`;

export function createCharacterStatusRepository(pool: PostgresPool) {
  return {
    async listCharacterStatusChoices(discordGuildId: string, query: string): Promise<Array<{ characterName: string; albionServer: AlbionServer; albionCharacterId: string }>> {
      const result = await pool.query(`with evidence as (${evidence})
        select c.character_name as "characterName", c.albion_server as "albionServer", c.albion_character_id as "albionCharacterId"
        from evidence e join albion_characters c using (albion_server, albion_character_id)
        where strpos(lower(c.character_name), lower($2)) > 0 or strpos(lower(c.albion_character_id), lower($2)) > 0
        order by lower(c.character_name), c.albion_server, c.albion_character_id limit 25`, [discordGuildId, query]);
      return result.rows;
    },
    async getCharacterStatus(discordGuildId: string, albionServer: AlbionServer, albionCharacterId: string): Promise<CharacterStatusSnapshot | undefined> {
      // A single statement gives a consistent read snapshot without locks, writes, or repair.
      const result = await pool.query(`with evidence as (${evidence})
        select c.character_name, r.discord_user_id as current_owner,
          coalesce(l.previous_discord_user_id, case when k.recovery_required then k.disconnected_discord_user_id end) as former_owner,
          l.state, l.source, l.detected_at, l.expires_at, l.purged_at,
          k.recovery_required as kicked, k.updated_at as kicked_at, ma.cleanup_pending as kick_cleanup_pending,
          a.status as account_status, a.balance::text as balance,
          character_has_active_membership($1, $2, $3, r.discord_user_id) as active_membership,
          character_financial_actions_suspended($1, $2, $3) as financial_suspended,
          coalesce((select jsonb_agg(jsonb_build_object(
            'groupId', p.member_group_id::text, 'groupName', g.group_name, 'groupType', g.group_type,
            'state', p.lifecycle_state, 'preserved', p.entitlement_preserved,
            'owner', p.discord_user_id, 'formerOwner', p.previous_discord_user_id,
            'detectedAt', p.departure_detected_at, 'expiresAt', p.departure_expires_at,
            'appointments', coalesce((select jsonb_agg(jsonb_build_object('name', pos.name, 'roleId', pos.discord_role_id,
              'appointedAt', ap.created_at) order by pos.name, pos.member_group_position_id)
              from member_group_position_appointments ap join member_group_positions pos
                on pos.member_group_position_id = ap.member_group_position_id and pos.discord_guild_id = ap.discord_guild_id
              where ap.discord_guild_id = $1 and ap.member_group_profile_id = p.member_group_profile_id), '[]'::jsonb))
            order by g.group_name, p.member_group_id)
            from member_group_profiles p join member_groups g on g.member_group_id = p.member_group_id and g.discord_guild_id = p.discord_guild_id
            where p.discord_guild_id = $1 and p.albion_server = $2 and p.albion_character_id = $3), '[]'::jsonb) as memberships,
          (select count(*) from regear_claims where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3 and status = 'pending')::integer as pending_regears,
          (select count(*) from specialisation_requests where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3 and state = 'pending')::integer as pending_specialisations
        from evidence e join albion_characters c using (albion_server, albion_character_id)
        left join discord_user_characters r on r.discord_guild_id = $1 and r.albion_server = c.albion_server and r.albion_character_id = c.albion_character_id
        left join member_registration_lifecycle l on l.discord_guild_id = $1 and l.albion_server = c.albion_server and l.albion_character_id = c.albion_character_id
        left join character_kick_recovery k on k.discord_guild_id = $1 and k.albion_server = c.albion_server and k.albion_character_id = c.albion_character_id
        left join guild_member_access ma on ma.discord_guild_id = $1 and ma.discord_user_id = k.disconnected_discord_user_id
        left join character_accounts a on a.discord_guild_id = $1 and a.albion_server = c.albion_server and a.albion_character_id = c.albion_character_id
        where c.albion_server = $2 and c.albion_character_id = $3`, [discordGuildId, albionServer, albionCharacterId]);
      const row = result.rows[0];
      if (!row) return undefined;
      return { discordGuildId, albionServer, albionCharacterId, characterName: row.character_name,
        currentOwner: row.current_owner ?? undefined, formerOwner: row.former_owner ?? undefined,
        registration: row.kicked ? 'kicked' : row.state ?? (row.current_owner ? 'registered' : 'unregistered'),
        kickCleanupPending: row.kicked ? !!row.kick_cleanup_pending : undefined,
        source: row.kicked ? 'kick' : row.source ?? undefined,
        detectedAt: row.kicked ? row.kicked_at : row.detected_at ?? undefined, expiresAt: row.expires_at ?? undefined, purgedAt: row.purged_at ?? undefined,
        account: row.account_status ? { status: row.account_status, balance: BigInt(row.balance) } : undefined,
        activeMembership: row.active_membership, financialSuspended: row.financial_suspended,
        memberships: row.memberships, pendingRegears: row.pending_regears, pendingSpecialisations: row.pending_specialisations };
    }
  };
}
