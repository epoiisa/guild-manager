export const MEMBERSHIP_LIFECYCLE_SCHEMA_SQL = `
create sequence membership_lifecycle_revision_seq;
create table member_registration_lifecycle (
  discord_guild_id text not null,
  albion_server text not null,
  albion_character_id text not null,
  previous_discord_user_id text,
  source text not null default 'discord_departure' check (source in ('discord_departure', 'legacy_review')),
  state text not null check (state in ('hold', 'abandoned')),
  detected_at timestamptz not null,
  expires_at timestamptz not null,
  abandoned_at timestamptz,
  revision bigint not null default nextval('membership_lifecycle_revision_seq'),
  check_failed_at timestamptz,
  primary key (discord_guild_id, albion_server, albion_character_id),
  foreign key (albion_server, albion_character_id) references albion_characters (albion_server, albion_character_id) on delete restrict,
  check (expires_at = detected_at + interval '72 hours')
);
create index member_registration_lifecycle_due on member_registration_lifecycle (discord_guild_id, expires_at) where state = 'hold';
alter table member_group_profiles
  add column lifecycle_state text not null default 'current' check (lifecycle_state in ('current', 'manual', 'legacy', 'unregistered', 'departed')),
  add column entitlement_preserved boolean not null default true,
  add column previous_discord_user_id text,
  add column departure_detected_at timestamptz,
  add column departure_expires_at timestamptz,
  add column lifecycle_revision bigint not null default nextval('membership_lifecycle_revision_seq'),
  add column lifecycle_check_failed_at timestamptz;
-- Existing unowned profiles have no reliable cause or departure timestamp.
update member_group_profiles set lifecycle_state = 'legacy' where discord_user_id is null;
create index member_group_profiles_departure_due on member_group_profiles (discord_guild_id, departure_expires_at) where lifecycle_state = 'departed';
create function character_has_preserved_membership(guild_id text, server_name text, character_id text)
returns boolean language sql stable as $$
  select exists (select 1 from member_group_profiles p where p.discord_guild_id = guild_id
    and p.albion_server = server_name and p.albion_character_id = character_id and p.entitlement_preserved)
  and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
    and r.albion_server = server_name and r.albion_character_id = character_id and r.state = 'abandoned')
$$;
create function character_has_active_membership(guild_id text, server_name text, character_id text, owner_id text default null)
returns boolean language sql stable as $$
  select exists (select 1 from member_group_profiles p where p.discord_guild_id = guild_id
    and p.albion_server = server_name and p.albion_character_id = character_id and p.entitlement_preserved
    and p.lifecycle_state = 'current' and p.discord_user_id is not null and (owner_id is null or p.discord_user_id = owner_id))
  and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
    and r.albion_server = server_name and r.albion_character_id = character_id)
$$;
create function character_financial_actions_suspended(guild_id text, server_name text, character_id text)
returns boolean language sql stable as $$
  select exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
    and r.albion_server = server_name and r.albion_character_id = character_id)
  or (not character_has_active_membership(guild_id, server_name, character_id) and exists (
    select 1 from member_group_profiles p where p.discord_guild_id = guild_id
      and p.albion_server = server_name and p.albion_character_id = character_id and p.lifecycle_state = 'departed'))
$$;
create or replace function ensure_character_account_for_profile() returns trigger language plpgsql as $$
declare existing character_accounts%rowtype;
begin
  if current_setting('guild_manager.account_purge_in_progress', true) = 'on'
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
create or replace function close_character_account_after_profile_loss() returns trigger language plpgsql as $$
declare account character_accounts%rowtype; adjustment bigint;
begin
  if current_setting('guild_manager.account_purge_in_progress', true) = 'on' then return old; end if;
  if character_has_preserved_membership(old.discord_guild_id, old.albion_server, old.albion_character_id) then return old; end if;
  select * into account from character_accounts where discord_guild_id = old.discord_guild_id
    and albion_server = old.albion_server and albion_character_id = old.albion_character_id for update;
  if not found or account.status = 'closed' then return old; end if;
  adjustment := -account.balance;
  if adjustment <> 0 then
    insert into account_transactions (account_id, discord_guild_id, transaction_type, amount, balance_after, description)
      values (account.account_id, account.discord_guild_id, 'closure_adjustment', adjustment, 0, 'Character no longer eligible');
  end if;
  update character_accounts set status = 'closed', balance = 0, closed_at = now(), updated_at = now() where account_id = account.account_id;
  insert into account_status_events (account_id, discord_guild_id, from_status, to_status, event_type, reason)
    values (account.account_id, account.discord_guild_id, account.status, 'closed', 'closed', 'Character no longer eligible');
  return old;
end $$;
drop trigger member_group_profiles_ensure_account on member_group_profiles;
create trigger member_group_profiles_ensure_account after insert or update of discord_user_id, albion_server, albion_character_id, entitlement_preserved
  on member_group_profiles for each row execute function ensure_character_account_for_profile();
drop trigger member_group_profiles_close_lost_account on member_group_profiles;
create trigger member_group_profiles_close_lost_account after delete or update of albion_server, albion_character_id, entitlement_preserved
  on member_group_profiles for each row execute function close_character_account_after_profile_loss();
-- Every effective profile change invalidates an earlier external-evidence snapshot.
create function stamp_membership_lifecycle_revision() returns trigger language plpgsql as $$
begin
  if (new.discord_user_id, new.albion_server, new.albion_character_id, new.lifecycle_state, new.entitlement_preserved,
      new.departure_detected_at, new.departure_expires_at) is distinct from
     (old.discord_user_id, old.albion_server, old.albion_character_id, old.lifecycle_state, old.entitlement_preserved,
      old.departure_detected_at, old.departure_expires_at) then
    new.lifecycle_revision := nextval('membership_lifecycle_revision_seq');
  end if;
  return new;
end $$;
create trigger member_group_profiles_lifecycle_revision before update on member_group_profiles
  for each row execute function stamp_membership_lifecycle_revision();
`;

// Deliberate officer purges are terminal; migration leaves historical data alone.
export const MEMBERSHIP_PURGE_SCHEMA_SQL = `
alter table member_registration_lifecycle
  drop constraint member_registration_lifecycle_source_check,
  drop constraint member_registration_lifecycle_state_check,
  drop constraint member_registration_lifecycle_check,
  alter column expires_at drop not null,
  add column purged_at timestamptz;
alter table member_registration_lifecycle
  add check (source in ('discord_departure', 'legacy_review', 'purge')),
  add check (state in ('hold', 'abandoned', 'purged')),
  add check ((state = 'purged' and source = 'purge' and expires_at is null and purged_at is not null and abandoned_at is null)
    or (state in ('hold', 'abandoned') and source <> 'purge' and expires_at is not null
      and expires_at = detected_at + interval '72 hours' and purged_at is null));
create or replace function character_has_preserved_membership(guild_id text, server_name text, character_id text)
returns boolean language sql stable as $$
  select exists (select 1 from member_group_profiles p where p.discord_guild_id = guild_id
    and p.albion_server = server_name and p.albion_character_id = character_id and p.entitlement_preserved)
  and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = guild_id
    and r.albion_server = server_name and r.albion_character_id = character_id and r.state in ('abandoned', 'purged'))
$$;
`;
