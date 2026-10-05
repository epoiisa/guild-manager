import type { AlbionServer } from "../services/albion/servers.js";
import type { ApplicationStatus, CharacterResolutionState } from "./applicationRepository.js";
import type { PostgresPool } from "./postgres.js";

export interface TaskApplication {
  applicationId: string;
  name: string;
  targetMemberGroupName?: string;
  applicantDiscordUserId?: string;
  ticketChannelId?: string;
  status: ApplicationStatus;
  characterResolutionState: CharacterResolutionState;
  createdAt: Date;
}
export interface TaskTicket {
  ticketId: string;
  name: string;
  openerDiscordUserId?: string;
  ticketChannelId?: string;
  createdAt: Date;
}
export interface TaskRegear {
  regearClaimId: string;
  characterName: string;
  contentName: string;
  contentDate: string;
  contentAt?: Date;
  currentOwnerDiscordUserId?: string;
  albionServer: AlbionServer;
  requestedValue: bigint;
  reviewChannelId?: string;
  reviewMessageId?: string;
  submittedAt: Date;
}
export interface TaskSpecialisation {
  specialisationRequestId: string;
  characterName: string;
  targetDisplayName: string;
  level: 100 | 800;
  submittedByDiscordUserId?: string;
  currentOwnerDiscordUserId?: string;
  albionServer: AlbionServer;
  reviewChannelId?: string;
  reviewMessageId?: string;
  createdAt: Date;
}
export interface TaskRegearContent {
  regearContentId: string;
  name: string;
  albionServer: AlbionServer;
  contentDate: string;
  contentAt?: Date;
  channelId?: string;
  announcementMessageId?: string;
  createdAt: Date;
}
export interface TasksSnapshot {
  discordGuildId: string;
  applications: TaskApplication[];
  tickets: TaskTicket[];
  regearContents: TaskRegearContent[];
  regears: TaskRegear[];
  specialisations: TaskSpecialisation[];
}

// PostgreSQL returns NULL for optional persisted references and strings for bigint.
type ReportRow<T> = { [K in keyof T]-?: T[K] extends bigint ? string : Exclude<T[K], undefined> | (undefined extends T[K] ? null : never) };

export function createTasksRepository(pool: PostgresPool) {
  return {
    async getSnapshot(discordGuildId: string): Promise<TasksSnapshot> {
      const [applications, tickets, regearContents, regears, specialisations] = await Promise.all([
        pool.query<ReportRow<TaskApplication>>(`
          select application.application_id as "applicationId", class.name,
            coalesce(member_group.group_name, class.archived_member_group_name) as "targetMemberGroupName",
            application.applicant_discord_user_id as "applicantDiscordUserId",
            application.ticket_channel_id as "ticketChannelId", application.status,
            application.character_resolution_state as "characterResolutionState", application.created_at as "createdAt"
          from open_applications application
          join application_classes class on class.application_class_id = application.application_class_id
            and class.discord_guild_id = application.discord_guild_id
          left join member_groups member_group on member_group.member_group_id = class.member_group_id
            and member_group.discord_guild_id = class.discord_guild_id
          where application.discord_guild_id = $1 and application.channel_status = 'open'
          order by application.created_at, application.application_id`, [discordGuildId]),
        pool.query<ReportRow<TaskTicket>>(`
          select ticket.ticket_id as "ticketId", class.name,
            ticket.opener_discord_user_id as "openerDiscordUserId", ticket.ticket_channel_id as "ticketChannelId",
            ticket.created_at as "createdAt"
          from tickets ticket
          join ticket_classes class on class.ticket_class_id = ticket.ticket_class_id
            and class.discord_guild_id = ticket.discord_guild_id
          where ticket.discord_guild_id = $1 and ticket.status = 'open'
          order by ticket.created_at, ticket.ticket_id`, [discordGuildId]),
        pool.query<ReportRow<TaskRegearContent>>(`
          select regear_content_id as "regearContentId", name, albion_server as "albionServer",
            content_date::text as "contentDate", content_at as "contentAt", channel_id as "channelId",
            announcement_message_id as "announcementMessageId", created_at as "createdAt"
          from regear_contents
          where discord_guild_id = $1 and state = 'open'
          order by content_date, content_at nulls first, created_at, regear_content_id`, [discordGuildId]),
        pool.query<ReportRow<TaskRegear>>(`
          select claim.regear_claim_id as "regearClaimId", character.character_name as "characterName",
            content.name as "contentName", content.content_date::text as "contentDate", content.content_at as "contentAt",
            current_owner.discord_user_id as "currentOwnerDiscordUserId",
            claim.albion_server as "albionServer", claim.requested_value as "requestedValue",
            claim.review_channel_id as "reviewChannelId", claim.review_message_id as "reviewMessageId",
            claim.submitted_at as "submittedAt"
          from regear_claims claim
          join regear_contents content on content.regear_content_id = claim.regear_content_id
            and content.discord_guild_id = claim.discord_guild_id and content.albion_server = claim.albion_server
          join albion_characters character on character.albion_server = claim.albion_server
            and character.albion_character_id = claim.albion_character_id
          left join lateral (
            select registered.discord_user_id from discord_user_characters registered
            where registered.discord_guild_id = claim.discord_guild_id
              and registered.albion_server = claim.albion_server
              and registered.albion_character_id = claim.albion_character_id
              and character_has_active_membership(registered.discord_guild_id, registered.albion_server, registered.albion_character_id, registered.discord_user_id)
            limit 1
          ) current_owner on true
          where claim.discord_guild_id = $1 and claim.status = 'pending'
          order by claim.submitted_at, claim.regear_claim_id`, [discordGuildId]),
        pool.query<ReportRow<TaskSpecialisation>>(`
          select request.specialisation_request_id as "specialisationRequestId", character.character_name as "characterName",
            request.target_display_name as "targetDisplayName", request.level,
            request.submitted_by_discord_user_id as "submittedByDiscordUserId", current_owner.discord_user_id as "currentOwnerDiscordUserId", request.albion_server as "albionServer",
            request.review_channel_id as "reviewChannelId",
            case when request.review_message_deleted_at is null then request.review_message_id end as "reviewMessageId",
            request.created_at as "createdAt"
          from specialisation_requests request
          join albion_characters character on character.albion_server = request.albion_server
            and character.albion_character_id = request.albion_character_id
          left join lateral (
            select registered.discord_user_id from discord_user_characters registered
            where registered.discord_guild_id = request.discord_guild_id
              and registered.albion_server = request.albion_server
              and registered.albion_character_id = request.albion_character_id
              and character_has_active_membership(registered.discord_guild_id, registered.albion_server, registered.albion_character_id, registered.discord_user_id)
            limit 1
          ) current_owner on true
          where request.discord_guild_id = $1 and request.state = 'pending'
          order by request.created_at, request.specialisation_request_id`, [discordGuildId])
      ]);
      return {
        discordGuildId,
        applications: applications.rows.map((row) => ({ ...row, targetMemberGroupName: row.targetMemberGroupName ?? undefined, applicantDiscordUserId: row.applicantDiscordUserId ?? undefined, ticketChannelId: row.ticketChannelId ?? undefined })),
        tickets: tickets.rows.map((row) => ({ ...row, openerDiscordUserId: row.openerDiscordUserId ?? undefined, ticketChannelId: row.ticketChannelId ?? undefined })),
        regearContents: regearContents.rows.map((row) => ({ ...row, contentAt: row.contentAt ?? undefined, channelId: row.channelId ?? undefined, announcementMessageId: row.announcementMessageId ?? undefined })),
        regears: regears.rows.map((row) => ({ ...row, contentAt: row.contentAt ?? undefined, requestedValue: BigInt(row.requestedValue), currentOwnerDiscordUserId: row.currentOwnerDiscordUserId ?? undefined, reviewChannelId: row.reviewChannelId ?? undefined, reviewMessageId: row.reviewMessageId ?? undefined })),
        specialisations: specialisations.rows.map((row) => ({ ...row, submittedByDiscordUserId: row.submittedByDiscordUserId ?? undefined, currentOwnerDiscordUserId: row.currentOwnerDiscordUserId ?? undefined, reviewChannelId: row.reviewChannelId ?? undefined, reviewMessageId: row.reviewMessageId ?? undefined }))
      };
    }
  };
}

export type TasksRepository = ReturnType<typeof createTasksRepository>;
