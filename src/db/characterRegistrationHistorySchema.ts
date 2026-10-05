// Registration history records ownership, never an entitlement namespace.
export const CHARACTER_REGISTRATION_HISTORY_SCHEMA_SQL = `
lock table discord_user_characters, member_group_profiles, member_registration_lifecycle in share row exclusive mode;

update member_group_profiles set lifecycle_state = 'manual' where lifecycle_state = 'legacy';
alter table member_group_profiles drop constraint member_group_profiles_lifecycle_state_check;
alter table member_group_profiles add constraint member_group_profiles_lifecycle_state_check
  check (lifecycle_state in ('current', 'manual', 'unregistered', 'departed'));
create table character_registration_history (
  discord_guild_id text not null check (length(trim(discord_guild_id)) > 0),
  albion_server text not null,
  albion_character_id text not null,
  discord_user_id text check (discord_user_id is null or length(trim(discord_user_id)) > 0),
  registered_at timestamptz not null check (isfinite(registered_at)),
  unregistered_at timestamptz,
  primary key (discord_guild_id, albion_server, albion_character_id, registered_at),
  foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id) on delete restrict,
  check (unregistered_at is null or (isfinite(unregistered_at) and unregistered_at >= registered_at)),
  check (unregistered_at is not null or discord_user_id is not null)
);
create unique index character_registration_history_one_current_owner
  on character_registration_history (discord_guild_id, albion_server, albion_character_id)
  where unregistered_at is null;

insert into character_registration_history
  (discord_guild_id, albion_server, albion_character_id, discord_user_id, registered_at)
select discord_guild_id, albion_server, albion_character_id, discord_user_id, registered_at
from discord_user_characters;

-- Retained local records supply identities; actors and submitters do not imply ownership.
-- Missing dates use one conversion boundary, with microsecond spacing for keys.
-- Existing Discord departure times remain useful registration end times.
with evidence as (
  select discord_guild_id, albion_server, albion_character_id, previous_discord_user_id as discord_user_id
    from member_registration_lifecycle
  union
  select discord_guild_id, albion_server, albion_character_id, previous_discord_user_id
    from member_group_profiles where previous_discord_user_id is not null
      or (discord_user_id is null and entitlement_preserved)
  union
  select discord_guild_id, albion_server, albion_character_id, null::text from character_accounts
  union
  select discord_guild_id, albion_server, albion_character_id, null::text from regear_claims
  union
  select discord_guild_id, albion_server, albion_character_id, null::text from specialisation_requests
  union
  select discord_guild_id, albion_server, albion_character_id, null::text from character_specialisations
), candidates as (
  select e.*, coalesce(r.registered_at, now()) as boundary,
    case when l.source = 'discord_departure' and l.previous_discord_user_id = e.discord_user_id
      and l.detected_at <= coalesce(r.registered_at, now()) then l.detected_at end as recorded_end
  from evidence e
  left join discord_user_characters r using (discord_guild_id, albion_server, albion_character_id)
  left join member_registration_lifecycle l using (discord_guild_id, albion_server, albion_character_id)
  where not exists (select 1 from member_registration_lifecycle l
    where (l.discord_guild_id, l.albion_server, l.albion_character_id) =
      (e.discord_guild_id, e.albion_server, e.albion_character_id) and l.state = 'purged')
    and (r.discord_user_id is null or (e.discord_user_id is not null and e.discord_user_id <> r.discord_user_id))
    and (e.discord_user_id is not null or not exists (select 1 from evidence known
      where (known.discord_guild_id, known.albion_server, known.albion_character_id) =
        (e.discord_guild_id, e.albion_server, e.albion_character_id) and known.discord_user_id is not null))
), periods as (
  select *, least(boundary, min(recorded_end) over (
    partition by discord_guild_id, albion_server, albion_character_id
  )) - row_number() over (
    partition by discord_guild_id, albion_server, albion_character_id order by discord_user_id nulls last
  ) * interval '1 microsecond' as period_at from candidates
)
insert into character_registration_history
  (discord_guild_id, albion_server, albion_character_id, discord_user_id, registered_at, unregistered_at)
select discord_guild_id, albion_server, albion_character_id, discord_user_id, period_at, coalesce(recorded_end, period_at) from periods;

update member_registration_lifecycle set source = 'discord_departure' where source = 'legacy_review';
alter table member_registration_lifecycle drop constraint member_registration_lifecycle_source_check;
alter table member_registration_lifecycle add constraint member_registration_lifecycle_source_check
  check (source in ('discord_departure', 'purge'));

create function stamp_character_registration_period() returns trigger language plpgsql as $$
declare boundary timestamptz; last_boundary timestamptz; tenant text;
begin
  if tg_op = 'UPDATE' and
    (new.discord_guild_id, new.discord_user_id, new.albion_server, new.albion_character_id) is not distinct from
    (old.discord_guild_id, old.discord_user_id, old.albion_server, old.albion_character_id) then
    new.registered_at := old.registered_at;
    return new;
  end if;
  -- Use the same tenant fence as registration, departure, recovery and reset.
  for tenant in select distinct id from unnest(case when tg_op = 'UPDATE'
      then array[old.discord_guild_id, new.discord_guild_id] else array[new.discord_guild_id] end) id order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended('membership-lifecycle-tenant:' || tenant, 0));
  end loop;
  boundary := case when tg_op = 'UPDATE' then greatest(clock_timestamp(), old.registered_at)
    else coalesce(new.registered_at, clock_timestamp()) end;
  select greatest(max(registered_at) + interval '1 microsecond', max(unregistered_at)) into last_boundary
    from character_registration_history where discord_guild_id = new.discord_guild_id
      and albion_server = new.albion_server and albion_character_id = new.albion_character_id;
  new.registered_at := greatest(boundary, last_boundary);
  return new;
end $$;

create function record_character_registration_period() returns trigger language plpgsql as $$
declare ended_at timestamptz;
begin
  if tg_op = 'UPDATE' and
    (new.discord_guild_id, new.discord_user_id, new.albion_server, new.albion_character_id) is not distinct from
    (old.discord_guild_id, old.discord_user_id, old.albion_server, old.albion_character_id) then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    ended_at := case when tg_op = 'UPDATE' then new.registered_at else greatest(clock_timestamp(), old.registered_at) end;
    update character_registration_history set unregistered_at = ended_at
      where discord_guild_id = old.discord_guild_id and albion_server = old.albion_server
        and albion_character_id = old.albion_character_id and discord_user_id = old.discord_user_id
        and registered_at = old.registered_at and unregistered_at is null;
    if not found then raise exception 'Current registration history is missing'; end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into character_registration_history
      (discord_guild_id, albion_server, albion_character_id, discord_user_id, registered_at)
    values (new.discord_guild_id, new.albion_server, new.albion_character_id, new.discord_user_id, new.registered_at);
    return new;
  end if;
  return old;
end $$;

create trigger discord_user_characters_00_stamp_period before insert or update on discord_user_characters
  for each row execute function stamp_character_registration_period();
create trigger discord_user_characters_record_period after insert or update or delete on discord_user_characters
  for each row execute function record_character_registration_period();
`;
