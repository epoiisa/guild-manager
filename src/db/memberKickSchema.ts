export const MEMBER_KICK_SCHEMA_SQL = `
create table guild_member_access (
  discord_guild_id text not null check (length(trim(discord_guild_id)) > 0),
  discord_user_id text not null check (length(trim(discord_user_id)) > 0),
  blocked boolean not null default true,
  cleanup_pending boolean not null default true,
  revoked_role_ids text[] not null default '{}',
  cleanup_role_ids text[] not null default '{}',
  last_kicked_at timestamptz,
  revision bigint not null default nextval('membership_lifecycle_revision_seq'),
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id),
  check (blocked or not cleanup_pending)
);
create table character_kick_recovery (
  discord_guild_id text not null check (length(trim(discord_guild_id)) > 0),
  albion_server text not null,
  albion_character_id text not null,
  disconnected_discord_user_id text not null check (length(trim(disconnected_discord_user_id)) > 0),
  recovery_required boolean not null default true,
  revision bigint not null default nextval('membership_lifecycle_revision_seq'),
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, albion_server, albion_character_id),
  foreign key (albion_server, albion_character_id) references albion_characters(albion_server, albion_character_id) on delete restrict
);

-- Retained character records are independent of the memberships that kick removes.
create or replace function character_has_preserved_membership(guild_id text, server_name text, character_id text)
returns boolean language sql stable as $$
  select exists (select 1 from character_kick_recovery k where k.discord_guild_id = guild_id
    and k.albion_server = server_name and k.albion_character_id = character_id and k.recovery_required)
  or (exists (select 1 from member_group_profiles p where p.discord_guild_id = guild_id
      and p.albion_server = server_name and p.albion_character_id = character_id and p.entitlement_preserved)
    and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
      and r.albion_server = server_name and r.albion_character_id = character_id and r.state in ('abandoned', 'purged')))
$$;

create or replace function character_has_active_membership(guild_id text, server_name text, character_id text, owner_id text default null)
returns boolean language sql stable as $$
  select exists (select 1 from member_group_profiles p where p.discord_guild_id = guild_id
    and p.albion_server = server_name and p.albion_character_id = character_id and p.entitlement_preserved
    and p.lifecycle_state = 'current' and p.discord_user_id is not null and (owner_id is null or p.discord_user_id = owner_id)
    and not exists (select 1 from guild_member_access a where a.discord_guild_id = guild_id and a.discord_user_id = p.discord_user_id and a.blocked))
  and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
    and r.albion_server = server_name and r.albion_character_id = character_id)
  and not exists (select 1 from character_kick_recovery k where k.discord_guild_id = guild_id
    and k.albion_server = server_name and k.albion_character_id = character_id and k.recovery_required)
$$;

-- Roster observations during officer-controlled recovery never create an account.
create or replace function ensure_character_account_for_profile() returns trigger language plpgsql as $$
declare existing character_accounts%rowtype;
begin
  if current_setting('guild_manager.account_purge_in_progress', true) = 'on'
    or exists (select 1 from character_kick_recovery k where k.discord_guild_id = new.discord_guild_id
      and k.albion_server = new.albion_server and k.albion_character_id = new.albion_character_id and k.recovery_required)
    or not character_has_preserved_membership(new.discord_guild_id, new.albion_server, new.albion_character_id) then return new; end if;
  select * into existing from character_accounts where discord_guild_id = new.discord_guild_id
    and albion_server = new.albion_server and albion_character_id = new.albion_character_id for update;
  if not found then
    insert into character_accounts (discord_guild_id, albion_server, albion_character_id)
      values (new.discord_guild_id, new.albion_server, new.albion_character_id) returning * into existing;
    insert into account_status_events (account_id, discord_guild_id, to_status, event_type)
      values (existing.account_id, existing.discord_guild_id, 'open', 'created');
  elsif existing.status = 'closed' then
    update character_accounts set status = 'open', closed_at = null, updated_at = now() where account_id = existing.account_id;
    insert into account_status_events (account_id, discord_guild_id, from_status, to_status, event_type)
      values (existing.account_id, existing.discord_guild_id, 'closed', 'open', 'reopened');
  end if;
  return new;
end $$;

create function assert_guild_member_access(guild_id text, user_id text) returns void language plpgsql as $$
begin
  if user_id is null then return; end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('guild-manager-member-access:' || guild_id || ':' || user_id, 0));
  if exists (select 1 from guild_member_access where discord_guild_id = guild_id and discord_user_id = user_id and blocked) then
    raise exception 'This Discord user requires officer reconnection' using errcode = '23514', constraint = 'guild_member_access_allowed';
  end if;
end $$;
create function guard_character_registration_access() returns trigger language plpgsql as $$
begin
  perform assert_guild_member_access(new.discord_guild_id, new.discord_user_id);
  if exists (select 1 from character_kick_recovery where discord_guild_id = new.discord_guild_id
    and albion_server = new.albion_server and albion_character_id = new.albion_character_id and recovery_required) then
    raise exception 'This character requires officer reconnection' using errcode = '23514', constraint = 'character_kick_recovery_required';
  end if;
  return new;
end $$;
create trigger discord_user_characters_00_access before insert or update on discord_user_characters
  for each row execute function guard_character_registration_access();

create function guard_guild_member_owned_row() returns trigger language plpgsql as $$
declare user_id text;
begin
  user_id := to_jsonb(new)->>tg_argv[0];
  if tg_table_name = 'temporary_voice_channels' and to_jsonb(new)->>'ownership_revoked_at' is not null then return new; end if;
  if tg_nargs > 1 and to_jsonb(new)->>tg_argv[1] <> tg_argv[2] then return new; end if;
  perform assert_guild_member_access(new.discord_guild_id, user_id);
  if tg_table_name = 'member_group_profiles' and user_id is not null
    and exists (select 1 from character_kick_recovery k where k.discord_guild_id = new.discord_guild_id
      and k.albion_server = to_jsonb(new)->>'albion_server' and k.albion_character_id = to_jsonb(new)->>'albion_character_id' and k.recovery_required) then
    raise exception 'This character requires officer reconnection' using errcode = '23514', constraint = 'character_kick_recovery_required';
  end if;
  return new;
end $$;
create trigger member_group_profiles_access before insert or update of discord_user_id on member_group_profiles
  for each row execute function guard_guild_member_owned_row('discord_user_id');
create trigger content_items_host_access before insert or update of leader_discord_user_id on content_items
  for each row execute function guard_guild_member_owned_row('leader_discord_user_id');
create trigger giveaways_creator_access before insert or update of creator_discord_user_id on giveaways
  for each row execute function guard_guild_member_owned_row('creator_discord_user_id');
create trigger content_signups_member_access before insert or update on content_signups
  for each row execute function guard_guild_member_owned_row('discord_user_id', 'state', 'active');
create trigger content_signup_requests_member_access before insert or update on content_signup_requests
  for each row execute function guard_guild_member_owned_row('discord_user_id', 'status', 'pending');
create trigger giveaway_entries_member_access before insert or update on giveaway_entries
  for each row execute function guard_guild_member_owned_row('discord_user_id');
create trigger giveaway_reactions_member_access before insert or update on giveaway_reactions
  for each row execute function guard_guild_member_owned_row('discord_user_id');
create trigger temporary_voice_channels_member_access before insert or update on temporary_voice_channels
  for each row execute function guard_guild_member_owned_row('owner_discord_user_id');
create trigger reaction_role_subscriptions_member_access before insert or update on reaction_role_subscriptions
  for each row execute function guard_guild_member_owned_row('discord_user_id');
`;
