import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { setTicketConversationSendPermission } from "../../commands/ticketChannelPermissions.js";
import type { Ticket, TicketClass, createTicketRepository } from "../../db/ticketRepository.js";
import { withTicketOperationLock } from "./ticketOperationLock.js";

type TicketRepository = ReturnType<typeof createTicketRepository>;
export type TicketLifecycleAction = "close" | "reopen";
export type TicketLifecycleResult = { kind: "closed" | "reopened"; repaired: boolean } | { kind: "error"; title: string; description: string };
export type TicketPresentation = {
  renderClosed(ticket: Ticket, ticketClass: TicketClass, description: string): Promise<string | undefined>;
  renderOpen(ticket: Ticket, ticketClass: TicketClass, description: string): Promise<string | undefined>;
  retireCandidate(messageId: string): Promise<void>;
};

export async function runTicketLifecycleOperation(input: { action: TicketLifecycleAction; guild: Guild; guildId: string; ticketId: string; actor: { userId: string; roleIds: ReadonlySet<string> }; ticketRepository: TicketRepository; channel?: TextChannel; presentation: TicketPresentation }): Promise<TicketLifecycleResult> {
  return withTicketOperationLock(input.guildId, input.ticketId, () => runTicketLifecycleOperationLocked(input));
}

async function runTicketLifecycleOperationLocked(input: Parameters<typeof runTicketLifecycleOperation>[0]): Promise<TicketLifecycleResult> {
  const ticket = await input.ticketRepository.getTicket(input.guildId, input.ticketId);
  if (!ticket || ticket.status === "deleted") return error("Ticket Not Found", "Choose an active ticket.");
  if (input.action === "reopen" && ticket.accessRevokedAt) return error("Ticket Access Revoked", "This historical ticket cannot be reopened after its opener was kicked.");
  const ticketClass = await input.ticketRepository.getTicketClass(input.guildId, ticket.ticketClassId);
  if (!ticketClass) return error("Ticket Class Missing", "This ticket class no longer exists.");
  if (!ticket.ticketChannelId) return error("Ticket Channel Unavailable", "The retained ticket channel is no longer available.");
  const channel = input.channel ?? input.guild.channels.cache.get(ticket.ticketChannelId) ?? await input.guild.channels.fetch(ticket.ticketChannelId).catch(() => undefined);
  if (channel?.type !== ChannelType.GuildText || (channel.id && channel.id !== ticket.ticketChannelId)) return error("Ticket Channel Unavailable", "The retained ticket channel is no longer available.");
  const reviewer = input.actor.roleIds.has(ticketClass.reviewerRoleId);
  const opener = input.actor.userId === ticket.openerDiscordUserId;
  if (!reviewer && !opener) return error("Ticket Access Required", "Only the ticket opener or a configured reviewer can use this control.");
  if (input.action === "close") {
    if (ticket.status === "closed") {
      await setTicketConversationSendPermission(channel, ticket.openerDiscordUserId, ticketClass.reviewerRoleId, false);
      await renderAndClaimClosedControl(input, ticket, ticketClass, "This ticket is closed.");
      return { kind: "closed", repaired: true };
    }
    if (ticket.status !== "open") return error("Ticket Not Open", "This ticket is not open.");
    await setTicketConversationSendPermission(channel, ticket.openerDiscordUserId, ticketClass.reviewerRoleId, false);
    const closed = await input.ticketRepository.markTicketClosed(input.guildId, ticket.ticketId, input.actor.userId) ?? await input.ticketRepository.getTicket(input.guildId, ticket.ticketId);
    if (!closed || closed.status !== "closed") return error("Ticket Not Open", "This ticket is not open.");
    await renderAndClaimClosedControl(input, closed, ticketClass, `Ticket closed by <@${input.actor.userId}>.`);
    return { kind: "closed", repaired: false };
  }
  if (ticket.status === "open") {
    await setTicketConversationSendPermission(channel, ticket.openerDiscordUserId, ticketClass.reviewerRoleId, true);
    await renderAndClaimControl(input, ticket, ticketClass, "open", "This ticket is open.");
    return { kind: "reopened", repaired: true };
  }
  if (ticket.status !== "closed") return error("Ticket Not Closed", "This ticket cannot be reopened.");
  await setTicketConversationSendPermission(channel, ticket.openerDiscordUserId, ticketClass.reviewerRoleId, true);
  const reopened = await input.ticketRepository.markTicketReopened(input.guildId, ticket.ticketId, input.actor.userId) ?? await input.ticketRepository.getTicket(input.guildId, ticket.ticketId);
  if (!reopened || reopened.status !== "open") return error("Ticket Not Closed", "This ticket cannot be reopened.");
  await renderAndClaimControl(input, reopened, ticketClass, "open", `Ticket reopened by <@${input.actor.userId}>.`);
  return { kind: "reopened", repaired: false };
}

async function renderAndClaimClosedControl(
  input: Parameters<typeof runTicketLifecycleOperation>[0],
  ticket: Ticket,
  ticketClass: TicketClass,
  description: string
): Promise<void> {
  await renderAndClaimControl(input, ticket, ticketClass, "closed", description);
}

async function renderAndClaimControl(
  input: Parameters<typeof runTicketLifecycleOperation>[0],
  ticket: Ticket,
  ticketClass: TicketClass,
  state: "open" | "closed",
  description: string
): Promise<void> {
  const candidateMessageId = state === "closed"
    ? await input.presentation.renderClosed(ticket, ticketClass, description)
    : await input.presentation.renderOpen(ticket, ticketClass, description);
  if (!candidateMessageId) return;
  const expectedMessageId = ticket.controlMessageId;
  const claimed = await input.ticketRepository.claimTicketControlMessageId(
    input.guildId,
    ticket.ticketId,
    expectedMessageId,
    candidateMessageId
  );
  if (claimed && expectedMessageId && candidateMessageId !== expectedMessageId) {
    await input.presentation.retireCandidate(expectedMessageId);
  } else if (!claimed && candidateMessageId !== expectedMessageId) {
    const current = await input.ticketRepository.getTicket(input.guildId, ticket.ticketId);
    if (current?.controlMessageId !== candidateMessageId) {
      await input.presentation.retireCandidate(candidateMessageId);
    }
  }
}
function error(title: string, description: string): TicketLifecycleResult { return { kind: "error", title, description }; }
