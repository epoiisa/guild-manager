import type { AlbionServer } from "../services/albion/servers.js";
import type { PostgresPool } from "./postgres.js";

interface Queryable { query: PostgresPool["query"]; }
export type StatusMemberGroupType = "group" | "guild" | "alliance";
export type StatusReviewerDomain = "regears" | "specialisation";

export interface StatusMemberGroup { memberGroupId: string; albionServer: AlbionServer; groupType: StatusMemberGroupType; groupName: string; managed?: boolean; isDefaultAlbionGuild: boolean; discordRoleIds: string[]; albionAllianceTag?: string; }
export interface StatusPosition { memberGroupPositionId: string; memberGroupId: string; name: string; discordRoleId: string; }
export interface StatusCharacterRoleConfig { characterRoleConfigId: string; albionServer?: AlbionServer; discordRoleId: string; }
export interface StatusReactionRole { reactionRoleConfigId: string; discordRoleId: string; emojiPlacement?: { reactionRoleEmojiPlacementId: string; channelId: string; messageId: string; emojiDisplayValue: string; }; }
export interface StatusReviewerBinding { reviewerBindingId: string; domain: StatusReviewerDomain; discordRoleId: string; }
export interface StatusPartyTemplate { contentTemplateId: string; name: string; }
export interface StatusApplicationClass { applicationClassId: string; name: string; enabled: boolean; albionServer: AlbionServer; memberGroupId?: string; memberGroupName?: string; memberGroupType?: StatusMemberGroupType; ticketCategoryId: string; reviewerRoleId: string; activeRoleId?: string; }
export interface StatusTicketClass { ticketClassId: string; name: string; enabled: boolean; ticketCategoryId: string; reviewerRoleId: string; }
export interface StatusMemberUpdateSchedule { cadence: "daily" | "weekly"; weekday: number | null; hourUtc: number; minuteUtc: number; }
export interface StatusTemporaryVoiceConfiguration { baseChannelId: string; }
export interface StatusSnapshot {
  discordGuildId: string;
  memberGroups: StatusMemberGroup[];
  positions: StatusPosition[];
  characterRoleConfigs: StatusCharacterRoleConfig[];
  reactionRoles: StatusReactionRole[];
  reviewerBindings: StatusReviewerBinding[];
  partyTemplates: StatusPartyTemplate[];
  applicationClasses: StatusApplicationClass[];
  ticketClasses: StatusTicketClass[];
  memberUpdateSchedule?: StatusMemberUpdateSchedule;
  contentChannelId?: string;
  logChannelId?: string;
  entryChannels?: Array<{ feature: string; channelId: string }>;
  entryRoles?: Array<{ kind: string; roleId: string }>;
  utcChannelId?: string;
  temporaryVoice?: StatusTemporaryVoiceConfiguration;
  specialisationCatalogueExclusionKeys: string[];
}

export function createStatusRepository(pool: PostgresPool) { return { getSnapshot: (discordGuildId: string) => getSnapshot(pool, discordGuildId) }; }
export type StatusRepository = ReturnType<typeof createStatusRepository>;

async function getSnapshot(pool: Queryable, discordGuildId: string): Promise<StatusSnapshot> {
  const [groupsResult, groupRolesResult, positionsResult, characterRolesResult, reactionRolesResult, reviewerBindingsResult, partyTemplatesResult, applicationClassesResult, ticketClassesResult, schedulesResult, contentChannelsResult, utcChannelsResult, temporaryVoiceResult, exclusionsResult, entryChannelsResult, entryRolesResult, logChannelsResult] = await Promise.all([
    pool.query<MemberGroupRow>(memberGroupsSql, [discordGuildId]), pool.query<MemberGroupRoleRow>(memberGroupRolesSql, [discordGuildId]), pool.query<PositionRow>(positionsSql, [discordGuildId]), pool.query<CharacterRoleRow>(characterRolesSql, [discordGuildId]), pool.query<ReactionRoleRow>(reactionRolesSql, [discordGuildId]), pool.query<ReviewerBindingRow>(reviewerBindingsSql, [discordGuildId]), pool.query<PartyTemplateRow>(partyTemplatesSql, [discordGuildId]), pool.query<ApplicationClassRow>(applicationClassesSql, [discordGuildId]), pool.query<TicketClassRow>(ticketClassesSql, [discordGuildId]), pool.query<ScheduleRow>(scheduleSql, [discordGuildId]), pool.query<ChannelRow>(contentChannelSql, [discordGuildId]), pool.query<ChannelRow>(utcChannelSql, [discordGuildId]), pool.query<TemporaryVoiceRow>(temporaryVoiceSql, [discordGuildId]), pool.query<ExclusionRow>(exclusionsSql, [discordGuildId]),
    pool.query<{ feature: string; discord_channel_id: string }>("select feature, discord_channel_id from entry_panel_channels where discord_guild_id = $1 order by feature", [discordGuildId]),
    pool.query<{ role_kind: string; discord_role_id: string }>("select role_kind, discord_role_id from entry_panel_roles where discord_guild_id = $1 order by role_kind, discord_role_id", [discordGuildId]),
    pool.query<ChannelRow>("select discord_channel_id from log_channel_configs where discord_guild_id = $1", [discordGuildId])
  ]);
  const rolesByGroup = new Map<string, string[]>();
  for (const row of groupRolesResult.rows) { const roles = rolesByGroup.get(row.member_group_id) ?? []; roles.push(row.discord_role_id); rolesByGroup.set(row.member_group_id, roles); }
  return {
    discordGuildId,
    memberGroups: groupsResult.rows.map((row) => ({ memberGroupId: row.member_group_id, albionServer: row.albion_server, groupType: row.group_type, groupName: row.group_name, managed: row.managed ?? undefined, isDefaultAlbionGuild: row.is_default_albion_guild, discordRoleIds: rolesByGroup.get(row.member_group_id) ?? [], albionAllianceTag: row.albion_alliance_tag ?? undefined })),
    positions: positionsResult.rows.map((row) => ({ memberGroupPositionId: row.member_group_position_id, memberGroupId: row.member_group_id, name: row.name, discordRoleId: row.discord_role_id })),
    characterRoleConfigs: characterRolesResult.rows.map((row) => ({ characterRoleConfigId: row.character_role_config_id, albionServer: row.albion_server ?? undefined, discordRoleId: row.discord_role_id })),
    reactionRoles: reactionRolesResult.rows.map(mapReactionRole),
    reviewerBindings: reviewerBindingsResult.rows.map((row) => ({ reviewerBindingId: row.reviewer_binding_id, domain: row.domain, discordRoleId: row.discord_role_id })),
    partyTemplates: partyTemplatesResult.rows.map((row) => ({ contentTemplateId: row.content_template_id, name: row.name })),
    applicationClasses: applicationClassesResult.rows.map((row) => ({ applicationClassId: row.application_class_id, name: row.name, enabled: row.enabled, albionServer: row.albion_server, memberGroupId: row.member_group_id ?? undefined, memberGroupName: row.member_group_name ?? undefined, memberGroupType: row.member_group_type ?? undefined, ticketCategoryId: row.ticket_category_id, reviewerRoleId: row.reviewer_role_id, activeRoleId: row.active_role_id ?? undefined })),
    ticketClasses: ticketClassesResult.rows.map((row) => ({ ticketClassId: row.ticket_class_id, name: row.name, enabled: row.enabled, ticketCategoryId: row.ticket_category_id, reviewerRoleId: row.reviewer_role_id })),
    memberUpdateSchedule: schedulesResult.rows[0] ? mapSchedule(schedulesResult.rows[0]) : undefined,
    entryChannels: entryChannelsResult.rows.map(row => ({ feature: row.feature, channelId: row.discord_channel_id })),
    entryRoles: entryRolesResult.rows.map(row => ({ kind: row.role_kind, roleId: row.discord_role_id })),
    logChannelId: logChannelsResult.rows[0]?.discord_channel_id,
    contentChannelId: contentChannelsResult.rows[0]?.discord_channel_id, utcChannelId: utcChannelsResult.rows[0]?.discord_channel_id,
    temporaryVoice: temporaryVoiceResult.rows[0] ? { baseChannelId: temporaryVoiceResult.rows[0].base_channel_id } : undefined,
    specialisationCatalogueExclusionKeys: exclusionsResult.rows.map((row) => row.catalogue_key)
  };
}

const memberGroupsSql = `select mg.member_group_id::text, mg.albion_server, mg.group_type, mg.group_name, guild.managed, alliance.albion_alliance_tag, (defaults.default_albion_guild_member_group_id is not null) as is_default_albion_guild from member_groups mg left join configured_albion_guilds guild on guild.member_group_id = mg.member_group_id and guild.discord_guild_id = mg.discord_guild_id left join configured_albion_alliances alliance on alliance.member_group_id = mg.member_group_id and alliance.discord_guild_id = mg.discord_guild_id left join discord_guild_defaults defaults on defaults.discord_guild_id = mg.discord_guild_id and defaults.default_albion_guild_member_group_id = mg.member_group_id where mg.discord_guild_id = $1 order by mg.albion_server, case mg.group_type when 'guild' then 1 when 'alliance' then 2 else 3 end, lower(mg.group_name), mg.member_group_id`;
const memberGroupRolesSql = `select config.member_group_id::text, config.discord_role_id from member_group_role_configs config join member_groups mg on mg.member_group_id = config.member_group_id where mg.discord_guild_id = $1 order by config.member_group_id, config.discord_role_id`;
const positionsSql = `select position.member_group_position_id::text, position.member_group_id::text, position.name, position.discord_role_id from member_group_positions position join member_groups mg on mg.member_group_id = position.member_group_id and mg.discord_guild_id = position.discord_guild_id where position.discord_guild_id = $1 order by mg.albion_server, case mg.group_type when 'guild' then 1 when 'alliance' then 2 else 3 end, lower(mg.group_name), lower(position.name), position.member_group_position_id`;
const characterRolesSql = `select character_role_config_id::text, albion_server, discord_role_id from character_role_configs where discord_guild_id = $1 order by albion_server nulls first, discord_role_id, character_role_config_id`;
const reactionRolesSql = `select config.reaction_role_config_id::text, config.discord_role_id, placement.reaction_role_emoji_placement_id::text, placement.channel_id, placement.message_id, placement.emoji_display_value from reaction_role_configs config left join reaction_role_emoji_placements placement on placement.reaction_role_config_id = config.reaction_role_config_id and placement.discord_guild_id = config.discord_guild_id where config.discord_guild_id = $1 order by config.discord_role_id, config.reaction_role_config_id`;
const reviewerBindingsSql = `select reviewer_binding_id::text, domain, discord_role_id from reviewer_role_bindings where discord_guild_id = $1 order by domain, discord_role_id, reviewer_binding_id`;
const partyTemplatesSql = `select content_template_id::text, name from content_templates where discord_guild_id = $1 order by lower(name), content_template_id`;
const applicationClassesSql = `select class.application_class_id::text, class.name, class.enabled, class.albion_server, class.member_group_id::text, group_target.group_name as member_group_name, group_target.group_type as member_group_type, class.ticket_category_id, class.reviewer_role_id, class.active_role_id from application_classes class left join member_groups group_target on group_target.member_group_id = class.member_group_id and group_target.discord_guild_id = class.discord_guild_id where class.discord_guild_id = $1 and class.archived_at is null order by class.enabled desc, lower(class.name), class.application_class_id`;
const ticketClassesSql = `select ticket_class_id::text, name, enabled, ticket_category_id, reviewer_role_id from ticket_classes where discord_guild_id = $1 order by enabled desc, lower(name), ticket_class_id`;
const scheduleSql = `select cadence, weekday, hour_utc, minute_utc from member_update_schedules where discord_guild_id = $1`;
const contentChannelSql = `select discord_channel_id from content_channel_configs where discord_guild_id = $1`;
const utcChannelSql = `select discord_channel_id from utc_voice_channels where discord_guild_id = $1`;
const temporaryVoiceSql = `select base_channel_id from temporary_voice_configs where discord_guild_id = $1`;
const exclusionsSql = `select catalogue_key from specialisation_catalogue_exclusions where discord_guild_id = $1 order by catalogue_key`;

interface MemberGroupRow { member_group_id: string; albion_server: AlbionServer; group_type: StatusMemberGroupType; group_name: string; managed: boolean | null; albion_alliance_tag: string | null; is_default_albion_guild: boolean; }
interface MemberGroupRoleRow { member_group_id: string; discord_role_id: string; }
interface PositionRow { member_group_position_id: string; member_group_id: string; name: string; discord_role_id: string; }
interface CharacterRoleRow { character_role_config_id: string; albion_server: AlbionServer | null; discord_role_id: string; }
interface ReactionRoleRow { reaction_role_config_id: string; discord_role_id: string; reaction_role_emoji_placement_id: string | null; channel_id: string | null; message_id: string | null; emoji_display_value: string | null; }
interface ReviewerBindingRow { reviewer_binding_id: string; domain: StatusReviewerDomain; discord_role_id: string; }
interface PartyTemplateRow { content_template_id: string; name: string; }
interface ApplicationClassRow { application_class_id: string; name: string; enabled: boolean; albion_server: AlbionServer; member_group_id: string | null; member_group_name: string | null; member_group_type: StatusMemberGroupType | null; ticket_category_id: string; reviewer_role_id: string; active_role_id: string | null; }
interface TicketClassRow { ticket_class_id: string; name: string; enabled: boolean; ticket_category_id: string; reviewer_role_id: string; }
interface ScheduleRow { cadence: "daily" | "weekly"; weekday: number | null; hour_utc: number; minute_utc: number; }
interface ChannelRow { discord_channel_id: string; }
interface TemporaryVoiceRow { base_channel_id: string; }
interface ExclusionRow { catalogue_key: string; }
function mapReactionRole(row: ReactionRoleRow): StatusReactionRole { const emojiPlacement = row.reaction_role_emoji_placement_id ? { reactionRoleEmojiPlacementId: row.reaction_role_emoji_placement_id, channelId: row.channel_id!, messageId: row.message_id!, emojiDisplayValue: row.emoji_display_value! } : undefined; return { reactionRoleConfigId: row.reaction_role_config_id, discordRoleId: row.discord_role_id, emojiPlacement }; }
function mapSchedule(row: ScheduleRow): StatusMemberUpdateSchedule { return { cadence: row.cadence, weekday: row.weekday, hourUtc: row.hour_utc, minuteUtc: row.minute_utc }; }
