export const KICK_ACTIVITIES_SCHEMA_SQL = `
create table if not exists member_kick_activity_revocations (
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  discord_user_id text not null,
  kind text not null check (kind in ('content_host', 'giveaway_host', 'application', 'ticket', 'voice')),
  target_id text not null,
  revoked_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id, kind, target_id)
);
create table if not exists member_kick_activity_cleanup (
  cleanup_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  discord_user_id text not null,
  kind text not null check (kind in ('content', 'giveaway', 'application', 'ticket', 'voice')),
  target_id text not null,
  channel_id text not null,
  message_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(message_ids) = 'array'),
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  unique (discord_guild_id, discord_user_id, kind, target_id)
);
alter table open_applications add column if not exists access_revoked_at timestamptz;
alter table tickets add column if not exists access_revoked_at timestamptz;
alter table temporary_voice_channels add column if not exists ownership_revoked_at timestamptz;
do $$ declare owner_constraint text; begin
  select conname into owner_constraint from pg_constraint
    where conrelid = 'temporary_voice_channels'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (discord_guild_id, owner_discord_user_id)';
  if owner_constraint is not null then
    execute format('alter table temporary_voice_channels drop constraint %I', owner_constraint);
  end if;
end $$;
create unique index if not exists temporary_voice_channels_active_owner
  on temporary_voice_channels (discord_guild_id, owner_discord_user_id) where ownership_revoked_at is null;
`;
