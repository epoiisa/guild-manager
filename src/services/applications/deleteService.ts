import { reconcileApplicationActiveRole } from "./activeRoleService.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { createApplicationRepository } from "../../db/applicationRepository.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
export type ApplicationDeleteResult = { kind: "deleted"; channelName: string; warnings?: MemberUpdateWarning[] } | { kind: "error"; title: string; description: string };

export async function deleteApplicationChannel(input: { guild: Guild; guildId: string; applicationId: string; actor: { userId: string; roleIds: ReadonlySet<string> }; applicationRepository: ApplicationRepository; channel?: TextChannel }): Promise<ApplicationDeleteResult> {
  const open = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  const application = open ? await input.applicationRepository.getApplicationClass(input.guildId, open.applicationClassId) : undefined;
  if (!open || !application) return error("Application Not Found", "That application is no longer available.");
  if (!input.actor.roleIds.has(application.reviewerRoleId)) return error("Reviewer Role Required", `Only members with <@&${application.reviewerRoleId}> can use this control.`);
  if (open.channelStatus !== "closed") return error("Close Channel First", "This application channel must be closed before it can be deleted.");
  if (!open.ticketChannelId) return error("Application Channel Unavailable", "The retained application channel is no longer available.");
  const channel = input.channel ?? input.guild.channels.cache.get(open.ticketChannelId) ?? await input.guild.channels.fetch(open.ticketChannelId).catch(() => undefined);
  if (channel?.type !== ChannelType.GuildText || (channel.id && channel.id !== open.ticketChannelId)) return error("Application Channel Unavailable", "The retained application channel is no longer available.");
  const channelName = channel.name ?? "Application channel";
  await channel.delete("Guild Manager application channel deleted");
  const deleted = await input.applicationRepository.markApplicationDeleted(input.guildId, input.applicationId, input.actor.userId);
  const current = deleted ?? await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  if (!current || current.channelStatus !== "deleted") throw new Error(`Application ${input.applicationId} channel was deleted without a matching deleted lifecycle state.`);
  const warnings = await reconcileApplicationActiveRole(input.guild, input.applicationRepository, application, open.applicantDiscordUserId);
  return { kind: "deleted", channelName, ...(warnings.length ? { warnings } : {}) };
}
function error(title: string, description: string): ApplicationDeleteResult { return { kind: "error", title, description }; }
