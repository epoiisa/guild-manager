import type { PostgresPool } from "./postgres.js";
import type { AlbionServer } from "../services/albion/servers.js";

export interface MemberAccessQueryable { query: PostgresPool["query"] }

export interface MemberAccess {
  discordGuildId: string;
  discordUserId: string;
  blocked: boolean;
  cleanupPending: boolean;
  revokedRoleIds: string[];
  cleanupRoleIds: string[];
  revision: number;
  updatedAt: Date;
  lastKickedAt: Date | null;
}

export interface KickRecoverySnapshot {
  expectedMemberAccessRevision: number | null;
  expectedCharacterKickRevision: number | null;
  characterKickRecoveryRequired: boolean;
}

export class MemberAccessBlockedError extends Error {
  constructor() {
    super("This Discord user is disconnected from Guild Manager. An officer must reconnect them through /character register.");
    this.name = "MemberAccessBlockedError";
  }
}

export class KickCleanupPendingError extends Error {
  constructor() {
    super("Kick cleanup has not finished. Resolve the remaining Discord cleanup before reconnecting this member.");
    this.name = "KickCleanupPendingError";
  }
}

export async function lockMemberAccess(client: MemberAccessQueryable, guild: string, user: string, exclusive = false): Promise<void> {
  await client.query(
    `select ${exclusive ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('guild-manager-member-access:' || $1 || ':' || $2, 0))`,
    [guild, user]
  );
}

export async function assertMemberAccessAllowed(client: MemberAccessQueryable, guild: string, user: string): Promise<void> {
  if ((await client.query("select 1 from guild_member_access where discord_guild_id = $1 and discord_user_id = $2 and blocked", [guild, user])).rowCount) {
    throw new MemberAccessBlockedError();
  }
}

export function createMemberAccessRepository(pool: MemberAccessQueryable) {
  const getMemberAccess = async (guild: string, user: string): Promise<MemberAccess | undefined> => {
    const result = await pool.query("select * from guild_member_access where discord_guild_id = $1 and discord_user_id = $2", [guild, user]);
    return result.rows[0] ? mapMemberAccess(result.rows[0]) : undefined;
  };
  return {
    getMemberAccess,
    isMemberBlocked: async (guild: string, user: string): Promise<boolean> =>
      !!(await pool.query("select 1 from guild_member_access where discord_guild_id = $1 and discord_user_id = $2 and blocked", [guild, user])).rowCount,
    getKickRecoverySnapshot: async (guild: string, user: string, server: AlbionServer, character: string): Promise<KickRecoverySnapshot> => {
      const result = await pool.query(`select
        (select revision from guild_member_access where discord_guild_id = $1 and discord_user_id = $2) as member_revision,
        (select revision from character_kick_recovery where discord_guild_id = $1 and albion_server = $3 and albion_character_id = $4) as character_revision,
        exists (select 1 from character_kick_recovery where discord_guild_id = $1 and albion_server = $3 and albion_character_id = $4 and recovery_required) as character_recovery_required`,
      [guild, user, server, character]);
      const row = result.rows[0];
      return { expectedMemberAccessRevision: row?.member_revision == null ? null : Number(row.member_revision),
        expectedCharacterKickRevision: row?.character_revision == null ? null : Number(row.character_revision),
        characterKickRecoveryRequired: row?.character_recovery_required === true };
    },
    markKickCleanupComplete: async (guild: string, user: string, revision: number): Promise<boolean> => {
      const result = await pool.query(`update guild_member_access set cleanup_pending = false, updated_at = now()
        where discord_guild_id = $1 and discord_user_id = $2 and revision = $3 and blocked
          and not exists (select 1 from member_kick_activity_cleanup where discord_guild_id = $1 and discord_user_id = $2)
        returning discord_user_id`, [guild, user, revision]);
      return !!result.rowCount;
    },
    addRevokedRoleIds: async (guild: string, user: string, revision: number, roles: readonly string[], cleanupRoles: readonly string[] = []): Promise<boolean> => {
      const result = await pool.query(`update guild_member_access set revoked_role_ids = array(
          select distinct role_id from unnest(revoked_role_ids || $4::text[]) role_id order by role_id),
          cleanup_role_ids = array(select distinct role_id from unnest(cleanup_role_ids || $4::text[] || $5::text[]) role_id order by role_id),
          cleanup_pending = true, updated_at = now()
        where discord_guild_id = $1 and discord_user_id = $2 and revision = $3 and blocked returning discord_user_id`,
      [guild, user, revision, roles, cleanupRoles]);
      return !!result.rowCount;
    },
    listPendingKickCleanups: async (guild?: string): Promise<MemberAccess[]> => {
      const result = await pool.query(`select * from guild_member_access where cleanup_pending and blocked
        and ($1::text is null or discord_guild_id = $1) order by updated_at, discord_guild_id, discord_user_id`, [guild ?? null]);
      return result.rows.map(mapMemberAccess);
    }
  };
}

function mapMemberAccess(row: Record<string, any>): MemberAccess {
  return { discordGuildId: row.discord_guild_id, discordUserId: row.discord_user_id, blocked: row.blocked,
    cleanupPending: row.cleanup_pending, revokedRoleIds: row.revoked_role_ids, cleanupRoleIds: row.cleanup_role_ids,
    revision: Number(row.revision), updatedAt: new Date(row.updated_at),
    lastKickedAt: row.last_kicked_at == null ? null : new Date(row.last_kicked_at) };
}
