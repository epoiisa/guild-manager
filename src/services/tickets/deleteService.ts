import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { createTicketRepository } from "../../db/ticketRepository.js";
import { withTicketOperationLock } from "./ticketOperationLock.js";
type TicketRepository = ReturnType<typeof createTicketRepository>;
export type TicketDeleteResult = { kind: "deleted"; channelName: string } | { kind: "error"; title: string; description: string };
export async function deleteTicketChannel(input: { guild: Guild; guildId: string; ticketId: string; actor: { userId: string; roleIds: ReadonlySet<string> }; ticketRepository: TicketRepository; channel?: TextChannel }): Promise<TicketDeleteResult> {
  return withTicketOperationLock(input.guildId, input.ticketId, () => deleteTicketChannelLocked(input));
}

async function deleteTicketChannelLocked(input: Parameters<typeof deleteTicketChannel>[0]): Promise<TicketDeleteResult> {
  const ticket = await input.ticketRepository.getTicket(input.guildId, input.ticketId);
  const ticketClass = ticket ? await input.ticketRepository.getTicketClass(input.guildId, ticket.ticketClassId) : undefined;
  if (!ticket || !ticketClass || ticket.status === "deleted") return error("Ticket Not Found", "That ticket is no longer available.");
  if (!input.actor.roleIds.has(ticketClass.reviewerRoleId)) return error("Reviewer Role Required", `Only members with <@&${ticketClass.reviewerRoleId}> can delete this ticket.`);
  if (ticket.status !== "closed") return error("Close Ticket First", "This ticket must be closed before it can be deleted.");
  if (!ticket.ticketChannelId) return error("Ticket Channel Unavailable", "The retained ticket channel is no longer available.");
  const channel = input.channel ?? input.guild.channels.cache.get(ticket.ticketChannelId) ?? await input.guild.channels.fetch(ticket.ticketChannelId).catch(() => undefined);
  if (channel?.type !== ChannelType.GuildText || (channel.id && channel.id !== ticket.ticketChannelId)) return error("Ticket Channel Unavailable", "The retained ticket channel is no longer available.");
  const channelName = channel.name ?? "Ticket channel";
  await channel.delete("Guild Manager general ticket deleted");
  const deleted = await input.ticketRepository.markTicketDeleted(input.guildId, ticket.ticketId, input.actor.userId);
  const current = deleted ?? await input.ticketRepository.getTicket(input.guildId, ticket.ticketId);
  if (!current || current.status !== "deleted") throw new Error(`Ticket ${input.ticketId} channel was deleted without a matching deleted lifecycle state.`);
  return { kind: "deleted", channelName };
}
function error(title: string, description: string): TicketDeleteResult { return { kind: "error", title, description }; }
