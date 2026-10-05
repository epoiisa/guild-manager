import type { PostgresPool } from "./postgres.js";
import { createConversationClassRemovalRepository } from "./conversationClassRemovalRepository.js";

interface Queryable { query: PostgresPool["query"]; }

export type TicketButtonStyle = "primary" | "secondary" | "success" | "danger";
export type TicketMessageType = "initial" | "closed";
export type TicketStatus = "open" | "closed" | "deleted";

export class TicketClassUnavailableError extends Error {
  constructor() { super("The ticket class is disabled or no longer available."); this.name = "TicketClassUnavailableError"; }
}

export interface TicketClass {
  ticketClassId: string;
  discordGuildId: string;
  name: string;
  ticketCategoryId: string;
  reviewerRoleId: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  buttonLabel?: string;
  buttonStyle?: TicketButtonStyle;
  initialMessage?: string;
  closedMessage?: string;
  enabled: boolean;
  createdByDiscordUserId: string;
}

export interface Ticket {
  ticketId: string;
  ticketClassId: string;
  discordGuildId: string;
  openerDiscordUserId: string;
  ticketChannelId?: string;
  controlMessageId?: string;
  status: TicketStatus;
  accessRevokedAt?: Date;
  closedAt?: Date;
  closedByDiscordUserId?: string;
  reopenedAt?: Date;
  reopenedByDiscordUserId?: string;
  deletedAt?: Date;
  deletedByDiscordUserId?: string;
}
export interface OperationalTicketTarget { ticketId: string; ticketName: string; openerDiscordUserId: string; ticketChannelId?: string; status: TicketStatus; reviewerRoleId: string; }

export function createTicketRepository(pool: PostgresPool) {
  return {
    classRemoval: createConversationClassRemovalRepository(pool, "ticket"),
    createTicketClass: (input: { discordGuildId: string; name: string; ticketCategoryId: string; reviewerRoleId: string; createdByDiscordUserId: string }) => createTicketClass(pool, input),
    listTicketClasses: (discordGuildId: string) => listTicketClasses(pool, discordGuildId),
    getTicketClass: (discordGuildId: string, ticketClassId: string) => getTicketClass(pool, discordGuildId, ticketClassId),
    configureTicketButton: (discordGuildId: string, ticketClassId: string, sourceChannelId: string, sourceMessageId: string, buttonLabel: string, buttonStyle: TicketButtonStyle) => configureTicketButton(pool, discordGuildId, ticketClassId, sourceChannelId, sourceMessageId, buttonLabel, buttonStyle),
    setTicketMessage: (discordGuildId: string, ticketClassId: string, type: TicketMessageType, message: string | undefined) => setTicketMessage(pool, discordGuildId, ticketClassId, type, message),
    setTicketEnabled: (discordGuildId: string, ticketClassId: string, enabled: boolean) => setTicketEnabled(pool, discordGuildId, ticketClassId, enabled),
    createTicket: (input: { ticketClassId: string; discordGuildId: string; openerDiscordUserId: string }) => createTicket(pool, input),
    setTicketChannel: (discordGuildId: string, ticketId: string, channelId: string) => setTicketChannel(pool, discordGuildId, ticketId, channelId),
    setTicketControlMessageId: (discordGuildId: string, ticketId: string, messageId: string | undefined) => setTicketControlMessageId(pool, discordGuildId, ticketId, messageId),
    claimTicketControlMessageId: (discordGuildId: string, ticketId: string, expectedMessageId: string | undefined, candidateMessageId: string) =>
      claimTicketControlMessageId(pool, discordGuildId, ticketId, expectedMessageId, candidateMessageId),
    getTicket: (discordGuildId: string, ticketId: string) => getTicket(pool, discordGuildId, ticketId),
    getTicketByChannel: (discordGuildId: string, ticketChannelId: string) => getTicketByChannel(pool, discordGuildId, ticketChannelId),
    listOperationalTicketTargets: (discordGuildId: string) => listOperationalTicketTargets(pool, discordGuildId),
    markTicketClosed: (discordGuildId: string, ticketId: string, actorId: string) => markTicketClosed(pool, discordGuildId, ticketId, actorId),
    markTicketReopened: (discordGuildId: string, ticketId: string, actorId: string) => markTicketReopened(pool, discordGuildId, ticketId, actorId),
    markTicketDeleted: (discordGuildId: string, ticketId: string, actorId: string) => markTicketDeleted(pool, discordGuildId, ticketId, actorId),
    markTicketChannelDeleted: (discordGuildId: string, ticketChannelId: string) => markTicketChannelDeleted(pool, discordGuildId, ticketChannelId)
  };
}

async function createTicketClass(pool: Queryable, input: { discordGuildId: string; name: string; ticketCategoryId: string; reviewerRoleId: string; createdByDiscordUserId: string }): Promise<TicketClass> {
  const result = await pool.query<TicketClassRow>(`insert into ticket_classes (discord_guild_id, name, ticket_category_id, reviewer_role_id, created_by_discord_user_id) values ($1,$2,$3,$4,$5) returning *`, [input.discordGuildId, input.name, input.ticketCategoryId, input.reviewerRoleId, input.createdByDiscordUserId]);
  return mapTicketClass(result.rows[0]);
}

async function listTicketClasses(pool: Queryable, guildId: string): Promise<TicketClass[]> {
  const result = await pool.query<TicketClassRow>(`select * from ticket_classes where discord_guild_id=$1 order by enabled desc, lower(name), ticket_class_id`, [guildId]);
  return result.rows.map(mapTicketClass);
}

async function getTicketClass(pool: Queryable, guildId: string, id: string): Promise<TicketClass | undefined> {
  const result = await pool.query<TicketClassRow>(`select * from ticket_classes where discord_guild_id=$1 and ticket_class_id=$2`, [guildId, id]);
  return result.rows[0] ? mapTicketClass(result.rows[0]) : undefined;
}

async function configureTicketButton(pool: Queryable, guildId: string, id: string, channelId: string, messageId: string, label: string, style: TicketButtonStyle): Promise<TicketClass | undefined> {
  const result = await pool.query<TicketClassRow>(`update ticket_classes set source_channel_id=$3, source_message_id=$4, button_label=$5, button_style=$6, updated_at=now() where discord_guild_id=$1 and ticket_class_id=$2 returning *`, [guildId, id, channelId, messageId, label, style]);
  return result.rows[0] ? mapTicketClass(result.rows[0]) : undefined;
}

async function setTicketMessage(pool: Queryable, guildId: string, id: string, type: TicketMessageType, message: string | undefined): Promise<void> {
  const column = type === "initial" ? "initial_message" : "closed_message";
  await pool.query(`update ticket_classes set ${column}=$3, updated_at=now() where discord_guild_id=$1 and ticket_class_id=$2`, [guildId, id, message ?? null]);
}

async function setTicketEnabled(pool: Queryable, guildId: string, id: string, enabled: boolean): Promise<void> {
  await pool.query(`update ticket_classes set enabled=$3, updated_at=now() where discord_guild_id=$1 and ticket_class_id=$2`, [guildId, id, enabled]);
}

async function createTicket(pool: Queryable, input: { ticketClassId: string; discordGuildId: string; openerDiscordUserId: string }): Promise<Ticket> {
  const result = await pool.query<TicketRow>(`
    with available_class as materialized (
      select ticket_class_id from ticket_classes
      where ticket_class_id=$1 and discord_guild_id=$2 and enabled=true for share
    )
    insert into tickets (ticket_class_id, discord_guild_id, opener_discord_user_id)
    select $1,$2,$3 from available_class returning *
  `, [input.ticketClassId, input.discordGuildId, input.openerDiscordUserId]);
  if (!result.rows[0]) throw new TicketClassUnavailableError();
  return mapTicket(result.rows[0]);
}

async function setTicketChannel(pool: Queryable, guildId: string, id: string, channelId: string): Promise<void> {
  await pool.query(`update tickets set ticket_channel_id=$3, updated_at=now() where discord_guild_id=$1 and ticket_id=$2`, [guildId, id, channelId]);
}
async function setTicketControlMessageId(pool: Queryable, guildId: string, id: string, messageId: string | undefined): Promise<Ticket | undefined> { const result = await pool.query<TicketRow>(`update tickets set control_message_id=$3, updated_at=now() where discord_guild_id=$1 and ticket_id=$2 returning *`, [guildId, id, messageId ?? null]); return result.rows[0] ? mapTicket(result.rows[0]) : undefined; }

async function claimTicketControlMessageId(pool: Queryable, guildId: string, id: string, expectedMessageId: string | undefined, candidateMessageId: string): Promise<boolean> {
  const result = await pool.query(
    `update tickets set control_message_id=$4, updated_at=now() where discord_guild_id=$1 and ticket_id=$2 and control_message_id is not distinct from $3`,
    [guildId, id, expectedMessageId ?? null, candidateMessageId]
  );
  return (result.rowCount ?? 0) === 1;
}

async function getTicket(pool: Queryable, guildId: string, id: string): Promise<Ticket | undefined> {
  const result = await pool.query<TicketRow>(`select * from tickets where discord_guild_id=$1 and ticket_id=$2`, [guildId, id]);
  return result.rows[0] ? mapTicket(result.rows[0]) : undefined;
}
async function getTicketByChannel(pool: Queryable, guildId: string, channelId: string): Promise<Ticket | undefined> { const result = await pool.query<TicketRow>(`select * from tickets where discord_guild_id=$1 and ticket_channel_id=$2 order by ticket_id desc limit 1`, [guildId, channelId]); return result.rows[0] ? mapTicket(result.rows[0]) : undefined; }
async function listOperationalTicketTargets(pool: Queryable, guildId: string): Promise<OperationalTicketTarget[]> { const result = await pool.query<OperationalTicketTargetRow>(`select t.ticket_id, c.name as ticket_name, t.opener_discord_user_id, t.ticket_channel_id, t.status, c.reviewer_role_id from tickets t join ticket_classes c on c.ticket_class_id=t.ticket_class_id and c.discord_guild_id=t.discord_guild_id where t.discord_guild_id=$1 and t.status <> 'deleted' order by t.ticket_id desc`, [guildId]); return result.rows.map((row) => ({ ticketId: row.ticket_id, ticketName: row.ticket_name, openerDiscordUserId: row.opener_discord_user_id, ticketChannelId: row.ticket_channel_id ?? undefined, status: row.status, reviewerRoleId: row.reviewer_role_id })); }

async function markTicketClosed(pool: Queryable, guildId: string, id: string, actor: string): Promise<Ticket | undefined> {
  const result = await pool.query<TicketRow>(`update tickets set status='closed', closed_at=now(), closed_by_discord_user_id=$3, updated_at=now() where discord_guild_id=$1 and ticket_id=$2 and status='open' returning *`, [guildId, id, actor]);
  return result.rows[0] ? mapTicket(result.rows[0]) : undefined;
}

async function markTicketReopened(pool: Queryable, guildId: string, id: string, actor: string): Promise<Ticket | undefined> {
  const result = await pool.query<TicketRow>(`update tickets set status='open', reopened_at=now(), reopened_by_discord_user_id=$3, updated_at=now() where discord_guild_id=$1 and ticket_id=$2 and status='closed' and access_revoked_at is null returning *`, [guildId, id, actor]);
  return result.rows[0] ? mapTicket(result.rows[0]) : undefined;
}

async function markTicketDeleted(pool: Queryable, guildId: string, id: string, actor: string): Promise<Ticket | undefined> {
  const result = await pool.query<TicketRow>(
    `update tickets
     set status='deleted',
       deleted_at=coalesce(deleted_at, now()),
       deleted_by_discord_user_id=coalesce(deleted_by_discord_user_id, $3),
       updated_at=now()
     where discord_guild_id=$1
       and ticket_id=$2
       and status in ('closed', 'deleted')
       and (status='closed' or deleted_by_discord_user_id is null)
     returning *`,
    [guildId, id, actor]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : undefined;
}

async function markTicketChannelDeleted(pool: Queryable, guildId: string, channelId: string): Promise<Ticket | undefined> {
  const result = await pool.query<TicketRow>(
    `
    update tickets
    set status = 'deleted',
      deleted_at = coalesce(deleted_at, now()),
      updated_at = now()
    where discord_guild_id = $1
      and ticket_channel_id = $2
      and status <> 'deleted'
    returning *
    `,
    [guildId, channelId]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : undefined;
}

interface TicketClassRow { ticket_class_id: string; discord_guild_id: string; name: string; ticket_category_id: string; reviewer_role_id: string; source_channel_id: string | null; source_message_id: string | null; button_label: string | null; button_style: TicketButtonStyle | null; initial_message: string | null; closed_message: string | null; enabled: boolean; created_by_discord_user_id: string; }
interface TicketRow { ticket_id: string; ticket_class_id: string; discord_guild_id: string; opener_discord_user_id: string; ticket_channel_id: string | null; control_message_id: string | null; status: TicketStatus; access_revoked_at?: Date | null; closed_at: Date | null; closed_by_discord_user_id: string | null; reopened_at: Date | null; reopened_by_discord_user_id: string | null; deleted_at: Date | null; deleted_by_discord_user_id: string | null; }
interface OperationalTicketTargetRow { ticket_id: string; ticket_name: string; opener_discord_user_id: string; ticket_channel_id: string | null; status: TicketStatus; reviewer_role_id: string; }

function mapTicketClass(row: TicketClassRow): TicketClass { return { ticketClassId: row.ticket_class_id, discordGuildId: row.discord_guild_id, name: row.name, ticketCategoryId: row.ticket_category_id, reviewerRoleId: row.reviewer_role_id, sourceChannelId: row.source_channel_id ?? undefined, sourceMessageId: row.source_message_id ?? undefined, buttonLabel: row.button_label ?? undefined, buttonStyle: row.button_style ?? undefined, initialMessage: row.initial_message ?? undefined, closedMessage: row.closed_message ?? undefined, enabled: row.enabled, createdByDiscordUserId: row.created_by_discord_user_id }; }
function mapTicket(row: TicketRow): Ticket { return { ticketId: row.ticket_id, ticketClassId: row.ticket_class_id, discordGuildId: row.discord_guild_id, openerDiscordUserId: row.opener_discord_user_id, ticketChannelId: row.ticket_channel_id ?? undefined, controlMessageId: row.control_message_id ?? undefined, status: row.status, ...(row.access_revoked_at ? { accessRevokedAt: row.access_revoked_at } : {}), closedAt: row.closed_at ?? undefined, closedByDiscordUserId: row.closed_by_discord_user_id ?? undefined, reopenedAt: row.reopened_at ?? undefined, reopenedByDiscordUserId: row.reopened_by_discord_user_id ?? undefined, deletedAt: row.deleted_at ?? undefined, deletedByDiscordUserId: row.deleted_by_discord_user_id ?? undefined }; }
