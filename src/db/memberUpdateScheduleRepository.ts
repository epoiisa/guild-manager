import type { PostgresPool } from "./postgres.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type MemberUpdateScheduleCadence = "daily" | "weekly";

export interface MemberUpdateScheduleRecord {
  discordGuildId: string;
  cadence: MemberUpdateScheduleCadence;
  weekday: number | null;
  hourUtc: number;
  minuteUtc: number;
  lastRunKey: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  createdByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertMemberUpdateScheduleInput {
  discordGuildId: string;
  cadence: MemberUpdateScheduleCadence;
  weekday: number | null;
  hourUtc: number;
  minuteUtc: number;
  createdByDiscordUserId: string;
}

interface MemberUpdateScheduleRow {
  discord_guild_id: string;
  cadence: MemberUpdateScheduleCadence;
  weekday: number | null;
  hour_utc: number;
  minute_utc: number;
  last_run_key: string | null;
  last_run_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  created_by_discord_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export function createMemberUpdateScheduleRepository(pool: PostgresPool) {
  return {
    getSchedule: (discordGuildId: string) => getSchedule(pool, discordGuildId),
    listSchedules: () => listSchedules(pool),
    upsertSchedule: (input: UpsertMemberUpdateScheduleInput) => upsertSchedule(pool, input),
    removeSchedule: (discordGuildId: string) => removeSchedule(pool, discordGuildId),
    markScheduleRun: (discordGuildId: string, runKey: string, success: boolean, error?: string) =>
      markScheduleRun(pool, discordGuildId, runKey, success, error)
  };
}

async function getSchedule(pool: Queryable, discordGuildId: string): Promise<MemberUpdateScheduleRecord | undefined> {
  const result = await pool.query<MemberUpdateScheduleRow>(
    `
    select
      discord_guild_id,
      cadence,
      weekday,
      hour_utc,
      minute_utc,
      last_run_key,
      last_run_at,
      last_success_at,
      last_error,
      created_by_discord_user_id,
      created_at,
      updated_at
    from member_update_schedules
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );

  const row = result.rows[0];
  return row ? mapSchedule(row) : undefined;
}

async function listSchedules(pool: Queryable): Promise<MemberUpdateScheduleRecord[]> {
  const result = await pool.query<MemberUpdateScheduleRow>(
    `
    select
      discord_guild_id,
      cadence,
      weekday,
      hour_utc,
      minute_utc,
      last_run_key,
      last_run_at,
      last_success_at,
      last_error,
      created_by_discord_user_id,
      created_at,
      updated_at
    from member_update_schedules
    order by discord_guild_id asc
    `
  );

  return result.rows.map(mapSchedule);
}

async function upsertSchedule(pool: Queryable, input: UpsertMemberUpdateScheduleInput): Promise<MemberUpdateScheduleRecord> {
  const result = await pool.query<MemberUpdateScheduleRow>(
    `
    insert into member_update_schedules (
      discord_guild_id,
      cadence,
      weekday,
      hour_utc,
      minute_utc,
      created_by_discord_user_id,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, now())
    on conflict (discord_guild_id) do update set
      cadence = excluded.cadence,
      weekday = excluded.weekday,
      hour_utc = excluded.hour_utc,
      minute_utc = excluded.minute_utc,
      created_by_discord_user_id = excluded.created_by_discord_user_id,
      updated_at = excluded.updated_at
    returning
      discord_guild_id,
      cadence,
      weekday,
      hour_utc,
      minute_utc,
      last_run_key,
      last_run_at,
      last_success_at,
      last_error,
      created_by_discord_user_id,
      created_at,
      updated_at
    `,
    [
      input.discordGuildId,
      input.cadence,
      input.weekday,
      input.hourUtc,
      input.minuteUtc,
      input.createdByDiscordUserId
    ]
  );

  return mapSchedule(result.rows[0]);
}

async function removeSchedule(pool: Queryable, discordGuildId: string): Promise<boolean> {
  const result = await pool.query(
    `
    delete from member_update_schedules
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function markScheduleRun(
  pool: Queryable,
  discordGuildId: string,
  runKey: string,
  success: boolean,
  error?: string
): Promise<void> {
  await pool.query(
    `
    update member_update_schedules
    set
      last_run_key = $2,
      last_run_at = now(),
      last_success_at = case when $3 then now() else last_success_at end,
      last_error = case when $3 then null else $4 end,
      updated_at = now()
    where discord_guild_id = $1
    `,
    [discordGuildId, runKey, success, error ?? "Unknown error"]
  );
}

function mapSchedule(row: MemberUpdateScheduleRow): MemberUpdateScheduleRecord {
  return {
    discordGuildId: row.discord_guild_id,
    cadence: row.cadence,
    weekday: row.weekday,
    hourUtc: row.hour_utc,
    minuteUtc: row.minute_utc,
    lastRunKey: row.last_run_key,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    createdByDiscordUserId: row.created_by_discord_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
