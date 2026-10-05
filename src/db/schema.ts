import type { PostgresPool } from "./postgres.js";
import { MEMBERSHIP_LIFECYCLE_SCHEMA_SQL, MEMBERSHIP_PURGE_SCHEMA_SQL } from "./membershipLifecycleSchema.js";
import { MEMBERSHIP_ENTITLEMENT_CLEANUP_SCHEMA_SQL } from "./membershipEntitlementCleanup.js";
import { CHARACTER_REGISTRATION_HISTORY_SCHEMA_SQL } from "./characterRegistrationHistorySchema.js";
import { MEMBER_KICK_SCHEMA_SQL } from "./memberKickSchema.js";
import { KICK_ACTIVITIES_SCHEMA_SQL } from "./kickActivitiesSchema.js";
import { SPECIALISATION_CATALOGUE } from "../services/specialisations/catalogue.js";

export const CURRENT_SCHEMA_VERSION = 51;

const MIGRATION_001_CORE_MEMBERSHIP_IDENTITY = `
create table if not exists guild_manager_schema_migrations (
  version integer primary key,
  name text not null,
  applied_at timestamptz not null default now()
);

create table if not exists albion_characters (
  albion_server text not null,
  albion_character_id text not null,
  character_name text not null,
  guild_id text,
  guild_name text,
  alliance_id text,
  alliance_name text,
  alliance_tag text,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (albion_server, albion_character_id),
  constraint albion_characters_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint albion_characters_id_nonempty check (length(trim(albion_character_id)) > 0),
  constraint albion_characters_name_nonempty check (length(trim(character_name)) > 0)
);

create table if not exists discord_user_characters (
  discord_guild_id text not null,
  discord_user_id text not null,
  albion_server text not null,
  albion_character_id text not null,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id, albion_server, albion_character_id),
  constraint discord_user_characters_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint discord_user_characters_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint discord_user_characters_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade
    on delete restrict
);

create unique index if not exists discord_user_characters_one_owner_per_guild_character
  on discord_user_characters (discord_guild_id, albion_server, albion_character_id);

create table if not exists member_groups (
  member_group_id bigserial primary key,
  discord_guild_id text not null,
  albion_server text not null,
  group_type text not null,
  group_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_groups_discord_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint member_groups_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint member_groups_type_check check (group_type in ('group', 'guild', 'alliance')),
  constraint member_groups_name_nonempty check (length(trim(group_name)) > 0),
  unique (member_group_id, discord_guild_id, albion_server)
);

create unique index if not exists member_groups_group_name_unique
  on member_groups (discord_guild_id, albion_server, lower(group_name))
  where group_type = 'group';

create table if not exists configured_albion_guilds (
  member_group_id bigint primary key references member_groups (member_group_id) on delete cascade,
  discord_guild_id text not null,
  albion_server text not null,
  albion_guild_id text not null,
  albion_guild_name text not null,
  managed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint configured_albion_guilds_id_nonempty check (length(trim(albion_guild_id)) > 0),
  constraint configured_albion_guilds_name_nonempty check (length(trim(albion_guild_name)) > 0),
  constraint configured_albion_guilds_group_fk foreign key (member_group_id, discord_guild_id, albion_server)
    references member_groups (member_group_id, discord_guild_id, albion_server)
    on update cascade
    on delete cascade,
  unique (discord_guild_id, albion_server, albion_guild_id)
);

create table if not exists configured_albion_alliances (
  member_group_id bigint primary key references member_groups (member_group_id) on delete cascade,
  discord_guild_id text not null,
  albion_server text not null,
  albion_alliance_id text not null,
  albion_alliance_name text not null,
  albion_alliance_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint configured_albion_alliances_id_nonempty check (length(trim(albion_alliance_id)) > 0),
  constraint configured_albion_alliances_name_nonempty check (length(trim(albion_alliance_name)) > 0),
  constraint configured_albion_alliances_group_fk foreign key (member_group_id, discord_guild_id, albion_server)
    references member_groups (member_group_id, discord_guild_id, albion_server)
    on update cascade
    on delete cascade,
  unique (discord_guild_id, albion_server, albion_alliance_id)
);

create table if not exists member_group_profiles (
  member_group_profile_id bigserial primary key,
  member_group_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text,
  albion_server text not null,
  albion_character_id text not null,
  discovered_at timestamptz,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_group_profiles_group_fk foreign key (member_group_id, discord_guild_id, albion_server)
    references member_groups (member_group_id, discord_guild_id, albion_server)
    on update cascade
    on delete cascade,
  constraint member_group_profiles_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade
    on delete restrict,
  constraint member_group_profiles_registered_owner_fk foreign key (
    discord_guild_id,
    discord_user_id,
    albion_server,
    albion_character_id
  )
    references discord_user_characters (
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id
    )
    on update cascade
    on delete set null (discord_user_id),
  unique (member_group_id, albion_server, albion_character_id)
);

create table if not exists discord_user_main_characters (
  discord_guild_id text not null,
  discord_user_id text not null,
  albion_server text not null,
  albion_character_id text not null,
  selected_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id),
  constraint discord_user_main_characters_registration_fk foreign key (
    discord_guild_id,
    discord_user_id,
    albion_server,
    albion_character_id
  )
    references discord_user_characters (
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id
    )
    on update cascade
    on delete cascade
);

create table if not exists discord_user_custom_nicknames (
  discord_guild_id text not null,
  discord_user_id text not null,
  nickname text not null,
  updated_at timestamptz not null default now(),
  primary key (discord_guild_id, discord_user_id),
  constraint discord_user_custom_nicknames_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint discord_user_custom_nicknames_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint discord_user_custom_nicknames_nickname_nonempty check (length(trim(nickname)) > 0)
);

create table if not exists character_role_configs (
  character_role_config_id bigserial primary key,
  discord_guild_id text not null,
  albion_server text,
  discord_role_id text not null,
  reaction boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint character_role_configs_server_check check (
    albion_server is null or albion_server in ('americas', 'asia', 'europe')
  ),
  constraint character_role_configs_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint character_role_configs_role_nonempty check (length(trim(discord_role_id)) > 0)
);

alter table character_role_configs
  add column if not exists reaction boolean not null default false;

alter table character_role_configs
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists character_role_configs_unique_scope_role
  on character_role_configs (discord_guild_id, coalesce(albion_server, 'all'), discord_role_id);

create table if not exists member_group_role_configs (
  member_group_role_config_id bigserial primary key,
  member_group_id bigint not null references member_groups (member_group_id) on delete cascade,
  discord_role_id text not null,
  reaction boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_group_role_configs_role_nonempty check (length(trim(discord_role_id)) > 0),
  unique (member_group_id, discord_role_id)
);
`;

const MIGRATION_002_DISCORD_GUILD_LIFECYCLE = `
create table if not exists discord_guild_lifecycle (
  discord_guild_id text primary key,
  status text not null,
  guild_name text not null,
  activated_at timestamptz,
  activated_by_discord_user_id text,
  inactive_at timestamptz,
  inactive_by_discord_user_id text,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discord_guild_lifecycle_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint discord_guild_lifecycle_name_nonempty check (length(trim(guild_name)) > 0),
  constraint discord_guild_lifecycle_status_check check (status in ('active', 'inactive')),
  constraint discord_guild_lifecycle_active_timestamp_check check (
    status <> 'active' or activated_at is not null
  ),
  constraint discord_guild_lifecycle_inactive_timestamp_check check (
    status <> 'inactive' or inactive_at is not null
  )
);

create index if not exists discord_guild_lifecycle_due_purge
  on discord_guild_lifecycle (purge_after)
  where status = 'inactive' and purge_after is not null;
`;

const MIGRATION_003_UTC_VOICE_CHANNELS = `
create table if not exists utc_voice_channels (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  discord_channel_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint utc_voice_channels_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint utc_voice_channels_channel_nonempty check (length(trim(discord_channel_id)) > 0)
);
`;

const MIGRATION_004_DISCORD_GUILD_DEFAULTS = `
create unique index if not exists configured_albion_guilds_group_guild_server_unique
  on configured_albion_guilds (member_group_id, discord_guild_id, albion_server);

create table if not exists discord_guild_defaults (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  default_albion_guild_member_group_id bigint not null,
  default_albion_server text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discord_guild_defaults_server_check check (default_albion_server in ('americas', 'asia', 'europe')),
  constraint discord_guild_defaults_guild_fk foreign key (
    default_albion_guild_member_group_id,
    discord_guild_id,
    default_albion_server
  )
    references configured_albion_guilds (member_group_id, discord_guild_id, albion_server)
    on update cascade
    on delete cascade
);
`;

const MIGRATION_005_MEMBER_UPDATE_SCHEDULES = `
create table if not exists member_update_schedules (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  cadence text not null,
  weekday integer,
  hour_utc integer not null,
  minute_utc integer not null,
  last_run_key text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_update_schedules_cadence_check check (cadence in ('daily', 'weekly')),
  constraint member_update_schedules_weekday_check check (weekday is null or weekday between 0 and 6),
  constraint member_update_schedules_hour_check check (hour_utc between 0 and 23),
  constraint member_update_schedules_minute_check check (minute_utc between 0 and 59),
  constraint member_update_schedules_cadence_weekday_check check (
    (cadence = 'daily' and weekday is null)
    or (cadence = 'weekly' and weekday is not null)
  ),
  constraint member_update_schedules_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint member_update_schedules_creator_nonempty check (length(trim(created_by_discord_user_id)) > 0)
);
`;

const MIGRATION_006_APPLICATION_TICKETS = `
create table if not exists application_classes (
  application_class_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  name text not null,
  outcome_type text not null,
  member_group_id bigint,
  albion_server text not null,
  active_role_id text,
  source_channel_id text,
  source_message_id text,
  button_label text,
  button_style text,
  ticket_category_id text not null,
  reviewer_role_id text not null,
  questions jsonb not null default '[]'::jsonb,
  initial_message text,
  acceptance_message text,
  rejection_message text,
  enabled boolean not null default true,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint application_classes_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint application_classes_name_nonempty check (length(trim(name)) > 0),
  constraint application_classes_outcome_type_check check (outcome_type in ('register_character', 'member_group')),
  constraint application_classes_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint application_classes_button_style_check check (
    button_style is null or button_style in ('primary', 'secondary', 'success', 'danger')
  ),
  constraint application_classes_member_group_required_check check (
    (outcome_type = 'member_group' and member_group_id is not null)
    or (outcome_type = 'register_character' and member_group_id is null)
  ),
  constraint application_classes_source_message_pair_check check (
    (source_channel_id is null and source_message_id is null and button_label is null and button_style is null)
    or (source_channel_id is not null and source_message_id is not null and button_label is not null and button_style is not null)
  ),
  constraint application_classes_group_fk foreign key (member_group_id, discord_guild_id, albion_server)
    references member_groups (member_group_id, discord_guild_id, albion_server)
    on update cascade
    on delete restrict
);

create unique index if not exists application_classes_unique_name
  on application_classes (discord_guild_id, lower(name));

create index if not exists application_classes_source_message
  on application_classes (discord_guild_id, source_channel_id, source_message_id)
  where source_channel_id is not null and source_message_id is not null;

create unique index if not exists application_classes_unique_id_guild
  on application_classes (application_class_id, discord_guild_id);

create table if not exists open_applications (
  application_id bigserial primary key,
  application_class_id bigint not null references application_classes (application_class_id) on delete restrict,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  applicant_discord_user_id text not null,
  ticket_channel_id text not null,
  submitted_character_name text not null,
  modal_answers jsonb not null default '[]'::jsonb,
  albion_server text not null,
  selected_albion_character_id text,
  character_resolution_state text not null default 'unresolved',
  status text not null default 'open',
  reviewer_discord_user_id text,
  accepted_at timestamptz,
  rejected_at timestamptz,
  closed_at timestamptz,
  closed_by_discord_user_id text,
  last_ingame_membership_check_at timestamptz,
  last_ingame_membership_failure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint open_applications_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint open_applications_applicant_nonempty check (length(trim(applicant_discord_user_id)) > 0),
  constraint open_applications_channel_nonempty check (length(trim(ticket_channel_id)) > 0),
  constraint open_applications_character_name_nonempty check (length(trim(submitted_character_name)) > 0),
  constraint open_applications_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint open_applications_resolution_state_check check (
    character_resolution_state in ('unresolved', 'selected', 'not_listed', 'registered_to_other_user')
  ),
  constraint open_applications_status_check check (
    status in ('open', 'accepted', 'awaiting_ingame_membership', 'rejected', 'closed')
  ),
  constraint open_applications_selected_character_fk foreign key (albion_server, selected_albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade
    on delete restrict,
  constraint open_applications_class_guild_fk foreign key (application_class_id, discord_guild_id)
    references application_classes (application_class_id, discord_guild_id)
    on update cascade
    on delete restrict
);

create index if not exists open_applications_ticket_channel
  on open_applications (discord_guild_id, ticket_channel_id);

create index if not exists open_applications_closed_cleanup
  on open_applications (closed_at)
  where status = 'closed' and closed_at is not null;
`;

const MIGRATION_007_APPLICATION_TICKET_CHANNEL_DEFER = `
alter table open_applications
  alter column ticket_channel_id drop not null;

alter table open_applications
  drop constraint if exists open_applications_channel_nonempty;

alter table open_applications
  add constraint open_applications_channel_nonempty check (
    ticket_channel_id is null or length(trim(ticket_channel_id)) > 0
  );
`;

const MIGRATION_008_GROUP_SCOPED_ROLES = `
create unique index if not exists member_groups_id_guild_unique
  on member_groups (member_group_id, discord_guild_id);

create table if not exists member_group_scoped_roles (
  member_group_scoped_role_id bigserial primary key,
  discord_guild_id text not null,
  member_group_id bigint not null,
  name text not null,
  discord_role_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_group_scoped_roles_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint member_group_scoped_roles_name_nonempty check (length(trim(name)) > 0),
  constraint member_group_scoped_roles_role_nonempty check (length(trim(discord_role_id)) > 0),
  constraint member_group_scoped_roles_group_fk foreign key (member_group_id, discord_guild_id)
    references member_groups (member_group_id, discord_guild_id)
    on update cascade
    on delete cascade,
  unique (member_group_scoped_role_id, discord_guild_id)
);

create unique index if not exists member_group_scoped_roles_group_name_unique
  on member_group_scoped_roles (member_group_id, lower(name));

create table if not exists member_group_scoped_role_assignments (
  member_group_scoped_role_assignment_id bigserial primary key,
  member_group_scoped_role_id bigint not null,
  member_group_profile_id bigint not null,
  discord_guild_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_group_scoped_role_assignments_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint member_group_scoped_role_assignments_role_fk foreign key (
    member_group_scoped_role_id,
    discord_guild_id
  )
    references member_group_scoped_roles (member_group_scoped_role_id, discord_guild_id)
    on update cascade
    on delete cascade,
  constraint member_group_scoped_role_assignments_profile_fk foreign key (member_group_profile_id)
    references member_group_profiles (member_group_profile_id)
    on update cascade
    on delete cascade,
  unique (member_group_scoped_role_id, member_group_profile_id)
);

create index if not exists member_group_scoped_role_assignments_profile
  on member_group_scoped_role_assignments (member_group_profile_id);
`;

const MIGRATION_009_GROUP_TYPE_NOMENCLATURE = `
alter table member_groups
  drop constraint if exists member_groups_type_check;

drop index if exists member_groups_custom_name_unique;

update member_groups
set group_type = 'group',
    updated_at = now()
where group_type = 'custom';

alter table member_groups
  add constraint member_groups_type_check check (group_type in ('group', 'guild', 'alliance'));

create unique index if not exists member_groups_group_name_unique
  on member_groups (discord_guild_id, albion_server, lower(group_name))
  where group_type = 'group';
`;

const MIGRATION_010_CONTENT_SIGNUPS = `
create table if not exists content_channel_configs (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  discord_channel_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_channel_configs_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint content_channel_configs_channel_nonempty check (length(trim(discord_channel_id)) > 0)
);

create table if not exists content_templates (
  content_template_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  name text not null,
  title text not null,
  description text not null,
  roles_text text not null,
  created_by_discord_user_id text not null,
  updated_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_templates_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint content_templates_name_nonempty check (length(trim(name)) > 0),
  constraint content_templates_title_nonempty check (length(trim(title)) > 0),
  constraint content_templates_creator_nonempty check (length(trim(created_by_discord_user_id)) > 0),
  constraint content_templates_updater_nonempty check (length(trim(updated_by_discord_user_id)) > 0),
  unique (content_template_id, discord_guild_id)
);

create unique index if not exists content_templates_guild_name_unique
  on content_templates (discord_guild_id, lower(name));

create table if not exists content_items (
  content_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  source_channel_id text not null,
  thread_channel_id text not null,
  leader_discord_user_id text not null,
  title text not null,
  description text not null,
  scheduled_start_at timestamptz not null,
  state text not null default 'scheduled',
  initial_message_id text,
  start_notification_message_id text,
  last_rendered_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  cancelled_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_items_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint content_items_source_channel_nonempty check (length(trim(source_channel_id)) > 0),
  constraint content_items_thread_channel_nonempty check (length(trim(thread_channel_id)) > 0),
  constraint content_items_leader_nonempty check (length(trim(leader_discord_user_id)) > 0),
  constraint content_items_title_nonempty check (length(trim(title)) > 0),
  constraint content_items_state_check check (state in ('scheduled', 'active', 'ended', 'cancelled', 'archived')),
  unique (content_id, discord_guild_id)
);

create unique index if not exists content_items_thread_unique
  on content_items (discord_guild_id, thread_channel_id);

create index if not exists content_items_due_start
  on content_items (scheduled_start_at)
  where state = 'scheduled';

create index if not exists content_items_due_cleanup
  on content_items (scheduled_start_at)
  where state in ('scheduled', 'active', 'ended', 'cancelled');

create table if not exists content_role_slots (
  content_role_slot_id bigserial primary key,
  content_id bigint not null,
  discord_guild_id text not null,
  slot_index integer not null,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_role_slots_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint content_role_slots_label_nonempty check (length(trim(label)) > 0),
  constraint content_role_slots_index_positive check (slot_index > 0),
  constraint content_role_slots_content_fk foreign key (content_id, discord_guild_id)
    references content_items (content_id, discord_guild_id)
    on update cascade
    on delete cascade,
  unique (content_id, slot_index),
  unique (content_role_slot_id, content_id, discord_guild_id)
);

create table if not exists content_signups (
  content_signup_id bigserial primary key,
  content_id bigint not null,
  content_role_slot_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  state text not null default 'active',
  removed_at timestamptz,
  removed_by_discord_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_signups_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint content_signups_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint content_signups_state_check check (state in ('active', 'removed')),
  constraint content_signups_content_fk foreign key (content_id, discord_guild_id)
    references content_items (content_id, discord_guild_id)
    on update cascade
    on delete cascade,
  constraint content_signups_slot_fk foreign key (content_role_slot_id, content_id, discord_guild_id)
    references content_role_slots (content_role_slot_id, content_id, discord_guild_id)
    on update cascade
    on delete cascade
);

create unique index if not exists content_signups_one_active_user_per_content
  on content_signups (content_id, discord_user_id)
  where state = 'active';

create unique index if not exists content_signups_one_active_user_per_slot
  on content_signups (content_role_slot_id)
  where state = 'active';
`;

const MIGRATION_011_REACTION_ROLES = `
alter table character_role_configs drop column if exists reaction;
alter table member_group_role_configs drop column if exists reaction;

create table if not exists reaction_role_configs (
  reaction_role_config_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  discord_role_id text not null,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reaction_role_configs_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint reaction_role_configs_role_nonempty check (length(trim(discord_role_id)) > 0),
  unique (discord_guild_id, discord_role_id),
  unique (reaction_role_config_id, discord_guild_id)
);

create table if not exists reaction_role_emoji_placements (
  reaction_role_emoji_placement_id bigserial primary key,
  reaction_role_config_id bigint not null,
  discord_guild_id text not null,
  channel_id text not null,
  message_id text not null,
  emoji_key text not null,
  emoji_display_value text not null,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reaction_role_emoji_placements_config_fk foreign key (reaction_role_config_id, discord_guild_id)
    references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade,
  constraint reaction_role_emoji_placements_key_nonempty check (length(trim(emoji_key)) > 0),
  constraint reaction_role_emoji_placements_display_nonempty check (length(trim(emoji_display_value)) > 0),
  unique (reaction_role_config_id),
  unique (discord_guild_id, message_id, emoji_key)
);

create index if not exists reaction_role_emoji_placements_message_lookup
  on reaction_role_emoji_placements (discord_guild_id, channel_id, message_id);
`;

const MIGRATION_012_REACTION_ROLE_MEMBERSHIP = `
create table if not exists reaction_role_member_groups (
  reaction_role_config_id bigint not null,
  member_group_id bigint not null references member_groups (member_group_id) on delete cascade,
  discord_guild_id text not null,
  connected_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (reaction_role_config_id, member_group_id),
  constraint reaction_role_member_groups_config_fk foreign key (reaction_role_config_id, discord_guild_id)
    references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade
);

create index if not exists reaction_role_member_groups_group_lookup
  on reaction_role_member_groups (discord_guild_id, member_group_id);

create table if not exists reaction_role_subscriptions (
  reaction_role_config_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reaction_role_config_id, discord_user_id),
  constraint reaction_role_subscriptions_config_fk foreign key (reaction_role_config_id, discord_guild_id)
    references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade
);

create index if not exists reaction_role_subscriptions_user_lookup
  on reaction_role_subscriptions (discord_guild_id, discord_user_id);
`;

const MIGRATION_013_CHARACTER_ACCOUNTS = `
create sequence if not exists account_transfer_id_seq;

create table if not exists character_accounts (
  account_id bigserial primary key,
  discord_guild_id text not null,
  albion_server text not null,
  albion_character_id text not null,
  status text not null default 'open',
  balance bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint character_accounts_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id) on update cascade on delete restrict,
  constraint character_accounts_status_check check (status in ('open', 'frozen', 'closed')),
  unique (discord_guild_id, albion_server, albion_character_id),
  unique (account_id, discord_guild_id)
);

create unique index if not exists character_accounts_id_guild_unique on character_accounts (account_id, discord_guild_id);

create table if not exists account_transactions (
  transaction_id bigserial primary key,
  account_id bigint not null,
  discord_guild_id text not null,
  transaction_type text not null,
  amount bigint not null,
  balance_after bigint not null,
  actor_discord_user_id text,
  transfer_id bigint,
  description text,
  created_at timestamptz not null default now(),
  constraint account_transactions_type_check check (transaction_type in (
    'credit', 'debit', 'transfer_credit', 'transfer_debit',
    'set_adjustment', 'reset_adjustment', 'purge_adjustment', 'closure_adjustment'
  )),
  constraint account_transactions_amount_nonzero check (amount <> 0),
  constraint account_transactions_description_length check (description is null or length(description) between 1 and 200)
);

alter table account_transactions drop constraint if exists account_transactions_account_id_fkey;
alter table account_transactions drop constraint if exists account_transactions_account_fk;
alter table account_transactions add constraint account_transactions_account_fk foreign key (account_id, discord_guild_id)
  references character_accounts (account_id, discord_guild_id) on delete cascade;

alter table account_transactions drop constraint if exists account_transactions_type_check;
alter table account_transactions add constraint account_transactions_type_check check (transaction_type in (
  'credit', 'debit', 'transfer_credit', 'transfer_debit',
  'set_adjustment', 'reset_adjustment', 'purge_adjustment', 'closure_adjustment'
));

create index if not exists account_transactions_account_history
  on account_transactions (account_id, created_at desc, transaction_id desc);
create index if not exists account_transactions_transfer
  on account_transactions (transfer_id) where transfer_id is not null;

create table if not exists account_status_events (
  account_status_event_id bigserial primary key,
  account_id bigint not null,
  discord_guild_id text not null,
  from_status text,
  to_status text not null,
  actor_discord_user_id text,
  reason text,
  event_type text not null,
  created_at timestamptz not null default now(),
  constraint account_status_events_status_check check (
    (from_status is null or from_status in ('open', 'frozen', 'closed'))
    and to_status in ('open', 'frozen', 'closed')
  ),
  constraint account_status_events_type_check check (event_type in ('created', 'reopened', 'frozen', 'unfrozen', 'closed')),
  constraint account_status_events_reason_length check (reason is null or length(reason) between 1 and 200)
);

alter table account_status_events drop constraint if exists account_status_events_account_id_fkey;
alter table account_status_events drop constraint if exists account_status_events_account_fk;
alter table account_status_events add constraint account_status_events_account_fk foreign key (account_id, discord_guild_id)
  references character_accounts (account_id, discord_guild_id) on delete cascade;

alter table character_accounts drop constraint if exists character_accounts_guild_fk;

create or replace function ensure_character_account_for_profile() returns trigger language plpgsql as $$
declare
  existing character_accounts%rowtype;
begin
  if current_setting('guild_manager.account_purge_in_progress', true) = 'on' then
    return new;
  end if;
  select * into existing from character_accounts
  where discord_guild_id = new.discord_guild_id
    and albion_server = new.albion_server
    and albion_character_id = new.albion_character_id
  for update;

  if not found then
    insert into character_accounts (discord_guild_id, albion_server, albion_character_id)
    values (new.discord_guild_id, new.albion_server, new.albion_character_id)
    returning * into existing;
    insert into account_status_events (account_id, discord_guild_id, to_status, event_type)
    values (existing.account_id, existing.discord_guild_id, 'open', 'created');
  elsif existing.status = 'closed' then
    update character_accounts set status = 'open', closed_at = null, updated_at = now()
    where account_id = existing.account_id;
    insert into account_status_events (account_id, discord_guild_id, from_status, to_status, event_type)
    values (existing.account_id, existing.discord_guild_id, 'closed', 'open', 'reopened');
  end if;
  return new;
end $$;

drop trigger if exists member_group_profiles_ensure_account on member_group_profiles;
create trigger member_group_profiles_ensure_account
after insert or update of discord_user_id, albion_server, albion_character_id on member_group_profiles
for each row execute function ensure_character_account_for_profile();

create or replace function close_character_account_after_profile_loss() returns trigger language plpgsql as $$
declare
  account character_accounts%rowtype;
  adjustment bigint;
begin
  if current_setting('guild_manager.account_purge_in_progress', true) = 'on' then
    return old;
  end if;
  if tg_op = 'UPDATE' and old.discord_guild_id = new.discord_guild_id
    and old.albion_server = new.albion_server and old.albion_character_id = new.albion_character_id then
    return new;
  end if;
  if exists (
    select 1 from member_group_profiles
    where discord_guild_id = old.discord_guild_id
      and albion_server = old.albion_server
      and albion_character_id = old.albion_character_id
  ) then
    return old;
  end if;
  select * into account from character_accounts
  where discord_guild_id = old.discord_guild_id
    and albion_server = old.albion_server
    and albion_character_id = old.albion_character_id
  for update;
  if not found or account.status = 'closed' then return old; end if;
  adjustment := -account.balance;
  if adjustment <> 0 then
    insert into account_transactions (
      account_id, discord_guild_id, transaction_type, amount, balance_after, description
    ) values (
      account.account_id, account.discord_guild_id, 'closure_adjustment', adjustment, 0, 'Character no longer eligible'
    );
  end if;
  update character_accounts set status = 'closed', balance = 0, closed_at = now(), updated_at = now()
  where account_id = account.account_id;
  insert into account_status_events (account_id, discord_guild_id, from_status, to_status, event_type, reason)
  values (account.account_id, account.discord_guild_id, account.status, 'closed', 'closed', 'Character no longer eligible');
  return old;
end $$;

drop trigger if exists member_group_profiles_close_lost_account on member_group_profiles;
create trigger member_group_profiles_close_lost_account
after delete or update of albion_server, albion_character_id on member_group_profiles
for each row execute function close_character_account_after_profile_loss();

insert into character_accounts (discord_guild_id, albion_server, albion_character_id)
select distinct discord_guild_id, albion_server, albion_character_id
from member_group_profiles
on conflict (discord_guild_id, albion_server, albion_character_id) do nothing;

insert into account_status_events (account_id, discord_guild_id, to_status, event_type)
select ca.account_id, ca.discord_guild_id, 'open', 'created'
from character_accounts ca
where not exists (select 1 from account_status_events ase where ase.account_id = ca.account_id);
`;

const MIGRATION_014_GENERAL_TICKETS = `
create table if not exists ticket_classes (
  ticket_class_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  name text not null,
  ticket_category_id text not null,
  reviewer_role_id text not null,
  source_channel_id text,
  source_message_id text,
  button_label text,
  button_style text,
  initial_message text,
  closed_message text,
  enabled boolean not null default true,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ticket_classes_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint ticket_classes_name_nonempty check (length(trim(name)) > 0),
  constraint ticket_classes_button_style_check check (button_style is null or button_style in ('primary','secondary','success','danger')),
  constraint ticket_classes_source_message_pair_check check (
    (source_channel_id is null and source_message_id is null and button_label is null and button_style is null)
    or (source_channel_id is not null and source_message_id is not null and button_label is not null and button_style is not null)
  )
);
create unique index if not exists ticket_classes_unique_name on ticket_classes (discord_guild_id, lower(name));
create unique index if not exists ticket_classes_unique_id_guild on ticket_classes (ticket_class_id, discord_guild_id);
create index if not exists ticket_classes_source_message on ticket_classes (discord_guild_id, source_channel_id, source_message_id) where source_channel_id is not null;

create table if not exists tickets (
  ticket_id bigserial primary key,
  ticket_class_id bigint not null references ticket_classes (ticket_class_id) on delete restrict,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  opener_discord_user_id text not null,
  ticket_channel_id text,
  status text not null default 'open',
  closed_at timestamptz,
  closed_by_discord_user_id text,
  reopened_at timestamptz,
  reopened_by_discord_user_id text,
  deleted_at timestamptz,
  deleted_by_discord_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tickets_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint tickets_opener_nonempty check (length(trim(opener_discord_user_id)) > 0),
  constraint tickets_channel_nonempty check (ticket_channel_id is null or length(trim(ticket_channel_id)) > 0),
  constraint tickets_status_check check (status in ('open','closed','deleted')),
  constraint tickets_class_guild_fk foreign key (ticket_class_id, discord_guild_id)
    references ticket_classes (ticket_class_id, discord_guild_id) on update cascade on delete restrict
);
create index if not exists tickets_channel on tickets (discord_guild_id, ticket_channel_id) where ticket_channel_id is not null;
`;

const MIGRATION_015_SHARED_TICKET_CHANNEL_LIFECYCLE = `
alter table open_applications add column if not exists channel_status text not null default 'open';
alter table open_applications add column if not exists withdrawn_at timestamptz;
alter table open_applications add column if not exists reopened_at timestamptz;
alter table open_applications add column if not exists reopened_by_discord_user_id text;
alter table open_applications add column if not exists deleted_at timestamptz;
alter table open_applications add column if not exists deleted_by_discord_user_id text;

alter table open_applications drop constraint if exists open_applications_status_check;

update open_applications
set channel_status = 'deleted',
    deleted_at = coalesce(deleted_at, closed_at, now()),
    status = case
      when rejected_at is not null then 'rejected'
      when accepted_at is not null and last_ingame_membership_failure is not null then 'awaiting_ingame_membership'
      when accepted_at is not null then 'accepted'
      else 'withdrawn'
    end,
    withdrawn_at = case when accepted_at is null and rejected_at is null then coalesce(withdrawn_at, closed_at, now()) else withdrawn_at end
where status = 'closed';

alter table open_applications add constraint open_applications_status_check check (
  status in ('open', 'accepted', 'awaiting_ingame_membership', 'rejected', 'withdrawn')
);
alter table open_applications drop constraint if exists open_applications_channel_status_check;
alter table open_applications add constraint open_applications_channel_status_check check (
  channel_status in ('open', 'closed', 'deleted')
);
drop index if exists open_applications_closed_cleanup;
`;

const MIGRATION_016_APPLICATION_CHARACTER_SEARCH_ATTEMPTS = `
alter table open_applications add column if not exists character_search_attempt_count integer not null default 0;
alter table open_applications drop constraint if exists open_applications_character_search_attempt_count_check;
alter table open_applications add constraint open_applications_character_search_attempt_count_check check (character_search_attempt_count >= 0);
`;

const MIGRATION_017_EMOJI_REACTION_ROLES = `
do $emoji_reaction_roles$
begin
  if (
    (
      to_regclass('reaction_role_member_preferences') is not null
      or to_regclass('reaction_role_buttons') is not null
      or exists (
        select 1
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'reaction_role_configs'
          and column_name = 'mode'
      )
    )
    and exists (select 1 from reaction_role_configs)
  ) then
    raise exception 'Emoji reaction-role migration requires empty reaction_role_configs'
      using hint = 'Run /reset and then /deactivate on every installed Discord server before deployment.';
  end if;
end
$emoji_reaction_roles$;

drop table if exists reaction_role_member_preferences;
drop table if exists reaction_role_buttons;

alter table reaction_role_configs drop constraint if exists reaction_role_configs_mode_check;
alter table reaction_role_configs drop column if exists mode;

create table if not exists reaction_role_subscriptions (
  reaction_role_config_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reaction_role_config_id, discord_user_id),
  constraint reaction_role_subscriptions_config_fk foreign key (reaction_role_config_id, discord_guild_id)
    references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade
);

create index if not exists reaction_role_subscriptions_user_lookup
  on reaction_role_subscriptions (discord_guild_id, discord_user_id);

create table if not exists reaction_role_emoji_placements (
  reaction_role_emoji_placement_id bigserial primary key,
  reaction_role_config_id bigint not null,
  discord_guild_id text not null,
  channel_id text not null,
  message_id text not null,
  emoji_key text not null,
  emoji_display_value text not null,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reaction_role_emoji_placements_config_fk foreign key (reaction_role_config_id, discord_guild_id)
    references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade,
  constraint reaction_role_emoji_placements_key_nonempty check (length(trim(emoji_key)) > 0),
  constraint reaction_role_emoji_placements_display_nonempty check (length(trim(emoji_display_value)) > 0),
  unique (reaction_role_config_id),
  unique (discord_guild_id, message_id, emoji_key)
);

create index if not exists reaction_role_emoji_placements_message_lookup
  on reaction_role_emoji_placements (discord_guild_id, channel_id, message_id);
`;

const MIGRATION_018_MANAGED_USER_REACTION_ROLES = `
drop table if exists reaction_role_member_groups;
`;

const MIGRATION_019_POSITION_APPOINTMENT_NOMENCLATURE = `
do $position_appointment_tables$
begin
  if to_regclass('member_group_scoped_roles') is not null
    and to_regclass('member_group_positions') is not null then
    raise exception 'Cannot rename member_group_scoped_roles because member_group_positions already exists';
  end if;

  if to_regclass('member_group_scoped_role_assignments') is not null
    and to_regclass('member_group_position_appointments') is not null then
    raise exception 'Cannot rename member_group_scoped_role_assignments because member_group_position_appointments already exists';
  end if;

  if to_regclass('member_group_scoped_roles') is not null then
    alter table member_group_scoped_roles rename to member_group_positions;
  end if;

  if to_regclass('member_group_scoped_role_assignments') is not null then
    alter table member_group_scoped_role_assignments rename to member_group_position_appointments;
  end if;
end
$position_appointment_tables$;

do $position_appointment_columns$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'member_group_positions'
      and column_name = 'member_group_scoped_role_id'
  ) then
    alter table member_group_positions
      rename column member_group_scoped_role_id to member_group_position_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'member_group_position_appointments'
      and column_name = 'member_group_scoped_role_assignment_id'
  ) then
    alter table member_group_position_appointments
      rename column member_group_scoped_role_assignment_id to member_group_position_appointment_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'member_group_position_appointments'
      and column_name = 'member_group_scoped_role_id'
  ) then
    alter table member_group_position_appointments
      rename column member_group_scoped_role_id to member_group_position_id;
  end if;
end
$position_appointment_columns$;

alter sequence if exists member_group_scoped_roles_member_group_scoped_role_id_seq
  rename to member_group_positions_member_group_position_id_seq;
alter sequence if exists member_group_scoped_role_assi_member_group_scoped_role_assi_seq
  rename to member_group_position_appointments_id_seq;

do $position_appointment_constraints$
declare
  constraint_rename record;
begin
  for constraint_rename in
    select *
    from (
      values
        ('member_group_positions', 'member_group_scoped_roles_pkey', 'member_group_positions_pkey'),
        ('member_group_positions', 'member_group_scoped_roles_guild_nonempty', 'member_group_positions_guild_nonempty'),
        ('member_group_positions', 'member_group_scoped_roles_name_nonempty', 'member_group_positions_name_nonempty'),
        ('member_group_positions', 'member_group_scoped_roles_role_nonempty', 'member_group_positions_discord_role_nonempty'),
        ('member_group_positions', 'member_group_scoped_roles_group_fk', 'member_group_positions_group_fk'),
        (
          'member_group_positions',
          'member_group_scoped_roles_member_group_scoped_role_id_disco_key',
          'member_group_positions_position_guild_unique'
        ),
        (
          'member_group_position_appointments',
          'member_group_scoped_role_assignments_pkey',
          'member_group_position_appointments_pkey'
        ),
        (
          'member_group_position_appointments',
          'member_group_scoped_role_assignments_guild_nonempty',
          'member_group_position_appointments_guild_nonempty'
        ),
        (
          'member_group_position_appointments',
          'member_group_scoped_role_assignments_role_fk',
          'member_group_position_appointments_position_fk'
        ),
        (
          'member_group_position_appointments',
          'member_group_scoped_role_assignments_profile_fk',
          'member_group_position_appointments_profile_fk'
        ),
        (
          'member_group_position_appointments',
          'member_group_scoped_role_assi_member_group_scoped_role_id_m_key',
          'member_group_position_appointments_position_profile_unique'
        )
    ) as renames(table_name, old_name, new_name)
  loop
    if exists (
      select 1
      from pg_constraint
      where conrelid = constraint_rename.table_name::regclass
        and conname = constraint_rename.old_name
    ) then
      execute format(
        'alter table %I rename constraint %I to %I',
        constraint_rename.table_name,
        constraint_rename.old_name,
        constraint_rename.new_name
      );
    end if;
  end loop;
end
$position_appointment_constraints$;

alter index if exists member_group_scoped_roles_group_name_unique
  rename to member_group_positions_group_name_unique;
alter index if exists member_group_scoped_role_assignments_profile
  rename to member_group_position_appointments_profile;
`;

const MIGRATION_020_APPLICATION_CONTROL_MESSAGE_IDS = `
alter table open_applications add column if not exists character_resolution_message_id text;
alter table open_applications add column if not exists application_control_message_id text;

alter table open_applications drop constraint if exists open_applications_character_resolution_message_id_nonempty;
alter table open_applications add constraint open_applications_character_resolution_message_id_nonempty check (
  character_resolution_message_id is null or length(trim(character_resolution_message_id)) > 0
);

alter table open_applications drop constraint if exists open_applications_application_control_message_id_nonempty;
alter table open_applications add constraint open_applications_application_control_message_id_nonempty check (
  application_control_message_id is null or length(trim(application_control_message_id)) > 0
);
`;

const MIGRATION_021_TEMPORARY_VOICE_CHANNELS = `
create table if not exists temporary_voice_configs (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  base_channel_id text not null,
  channel_name_prefix text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint temporary_voice_configs_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint temporary_voice_configs_base_channel_nonempty check (length(trim(base_channel_id)) > 0),
  constraint temporary_voice_configs_prefix_length check (char_length(channel_name_prefix) <= 32)
);

create table if not exists temporary_voice_channels (
  discord_channel_id text primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  owner_discord_user_id text not null,
  base_channel_id text not null,
  created_at timestamptz not null default now(),
  constraint temporary_voice_channels_channel_nonempty check (length(trim(discord_channel_id)) > 0),
  constraint temporary_voice_channels_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint temporary_voice_channels_owner_nonempty check (length(trim(owner_discord_user_id)) > 0),
  constraint temporary_voice_channels_base_channel_nonempty check (length(trim(base_channel_id)) > 0),
  unique (discord_guild_id, owner_discord_user_id)
);

create index if not exists temporary_voice_channels_guild
  on temporary_voice_channels (discord_guild_id);
`;

const MIGRATION_022_GIVEAWAYS = `
create table if not exists giveaways (
  giveaway_id bigserial primary key,
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  channel_id text not null,
  original_message_id text not null,
  announcement_message_id text,
  creator_discord_user_id text not null,
  title text not null,
  description text not null,
  image_attachment_name text not null,
  draw_at timestamptz not null,
  winner_count integer not null,
  state text not null default 'open',
  drawn_at timestamptz,
  drawn_by_discord_user_id text,
  cancelled_at timestamptz,
  cancelled_by_discord_user_id text,
  original_message_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint giveaways_guild_nonempty check (length(trim(discord_guild_id)) > 0),
  constraint giveaways_channel_nonempty check (length(trim(channel_id)) > 0),
  constraint giveaways_original_message_nonempty check (length(trim(original_message_id)) > 0),
  constraint giveaways_announcement_message_nonempty check (
    announcement_message_id is null or length(trim(announcement_message_id)) > 0
  ),
  constraint giveaways_creator_nonempty check (length(trim(creator_discord_user_id)) > 0),
  constraint giveaways_title_nonempty check (length(trim(title)) > 0),
  constraint giveaways_image_name_nonempty check (length(trim(image_attachment_name)) > 0),
  constraint giveaways_winner_count_check check (winner_count between 1 and 5),
  constraint giveaways_state_check check (state in ('open', 'drawn', 'cancelled')),
  unique (giveaway_id, discord_guild_id),
  unique (discord_guild_id, original_message_id)
);

create index if not exists giveaways_due_draw
  on giveaways (draw_at)
  where state = 'open';

create index if not exists giveaways_creator_state
  on giveaways (discord_guild_id, creator_discord_user_id, state, draw_at);

create table if not exists giveaway_entries (
  giveaway_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint giveaway_entries_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint giveaway_entries_giveaway_fk foreign key (giveaway_id, discord_guild_id)
    references giveaways (giveaway_id, discord_guild_id)
    on update cascade
    on delete cascade,
  primary key (giveaway_id, discord_user_id)
);

create index if not exists giveaway_entries_guild_user
  on giveaway_entries (discord_guild_id, discord_user_id);

create table if not exists giveaway_reactions (
  giveaway_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  emoji_key text not null,
  created_at timestamptz not null default now(),
  constraint giveaway_reactions_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint giveaway_reactions_emoji_nonempty check (length(trim(emoji_key)) > 0),
  constraint giveaway_reactions_giveaway_fk foreign key (giveaway_id, discord_guild_id)
    references giveaways (giveaway_id, discord_guild_id)
    on update cascade
    on delete cascade,
  primary key (giveaway_id, discord_user_id, emoji_key)
);

create table if not exists giveaway_winners (
  giveaway_winner_id bigserial primary key,
  giveaway_id bigint not null,
  discord_guild_id text not null,
  discord_user_id text not null,
  winner_position integer not null,
  status text not null default 'current',
  selected_at timestamptz not null default now(),
  replaced_at timestamptz,
  replaced_by_discord_user_id text,
  constraint giveaway_winners_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint giveaway_winners_position_positive check (winner_position > 0),
  constraint giveaway_winners_status_check check (status in ('current', 'replaced')),
  constraint giveaway_winners_giveaway_fk foreign key (giveaway_id, discord_guild_id)
    references giveaways (giveaway_id, discord_guild_id)
    on update cascade
    on delete cascade,
  unique (giveaway_id, discord_user_id)
);

create unique index if not exists giveaway_winners_current_position
  on giveaway_winners (giveaway_id, winner_position)
  where status = 'current';
`;

const MIGRATION_023_OPTIONAL_GIVEAWAY_IMAGES = `
alter table giveaways
  alter column image_attachment_name drop not null;

alter table giveaways
  drop constraint if exists giveaways_image_name_nonempty;

alter table giveaways
  add constraint giveaways_image_name_nonempty check (
    image_attachment_name is null or length(trim(image_attachment_name)) > 0
  );
`;

const MIGRATION_024_RETAIN_CLOSED_GIVEAWAYS = `
alter table giveaways
  add column if not exists original_message_closed_at timestamptz;

update giveaways
set original_message_closed_at = original_message_deleted_at
where original_message_closed_at is null
  and original_message_deleted_at is not null;
`;

const MIGRATION_025_GIVEAWAY_NOTIFICATION_ROLES = `
create table if not exists giveaway_notification_roles (
  reaction_role_config_id bigint not null,
  discord_guild_id text not null,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint giveaway_notification_roles_creator_nonempty check (
    length(trim(created_by_discord_user_id)) > 0
  ),
  constraint giveaway_notification_roles_config_fk foreign key (
    reaction_role_config_id,
    discord_guild_id
  ) references reaction_role_configs (
    reaction_role_config_id,
    discord_guild_id
  ) on delete cascade,
  primary key (reaction_role_config_id)
);

create index if not exists giveaway_notification_roles_guild
  on giveaway_notification_roles (discord_guild_id, reaction_role_config_id);

alter table giveaways
  add column if not exists notification_role_id text;

alter table giveaways
  drop constraint if exists giveaways_notification_role_nonempty;

alter table giveaways
  add constraint giveaways_notification_role_nonempty check (
    notification_role_id is null or length(trim(notification_role_id)) > 0
  );
`;

const MIGRATION_026_CONTENT_CONTROL_MESSAGES = `
alter table content_items
  add column if not exists control_message_id text;

alter table content_items
  drop constraint if exists content_items_control_message_nonempty;

alter table content_items
  add constraint content_items_control_message_nonempty check (
    control_message_id is null or length(trim(control_message_id)) > 0
  );
`;

const MIGRATION_027_CONTENT_STANDBY_SIGNUPS = `
alter table content_signups
  add column if not exists signup_type text not null default 'role';

alter table content_signups
  alter column content_role_slot_id drop not null;

alter table content_signups
  drop constraint if exists content_signups_type_check;

alter table content_signups
  add constraint content_signups_type_check check (signup_type in ('role', 'standby'));

alter table content_signups
  drop constraint if exists content_signups_role_slot_check;

alter table content_signups
  add constraint content_signups_role_slot_check check (
    (signup_type = 'role' and content_role_slot_id is not null)
    or (signup_type = 'standby' and content_role_slot_id is null)
  );
`;

const MIGRATION_028_REGEARS = `
create table if not exists regear_admin_grants (
  regear_admin_grant_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  albion_server text not null,
  discord_user_id text not null,
  granted_by_discord_user_id text not null,
  granted_at timestamptz not null default now(),
  revoked_by_discord_user_id text,
  revoked_at timestamptz,
  constraint regear_admin_grants_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint regear_admin_grants_user_nonempty check (length(trim(discord_user_id)) > 0),
  constraint regear_admin_grants_grantor_nonempty check (length(trim(granted_by_discord_user_id)) > 0),
  constraint regear_admin_grants_revocation_pair_check check (
    (revoked_at is null and revoked_by_discord_user_id is null)
    or (revoked_at is not null and revoked_by_discord_user_id is not null and length(trim(revoked_by_discord_user_id)) > 0)
  ),
  unique (regear_admin_grant_id, discord_guild_id)
);

create unique index if not exists regear_admin_grants_one_active
  on regear_admin_grants (discord_guild_id, albion_server, discord_user_id)
  where revoked_at is null;
create index if not exists regear_admin_grants_guild_user
  on regear_admin_grants (discord_guild_id, discord_user_id, albion_server)
  where revoked_at is null;

create table if not exists regear_contents (
  regear_content_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  albion_server text not null,
  name text not null,
  content_date date not null,
  content_at timestamptz,
  state text not null default 'open',
  channel_id text not null,
  announcement_message_id text,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  closed_by_discord_user_id text,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint regear_contents_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint regear_contents_name_length check (length(trim(name)) between 1 and 100),
  constraint regear_contents_state_check check (state in ('open', 'closed')),
  constraint regear_contents_channel_nonempty check (length(trim(channel_id)) > 0),
  constraint regear_contents_announcement_nonempty check (
    announcement_message_id is null or length(trim(announcement_message_id)) > 0
  ),
  constraint regear_contents_creator_nonempty check (length(trim(created_by_discord_user_id)) > 0),
  constraint regear_contents_closure_check check (
    (state = 'open' and closed_at is null and closed_by_discord_user_id is null)
    or (state = 'closed' and closed_at is not null and closed_by_discord_user_id is not null)
  ),
  unique (regear_content_id, discord_guild_id),
  unique (regear_content_id, discord_guild_id, albion_server)
);

create index if not exists regear_contents_open_lookup
  on regear_contents (discord_guild_id, albion_server, content_date desc, created_at desc)
  where state = 'open';
create index if not exists regear_contents_announcement_lookup
  on regear_contents (discord_guild_id, announcement_message_id)
  where announcement_message_id is not null;

create table if not exists regear_claims (
  regear_claim_id uuid primary key,
  discord_guild_id text not null,
  regear_content_id uuid not null,
  albion_server text not null,
  albion_character_id text not null,
  original_submitter_discord_user_id text not null,
  requested_value bigint not null,
  accepted_value bigint,
  status text not null default 'pending',
  review_channel_id text not null,
  review_message_id text not null,
  outcome_channel_id text,
  outcome_message_id text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_by_discord_user_id text,
  accepted_at timestamptz,
  acceptance_reason text,
  constraint regear_claims_content_fk foreign key (regear_content_id, discord_guild_id, albion_server)
    references regear_contents (regear_content_id, discord_guild_id, albion_server)
    on update cascade on delete restrict,
  constraint regear_claims_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade on delete restrict,
  constraint regear_claims_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint regear_claims_submitter_nonempty check (length(trim(original_submitter_discord_user_id)) > 0),
  constraint regear_claims_requested_positive check (requested_value > 0),
  constraint regear_claims_accepted_positive check (accepted_value is null or accepted_value > 0),
  constraint regear_claims_status_check check (status in ('pending', 'accepted')),
  constraint regear_claims_review_location_check check (
    length(trim(review_channel_id)) > 0 and length(trim(review_message_id)) > 0
  ),
  constraint regear_claims_outcome_location_pair_check check (
    (outcome_channel_id is null and outcome_message_id is null)
    or (outcome_channel_id is not null and outcome_message_id is not null
      and length(trim(outcome_channel_id)) > 0 and length(trim(outcome_message_id)) > 0)
  ),
  constraint regear_claims_acceptance_fields_check check (
    (status = 'pending' and accepted_value is null and accepted_by_discord_user_id is null
      and accepted_at is null and acceptance_reason is null and outcome_channel_id is null
      and outcome_message_id is null)
    or (status = 'accepted' and accepted_value is not null
      and accepted_by_discord_user_id is not null and length(trim(accepted_by_discord_user_id)) > 0
      and accepted_at is not null)
  ),
  constraint regear_claims_reason_length check (
    acceptance_reason is null or length(trim(acceptance_reason)) between 1 and 500
  ),
  unique (regear_claim_id, discord_guild_id)
);

create index if not exists regear_claims_pending_review_lookup
  on regear_claims (discord_guild_id, review_message_id)
  where status = 'pending';
create index if not exists regear_claims_outcome_lookup
  on regear_claims (discord_guild_id, outcome_message_id)
  where status = 'accepted' and outcome_message_id is not null;
create index if not exists regear_claims_character_history
  on regear_claims (discord_guild_id, albion_server, albion_character_id, submitted_at desc, regear_claim_id desc);
create index if not exists regear_claims_content_status
  on regear_claims (discord_guild_id, regear_content_id, status, submitted_at desc);

alter table account_transactions
  add column if not exists regear_claim_id uuid;

alter table account_transactions
  drop constraint if exists account_transactions_type_check;
alter table account_transactions
  add constraint account_transactions_type_check check (transaction_type in (
    'credit', 'debit', 'transfer_credit', 'transfer_debit',
    'set_adjustment', 'reset_adjustment', 'purge_adjustment', 'closure_adjustment',
    'regear_credit'
  ));

alter table account_transactions
  drop constraint if exists account_transactions_regear_claim_fk;
alter table account_transactions
  add constraint account_transactions_regear_claim_fk
  foreign key (regear_claim_id, discord_guild_id)
  references regear_claims (regear_claim_id, discord_guild_id)
  on update cascade on delete restrict
  deferrable initially deferred;

alter table account_transactions
  drop constraint if exists account_transactions_regear_type_check;
alter table account_transactions
  add constraint account_transactions_regear_type_check check (
    (transaction_type = 'regear_credit' and regear_claim_id is not null and amount > 0)
    or (transaction_type <> 'regear_credit' and regear_claim_id is null)
  );

create unique index if not exists account_transactions_one_regear_credit
  on account_transactions (regear_claim_id)
  where regear_claim_id is not null;
create index if not exists account_transactions_regear_lookup
  on account_transactions (discord_guild_id, regear_claim_id)
  where regear_claim_id is not null;

create or replace function validate_regear_claim_credit(
  checked_claim_id uuid,
  checked_guild_id text
) returns void language plpgsql as $$
declare
  claim regear_claims%rowtype;
  credit_count integer;
  matching_count integer;
begin
  select * into claim
  from regear_claims
  where regear_claim_id = checked_claim_id
    and discord_guild_id = checked_guild_id;

  if not found then
    return;
  end if;

  select count(*)::integer,
    count(*) filter (
      where transaction_type = 'regear_credit'
        and amount = claim.accepted_value
        and exists (
          select 1 from character_accounts account
          where account.account_id = account_transactions.account_id
            and account.discord_guild_id = account_transactions.discord_guild_id
            and account.albion_server = claim.albion_server
            and account.albion_character_id = claim.albion_character_id
        )
    )::integer
  into credit_count, matching_count
  from account_transactions
  where regear_claim_id = checked_claim_id
    and discord_guild_id = checked_guild_id;

  if claim.status = 'pending' and credit_count <> 0 then
    raise exception 'Pending re-gear claim % cannot have an account credit', checked_claim_id;
  end if;

  if claim.status = 'accepted' and (credit_count <> 1 or matching_count <> 1) then
    raise exception 'Accepted re-gear claim % must have exactly one matching account credit', checked_claim_id;
  end if;
end $$;

create or replace function validate_regear_claim_credit_from_claim()
returns trigger language plpgsql as $$
begin
  perform validate_regear_claim_credit(new.regear_claim_id, new.discord_guild_id);
  return new;
end $$;

drop trigger if exists regear_claims_validate_credit on regear_claims;
create constraint trigger regear_claims_validate_credit
after insert or update of status, accepted_value on regear_claims
deferrable initially deferred
for each row execute function validate_regear_claim_credit_from_claim();

create or replace function validate_regear_claim_credit_from_transaction()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.regear_claim_id is not null then
      perform validate_regear_claim_credit(old.regear_claim_id, old.discord_guild_id);
    end if;
    return old;
  end if;

  if new.regear_claim_id is not null then
    perform validate_regear_claim_credit(new.regear_claim_id, new.discord_guild_id);
  end if;
  if tg_op = 'UPDATE' and old.regear_claim_id is not null
    and (new.regear_claim_id is distinct from old.regear_claim_id
      or new.discord_guild_id is distinct from old.discord_guild_id) then
    perform validate_regear_claim_credit(old.regear_claim_id, old.discord_guild_id);
  end if;
  return new;
end $$;

drop trigger if exists account_transactions_validate_regear_credit on account_transactions;
create constraint trigger account_transactions_validate_regear_credit
after insert or update or delete on account_transactions
deferrable initially deferred
for each row execute function validate_regear_claim_credit_from_transaction();
`;

const MIGRATION_029_CONTENT_BUILDS_GRAPHICS = `
alter table content_items
  add column if not exists graphic_attachment_name text;

alter table content_items
  drop constraint if exists content_items_graphic_attachment_name_nonempty;

alter table content_items
  add constraint content_items_graphic_attachment_name_nonempty check (
    graphic_attachment_name is null or length(trim(graphic_attachment_name)) > 0
  );
`;

const MIGRATION_030_WEAPON_SPECIALISATIONS = `
create table if not exists specialisation_reviewer_configs (
  discord_guild_id text primary key references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  reviewer_role_id text not null,
  updated_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint specialisation_reviewer_configs_role_nonempty check (length(trim(reviewer_role_id)) > 0),
  constraint specialisation_reviewer_configs_actor_nonempty check (length(trim(updated_by_discord_user_id)) > 0)
);

create table if not exists specialisation_catalogue_exclusions (
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  catalogue_key text not null,
  excluded_by_discord_user_id text not null,
  excluded_at timestamptz not null default now(),
  constraint specialisation_catalogue_exclusions_key_nonempty check (length(trim(catalogue_key)) > 0),
  constraint specialisation_catalogue_exclusions_actor_nonempty check (length(trim(excluded_by_discord_user_id)) > 0),
  primary key (discord_guild_id, catalogue_key)
);

create table if not exists specialisation_requests (
  specialisation_request_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  submitted_by_discord_user_id text not null,
  albion_server text not null,
  albion_character_id text not null,
  target_key text not null,
  target_kind text not null,
  target_display_name text not null,
  level integer not null,
  state text not null default 'pending',
  review_channel_id text not null,
  review_message_id text,
  review_message_deleted_at timestamptz,
  reviewed_by_discord_user_id text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint specialisation_requests_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint specialisation_requests_character_nonempty check (length(trim(albion_character_id)) > 0),
  constraint specialisation_requests_submitter_nonempty check (length(trim(submitted_by_discord_user_id)) > 0),
  constraint specialisation_requests_target_key_nonempty check (length(trim(target_key)) > 0),
  constraint specialisation_requests_target_name_nonempty check (length(trim(target_display_name)) > 0),
  constraint specialisation_requests_channel_nonempty check (length(trim(review_channel_id)) > 0),
  constraint specialisation_requests_message_nonempty check (review_message_id is null or length(trim(review_message_id)) > 0),
  constraint specialisation_requests_kind_level_check check (
    (target_kind = 'weapon' and level = 100) or (target_kind = 'tree' and level = 800)
  ),
  constraint specialisation_requests_state_check check (state in ('pending', 'confirmed', 'dismissed')),
  constraint specialisation_requests_review_check check (
    (state = 'pending' and reviewed_by_discord_user_id is null and reviewed_at is null)
    or (state <> 'pending' and reviewed_by_discord_user_id is not null and reviewed_at is not null)
  ),
  constraint specialisation_requests_message_deletion_check check (
    review_message_deleted_at is null or review_message_id is not null
  ),
  constraint specialisation_requests_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade on delete restrict,
  constraint specialisation_requests_id_guild_unique unique (specialisation_request_id, discord_guild_id)
);
create unique index if not exists specialisation_requests_one_pending_target
  on specialisation_requests (discord_guild_id, albion_server, albion_character_id, target_key, level)
  where state = 'pending';
create index if not exists specialisation_requests_pending_report
  on specialisation_requests (discord_guild_id, created_at, specialisation_request_id)
  where state = 'pending';
create unique index if not exists specialisation_requests_review_message_unique
  on specialisation_requests (discord_guild_id, review_message_id)
  where review_message_id is not null;

create table if not exists character_specialisations (
  character_specialisation_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  albion_server text not null,
  albion_character_id text not null,
  target_key text not null,
  target_kind text not null,
  target_display_name text not null,
  level integer not null,
  source text not null,
  source_request_id uuid,
  recorded_by_discord_user_id text not null,
  recorded_at timestamptz not null default now(),
  removed_by_discord_user_id text,
  removed_at timestamptz,
  constraint character_specialisations_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint character_specialisations_character_nonempty check (length(trim(albion_character_id)) > 0),
  constraint character_specialisations_target_key_nonempty check (length(trim(target_key)) > 0),
  constraint character_specialisations_target_name_nonempty check (length(trim(target_display_name)) > 0),
  constraint character_specialisations_actor_nonempty check (length(trim(recorded_by_discord_user_id)) > 0),
  constraint character_specialisations_kind_level_check check (
    (target_kind = 'weapon' and level = 100) or (target_kind = 'tree' and level = 800)
  ),
  constraint character_specialisations_source_check check (
    (source = 'request' and source_request_id is not null)
    or (source = 'manual' and source_request_id is null)
  ),
  constraint character_specialisations_removal_check check (
    (removed_at is null and removed_by_discord_user_id is null)
    or (removed_at is not null and removed_by_discord_user_id is not null)
  ),
  constraint character_specialisations_request_fk foreign key (source_request_id, discord_guild_id)
    references specialisation_requests (specialisation_request_id, discord_guild_id)
    on delete restrict,
  constraint character_specialisations_character_fk foreign key (albion_server, albion_character_id)
    references albion_characters (albion_server, albion_character_id)
    on update cascade on delete restrict,
  constraint character_specialisations_source_request_unique unique (source_request_id)
);
create unique index if not exists character_specialisations_one_active_target
  on character_specialisations (discord_guild_id, albion_server, albion_character_id, target_key, level)
  where removed_at is null;
create index if not exists character_specialisations_active_report
  on character_specialisations (discord_guild_id, albion_server, albion_character_id, target_kind, target_display_name)
  where removed_at is null;
`;

// Migration 30 existed briefly in an uncommitted implementation scaffold. This
// bridge makes a developer database that applied that draft converge on the
// final V1 shape; on a fresh database the statements are harmless.
const MIGRATION_031_WEAPON_SPECIALISATION_V1 = `
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'specialisation_reviewer_configs' and column_name = 'discord_role_id')
    and not exists (select 1 from information_schema.columns where table_name = 'specialisation_reviewer_configs' and column_name = 'reviewer_role_id') then
    alter table specialisation_reviewer_configs rename column discord_role_id to reviewer_role_id;
  end if;
end $$;
alter table specialisation_reviewer_configs add column if not exists updated_by_discord_user_id text;
update specialisation_reviewer_configs set updated_by_discord_user_id = 'migration' where updated_by_discord_user_id is null;
alter table specialisation_reviewer_configs alter column updated_by_discord_user_id set not null;
alter table specialisation_reviewer_configs drop constraint if exists specialisation_reviewer_configs_role_nonempty;
alter table specialisation_reviewer_configs add constraint specialisation_reviewer_configs_role_nonempty check (length(trim(reviewer_role_id)) > 0);
alter table specialisation_reviewer_configs drop constraint if exists specialisation_reviewer_configs_actor_nonempty;
alter table specialisation_reviewer_configs add constraint specialisation_reviewer_configs_actor_nonempty check (length(trim(updated_by_discord_user_id)) > 0);

do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'specialisation_catalogue_exclusions' and column_name = 'created_at')
    and not exists (select 1 from information_schema.columns where table_name = 'specialisation_catalogue_exclusions' and column_name = 'excluded_at') then
    alter table specialisation_catalogue_exclusions rename column created_at to excluded_at;
  end if;
end $$;
alter table specialisation_catalogue_exclusions add column if not exists excluded_by_discord_user_id text;
update specialisation_catalogue_exclusions set excluded_by_discord_user_id = 'migration' where excluded_by_discord_user_id is null;
alter table specialisation_catalogue_exclusions alter column excluded_by_discord_user_id set not null;
alter table specialisation_catalogue_exclusions drop constraint if exists specialisation_catalogue_exclusions_key_nonempty;
alter table specialisation_catalogue_exclusions add constraint specialisation_catalogue_exclusions_key_nonempty check (length(trim(catalogue_key)) > 0);
alter table specialisation_catalogue_exclusions drop constraint if exists specialisation_catalogue_exclusions_actor_nonempty;
alter table specialisation_catalogue_exclusions add constraint specialisation_catalogue_exclusions_actor_nonempty check (length(trim(excluded_by_discord_user_id)) > 0);

do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'specialisation_requests' and column_name = 'submitter_discord_user_id') then
    alter table specialisation_requests rename column submitter_discord_user_id to submitted_by_discord_user_id;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'specialisation_requests' and column_name = 'catalogue_key') then
    alter table specialisation_requests rename column catalogue_key to target_key;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'specialisation_requests' and column_name = 'status') then
    alter table specialisation_requests rename column status to state;
  end if;
end $$;
alter table specialisation_requests add column if not exists target_kind text;
alter table specialisation_requests add column if not exists target_display_name text;
alter table specialisation_requests add column if not exists review_message_deleted_at timestamptz;
update specialisation_requests set target_kind = case when level = 100 then 'weapon' else 'tree' end where target_kind is null;
update specialisation_requests set target_display_name = target_key where target_display_name is null;
alter table specialisation_requests alter column target_kind set not null;
alter table specialisation_requests alter column target_display_name set not null;
alter table specialisation_requests alter column review_channel_id set not null;
alter table specialisation_requests drop constraint if exists specialisation_requests_server_check;
alter table specialisation_requests add constraint specialisation_requests_server_check check (albion_server in ('americas', 'asia', 'europe'));
alter table specialisation_requests drop constraint if exists specialisation_requests_character_nonempty;
alter table specialisation_requests add constraint specialisation_requests_character_nonempty check (length(trim(albion_character_id)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_submitter_nonempty;
alter table specialisation_requests add constraint specialisation_requests_submitter_nonempty check (length(trim(submitted_by_discord_user_id)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_target_key_nonempty;
alter table specialisation_requests add constraint specialisation_requests_target_key_nonempty check (length(trim(target_key)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_target_name_nonempty;
alter table specialisation_requests add constraint specialisation_requests_target_name_nonempty check (length(trim(target_display_name)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_channel_nonempty;
alter table specialisation_requests add constraint specialisation_requests_channel_nonempty check (length(trim(review_channel_id)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_message_nonempty;
alter table specialisation_requests add constraint specialisation_requests_message_nonempty check (review_message_id is null or length(trim(review_message_id)) > 0);
alter table specialisation_requests drop constraint if exists specialisation_requests_pending_review_check;
alter table specialisation_requests drop constraint if exists specialisation_requests_review_check;
alter table specialisation_requests drop constraint if exists specialisation_requests_kind_level_check;
alter table specialisation_requests add constraint specialisation_requests_kind_level_check check (
  (target_kind = 'weapon' and level = 100) or (target_kind = 'tree' and level = 800)
);
alter table specialisation_requests drop constraint if exists specialisation_requests_state_check;
alter table specialisation_requests add constraint specialisation_requests_state_check check (state in ('pending', 'confirmed', 'dismissed'));
alter table specialisation_requests add constraint specialisation_requests_review_check check (
  (state = 'pending' and reviewed_by_discord_user_id is null and reviewed_at is null)
  or (state <> 'pending' and reviewed_by_discord_user_id is not null and reviewed_at is not null)
);
alter table specialisation_requests drop constraint if exists specialisation_requests_message_deletion_check;
alter table specialisation_requests add constraint specialisation_requests_message_deletion_check check (
  review_message_deleted_at is null or review_message_id is not null
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'specialisation_requests_id_guild_unique') then
    alter table specialisation_requests add constraint specialisation_requests_id_guild_unique
      unique (specialisation_request_id, discord_guild_id);
  end if;
end $$;
alter table specialisation_requests drop constraint if exists specialisation_requests_character_fk;
alter table specialisation_requests add constraint specialisation_requests_character_fk
  foreign key (albion_server, albion_character_id)
  references albion_characters (albion_server, albion_character_id)
  on update cascade on delete restrict;
alter table specialisation_requests drop constraint if exists specialisation_requests_discord_guild_id_albion_server_albion_character_id_catalogue_key_level_status_key;
drop index if exists specialisation_requests_one_pending_target;
create unique index specialisation_requests_one_pending_target
  on specialisation_requests (discord_guild_id, albion_server, albion_character_id, target_key, level)
  where state = 'pending';
create index if not exists specialisation_requests_pending_report
  on specialisation_requests (discord_guild_id, created_at, specialisation_request_id)
  where state = 'pending';
create unique index if not exists specialisation_requests_review_message_unique
  on specialisation_requests (discord_guild_id, review_message_id)
  where review_message_id is not null;

do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'character_specialisations' and column_name = 'catalogue_key') then
    alter table character_specialisations rename column catalogue_key to target_key;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'character_specialisations' and column_name = 'added_by_discord_user_id') then
    alter table character_specialisations rename column added_by_discord_user_id to recorded_by_discord_user_id;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'character_specialisations' and column_name = 'added_at') then
    alter table character_specialisations rename column added_at to recorded_at;
  end if;
end $$;
alter table character_specialisations add column if not exists target_kind text;
alter table character_specialisations add column if not exists target_display_name text;
alter table character_specialisations add column if not exists source text;
update character_specialisations set target_kind = case when level = 100 then 'weapon' else 'tree' end where target_kind is null;
update character_specialisations set target_display_name = target_key where target_display_name is null;
update character_specialisations set source = case when source_request_id is null then 'manual' else 'request' end where source is null;
alter table character_specialisations alter column target_kind set not null;
alter table character_specialisations alter column target_display_name set not null;
alter table character_specialisations alter column source set not null;
alter table character_specialisations drop column if exists removal_reason;
alter table character_specialisations drop constraint if exists character_specialisations_server_check;
alter table character_specialisations add constraint character_specialisations_server_check check (albion_server in ('americas', 'asia', 'europe'));
alter table character_specialisations drop constraint if exists character_specialisations_character_nonempty;
alter table character_specialisations add constraint character_specialisations_character_nonempty check (length(trim(albion_character_id)) > 0);
alter table character_specialisations drop constraint if exists character_specialisations_target_key_nonempty;
alter table character_specialisations add constraint character_specialisations_target_key_nonempty check (length(trim(target_key)) > 0);
alter table character_specialisations drop constraint if exists character_specialisations_target_name_nonempty;
alter table character_specialisations add constraint character_specialisations_target_name_nonempty check (length(trim(target_display_name)) > 0);
alter table character_specialisations drop constraint if exists character_specialisations_actor_nonempty;
alter table character_specialisations add constraint character_specialisations_actor_nonempty check (length(trim(recorded_by_discord_user_id)) > 0);
alter table character_specialisations drop constraint if exists character_specialisations_kind_level_check;
alter table character_specialisations add constraint character_specialisations_kind_level_check check (
  (target_kind = 'weapon' and level = 100) or (target_kind = 'tree' and level = 800)
);
alter table character_specialisations drop constraint if exists character_specialisations_source_check;
alter table character_specialisations add constraint character_specialisations_source_check check (
  (source = 'request' and source_request_id is not null)
  or (source = 'manual' and source_request_id is null)
);
alter table character_specialisations drop constraint if exists character_specialisations_removal_check;
alter table character_specialisations add constraint character_specialisations_removal_check check (
  (removed_at is null and removed_by_discord_user_id is null)
  or (removed_at is not null and removed_by_discord_user_id is not null)
);
alter table character_specialisations drop constraint if exists character_specialisations_source_request_id_fkey;
alter table character_specialisations drop constraint if exists character_specialisations_request_fk;
alter table character_specialisations add constraint character_specialisations_request_fk
  foreign key (source_request_id, discord_guild_id)
  references specialisation_requests (specialisation_request_id, discord_guild_id)
  on delete restrict;
alter table character_specialisations drop constraint if exists character_specialisations_character_fk;
alter table character_specialisations add constraint character_specialisations_character_fk
  foreign key (albion_server, albion_character_id)
  references albion_characters (albion_server, albion_character_id)
  on update cascade on delete restrict;
drop index if exists character_specialisations_one_active_target;
create unique index character_specialisations_one_active_target
  on character_specialisations (discord_guild_id, albion_server, albion_character_id, target_key, level)
  where removed_at is null;
create unique index if not exists character_specialisations_source_request_unique
  on character_specialisations (source_request_id) where source_request_id is not null;
create index if not exists character_specialisations_active_report
  on character_specialisations (discord_guild_id, albion_server, albion_character_id, target_kind, target_display_name)
  where removed_at is null;
`;

const MIGRATION_032_CHARACTER_REGISTRATION_HIERARCHY = `
alter table discord_user_characters
  add column if not exists registration_order bigint;

with ranked_registrations as (
  select
    registration.discord_guild_id,
    registration.discord_user_id,
    registration.albion_server,
    registration.albion_character_id,
    row_number() over (
      partition by registration.discord_guild_id, registration.discord_user_id
      order by
        case when main.discord_user_id is not null then 0 else 1 end,
        registration.registered_at,
        registration.albion_server,
        registration.albion_character_id
    )::bigint as registration_order
  from discord_user_characters registration
  left join discord_user_main_characters main
    on main.discord_guild_id = registration.discord_guild_id
    and main.discord_user_id = registration.discord_user_id
    and main.albion_server = registration.albion_server
    and main.albion_character_id = registration.albion_character_id
)
update discord_user_characters registration
set registration_order = ranked.registration_order
from ranked_registrations ranked
where registration.discord_guild_id = ranked.discord_guild_id
  and registration.discord_user_id = ranked.discord_user_id
  and registration.albion_server = ranked.albion_server
  and registration.albion_character_id = ranked.albion_character_id
  and registration.registration_order is null;

alter table discord_user_characters
  alter column registration_order set not null;

alter table discord_user_characters
  drop constraint if exists discord_user_characters_registration_order_unique;
alter table discord_user_characters
  add constraint discord_user_characters_registration_order_unique
  unique (discord_guild_id, discord_user_id, registration_order);

create or replace function assign_discord_user_character_registration_order()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'character-registration:' || new.discord_guild_id || ':' || new.discord_user_id,
      0
    )
  );

  if new.registration_order is null then
    select coalesce(max(registration_order), 0) + 1
    into new.registration_order
    from discord_user_characters
    where discord_guild_id = new.discord_guild_id
      and discord_user_id = new.discord_user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists discord_user_characters_assign_registration_order on discord_user_characters;
create trigger discord_user_characters_assign_registration_order
before insert on discord_user_characters
for each row execute function assign_discord_user_character_registration_order();

create or replace function ensure_discord_user_main_character()
returns trigger
language plpgsql
as $$
begin
  insert into discord_user_main_characters (
    discord_guild_id,
    discord_user_id,
    albion_server,
    albion_character_id,
    selected_at
  )
  select
    registration.discord_guild_id,
    registration.discord_user_id,
    registration.albion_server,
    registration.albion_character_id,
    now()
  from discord_user_characters registration
  where registration.discord_guild_id = new.discord_guild_id
    and registration.discord_user_id = new.discord_user_id
  order by registration.registration_order
  limit 1
  on conflict (discord_guild_id, discord_user_id) do nothing;

  return null;
end;
$$;

drop trigger if exists discord_user_characters_ensure_main_after_insert on discord_user_characters;
create trigger discord_user_characters_ensure_main_after_insert
after insert on discord_user_characters
for each row execute function ensure_discord_user_main_character();

create or replace function promote_discord_user_main_character_before_delete()
returns trigger
language plpgsql
as $$
declare
  next_server text;
  next_character_id text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'character-registration:' || old.discord_guild_id || ':' || old.discord_user_id,
      0
    )
  );

  select registration.albion_server, registration.albion_character_id
  into next_server, next_character_id
  from discord_user_characters registration
  where registration.discord_guild_id = old.discord_guild_id
    and registration.discord_user_id = old.discord_user_id
    and not (
      registration.albion_server = old.albion_server
      and registration.albion_character_id = old.albion_character_id
    )
  order by registration.registration_order
  limit 1;

  if found then
    update discord_user_main_characters
    set albion_server = next_server,
      albion_character_id = next_character_id,
      selected_at = now()
    where discord_guild_id = old.discord_guild_id
      and discord_user_id = old.discord_user_id
      and albion_server = old.albion_server
      and albion_character_id = old.albion_character_id;
  else
    delete from discord_user_main_characters
    where discord_guild_id = old.discord_guild_id
      and discord_user_id = old.discord_user_id
      and albion_server = old.albion_server
      and albion_character_id = old.albion_character_id;
  end if;

  return old;
end;
$$;

drop trigger if exists discord_user_characters_ensure_main_after_delete on discord_user_characters;
drop trigger if exists discord_user_characters_promote_main_before_delete on discord_user_characters;
create trigger discord_user_characters_promote_main_before_delete
before delete on discord_user_characters
for each row execute function promote_discord_user_main_character_before_delete();

insert into discord_user_main_characters (
  discord_guild_id,
  discord_user_id,
  albion_server,
  albion_character_id,
  selected_at
)
select distinct on (registration.discord_guild_id, registration.discord_user_id)
  registration.discord_guild_id,
  registration.discord_user_id,
  registration.albion_server,
  registration.albion_character_id,
  now()
from discord_user_characters registration
left join discord_user_main_characters main
  on main.discord_guild_id = registration.discord_guild_id
  and main.discord_user_id = registration.discord_user_id
where main.discord_user_id is null
order by
  registration.discord_guild_id,
  registration.discord_user_id,
  registration.registration_order
on conflict (discord_guild_id, discord_user_id) do nothing;
`;

const MIGRATION_033_TICKET_LIFECYCLE_CONTROL_MESSAGES = `
alter table open_applications add column if not exists closed_control_message_id text;
alter table open_applications drop constraint if exists open_applications_closed_control_message_id_nonempty;
alter table open_applications add constraint open_applications_closed_control_message_id_nonempty check (
  closed_control_message_id is null or length(trim(closed_control_message_id)) > 0
);

alter table tickets add column if not exists control_message_id text;
alter table tickets drop constraint if exists tickets_control_message_id_nonempty;
alter table tickets add constraint tickets_control_message_id_nonempty check (
  control_message_id is null or length(trim(control_message_id)) > 0
);
`;

const MIGRATION_034_APPLICATION_CLASS_ARCHIVAL = `
alter table application_classes
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_discord_user_id text,
  add column if not exists archive_reason text,
  add column if not exists archived_member_group_id bigint,
  add column if not exists archived_member_group_type text,
  add column if not exists archived_member_group_name text,
  add column if not exists archived_albion_entity_id text,
  add column if not exists archived_albion_alliance_tag text;

alter table application_classes
  drop constraint if exists application_classes_member_group_required_check;
alter table application_classes
  add constraint application_classes_member_group_required_check check (
    (outcome_type = 'register_character' and member_group_id is null)
    or (
      outcome_type = 'member_group'
      and (
        (archived_at is null and member_group_id is not null)
        or (
          archived_at is not null
          and member_group_id is null
          and archived_member_group_id is not null
        )
      )
    )
  );

alter table application_classes
  add constraint application_classes_archived_by_nonempty check (
    archived_by_discord_user_id is null
    or length(trim(archived_by_discord_user_id)) > 0
  ),
  add constraint application_classes_archive_reason_nonempty check (
    archive_reason is null or length(trim(archive_reason)) > 0
  ),
  add constraint application_classes_archived_group_type_check check (
    archived_member_group_type is null
    or archived_member_group_type in ('group', 'guild', 'alliance')
  ),
  add constraint application_classes_archived_group_name_nonempty check (
    archived_member_group_name is null
    or length(trim(archived_member_group_name)) > 0
  ),
  add constraint application_classes_archived_albion_entity_id_nonempty check (
    archived_albion_entity_id is null
    or length(trim(archived_albion_entity_id)) > 0
  ),
  add constraint application_classes_archived_alliance_tag_nonempty check (
    archived_albion_alliance_tag is null
    or length(trim(archived_albion_alliance_tag)) > 0
  ),
  add constraint application_classes_archive_lifecycle_check check (
    (
      archived_at is null
      and archived_by_discord_user_id is null
      and archive_reason is null
      and archived_member_group_id is null
      and archived_member_group_type is null
      and archived_member_group_name is null
      and archived_albion_entity_id is null
      and archived_albion_alliance_tag is null
    )
    or (
      archived_at is not null
      and archived_by_discord_user_id is not null
      and archive_reason is not null
      and member_group_id is null
      and enabled = false
      and source_channel_id is null
      and source_message_id is null
      and button_label is null
      and button_style is null
      and (
        outcome_type = 'register_character'
        or (
          archived_member_group_id is not null
          and archived_member_group_type is not null
          and archived_member_group_name is not null
          and (
            archived_member_group_type = 'group'
            or archived_albion_entity_id is not null
          )
        )
      )
    )
  );

drop index if exists application_classes_unique_name;
create unique index application_classes_unique_name
  on application_classes (discord_guild_id, lower(name))
  where archived_at is null;

create or replace function prevent_archived_application_class_update()
returns trigger
language plpgsql
as $$
begin
  if old.archived_at is not null then
    raise exception using
      errcode = '55000',
      message = 'Archived application classes are immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists application_classes_prevent_archived_update on application_classes;
create trigger application_classes_prevent_archived_update
before update on application_classes
for each row execute function prevent_archived_application_class_update();
`;

const MIGRATION_035_REVIEWER_ROLE_BINDINGS = `
create table if not exists reviewer_role_bindings (
  reviewer_binding_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  domain text not null,
  albion_server text,
  discord_role_id text not null,
  created_by_discord_user_id text not null,
  created_at timestamptz not null default now(),
  constraint reviewer_role_bindings_domain_check check (domain in ('regears', 'specialisation')),
  constraint reviewer_role_bindings_server_check check (albion_server is null or albion_server in ('americas', 'asia', 'europe')),
  constraint reviewer_role_bindings_role_nonempty check (length(trim(discord_role_id)) > 0),
  constraint reviewer_role_bindings_actor_nonempty check (length(trim(created_by_discord_user_id)) > 0)
);
create unique index if not exists reviewer_role_bindings_unique_scope_role
  on reviewer_role_bindings (discord_guild_id, domain, coalesce(albion_server, 'all'), discord_role_id);

create table if not exists reviewer_scope_migrations (
  discord_guild_id text not null references discord_guild_lifecycle (discord_guild_id) on delete cascade,
  domain text not null,
  albion_server text not null,
  migrated_by_discord_user_id text not null,
  migrated_at timestamptz not null default now(),
  primary key (discord_guild_id, domain, albion_server),
  constraint reviewer_scope_migrations_domain_check check (domain in ('regears', 'specialisation')),
  constraint reviewer_scope_migrations_server_check check (albion_server in ('americas', 'asia', 'europe')),
  constraint reviewer_scope_migrations_actor_nonempty check (length(trim(migrated_by_discord_user_id)) > 0)
);

-- Retain old specialisation configuration only as an upgrade source. New code reads role bindings.
insert into reviewer_role_bindings (discord_guild_id, domain, albion_server, discord_role_id, created_by_discord_user_id)
select discord_guild_id, 'specialisation', null, reviewer_role_id, updated_by_discord_user_id
from specialisation_reviewer_configs
on conflict (discord_guild_id, domain, coalesce(albion_server, 'all'), discord_role_id) do nothing;
`;

const SPECIALISATION_TREE_WEAPON_MIGRATION_VALUES = SPECIALISATION_CATALOGUE
  .filter((entry) => entry.kind === "weapon" && entry.treeKey)
  .map((entry) => `('${entry.treeKey}', '${entry.key}')`)
  .join(",\n  ");

const MIGRATION_036_SPECIALISATION_TREE_COVERAGE = `
with tree_weapon_catalogue (tree_key, weapon_key) as (
  values
  ${SPECIALISATION_TREE_WEAPON_MIGRATION_VALUES}
)
update character_specialisations weapon
set removed_by_discord_user_id = tree.recorded_by_discord_user_id,
  removed_at = now()
from character_specialisations tree,
  tree_weapon_catalogue catalogue
where tree.discord_guild_id = weapon.discord_guild_id
  and tree.albion_server = weapon.albion_server
  and tree.albion_character_id = weapon.albion_character_id
  and tree.target_kind = 'tree'
  and tree.level = 800
  and tree.target_key = catalogue.tree_key
  and tree.removed_at is null
  and weapon.target_kind = 'weapon'
  and weapon.level = 100
  and weapon.target_key = catalogue.weapon_key
  and weapon.removed_at is null;
`;

const MIGRATION_037_RETIRE_REGEAR_LEGACY_GRANTS = `
drop table regear_admin_grants;
drop table reviewer_scope_migrations;
`;

const MIGRATION_038_APPLICATION_REVIEW_PUBLICATION = `
alter table open_applications add column review_publication jsonb;
-- Every pre-migration application retains its posted instructions/answers as history.
-- Its next adoption is silent even if its first valid selection occurs afterwards.
alter table open_applications add column legacy_review_publication boolean not null default true;
alter table open_applications alter column legacy_review_publication set default false;
alter table open_applications add constraint open_applications_review_publication_check check (
  review_publication is null or (
    jsonb_typeof(review_publication) = 'object'
    and review_publication ?& array['answerMessageIds', 'reviewerRoleId', 'notificationClaimed']
    and jsonb_typeof(review_publication->'answerMessageIds') = 'array'
    and not jsonb_path_exists(review_publication, '$.answerMessageIds[*] ? (@.type() != "string" || @ == "")')
    and jsonb_typeof(review_publication->'reviewerRoleId') = 'string'
    and length(trim(review_publication->>'reviewerRoleId')) > 0
    and jsonb_typeof(review_publication->'notificationClaimed') = 'boolean'
    and (not review_publication ? 'initialMessage' or jsonb_typeof(review_publication->'initialMessage') = 'string')
    and (not review_publication ? 'initialMessageId' or (jsonb_typeof(review_publication->'initialMessageId') = 'string' and length(trim(review_publication->>'initialMessageId')) > 0))
    and (not review_publication ? 'notificationMessageId' or (review_publication->>'notificationClaimed' = 'true' and jsonb_typeof(review_publication->'notificationMessageId') = 'string' and length(trim(review_publication->>'notificationMessageId')) > 0))
    and (not review_publication ? 'legacyHistoryPayload' or jsonb_typeof(review_publication->'legacyHistoryPayload') = 'object')
    and (not review_publication ? 'legacyHistoryMessageId' or (jsonb_typeof(review_publication->'legacyHistoryMessageId') = 'string' and length(trim(review_publication->>'legacyHistoryMessageId')) > 0))
  )
);
`;

const MIGRATION_039_UNSCHEDULED_CONTENT = `
alter table content_items add column start_notification_claimed_at timestamptz;
update content_items set start_notification_claimed_at = coalesce(started_at, updated_at)
  where start_notification_message_id is not null;
alter table content_items alter column scheduled_start_at drop not null;
alter table content_items drop constraint content_items_state_check;
alter table content_items add constraint content_items_state_check
  check (state in ('scheduled', 'unscheduled', 'active', 'ended', 'cancelled', 'archived'));
alter table content_items add constraint content_items_waiting_mode_check
  check ((state <> 'scheduled' or scheduled_start_at is not null)
     and (state <> 'unscheduled' or (scheduled_start_at is null and started_at is null)));
`;

const MIGRATION_040_CONTENT_PANELS = `
alter table content_channel_configs add column configuration_revision text not null default gen_random_uuid()::text;
create table content_panel_messages (
  discord_guild_id text not null,
  generation varchar(25) not null check (length(generation) > 0),
  discord_channel_id text not null,
  configuration_revision text not null,
  previous_generation varchar(25),
  message_id text,
  state text not null check (state in ('pending', 'current', 'retired')),
  render_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  scan_before_message_id text,
  primary key (discord_guild_id, generation),
  check (state <> 'current' or (message_id is not null and published_at is not null))
);
create unique index content_panel_one_current on content_panel_messages (discord_guild_id) where state = 'current';
create unique index content_panel_one_pending on content_panel_messages (discord_guild_id) where state = 'pending';
`;

const MIGRATION_041_FEATURE_ENTRY_PANELS = `
create table entry_panel_channels (
  discord_guild_id text not null,
  feature text not null check (feature in ('accounts', 'regears', 'specialisation', 'giveaways')),
  discord_channel_id text not null,
  configuration_revision text not null default gen_random_uuid()::text,
  primary key (discord_guild_id, feature)
);
create table entry_panel_roles (
  discord_guild_id text not null,
  role_kind text not null check (role_kind in ('accounts_manager', 'giveaway_host')),
  discord_role_id text not null,
  primary key (discord_guild_id, role_kind, discord_role_id)
);
create table entry_panel_messages (
  discord_guild_id text not null,
  feature text not null check (feature in ('accounts', 'regears', 'specialisation', 'giveaways')),
  generation varchar(25) not null check (length(generation) > 0),
  discord_channel_id text not null,
  configuration_revision text not null,
  previous_generation varchar(25),
  message_id text,
  state text not null check (state in ('pending', 'current', 'retired')),
  render_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  scan_before_message_id text,
  primary key (discord_guild_id, feature, generation),
  check (state <> 'current' or (message_id is not null and published_at is not null))
);
create unique index entry_panel_one_current on entry_panel_messages (discord_guild_id, feature) where state = 'current';
create unique index entry_panel_one_pending on entry_panel_messages (discord_guild_id, feature) where state = 'pending';
`;

const MIGRATION_042_SHARED_CONFIGURATION = `
-- Preserve each existing role once per Discord server and system. Prefer the
-- existing all-server binding when scoped and unscoped bindings overlap.
with duplicates as (
  select reviewer_binding_id, row_number() over (
    partition by discord_guild_id, domain, discord_role_id
    order by (albion_server is null) desc, created_at, reviewer_binding_id
  ) as occurrence
  from reviewer_role_bindings
)
delete from reviewer_role_bindings binding using duplicates
where binding.reviewer_binding_id = duplicates.reviewer_binding_id and duplicates.occurrence > 1;
alter table reviewer_role_bindings drop column albion_server;
create unique index reviewer_role_bindings_unique_role
  on reviewer_role_bindings (discord_guild_id, domain, discord_role_id);
alter table temporary_voice_configs drop column channel_name_prefix;
delete from entry_panel_roles where role_kind = 'giveaway_host';
alter table entry_panel_roles drop constraint entry_panel_roles_role_kind_check;
alter table entry_panel_roles add constraint entry_panel_roles_role_kind_check
  check (role_kind = 'accounts_manager');
`;

export const MIGRATION_043_CONTENT_SIGNUP_APPROVAL = `
alter table content_items add column approval_required boolean not null default false;
alter table content_items add column render_revision uuid not null default gen_random_uuid();
alter table content_items add column rendered_revision uuid;

create function content_rotate_render_revision() returns trigger language plpgsql as $$
begin
  new.render_revision := gen_random_uuid();
  return new;
end;
$$;
create trigger content_render_revision before update of leader_discord_user_id, title, description,
  scheduled_start_at, graphic_attachment_name, state, started_at on content_items
  for each row execute function content_rotate_render_revision();

create function content_mark_roster_dirty() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    update content_items set render_revision = gen_random_uuid()
      where content_id = old.content_id and discord_guild_id = old.discord_guild_id;
    return old;
  end if;
  update content_items set render_revision = gen_random_uuid()
    where content_id = new.content_id and discord_guild_id = new.discord_guild_id;
  return new;
end;
$$;
create trigger content_signup_render_revision after insert or update or delete on content_signups
  for each row execute function content_mark_roster_dirty();
create trigger content_slot_render_revision after insert or update or delete on content_role_slots
  for each row execute function content_mark_roster_dirty();
create table content_signup_requests (
  request_id uuid primary key default gen_random_uuid(),
  discord_guild_id text not null,
  content_id bigint not null,
  discord_user_id text not null check (length(trim(discord_user_id)) > 0),
  role_slot_id bigint,
  slot_index integer,
  role_label text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn','superseded','invalidated','closed')),
  request_message_id text,
  outcome_message_id text,
  request_notification_claimed_at timestamptz,
  outcome_notification_claimed_at timestamptz,
  presentation_finished_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (content_id, discord_guild_id) references content_items(content_id, discord_guild_id) on delete cascade,
  constraint content_signup_request_target check (
    (role_slot_id is null and slot_index is null and role_label is null)
    or (role_slot_id is not null and slot_index is not null and role_label is not null
        and slot_index > 0 and length(trim(role_label)) > 0)),
  constraint content_signup_request_resolution check ((status = 'pending') = (resolved_at is null)),
  unique (request_id, content_id, discord_guild_id)
);
-- Slot identity is retained as a snapshot after role removal, deliberately without a slot FK.
create unique index content_signup_requests_one_pending on content_signup_requests(content_id,discord_guild_id,discord_user_id) where status = 'pending';
create index content_signup_requests_repair on content_signup_requests(content_id,discord_guild_id) where status = 'pending' or presentation_finished_at is null;
`;

const MIGRATION_044_LOG_CHANNEL_CONFIGS = `
create table log_channel_configs (
  discord_guild_id text primary key check (length(trim(discord_guild_id)) > 0),
  discord_channel_id text not null check (length(trim(discord_channel_id)) > 0),
  configured_by_discord_user_id text not null check (length(trim(configured_by_discord_user_id)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

export const MIGRATION_045_CONTENT_DETAILS_MESSAGE = `
alter table content_items add column details_message_id text
  check (details_message_id is null or length(trim(details_message_id)) > 0);
-- Keep the original thread message and its graphic in the second position.
-- Reconciliation converts it to details, then publishes the new roles message.
update content_items
set details_message_id = control_message_id,
    control_message_id = null,
    rendered_revision = null
where state <> 'archived';
`;

export const MIGRATION_046_CONTENT_MULTI_SIGNUP = `
alter table content_items add column multi_signup_enabled boolean not null default false;
-- Conditional capacity is enforced under the party-row lock by every signup writer.
-- The independent one-active-signup-per-user unique index remains in force.
drop index content_signups_one_active_user_per_slot;
create index content_signups_active_role_slot
  on content_signups (discord_guild_id, content_id, content_role_slot_id)
  where state = 'active' and signup_type = 'role';
update content_items set rendered_revision = null
where state in ('scheduled', 'unscheduled', 'active');
`;

export const MIGRATION_047_CONTENT_UNSTART = `
alter table content_items add column first_started_at timestamptz;
alter table content_items add column started_by_discord_user_id text;
alter table content_items add column start_revision uuid;
-- Preserve the first start as the unscheduled cleanup anchor. Each later start
-- has its own timestamp and revision, so an old button cannot undo a new start.
update content_items set first_started_at = started_at,
  start_revision = gen_random_uuid()
where started_at is not null;
`;

const SCHEMA_MIGRATIONS = [
  [1, "core_membership_identity", MIGRATION_001_CORE_MEMBERSHIP_IDENTITY],
  [2, "discord_guild_lifecycle", MIGRATION_002_DISCORD_GUILD_LIFECYCLE],
  [3, "utc_voice_channels", MIGRATION_003_UTC_VOICE_CHANNELS],
  [4, "discord_guild_defaults", MIGRATION_004_DISCORD_GUILD_DEFAULTS],
  [5, "member_update_schedules", MIGRATION_005_MEMBER_UPDATE_SCHEDULES],
  [6, "application_tickets", MIGRATION_006_APPLICATION_TICKETS],
  [7, "application_ticket_channel_defer", MIGRATION_007_APPLICATION_TICKET_CHANNEL_DEFER],
  [8, "group_scoped_roles", MIGRATION_008_GROUP_SCOPED_ROLES],
  [9, "group_type_nomenclature", MIGRATION_009_GROUP_TYPE_NOMENCLATURE],
  [10, "content_signups", MIGRATION_010_CONTENT_SIGNUPS],
  [11, "reaction_roles", MIGRATION_011_REACTION_ROLES],
  [12, "reaction_role_membership", MIGRATION_012_REACTION_ROLE_MEMBERSHIP],
  [13, "character_accounts", MIGRATION_013_CHARACTER_ACCOUNTS],
  [14, "general_tickets", MIGRATION_014_GENERAL_TICKETS],
  [15, "shared_ticket_channel_lifecycle", MIGRATION_015_SHARED_TICKET_CHANNEL_LIFECYCLE],
  [16, "application_character_search_attempts", MIGRATION_016_APPLICATION_CHARACTER_SEARCH_ATTEMPTS],
  [17, "emoji_reaction_roles", MIGRATION_017_EMOJI_REACTION_ROLES],
  [18, "managed_user_reaction_roles", MIGRATION_018_MANAGED_USER_REACTION_ROLES],
  [19, "position_appointment_nomenclature", MIGRATION_019_POSITION_APPOINTMENT_NOMENCLATURE],
  [20, "application_control_message_ids", MIGRATION_020_APPLICATION_CONTROL_MESSAGE_IDS],
  [21, "temporary_voice_channels", MIGRATION_021_TEMPORARY_VOICE_CHANNELS],
  [22, "giveaways", MIGRATION_022_GIVEAWAYS],
  [23, "optional_giveaway_images", MIGRATION_023_OPTIONAL_GIVEAWAY_IMAGES],
  [24, "retain_closed_giveaways", MIGRATION_024_RETAIN_CLOSED_GIVEAWAYS],
  [25, "giveaway_notification_roles", MIGRATION_025_GIVEAWAY_NOTIFICATION_ROLES],
  [26, "content_control_messages", MIGRATION_026_CONTENT_CONTROL_MESSAGES],
  [27, "content_standby_signups", MIGRATION_027_CONTENT_STANDBY_SIGNUPS],
  [28, "regears", MIGRATION_028_REGEARS],
  [29, "content_builds_graphics", MIGRATION_029_CONTENT_BUILDS_GRAPHICS],
  [30, "weapon_specialisations", MIGRATION_030_WEAPON_SPECIALISATIONS],
  [31, "weapon_specialisation_v1", MIGRATION_031_WEAPON_SPECIALISATION_V1],
  [32, "character_registration_hierarchy", MIGRATION_032_CHARACTER_REGISTRATION_HIERARCHY],
  [33, "ticket_lifecycle_control_messages", MIGRATION_033_TICKET_LIFECYCLE_CONTROL_MESSAGES],
  [34, "application_class_archival", MIGRATION_034_APPLICATION_CLASS_ARCHIVAL],
  [35, "reviewer_role_bindings", MIGRATION_035_REVIEWER_ROLE_BINDINGS],
  [36, "specialisation_tree_coverage", MIGRATION_036_SPECIALISATION_TREE_COVERAGE],
  [37, "retire_regear_legacy_grants", MIGRATION_037_RETIRE_REGEAR_LEGACY_GRANTS],
  [38, "application_review_publication", MIGRATION_038_APPLICATION_REVIEW_PUBLICATION],
  [39, "unscheduled_content", MIGRATION_039_UNSCHEDULED_CONTENT],
  [40, "content_panels", MIGRATION_040_CONTENT_PANELS],
  [41, "feature_entry_panels", MIGRATION_041_FEATURE_ENTRY_PANELS],
  [42, "shared_configuration", MIGRATION_042_SHARED_CONFIGURATION],
  [43, "content_signup_approval", MIGRATION_043_CONTENT_SIGNUP_APPROVAL],
  [44, "log_channel_configs", MIGRATION_044_LOG_CHANNEL_CONFIGS],
  [45, "content_details_message", MIGRATION_045_CONTENT_DETAILS_MESSAGE],
  [46, "content_multi_signup", MIGRATION_046_CONTENT_MULTI_SIGNUP],
  [47, "content_unstart", MIGRATION_047_CONTENT_UNSTART],
  [48, "membership_departure_lifecycle", MEMBERSHIP_LIFECYCLE_SCHEMA_SQL + MEMBERSHIP_ENTITLEMENT_CLEANUP_SCHEMA_SQL],
  [49, "immediate_character_purge", MEMBERSHIP_PURGE_SCHEMA_SQL],
  [50, "character_registration_history", CHARACTER_REGISTRATION_HISTORY_SCHEMA_SQL],
  [51, "member_kick_access", MEMBER_KICK_SCHEMA_SQL + KICK_ACTIVITIES_SCHEMA_SQL]
] as const;

export async function migrateDatabaseSchema(pool: PostgresPool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query(
      `
      create table if not exists guild_manager_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
      `
    );

    for (const [version, name, sql] of SCHEMA_MIGRATIONS) {
      const applied = await client.query(
        "select 1 from guild_manager_schema_migrations where version = $1",
        [version]
      );
      if ((applied.rowCount ?? 0) > 0) continue;

      await client.query(sql);
      await client.query(
        "insert into guild_manager_schema_migrations (version, name) values ($1, $2)",
        [version, name]
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
