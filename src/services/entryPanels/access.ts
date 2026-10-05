import { MessageFlags, PermissionFlagsBits, type GuildMember, type NewsChannel, type TextChannel } from "discord.js";
import { INFO_COLOR } from "../../commands/configurationHelpers.js";
import { editFeedback, feedbackMessage, feedbackReply, type FeedbackWording } from "../../discord/feedbackMessages.js";
import { ENTRY_NAMES, type EntryFeature, type EntryInteraction, type EntryPanelContext, type EntryRole } from "./types.js";

export const ENTRY_MENTIONS = { parse: [] as never[], users: [], roles: [], repliedUser: false };
export function entryState(title: string, text: string, wording: FeedbackWording = "context", structured = false) {
  return feedbackMessage({ cards: [{ title, description: text, color: INFO_COLOR }], structured, allowedMentions: ENTRY_MENTIONS }, wording);
}
export async function replyEntryState(i: EntryInteraction, title: string, text: string, wording: FeedbackWording = "context", structured = false) {
  const options = { cards: [{ title, description: text, color: INFO_COLOR }], structured, allowedMentions: ENTRY_MENTIONS };
  if (i.deferred && !i.replied) await editFeedback(i, options, wording);
  else if (i.replied) await i.followUp(feedbackReply({ ...options, flags: MessageFlags.Ephemeral }, wording));
  else await i.reply(feedbackReply({ ...options, flags: MessageFlags.Ephemeral }, wording));
}
export function panelPermissions(feature: EntryFeature) {
  return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages,
    ...(feature === "accounts" ? [] : [PermissionFlagsBits.AttachFiles]),
    ...(feature === "giveaways" ? [PermissionFlagsBits.AddReactions, PermissionFlagsBits.ManageMessages] : [])];
}
export async function currentEntryMember(i: EntryInteraction): Promise<GuildMember | undefined> {
  if (!i.guild || !i.guildId || i.user.bot) return undefined;
  const member = await i.guild.members.fetch({ user: i.user.id, force: true }).catch(() => undefined);
  return member && !member.user.bot ? member : undefined;
}
export function createEntryPanelContext(deps: Pick<EntryPanelContext, "repository" | "runExclusive" | "refresh"> & {
  isGuildActive(guildId: string): Promise<boolean>;
  hasRegisteredCharacter(guildId: string, userId: string): Promise<boolean>;
  isCurrentPanel(feature: EntryFeature, guildId: string, channelId: string, messageId: string, generation: string): Promise<boolean>;
  captureFence(guildId: string): () => boolean;
}): EntryPanelContext {
  async function hasRole(guildId: string, kind: EntryRole, member: GuildMember) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const roles = await deps.repository.listRoles(guildId, kind);
    return roles.some(id => member.roles.cache.has(id));
  }
  return {
    repository: deps.repository, runExclusive: deps.runExclusive, refresh: deps.refresh, hasRole,
    async requireRole(i, kind) {
      const member = await currentEntryMember(i);
      if (member && await hasRole(i.guildId!, kind, member)) return true;
      await replyEntryState(i, "Accounts Manager Required", "You need an Accounts Manager role or Discord Administrator permission to use this action.");
      return false;
    },
    async checkAccess(i, feature, options = {}) {
      const again = async () => { await replyEntryState(i, "Start Again", "This control is no longer current. Open the latest entry panel and start again."); return undefined; };
      if (!i.guildId || !i.guild || i.user.bot) return again();
      const live = deps.captureFence(i.guildId);
      if (!live() || !await deps.isGuildActive(i.guildId)) return again();
      const config = await deps.repository.getChannel(i.guildId, feature);
      if (options.expected && (!config || config.discordChannelId !== options.expected.discordChannelId || config.configurationRevision !== options.expected.configurationRevision)) return again();
      if (options.generation && (!("message" in i) || !i.message || !await deps.isCurrentPanel(feature, i.guildId, i.channelId!, i.message.id, options.generation))) return again();
      if (!config) {
        await replyEntryState(i, `${ENTRY_NAMES[feature]} Channel Not Configured`, "Ask a Discord Administrator to configure this feature’s channel.");
        return undefined;
      }
      const [member, channel] = await Promise.all([currentEntryMember(i), i.guild.channels.fetch(config.discordChannelId).catch(() => null)]);
      if (!channel || (channel.type !== 0 && channel.type !== 5) || !channel.permissionsFor(i.guild.members.me ?? i.guild.client.user!.id)?.has(panelPermissions(feature))) {
        await replyEntryState(i, `${ENTRY_NAMES[feature]} Channel Unavailable`, "The configured channel is unavailable. Ask a Discord Administrator to check the channel setting.");
        return undefined;
      }
      if (!member || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) return again();
      if (feature === "giveaways" && !await deps.hasRegisteredCharacter(i.guildId, i.user.id)) {
        await replyEntryState(i, "Registration Required", "Register an Albion Online character in this Discord server to use giveaway controls.");
        return undefined;
      }
      if (options.mutation && (member.communicationDisabledUntilTimestamp ?? 0) > Date.now()) {
        await replyEntryState(i, "Action Unavailable", "You cannot use this action while timed out in this Discord server.");
        return undefined;
      }
      const latest = await deps.repository.getChannel(i.guildId, feature);
      if (!live() || latest?.configurationRevision !== config.configurationRevision || latest.discordChannelId !== config.discordChannelId) return again();
      return { ...config, channel: channel as TextChannel | NewsChannel, member };
    }
  };
}
