import { createMemberAccessRepository } from "./memberAccessRepository.js";
import { listQualifiedRoleIdsForUser } from "./roleEntitlements.js";
import type { AlbionServer } from "../services/albion/servers.js";
import type { PostgresPool } from "./postgres.js";
import { createConversationClassRemovalRepository } from "./conversationClassRemovalRepository.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type ApplicationOutcomeType = "register_character" | "member_group";
export type ApplicationButtonStyle = "primary" | "secondary" | "success" | "danger";
export type ApplicationMessageType = "initial" | "accepted" | "rejected";
export type ApplicationClassArchiveReason = "application_class_removed" | "member_group_removed";
export type CharacterResolutionState = "unresolved" | "selected" | "not_listed" | "registered_to_other_user";
export type ApplicationStatus = "open" | "accepted" | "awaiting_ingame_membership" | "rejected" | "withdrawn";
export type ApplicationChannelStatus = "open" | "closed" | "deleted";

export interface ApplicationQuestion {
  label: string;
}

export interface ApplicationAnswer {
  question: string;
  answer: string;
}

export interface ApplicationClass {
  applicationClassId: string;
  discordGuildId: string;
  name: string;
  outcomeType: ApplicationOutcomeType;
  memberGroupId?: string;
  albionServer: AlbionServer;
  activeRoleId?: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  buttonLabel?: string;
  buttonStyle?: ApplicationButtonStyle;
  ticketCategoryId: string;
  reviewerRoleId: string;
  questions: ApplicationQuestion[];
  initialMessage?: string;
  acceptanceMessage?: string;
  rejectionMessage?: string;
  enabled: boolean;
  createdByDiscordUserId: string;
  archivedAt?: Date;
  archivedByDiscordUserId?: string;
  archiveReason?: ApplicationClassArchiveReason;
  archivedMemberGroupId?: string;
  archivedMemberGroupType?: "group" | "guild" | "alliance";
  archivedMemberGroupName?: string;
  archivedAlbionEntityId?: string;
  archivedAlbionAllianceTag?: string;
}

export class ApplicationClassUnavailableError extends Error {
  constructor() {
    super("The application class is disabled, archived, or no longer has a valid target.");
    this.name = "ApplicationClassUnavailableError";
  }
}

export interface ApplicationReviewPublication {
  initialMessage?: string;
  initialMessageId?: string;
  answerMessageIds: string[];
  reviewerRoleId: string;
  /** Canonical summary created when the first valid selection replaces intake. */
  reviewCardMessageId?: string;
  /** Retained until the replaced selection message has been deleted. */
  replacedSelectionMessageId?: string;
  /** Former standalone reviewer notice; retained only for cleanup. */
  notificationMessageId?: string;
  /** Claimed before the first notifying review-card send; recovery is silent. */
  notificationClaimed: boolean;
  legacyHistoryMessageId?: string;
  legacyHistoryPayload?: { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number };
}

export interface OpenApplication {
  applicationId: string;
  applicationClassId: string;
  discordGuildId: string;
  applicantDiscordUserId: string;
  ticketChannelId?: string;
  submittedCharacterName: string;
  modalAnswers: ApplicationAnswer[];
  albionServer: AlbionServer;
  selectedAlbionCharacterId?: string;
  selectedCharacterOwnerDiscordUserId?: string;
  selectedCharacterName?: string;
  selectedCharacterGuildName?: string;
  selectedCharacterAllianceName?: string;
  selectedCharacterAllianceTag?: string;
  targetMemberGroupName?: string;
  targetMemberGroupType?: "group" | "guild" | "alliance";
  reviewPublication?: ApplicationReviewPublication;
  legacyReviewPublication?: boolean;
  characterResolutionState: CharacterResolutionState;
  characterSearchAttemptCount: number;
  characterResolutionMessageId?: string;
  applicationControlMessageId?: string;
  closedControlMessageId?: string;
  status: ApplicationStatus;
  channelStatus: ApplicationChannelStatus;
  accessRevokedAt?: Date;
  reviewerDiscordUserId?: string;
  acceptedAt?: Date;
  rejectedAt?: Date;
  withdrawnAt?: Date;
  closedAt?: Date;
  closedByDiscordUserId?: string;
  reopenedAt?: Date;
  reopenedByDiscordUserId?: string;
  deletedAt?: Date;
  deletedByDiscordUserId?: string;
  lastIngameMembershipCheckAt?: Date;
  lastIngameMembershipFailure?: string;
}

export interface CreateApplicationClassInput {
  discordGuildId: string;
  name: string;
  outcomeType: ApplicationOutcomeType;
  memberGroupId?: string;
  albionServer: AlbionServer;
  activeRoleId?: string;
  ticketCategoryId: string;
  reviewerRoleId: string;
  createdByDiscordUserId: string;
}

export interface CreateOpenApplicationInput {
  applicationClassId: string;
  discordGuildId: string;
  applicantDiscordUserId: string;
  ticketChannelId?: string;
  submittedCharacterName: string;
  modalAnswers: ApplicationAnswer[];
  albionServer: AlbionServer;
}

export interface OperationalApplicationTarget {
  characterResolutionState: CharacterResolutionState;
  selectedAlbionCharacterId?: string;
  selectedCharacterOwnerDiscordUserId?: string;
  applicationId: string;
  applicationName: string;
  targetMemberGroupName?: string;
  applicantDiscordUserId: string;
  ticketChannelId?: string;
  status: ApplicationStatus;
  channelStatus: ApplicationChannelStatus;
  reviewerRoleId: string;
}

export function createApplicationRepository(pool: PostgresPool) {
  return {
    getMemberAccess: (guildId: string, userId: string) => createMemberAccessRepository(pool).getMemberAccess(guildId, userId),
    classRemoval: createConversationClassRemovalRepository(pool, "application"),
    createApplicationClass: (input: CreateApplicationClassInput) => createApplicationClass(pool, input),
    listApplicationClasses: (discordGuildId: string, includeArchived = false) => listApplicationClasses(pool, discordGuildId, includeArchived),
    getApplicationClass: (discordGuildId: string, applicationClassId: string) =>
      getApplicationClass(pool, discordGuildId, applicationClassId),
    configureApplicationButton: (
      discordGuildId: string,
      applicationClassId: string,
      sourceChannelId: string,
      sourceMessageId: string,
      buttonLabel: string,
      buttonStyle: ApplicationButtonStyle
    ) => configureApplicationButton(
      pool,
      discordGuildId,
      applicationClassId,
      sourceChannelId,
      sourceMessageId,
      buttonLabel,
      buttonStyle
    ),
    setApplicationQuestions: (
      discordGuildId: string,
      applicationClassId: string,
      questions: ApplicationQuestion[]
    ) => setApplicationQuestions(pool, discordGuildId, applicationClassId, questions),
    setApplicationMessage: (
      discordGuildId: string,
      applicationClassId: string,
      messageType: ApplicationMessageType,
      message: string | undefined
    ) => setApplicationMessage(pool, discordGuildId, applicationClassId, messageType, message),
    setApplicationEnabled: (discordGuildId: string, applicationClassId: string, enabled: boolean) =>
      setApplicationEnabled(pool, discordGuildId, applicationClassId, enabled),
    createOpenApplication: (input: CreateOpenApplicationInput) => createOpenApplication(pool, input),
    setOpenApplicationTicketChannel: (discordGuildId: string, applicationId: string, ticketChannelId: string) =>
      setOpenApplicationTicketChannel(pool, discordGuildId, applicationId, ticketChannelId),
    isOpenApplicationClassOperational: (discordGuildId: string, applicationId: string) =>
      isOpenApplicationClassOperational(pool, discordGuildId, applicationId),
    setCharacterResolutionMessageId: (discordGuildId: string, applicationId: string, messageId: string) =>
      setCharacterResolutionMessageId(pool, discordGuildId, applicationId, messageId),
    setApplicationControlMessageId: (discordGuildId: string, applicationId: string, messageId: string) =>
      setApplicationControlMessageId(pool, discordGuildId, applicationId, messageId),
    setClosedControlMessageId: (discordGuildId: string, applicationId: string, messageId: string | undefined) =>
      setClosedControlMessageId(pool, discordGuildId, applicationId, messageId),
    claimClosedControlMessageId: (
      discordGuildId: string,
      applicationId: string,
      expectedMessageId: string | undefined,
      candidateMessageId: string
    ) => claimClosedControlMessageId(pool, discordGuildId, applicationId, expectedMessageId, candidateMessageId),
    ensureApplicationReviewPublication: (discordGuildId: string, applicationId: string) =>
      ensureApplicationReviewPublication(pool, discordGuildId, applicationId),
    updateApplicationReviewPublication: (discordGuildId: string, applicationId: string, expected: ApplicationReviewPublication, next: ApplicationReviewPublication) =>
      updateApplicationReviewPublication(pool, discordGuildId, applicationId, expected, next),
    claimApplicationFirstMessageId: (discordGuildId: string, applicationId: string, expectedMessageId: string | undefined, candidateMessageId: string) =>
      claimApplicationFirstMessageId(pool, discordGuildId, applicationId, expectedMessageId, candidateMessageId),
    getOpenApplication: (discordGuildId: string, applicationId: string) =>
      getOpenApplication(pool, discordGuildId, applicationId),
    getOpenApplicationByTicketChannel: (discordGuildId: string, ticketChannelId: string) =>
      getOpenApplicationByTicketChannel(pool, discordGuildId, ticketChannelId),
    listOperationalApplicationTargets: (discordGuildId: string, includeArchived = false) =>
      listOperationalApplicationTargets(pool, discordGuildId, includeArchived),
    listQualifiedRoleIdsForUser: (discordGuildId: string, discordUserId: string) =>
      listQualifiedRoleIdsForUser(pool, discordGuildId, discordUserId),
    hasOpenApplicationRequiringRole: (discordGuildId: string, applicantDiscordUserId: string, activeRoleId: string) =>
      hasOpenApplicationRequiringRole(pool, discordGuildId, applicantDiscordUserId, activeRoleId),
    selectApplicationCharacter: (
      discordGuildId: string,
      applicationId: string,
      albionCharacterId: string,
      state: CharacterResolutionState = "selected"
    ) => selectApplicationCharacter(pool, discordGuildId, applicationId, albionCharacterId, state),
    markApplicationCharacterNotListed: (discordGuildId: string, applicationId: string) =>
      markApplicationCharacterNotListed(pool, discordGuildId, applicationId),
    beginApplicationCharacterSearch: (discordGuildId: string, applicationId: string, characterName: string) =>
      beginApplicationCharacterSearch(pool, discordGuildId, applicationId, characterName),
    markApplicationAccepted: (discordGuildId: string, applicationId: string, reviewerDiscordUserId: string, expectedStatus: "open" | "awaiting_ingame_membership") =>
      markApplicationAccepted(pool, discordGuildId, applicationId, reviewerDiscordUserId, expectedStatus),
    markApplicationAwaitingMembership: (
      discordGuildId: string,
      applicationId: string,
      reviewerDiscordUserId: string,
      failure: string,
      expectedStatus: "open" | "awaiting_ingame_membership"
    ) => markApplicationAwaitingMembership(pool, discordGuildId, applicationId, reviewerDiscordUserId, failure, expectedStatus),
    markApplicationRejected: (discordGuildId: string, applicationId: string, reviewerDiscordUserId: string) =>
      markApplicationRejected(pool, discordGuildId, applicationId, reviewerDiscordUserId),
    markApplicationWithdrawn: (discordGuildId: string, applicationId: string) =>
      markApplicationWithdrawn(pool, discordGuildId, applicationId),
    markApplicationClosed: (discordGuildId: string, applicationId: string, closerDiscordUserId: string) =>
      markApplicationClosed(pool, discordGuildId, applicationId, closerDiscordUserId),
    markApplicationReopened: (discordGuildId: string, applicationId: string, actorId: string) =>
      markApplicationReopened(pool, discordGuildId, applicationId, actorId),
    markApplicationDeleted: (discordGuildId: string, applicationId: string, actorId: string) =>
      markApplicationDeleted(pool, discordGuildId, applicationId, actorId),
    markApplicationChannelDeleted: (discordGuildId: string, ticketChannelId: string) =>
      markApplicationChannelDeleted(pool, discordGuildId, ticketChannelId)
  };
}

async function createApplicationClass(
  pool: Queryable,
  input: CreateApplicationClassInput
): Promise<ApplicationClass> {
  const result = await pool.query<ApplicationClassRow>(
    `
    insert into application_classes (
      discord_guild_id,
      name,
      outcome_type,
      member_group_id,
      albion_server,
      active_role_id,
      ticket_category_id,
      reviewer_role_id,
      created_by_discord_user_id,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
    returning *
    `,
    [
      input.discordGuildId,
      input.name,
      input.outcomeType,
      input.memberGroupId ?? null,
      input.albionServer,
      input.activeRoleId ?? null,
      input.ticketCategoryId,
      input.reviewerRoleId,
      input.createdByDiscordUserId
    ]
  );
  return mapApplicationClass(result.rows[0]);
}

async function listApplicationClasses(pool: Queryable, discordGuildId: string, includeArchived: boolean): Promise<ApplicationClass[]> {
  const result = await pool.query<ApplicationClassRow>(
    `
    select *
    from application_classes
    where discord_guild_id = $1
      ${includeArchived ? "" : "and archived_at is null"}
    order by enabled desc, lower(name) asc, application_class_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapApplicationClass);
}

async function getApplicationClass(
  pool: Queryable,
  discordGuildId: string,
  applicationClassId: string
): Promise<ApplicationClass | undefined> {
  const result = await pool.query<ApplicationClassRow>(
    `
    select *
    from application_classes
    where discord_guild_id = $1
      and application_class_id = $2
    `,
    [discordGuildId, applicationClassId]
  );
  return result.rows[0] ? mapApplicationClass(result.rows[0]) : undefined;
}

async function configureApplicationButton(
  pool: Queryable,
  discordGuildId: string,
  applicationClassId: string,
  sourceChannelId: string,
  sourceMessageId: string,
  buttonLabel: string,
  buttonStyle: ApplicationButtonStyle
): Promise<ApplicationClass | undefined> {
  const result = await pool.query<ApplicationClassRow>(
    `
    update application_classes
    set source_channel_id = $3,
      source_message_id = $4,
      button_label = $5,
      button_style = $6,
      updated_at = now()
    where discord_guild_id = $1
      and application_class_id = $2
      and archived_at is null
    returning *
    `,
    [discordGuildId, applicationClassId, sourceChannelId, sourceMessageId, buttonLabel, buttonStyle]
  );
  return result.rows[0] ? mapApplicationClass(result.rows[0]) : undefined;
}

async function setApplicationQuestions(
  pool: Queryable,
  discordGuildId: string,
  applicationClassId: string,
  questions: ApplicationQuestion[]
): Promise<ApplicationClass | undefined> {
  const result = await pool.query<ApplicationClassRow>(
    `
    update application_classes
    set questions = $3::jsonb,
      updated_at = now()
    where discord_guild_id = $1
      and application_class_id = $2
      and archived_at is null
    returning *
    `,
    [discordGuildId, applicationClassId, JSON.stringify(questions)]
  );
  return result.rows[0] ? mapApplicationClass(result.rows[0]) : undefined;
}

async function setApplicationMessage(
  pool: Queryable,
  discordGuildId: string,
  applicationClassId: string,
  messageType: ApplicationMessageType,
  message: string | undefined
): Promise<ApplicationClass | undefined> {
  const column = messageColumn(messageType);
  const result = await pool.query<ApplicationClassRow>(
    `
    update application_classes
    set ${column} = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_class_id = $2
      and archived_at is null
    returning *
    `,
    [discordGuildId, applicationClassId, message ?? null]
  );
  return result.rows[0] ? mapApplicationClass(result.rows[0]) : undefined;
}

async function setApplicationEnabled(
  pool: Queryable,
  discordGuildId: string,
  applicationClassId: string,
  enabled: boolean
): Promise<ApplicationClass | undefined> {
  const result = await pool.query<ApplicationClassRow>(
    `
    update application_classes
    set enabled = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_class_id = $2
      and archived_at is null
    returning *
    `,
    [discordGuildId, applicationClassId, enabled]
  );
  return result.rows[0] ? mapApplicationClass(result.rows[0]) : undefined;
}

async function createOpenApplication(
  pool: Queryable,
  input: CreateOpenApplicationInput
): Promise<OpenApplication> {
  const result = await pool.query<OpenApplicationRow>(
    `
    with available_class as materialized (
      select application_class.application_class_id
      from application_classes application_class
      left join member_groups member_group
        on member_group.member_group_id = application_class.member_group_id
        and member_group.discord_guild_id = application_class.discord_guild_id
        and member_group.albion_server = application_class.albion_server
      where application_class.application_class_id = $1
        and application_class.discord_guild_id = $2
        and application_class.albion_server = $7
        and application_class.enabled = true
        and application_class.archived_at is null
        and (
          application_class.outcome_type <> 'member_group'
          or member_group.member_group_id is not null
        )
      for share of application_class
    )
    insert into open_applications (
      application_class_id,
      discord_guild_id,
      applicant_discord_user_id,
      ticket_channel_id,
      submitted_character_name,
      modal_answers,
      albion_server,
      updated_at
    )
    select $1, $2, $3, $4, $5, $6::jsonb, $7, now()
    from available_class
    returning *
    `,
    [
      input.applicationClassId,
      input.discordGuildId,
      input.applicantDiscordUserId,
      input.ticketChannelId ?? null,
      input.submittedCharacterName,
      JSON.stringify(input.modalAnswers),
      input.albionServer
    ]
  );
  const row = result.rows[0];
  if (!row) throw new ApplicationClassUnavailableError();
  return mapOpenApplication(row);
}

async function setOpenApplicationTicketChannel(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  ticketChannelId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    with available_class as materialized (
      select 1
      from open_applications open_application
      join application_classes application_class
        on application_class.discord_guild_id = open_application.discord_guild_id
        and application_class.application_class_id = open_application.application_class_id
      where open_application.discord_guild_id = $1
        and open_application.application_id = $2
        and open_application.channel_status = 'open'
        and application_class.archived_at is null
      for share of application_class
    )
    update open_applications
    set ticket_channel_id = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and channel_status = 'open'
      and exists (select 1 from available_class)
    returning *
    `,
    [discordGuildId, applicationId, ticketChannelId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function isOpenApplicationClassOperational(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    select 1
    from open_applications open_application
    join application_classes application_class
      on application_class.discord_guild_id = open_application.discord_guild_id
      and application_class.application_class_id = open_application.application_class_id
    where open_application.discord_guild_id = $1
      and open_application.application_id = $2
      and open_application.channel_status = 'open'
      and application_class.archived_at is null
    for share of application_class
    `,
    [discordGuildId, applicationId]
  );
  return (result.rowCount ?? 0) === 1;
}

async function setCharacterResolutionMessageId(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  messageId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set character_resolution_message_id = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
    returning *
    `,
    [discordGuildId, applicationId, messageId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function setApplicationControlMessageId(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  messageId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set application_control_message_id = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
    returning *
    `,
    [discordGuildId, applicationId, messageId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function setClosedControlMessageId(pool: Queryable, discordGuildId: string, applicationId: string, messageId: string | undefined): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `update open_applications set closed_control_message_id=$3, updated_at=now() where discord_guild_id=$1 and application_id=$2 returning *`,
    [discordGuildId, applicationId, messageId ?? null]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function claimClosedControlMessageId(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  expectedMessageId: string | undefined,
  candidateMessageId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    update open_applications
    set closed_control_message_id = $4,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and closed_control_message_id is not distinct from $3
    `,
    [discordGuildId, applicationId, expectedMessageId ?? null, candidateMessageId]
  );
  return (result.rowCount ?? 0) === 1;
}

async function claimApplicationFirstMessageId(
  pool: Queryable, discordGuildId: string, applicationId: string,
  expectedMessageId: string | undefined, candidateMessageId: string
): Promise<boolean> {
  const result = await pool.query(`
    update open_applications
    set application_control_message_id = $4, character_resolution_message_id = $4, updated_at = now()
    where discord_guild_id = $1 and application_id = $2
      and application_control_message_id is not distinct from $3
      and channel_status <> 'deleted'`,
    [discordGuildId, applicationId, expectedMessageId ?? null, candidateMessageId]);
  return (result.rowCount ?? 0) === 1;
}

async function ensureApplicationReviewPublication(
  pool: Queryable, discordGuildId: string, applicationId: string
): Promise<OpenApplication | undefined> {
  await pool.query(`
    update open_applications a
    set review_publication = jsonb_strip_nulls(jsonb_build_object(
      'initialMessage', case when a.legacy_review_publication then null else c.initial_message end,
      'answerMessageIds', '[]'::jsonb,
      'reviewerRoleId', c.reviewer_role_id,
      'notificationClaimed', a.legacy_review_publication)), updated_at = now()
    from application_classes c
    where a.discord_guild_id = $1 and a.application_id = $2
      and c.discord_guild_id = a.discord_guild_id and c.application_class_id = a.application_class_id
      and a.review_publication is null and a.channel_status <> 'deleted'
      and (a.legacy_review_publication or (
        c.archived_at is null and a.status = 'open' and a.channel_status = 'open'
        and a.character_resolution_state = 'selected' and a.selected_albion_character_id is not null
        and exists (select 1 from albion_characters identity
          where identity.albion_server = a.albion_server and identity.albion_character_id = a.selected_albion_character_id)
        and not exists (select 1 from discord_user_characters owner
          where owner.discord_guild_id = a.discord_guild_id and owner.albion_server = a.albion_server
            and owner.albion_character_id = a.selected_albion_character_id
            and owner.discord_user_id <> a.applicant_discord_user_id)))`, [discordGuildId, applicationId]);
  return getOpenApplication(pool, discordGuildId, applicationId);
}

async function updateApplicationReviewPublication(
  pool: Queryable, discordGuildId: string, applicationId: string,
  expected: ApplicationReviewPublication, next: ApplicationReviewPublication
): Promise<boolean> {
  if (expected.initialMessage !== next.initialMessage || expected.reviewerRoleId !== next.reviewerRoleId
    || (expected.notificationClaimed && !next.notificationClaimed)
    || (expected.legacyHistoryPayload && JSON.stringify(expected.legacyHistoryPayload) !== JSON.stringify(next.legacyHistoryPayload))) return false;
  const result = await pool.query(`
    update open_applications set review_publication = $4::jsonb, updated_at = now()
    where discord_guild_id = $1 and application_id = $2
      and review_publication = $3::jsonb and channel_status <> 'deleted'`,
    [discordGuildId, applicationId, JSON.stringify(expected), JSON.stringify(next)]);
  return (result.rowCount ?? 0) === 1;
}

async function getOpenApplication(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    select open_applications.*,
      identity.character_name as selected_character_name,
      identity.guild_name as selected_character_guild_name,
      identity.alliance_name as selected_character_alliance_name,
      identity.alliance_tag as selected_character_alliance_tag,
      (select owner.discord_user_id from discord_user_characters owner
       where owner.discord_guild_id = open_applications.discord_guild_id
         and owner.albion_server = open_applications.albion_server
         and owner.albion_character_id = open_applications.selected_albion_character_id) as selected_character_owner_discord_user_id,
      (select coalesce(g.group_name, c.archived_member_group_name) from application_classes c
       left join member_groups g on g.member_group_id=c.member_group_id and g.discord_guild_id=c.discord_guild_id and g.albion_server=c.albion_server
       where c.application_class_id=open_applications.application_class_id and c.discord_guild_id=open_applications.discord_guild_id) as target_member_group_name,
      (select coalesce(g.group_type, c.archived_member_group_type) from application_classes c
       left join member_groups g on g.member_group_id=c.member_group_id and g.discord_guild_id=c.discord_guild_id and g.albion_server=c.albion_server
       where c.application_class_id=open_applications.application_class_id and c.discord_guild_id=open_applications.discord_guild_id) as target_member_group_type
    from open_applications
    left join albion_characters identity
      on identity.albion_server = open_applications.albion_server
      and identity.albion_character_id = open_applications.selected_albion_character_id
    where open_applications.discord_guild_id = $1
      and open_applications.application_id = $2
    `,
    [discordGuildId, applicationId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function getOpenApplicationByTicketChannel(
  pool: Queryable,
  discordGuildId: string,
  ticketChannelId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    select open_applications.*,
      identity.character_name as selected_character_name,
      identity.guild_name as selected_character_guild_name,
      identity.alliance_name as selected_character_alliance_name,
      identity.alliance_tag as selected_character_alliance_tag,
      (select owner.discord_user_id from discord_user_characters owner
       where owner.discord_guild_id = open_applications.discord_guild_id
         and owner.albion_server = open_applications.albion_server
         and owner.albion_character_id = open_applications.selected_albion_character_id) as selected_character_owner_discord_user_id,
      (select coalesce(g.group_name, c.archived_member_group_name) from application_classes c
       left join member_groups g on g.member_group_id=c.member_group_id and g.discord_guild_id=c.discord_guild_id and g.albion_server=c.albion_server
       where c.application_class_id=open_applications.application_class_id and c.discord_guild_id=open_applications.discord_guild_id) as target_member_group_name,
      (select coalesce(g.group_type, c.archived_member_group_type) from application_classes c
       left join member_groups g on g.member_group_id=c.member_group_id and g.discord_guild_id=c.discord_guild_id and g.albion_server=c.albion_server
       where c.application_class_id=open_applications.application_class_id and c.discord_guild_id=open_applications.discord_guild_id) as target_member_group_type
    from open_applications
    left join albion_characters identity
      on identity.albion_server = open_applications.albion_server
      and identity.albion_character_id = open_applications.selected_albion_character_id
    where open_applications.discord_guild_id = $1
      and open_applications.ticket_channel_id = $2
    order by open_applications.application_id desc
    limit 1
    `,
    [discordGuildId, ticketChannelId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function listOperationalApplicationTargets(
  pool: Queryable,
  discordGuildId: string,
  includeArchived: boolean
): Promise<OperationalApplicationTarget[]> {
  const result = await pool.query<OperationalApplicationTargetRow>(
    `select a.application_id, c.name as application_name, coalesce(g.group_name, c.archived_member_group_name) as target_member_group_name, a.applicant_discord_user_id, a.ticket_channel_id, a.status, a.channel_status, c.reviewer_role_id, a.character_resolution_state, a.selected_albion_character_id, owner.discord_user_id as selected_character_owner_discord_user_id
     from open_applications a join application_classes c on c.application_class_id=a.application_class_id and c.discord_guild_id=a.discord_guild_id
     left join member_groups g on g.member_group_id=c.member_group_id and g.discord_guild_id=c.discord_guild_id
     left join discord_user_characters owner on owner.discord_guild_id=a.discord_guild_id and owner.albion_server=a.albion_server and owner.albion_character_id=a.selected_albion_character_id
     where a.discord_guild_id=$1
       and a.channel_status <> 'deleted'
       and ($2::boolean or c.archived_at is null)
     order by a.application_id desc`,
    [discordGuildId, includeArchived]
  );
  return result.rows.map((row) => ({ applicationId: row.application_id, applicationName: row.application_name, targetMemberGroupName: row.target_member_group_name ?? undefined, applicantDiscordUserId: row.applicant_discord_user_id, ticketChannelId: row.ticket_channel_id ?? undefined, status: row.status, channelStatus: row.channel_status, reviewerRoleId: row.reviewer_role_id, characterResolutionState: row.character_resolution_state, selectedAlbionCharacterId: row.selected_albion_character_id ?? undefined, selectedCharacterOwnerDiscordUserId: row.selected_character_owner_discord_user_id ?? undefined }));
}

async function hasOpenApplicationRequiringRole(
  pool: Queryable,
  discordGuildId: string,
  applicantDiscordUserId: string,
  activeRoleId: string
): Promise<boolean> {
  const result = await pool.query<{ required: boolean }>(
    `
    select exists (
      select 1
      from open_applications open_application
      join application_classes application_class
        on application_class.discord_guild_id = open_application.discord_guild_id
        and application_class.application_class_id = open_application.application_class_id
      where open_application.discord_guild_id = $1
        and open_application.applicant_discord_user_id = $2
        and open_application.channel_status = 'open'
        and open_application.status in ('open', 'awaiting_ingame_membership')
        and application_class.archived_at is null
        and application_class.active_role_id = $3
    ) as required
    `,
    [discordGuildId, applicantDiscordUserId, activeRoleId]
  );
  return result.rows[0]?.required ?? false;
}

async function selectApplicationCharacter(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  albionCharacterId: string,
  state: CharacterResolutionState
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications a
    set selected_albion_character_id = $3,
      character_resolution_state = $4,
      review_publication = coalesce(a.review_publication, case
        when $4 = 'selected'
          and exists (select 1 from albion_characters identity
            where identity.albion_server = a.albion_server and identity.albion_character_id = $3)
          and not exists (select 1 from discord_user_characters owner
            where owner.discord_guild_id = a.discord_guild_id and owner.albion_server = a.albion_server
              and owner.albion_character_id = $3 and owner.discord_user_id <> a.applicant_discord_user_id)
        then jsonb_strip_nulls(jsonb_build_object(
          'initialMessage', case when a.legacy_review_publication then null else c.initial_message end,
          'answerMessageIds', '[]'::jsonb,
          'reviewerRoleId', c.reviewer_role_id,
          'notificationClaimed', a.legacy_review_publication))
        else null end),
      updated_at = now()
    from application_classes c
    where a.discord_guild_id = $1
      and a.application_id = $2
      and a.status = 'open'
      and a.channel_status = 'open'
      and c.application_class_id = a.application_class_id
      and c.discord_guild_id = a.discord_guild_id
      and c.archived_at is null
    returning a.*
    `,
    [discordGuildId, applicationId, albionCharacterId, state]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationCharacterNotListed(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set selected_albion_character_id = null,
      character_resolution_state = 'not_listed',
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and channel_status = 'open'
      and status = 'open'
    returning *
    `,
    [discordGuildId, applicationId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function beginApplicationCharacterSearch(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  characterName: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set submitted_character_name = $3,
      selected_albion_character_id = null,
      character_resolution_state = 'unresolved',
      character_search_attempt_count = character_search_attempt_count + 1,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and status = 'open'
      and channel_status = 'open'
    returning *
    `,
    [discordGuildId, applicationId, characterName]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationAccepted(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  reviewerDiscordUserId: string,
  expectedStatus: "open" | "awaiting_ingame_membership"
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set status = 'accepted',
      reviewer_discord_user_id = $3,
      accepted_at = coalesce(accepted_at, now()),
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and status = $4
      and channel_status = 'open'
    returning *
    `,
    [discordGuildId, applicationId, reviewerDiscordUserId, expectedStatus]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationAwaitingMembership(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  reviewerDiscordUserId: string,
  failure: string,
  expectedStatus: "open" | "awaiting_ingame_membership"
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set status = 'awaiting_ingame_membership',
      reviewer_discord_user_id = $3,
      accepted_at = coalesce(accepted_at, now()),
      last_ingame_membership_check_at = now(),
      last_ingame_membership_failure = $4,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and status = $5
      and channel_status = 'open'
    returning *
    `,
    [discordGuildId, applicationId, reviewerDiscordUserId, failure, expectedStatus]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationRejected(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  reviewerDiscordUserId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set status = 'rejected',
      reviewer_discord_user_id = $3,
      rejected_at = coalesce(rejected_at, now()),
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and status = 'open'
      and channel_status = 'open'
      and character_resolution_state = 'selected'
      and selected_albion_character_id is not null
      and not exists (
        select 1 from discord_user_characters owner
        where owner.discord_guild_id = open_applications.discord_guild_id
          and owner.albion_server = open_applications.albion_server
          and owner.albion_character_id = open_applications.selected_albion_character_id
          and owner.discord_user_id <> open_applications.applicant_discord_user_id
      )
    returning *
    `,
    [discordGuildId, applicationId, reviewerDiscordUserId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationClosed(
  pool: Queryable,
  discordGuildId: string,
  applicationId: string,
  closerDiscordUserId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set channel_status = 'closed',
      closed_at = now(),
      closed_by_discord_user_id = $3,
      updated_at = now()
    where discord_guild_id = $1
      and application_id = $2
      and channel_status = 'open'
    returning *
    `,
    [discordGuildId, applicationId, closerDiscordUserId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationWithdrawn(pool: Queryable, discordGuildId: string, applicationId: string): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set status = 'withdrawn', withdrawn_at = coalesce(withdrawn_at, now()), updated_at = now()
    where discord_guild_id = $1 and application_id = $2 and status = 'open' and channel_status = 'open'
    returning *
    `,
    [discordGuildId, applicationId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationReopened(pool: Queryable, discordGuildId: string, applicationId: string, actorId: string): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `with available_class as materialized (
       select 1
       from open_applications open_application
       join application_classes application_class
         on application_class.discord_guild_id = open_application.discord_guild_id
         and application_class.application_class_id = open_application.application_class_id
       where open_application.discord_guild_id = $1
         and open_application.application_id = $2
         and application_class.archived_at is null
       for share of application_class
     )
     update open_applications
     set channel_status='open', reopened_at=now(), reopened_by_discord_user_id=$3, updated_at=now()
     where discord_guild_id=$1
       and application_id=$2
       and channel_status='closed'
       and access_revoked_at is null
       and exists (select 1 from available_class)
     returning *`,
    [discordGuildId, applicationId, actorId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationDeleted(pool: Queryable, discordGuildId: string, applicationId: string, actorId: string): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `update open_applications
     set channel_status='deleted',
       deleted_at=coalesce(deleted_at, now()),
       deleted_by_discord_user_id=coalesce(deleted_by_discord_user_id, $3),
       updated_at=now()
     where discord_guild_id=$1
       and application_id=$2
       and channel_status in ('closed', 'deleted')
       and (channel_status='closed' or deleted_by_discord_user_id is null)
     returning *`,
    [discordGuildId, applicationId, actorId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

async function markApplicationChannelDeleted(
  pool: Queryable,
  discordGuildId: string,
  ticketChannelId: string
): Promise<OpenApplication | undefined> {
  const result = await pool.query<OpenApplicationRow>(
    `
    update open_applications
    set channel_status = 'deleted',
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
    where discord_guild_id = $1
      and ticket_channel_id = $2
      and channel_status <> 'deleted'
    returning *
    `,
    [discordGuildId, ticketChannelId]
  );
  return result.rows[0] ? mapOpenApplication(result.rows[0]) : undefined;
}

function messageColumn(messageType: ApplicationMessageType): string {
  if (messageType === "initial") return "initial_message";
  if (messageType === "accepted") return "acceptance_message";
  return "rejection_message";
}

interface ApplicationClassRow {
  application_class_id: string;
  discord_guild_id: string;
  name: string;
  outcome_type: ApplicationOutcomeType;
  member_group_id: string | null;
  albion_server: AlbionServer;
  active_role_id: string | null;
  source_channel_id: string | null;
  source_message_id: string | null;
  button_label: string | null;
  button_style: ApplicationButtonStyle | null;
  ticket_category_id: string;
  reviewer_role_id: string;
  questions: unknown;
  initial_message: string | null;
  acceptance_message: string | null;
  rejection_message: string | null;
  enabled: boolean;
  created_by_discord_user_id: string;
  archived_at: Date | null;
  archived_by_discord_user_id: string | null;
  archive_reason: ApplicationClassArchiveReason | null;
  archived_member_group_id: string | null;
  archived_member_group_type: "group" | "guild" | "alliance" | null;
  archived_member_group_name: string | null;
  archived_albion_entity_id: string | null;
  archived_albion_alliance_tag: string | null;
}



interface OpenApplicationRow {
  application_id: string;
  application_class_id: string;
  discord_guild_id: string;
  applicant_discord_user_id: string;
  ticket_channel_id: string | null;
  submitted_character_name: string;
  modal_answers: unknown;
  albion_server: AlbionServer;
  selected_albion_character_id: string | null;
  selected_character_name?: string | null;
  selected_character_guild_name?: string | null;
  selected_character_alliance_name?: string | null;
  selected_character_alliance_tag?: string | null;
  selected_character_owner_discord_user_id?: string | null;
  target_member_group_name?: string | null;
  target_member_group_type?: "group" | "guild" | "alliance" | null;
  review_publication?: ApplicationReviewPublication | null;
  legacy_review_publication?: boolean;
  character_resolution_state: CharacterResolutionState;
  character_search_attempt_count: number;
  character_resolution_message_id: string | null;
  application_control_message_id: string | null;
  closed_control_message_id: string | null;
  status: ApplicationStatus;
  channel_status: ApplicationChannelStatus;
  access_revoked_at?: Date | null;
  reviewer_discord_user_id: string | null;
  accepted_at: Date | null;
  rejected_at: Date | null;
  withdrawn_at: Date | null;
  closed_at: Date | null;
  closed_by_discord_user_id: string | null;
  reopened_at: Date | null;
  reopened_by_discord_user_id: string | null;
  deleted_at: Date | null;
  deleted_by_discord_user_id: string | null;
  last_ingame_membership_check_at: Date | null;
  last_ingame_membership_failure: string | null;
}
interface OperationalApplicationTargetRow { selected_character_owner_discord_user_id?: string | null; character_resolution_state: CharacterResolutionState; selected_albion_character_id: string | null; application_id: string; application_name: string; target_member_group_name: string | null; applicant_discord_user_id: string; ticket_channel_id: string | null; status: ApplicationStatus; channel_status: ApplicationChannelStatus; reviewer_role_id: string; }

function mapApplicationClass(row: ApplicationClassRow): ApplicationClass {
  return {
    applicationClassId: row.application_class_id,
    discordGuildId: row.discord_guild_id,
    name: row.name,
    outcomeType: row.outcome_type,
    memberGroupId: row.member_group_id ?? undefined,
    albionServer: row.albion_server,
    activeRoleId: row.active_role_id ?? undefined,
    sourceChannelId: row.source_channel_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    buttonLabel: row.button_label ?? undefined,
    buttonStyle: row.button_style ?? undefined,
    ticketCategoryId: row.ticket_category_id,
    reviewerRoleId: row.reviewer_role_id,
    questions: parseQuestions(row.questions),
    initialMessage: row.initial_message ?? undefined,
    acceptanceMessage: row.acceptance_message ?? undefined,
    rejectionMessage: row.rejection_message ?? undefined,
    enabled: row.enabled,
    createdByDiscordUserId: row.created_by_discord_user_id,
    archivedAt: row.archived_at ?? undefined,
    archivedByDiscordUserId: row.archived_by_discord_user_id ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
    archivedMemberGroupId: row.archived_member_group_id ?? undefined,
    archivedMemberGroupType: row.archived_member_group_type ?? undefined,
    archivedMemberGroupName: row.archived_member_group_name ?? undefined,
    archivedAlbionEntityId: row.archived_albion_entity_id ?? undefined,
    archivedAlbionAllianceTag: row.archived_albion_alliance_tag ?? undefined
  };
}

function mapOpenApplication(row: OpenApplicationRow): OpenApplication {
  return {
    applicationId: row.application_id,
    applicationClassId: row.application_class_id,
    discordGuildId: row.discord_guild_id,
    applicantDiscordUserId: row.applicant_discord_user_id,
    ticketChannelId: row.ticket_channel_id ?? "",
    submittedCharacterName: row.submitted_character_name,
    modalAnswers: parseAnswers(row.modal_answers),
    albionServer: row.albion_server,
    selectedAlbionCharacterId: row.selected_albion_character_id ?? undefined,
    selectedCharacterName: row.selected_character_name ?? undefined,
    selectedCharacterGuildName: row.selected_character_guild_name ?? undefined,
    selectedCharacterAllianceName: row.selected_character_alliance_name ?? undefined,
    selectedCharacterAllianceTag: row.selected_character_alliance_tag ?? undefined,
    selectedCharacterOwnerDiscordUserId: row.selected_character_owner_discord_user_id ?? undefined,
    targetMemberGroupName: row.target_member_group_name ?? undefined,
    targetMemberGroupType: row.target_member_group_type ?? undefined,
    reviewPublication: row.review_publication ?? undefined,
    legacyReviewPublication: row.legacy_review_publication ?? false,
    characterResolutionState: row.character_resolution_state,
    characterSearchAttemptCount: row.character_search_attempt_count,
    characterResolutionMessageId: row.character_resolution_message_id ?? undefined,
    applicationControlMessageId: row.application_control_message_id ?? undefined,
    closedControlMessageId: row.closed_control_message_id ?? undefined,
    status: row.status,
    channelStatus: row.channel_status,
    ...(row.access_revoked_at ? { accessRevokedAt: row.access_revoked_at } : {}),
    reviewerDiscordUserId: row.reviewer_discord_user_id ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    withdrawnAt: row.withdrawn_at ?? undefined,
    closedAt: row.closed_at ?? undefined,
    closedByDiscordUserId: row.closed_by_discord_user_id ?? undefined,
    reopenedAt: row.reopened_at ?? undefined,
    reopenedByDiscordUserId: row.reopened_by_discord_user_id ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedByDiscordUserId: row.deleted_by_discord_user_id ?? undefined,
    lastIngameMembershipCheckAt: row.last_ingame_membership_check_at ?? undefined,
    lastIngameMembershipFailure: row.last_ingame_membership_failure ?? undefined
  };
}

function parseQuestions(value: unknown): ApplicationQuestion[] {
  const parsed = parseJsonArray(value);
  return parsed
    .map((item) => typeof item === "object" && item !== null && "label" in item
      ? { label: String((item as { label: unknown }).label).trim() }
      : undefined)
    .filter((item): item is ApplicationQuestion => !!item && item.label.length > 0);
}

function parseAnswers(value: unknown): ApplicationAnswer[] {
  const parsed = parseJsonArray(value);
  return parsed
    .map((item) => typeof item === "object" && item !== null && "question" in item && "answer" in item
      ? {
        question: String((item as { question: unknown }).question).trim(),
        answer: String((item as { answer: unknown }).answer).trim()
      }
      : undefined)
    .filter((item): item is ApplicationAnswer => !!item && item.question.length > 0);
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
