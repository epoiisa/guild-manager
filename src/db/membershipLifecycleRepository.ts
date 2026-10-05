import type { PostgresPool } from './postgres.js';
import type { AlbionServer } from '../services/albion/servers.js';
import type { MemberGroupProfile, RegisteredCharacter } from './membershipRepository.js';
import { expireCharacterEntitlements, lockCharacterEntitlements } from './membershipEntitlementCleanup.js';

export const MEMBERSHIP_GRACE_MS = 72 * 60 * 60 * 1000;
export interface LifecycleCharacterRef { discordGuildId: string; albionServer: AlbionServer; albionCharacterId: string }
export interface LifecycleProfileRef extends LifecycleCharacterRef { memberGroupId: string; lifecycleRevision?: number }
export interface RegistrationLifecycle extends LifecycleCharacterRef {
  previousDiscordUserId?: string; source: 'discord_departure' | 'purge'; state: 'hold' | 'abandoned' | 'purged'; detectedAt: Date; expiresAt?: Date; purgedAt?: Date; revision: number; warning: boolean;
}
export interface OfficerRecoveryEvidence {
  expectedRegistrationRevision: number | null;
  expectedMemberAccessRevision?: number | null;
  expectedCharacterKickRevision?: number | null;
  kickAuthorityRoleIds?: readonly string[];
  /** Keyed by memberGroupId, not memberGroupProfileId. */
  expectedProfileRevisions: Record<string, number>;
  verifiedMemberGroupIds: string[];
  unavailableMemberGroupIds: string[];
}
export class CharacterRecoveryRequiredError extends Error {
  constructor() { super('This character requires officer recovery through /character register.'); this.name = 'CharacterRecoveryRequiredError'; }
}
export class MembershipRecoveryVerificationUnavailableError extends Error {
  constructor() { super('Required Albion Online membership checks are unavailable. Recovery has not changed this character.'); this.name = 'MembershipRecoveryVerificationUnavailableError'; }
}
export class MembershipLifecycleConflictError extends Error {
  constructor() { super('Membership changed during verification. Check the current state and try again.'); this.name = 'MembershipLifecycleConflictError'; }
}
interface Queryable { query: PostgresPool['query'] }
type Client = Queryable;
const values = (ref: LifecycleCharacterRef) => [ref.discordGuildId, ref.albionServer, ref.albionCharacterId];
const predicate = 'discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3';

export async function lockMembershipLifecycleTenant(client: Queryable, guild: string): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended('membership-lifecycle-tenant:' || $1, 0))", [guild]);
}

export async function assertRegistrationLifecycleAllowed(client: Queryable, ref: LifecycleCharacterRef): Promise<void> {
  await lockCharacterEntitlements(client, ref);
  if ((await client.query(`select 1 from member_registration_lifecycle where ${predicate}`, values(ref))).rowCount) throw new CharacterRecoveryRequiredError();
  if ((await client.query(`select 1 from character_kick_recovery where ${predicate} and recovery_required`, values(ref))).rowCount) throw new CharacterRecoveryRequiredError();
}

export function createMembershipLifecycleRepository(pool: PostgresPool) {
  const getRegistrationLifecycle = async (guild: string, server: AlbionServer, character: string) => {
    const result = await pool.query(`select * from member_registration_lifecycle where ${predicate}`, [guild, server, character]);
    return result.rows[0] ? mapRegistrationLifecycle(result.rows[0]) : undefined;
  };
  return {
    getDiscordRegistrationSnapshot: async (guild: string, user: string): Promise<Record<string, string>> => {
      const result = await pool.query('select albion_server, albion_character_id, xmin::text as row_revision from discord_user_characters where discord_guild_id = $1 and discord_user_id = $2', [guild, user]);
      return Object.fromEntries(result.rows.map(row => [`${row.albion_server}:${row.albion_character_id}`, String(row.row_revision)]));
    },
    getRegistrationLifecycle,
    getCharacterRegistrationLifecycle: getRegistrationLifecycle,
    listRegistrationLifecycles: async (guild: string): Promise<RegistrationLifecycle[]> => {
      const result = await pool.query('select * from member_registration_lifecycle where discord_guild_id = $1 order by detected_at, albion_server, albion_character_id', [guild]);
      return result.rows.map(mapRegistrationLifecycle);
    },
    listDueRegistrationHolds: async (guild: string, now = new Date(), limit = 100): Promise<RegistrationLifecycle[]> => {
      const result = await pool.query("select * from member_registration_lifecycle where discord_guild_id = $1 and state = 'hold' and expires_at <= $2 order by coalesce(check_failed_at, '-infinity'::timestamptz), expires_at, revision limit $3", [guild, now, bounded(limit)]);
      return result.rows.map(mapRegistrationLifecycle);
    },
    beginDiscordDeparture: (guild: string, user: string, now = new Date(), expectedSnapshot?: Record<string, string>) => beginDiscordDeparture(pool, guild, user, now, expectedSnapshot),
    abandonRegistration: (ref: LifecycleCharacterRef, revision: number, now = new Date()) => transaction(pool, ref, client => abandonRegistration(client, ref, revision, now)),
    markMembershipDeparted: (ref: LifecycleProfileRef, now = new Date()) => transaction(pool, ref, client => markMembershipDeparted(client, ref, now)),
    // The saved expiry is the minimum buffer boundary, not forfeiture. A
    // verified return keeps the same profile and appointments until an update
    // has actually removed it. Restore ownership under the same revision lock.
    restoreDepartedMembership: (ref: LifecycleProfileRef, revision: number) => transaction(pool, ref, async client => {
      const owner = (await client.query(`select discord_user_id from discord_user_characters where ${predicate}
        and not exists (select 1 from member_registration_lifecycle where ${predicate})`, values(ref))).rows[0];
      const changed = await client.query(`update member_group_profiles set lifecycle_state = 'current', discord_user_id = $6,
        departure_detected_at = null, departure_expires_at = null, lifecycle_check_failed_at = null, updated_at = now()
        where ${predicate} and member_group_id = $4 and lifecycle_state = 'departed' and lifecycle_revision = $5
        returning member_group_profile_id`, [...values(ref), ref.memberGroupId, revision, owner?.discord_user_id ?? null]);
      if (!changed.rowCount) return undefined;
      const restored = await client.query(`${profileSelect} where p.${predicate.replaceAll(' and ', ' and p.')} and p.member_group_id = $4`, [...values(ref), ref.memberGroupId]);
      return mapLifecycleProfile(restored.rows[0]);
    }),
    expireMembershipDeparture: (ref: LifecycleProfileRef, revision: number, now = new Date()) => transaction(pool, ref, client => expireMembershipDeparture(client, ref, revision, now)),
    noteLifecycleCheckFailure: async (input: LifecycleCharacterRef & { kind: 'membership' | 'registration'; memberGroupId?: string; revision: number }, now = new Date()): Promise<void> => {
      if (input.kind === 'registration') await pool.query(`update member_registration_lifecycle set check_failed_at = $5 where ${predicate} and revision = $4`, [...values(input), input.revision, now]);
      else await pool.query(`update member_group_profiles set lifecycle_check_failed_at = $6 where ${predicate} and member_group_id = $4 and lifecycle_revision = $5`, [...values(input), input.memberGroupId, input.revision, now]);
    }
  };
}

async function transaction<T>(pool: PostgresPool, ref: LifecycleCharacterRef, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('begin'); await lockMembershipLifecycleTenant(client, ref.discordGuildId); await lockCharacterEntitlements(client, ref); const result = await work(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function beginDiscordDeparture(pool: PostgresPool, guild: string, user: string, now: Date, expectedSnapshot?: Record<string, string>): Promise<{ characters: RegisteredCharacter[]; holds: RegistrationLifecycle[] }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockMembershipLifecycleTenant(client, guild);
    // Registration writers take this hierarchy lock before character locks too.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`character-registration:${guild}:${user}`]);
    const result = await client.query(`select r.*, r.xmin::text as row_revision, c.character_name from discord_user_characters r join albion_characters c using (albion_server, albion_character_id) where r.discord_guild_id = $1 and r.discord_user_id = $2 order by r.albion_server, r.albion_character_id`, [guild, user]);
    if (expectedSnapshot && (result.rows.length !== Object.keys(expectedSnapshot).length
      || result.rows.some(row => expectedSnapshot[`${row.albion_server}:${row.albion_character_id}`] !== String(row.row_revision)))) {
      await client.query('commit'); return { characters: [], holds: [] };
    }
    const characters: RegisteredCharacter[] = result.rows.map(row => ({ discordGuildId: guild, discordUserId: user, albionServer: row.albion_server, albionCharacterId: row.albion_character_id, characterName: row.character_name }));
    const holds: RegistrationLifecycle[] = [];
    for (const ref of [...characters].sort((a, b) => `${a.albionServer}:${a.albionCharacterId}`.localeCompare(`${b.albionServer}:${b.albionCharacterId}`))) {
      await lockCharacterEntitlements(client, ref);
      const held = await client.query(`insert into member_registration_lifecycle (discord_guild_id, albion_server, albion_character_id, previous_discord_user_id, state, detected_at, expires_at)
        values ($1, $2, $3, $4, 'hold', $5, $6) on conflict (discord_guild_id, albion_server, albion_character_id) do nothing returning *`, [...values(ref), user, now, new Date(now.getTime() + MEMBERSHIP_GRACE_MS)]);
      if (held.rows[0]) holds.push(mapRegistrationLifecycle(held.rows[0]));
      await client.query(`update member_group_profiles set previous_discord_user_id = coalesce(previous_discord_user_id, $4) where ${predicate}`, [...values(ref), user]);
    }
    for (const row of result.rows) await client.query('delete from discord_user_characters where discord_guild_id = $1 and discord_user_id = $2 and albion_server = $3 and albion_character_id = $4 and xmin::text = $5', [guild, user, row.albion_server, row.albion_character_id, row.row_revision]);
    await client.query('delete from reaction_role_subscriptions where discord_guild_id = $1 and discord_user_id = $2', [guild, user]);
    await client.query('commit'); return { characters, holds };
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function markMembershipDeparted(client: Queryable, ref: LifecycleProfileRef, now: Date): Promise<MemberGroupProfile | undefined> {
  const result = await client.query(`${profileSelect} where p.${predicate.replaceAll(' and ', ' and p.')} and p.member_group_id = $4 for update of p`, [...values(ref), ref.memberGroupId]);
  const row = result.rows[0];
  if (!row || (ref.lifecycleRevision !== undefined && Number(row.lifecycle_revision) !== ref.lifecycleRevision) || row.lifecycle_state === 'departed') return undefined;
  if (row.group_type === 'group') return undefined;
  if (!row.entitlement_preserved) {
    await client.query(`delete from member_group_profiles where ${predicate} and member_group_id = $4`, [...values(ref), ref.memberGroupId]);
    return mapLifecycleProfile(row);
  }
  const changed = await client.query(`update member_group_profiles set lifecycle_state = 'departed', previous_discord_user_id = coalesce(discord_user_id, previous_discord_user_id), discord_user_id = null,
    departure_detected_at = $5, departure_expires_at = $6, lifecycle_check_failed_at = null, updated_at = now()
    where ${predicate} and member_group_id = $4 returning *`, [...values(ref), ref.memberGroupId, now, new Date(now.getTime() + MEMBERSHIP_GRACE_MS)]);
  return mapLifecycleProfile({ ...row, ...changed.rows[0] });
}
async function expireMembershipDeparture(client: Queryable, ref: LifecycleProfileRef, revision: number, now: Date): Promise<boolean> {
  const result = await client.query(`delete from member_group_profiles where ${predicate} and member_group_id = $4 and lifecycle_state = 'departed' and lifecycle_revision = $5 and departure_expires_at <= $6 returning member_group_profile_id`, [...values(ref), ref.memberGroupId, revision, now]);
  if (!result.rowCount) return false;
  await expireCharacterEntitlements(client, ref); return true;
}
async function abandonRegistration(client: Queryable, ref: LifecycleCharacterRef, revision: number, now: Date): Promise<boolean> {
  const result = await client.query(`update member_registration_lifecycle set state = 'abandoned', abandoned_at = $5, revision = nextval('membership_lifecycle_revision_seq'), check_failed_at = null
    where ${predicate} and state = 'hold' and revision = $4 and expires_at <= $5 returning *`, [...values(ref), revision, now]);
  if (!result.rowCount) return false;
  // Tombstone is installed first; account triggers can no longer reopen from any old profile.
  await client.query(`delete from member_group_profiles where ${predicate}`, values(ref));
  await expireCharacterEntitlements(client, ref); return true;
}

/** Called only by the officer registration transaction, after remote verification. */
export async function prepareOfficerRecovery(client: Queryable, ref: LifecycleCharacterRef, evidence?: OfficerRecoveryEvidence, now = new Date()): Promise<void> {
  await lockCharacterEntitlements(client, ref);
  const protectedGroupIds = [...new Set([...Object.keys(evidence?.expectedProfileRevisions ?? {}), ...evidence?.verifiedMemberGroupIds ?? []])];
  if (protectedGroupIds.length) await client.query('select member_group_id from member_groups where discord_guild_id = $1 and member_group_id = any($2::bigint[]) order by member_group_id for key share', [ref.discordGuildId, protectedGroupIds]);
  const state = (await client.query(`select * from member_registration_lifecycle where ${predicate} for update`, values(ref))).rows[0];
  const profiles = (await client.query(`select p.member_group_id, p.lifecycle_revision, p.lifecycle_state, p.departure_expires_at, p.entitlement_preserved, g.group_type from member_group_profiles p join member_groups g using (member_group_id) where p.${predicate.replaceAll(' and ', ' and p.')} for update of p`, values(ref))).rows;
  if (!evidence && (state || profiles.some(row => row.lifecycle_state === 'departed'))) throw new CharacterRecoveryRequiredError();
  if (evidence) {
    if ((state ? Number(state.revision) : null) !== evidence.expectedRegistrationRevision) throw new MembershipLifecycleConflictError();
    if (profiles.some(row => row.entitlement_preserved && evidence.unavailableMemberGroupIds.includes(String(row.member_group_id)))) throw new MembershipRecoveryVerificationUnavailableError();
    if (profiles.length !== Object.keys(evidence.expectedProfileRevisions).length || profiles.some(row => evidence.expectedProfileRevisions[String(row.member_group_id)] !== Number(row.lifecycle_revision))) throw new MembershipLifecycleConflictError();
  }
  if (state?.state === 'purged') {
    // Purged characters have no recoverable entitlements. Roster rediscovery
    // may have added observations, but only freshly verified groups supplied
    // by the officer registration transaction may create new memberships.
    await client.query(`delete from member_group_profiles where ${predicate}`, values(ref));
    await client.query(`delete from member_registration_lifecycle where ${predicate}`, values(ref));
    return;
  }
  if (state?.state === 'hold' && new Date(state.expires_at).getTime() <= now.getTime()) await abandonRegistration(client, ref, Number(state.revision), now);
  await client.query(`delete from member_registration_lifecycle where ${predicate}`, values(ref));
  if (evidence) for (const profile of profiles) {
    if (profile.group_type !== 'group' && !evidence.verifiedMemberGroupIds.includes(String(profile.member_group_id)) && !evidence.unavailableMemberGroupIds.includes(String(profile.member_group_id))) {
      await markMembershipDeparted(client, { ...ref, memberGroupId: String(profile.member_group_id) }, now);
    }
  }
}
export function mapRegistrationLifecycle(row: Record<string, any>): RegistrationLifecycle {
  return { discordGuildId: row.discord_guild_id, albionServer: row.albion_server, albionCharacterId: row.albion_character_id,
    previousDiscordUserId: row.previous_discord_user_id ?? undefined, source: row.source ?? 'discord_departure', state: row.state, detectedAt: new Date(row.detected_at), expiresAt: row.expires_at ? new Date(row.expires_at) : undefined, purgedAt: row.purged_at ? new Date(row.purged_at) : undefined, revision: Number(row.revision), warning: !!row.check_failed_at };
}
export function mapLifecycleProfile(row: Record<string, any>): MemberGroupProfile {
  return { memberGroupProfileId: String(row.member_group_profile_id), memberGroupId: String(row.member_group_id), discordGuildId: row.discord_guild_id,
    discordUserId: row.discord_user_id ?? undefined, albionServer: row.albion_server, albionCharacterId: row.albion_character_id,
    characterName: row.character_name, groupName: row.group_name, groupType: row.group_type,
    lifecycleState: row.lifecycle_state ?? 'current', entitlementPreserved: row.entitlement_preserved ?? true,
    previousDiscordUserId: row.previous_discord_user_id ?? undefined, lifecycleRevision: Number(row.lifecycle_revision ?? 0),
    departureDetectedAt: row.departure_detected_at ? new Date(row.departure_detected_at) : undefined,
    departureExpiresAt: row.departure_expires_at ? new Date(row.departure_expires_at) : undefined,
    lifecycleWarning: !!row.lifecycle_check_failed_at, registrationState: row.registration_state ?? undefined, registrationSource: row.registration_source ?? undefined,
    registrationExpiresAt: row.registration_expires_at ? new Date(row.registration_expires_at) : undefined };
}
const profileSelect = `select p.*, g.group_type, g.group_name, c.character_name, r.state as registration_state, r.source as registration_source, r.expires_at as registration_expires_at, coalesce(p.lifecycle_check_failed_at, r.check_failed_at) as lifecycle_check_failed_at
  from member_group_profiles p join member_groups g using (member_group_id) join albion_characters c on c.albion_server = p.albion_server and c.albion_character_id = p.albion_character_id
  left join member_registration_lifecycle r on r.discord_guild_id = p.discord_guild_id and r.albion_server = p.albion_server and r.albion_character_id = p.albion_character_id`;
function bounded(limit: number) { return Math.max(1, Math.min(500, Math.trunc(limit))); }
