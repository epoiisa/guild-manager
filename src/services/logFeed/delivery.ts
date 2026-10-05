import { ChannelType, MessageFlags, PermissionFlagsBits, type Guild, type TextChannel, type NewsChannel } from "discord.js";
import type { LogChannelRepository } from "../../db/logChannelRepository.js";
import type { Logger } from "../../logging/logger.js";

export type LogDeliveryResult = "sent" | "disabled" | "failed";
export interface LogChannelInspection {
  available: boolean;
  reason?: "missing_channel" | "wrong_guild" | "unsupported_channel" | "missing_permissions" | "lookup_failed";
  missingPermissions: string[];
  everyoneVisible: boolean | null;
}

const REQUIRED_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.SendMessages, "Send Messages"]
] as const;

export function createLogFeedService(repository: Pick<LogChannelRepository, "get">, logger: Logger) {
  // Only identifiers, stages and numeric service codes are logged: Discord errors can contain payloads.
  function warn(guildId: string, channelId: string | undefined, stage: string, error?: unknown) {
    const metadata: Record<string, unknown> = { discordGuildId: guildId, discordChannelId: channelId, stage };
    if (error && typeof error === "object") {
      for (const key of ["code", "status"] as const) {
        const value = (error as Record<string, unknown>)[key];
        if (typeof value === "number") metadata[key] = value;
      }
    }
    // Delivery remains best effort even if the runtime's logging sink fails.
    try { logger.warn("Log feed delivery unavailable.", metadata); } catch { /* no domain failure */ }
  }

  async function resolve(guild: Guild, channelId: string): Promise<{
    inspection: LogChannelInspection;
    channel?: TextChannel | NewsChannel;
  }> {
    const unavailable = (reason: LogChannelInspection["reason"]): { inspection: LogChannelInspection } => ({
      inspection: { available: false, reason, missingPermissions: [], everyoneVisible: null }
    });
    try {
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel) return unavailable("missing_channel");
      if (channel.guildId !== guild.id) return unavailable("wrong_guild");
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
        return unavailable("unsupported_channel");
      }
      const member = guild.members.me ?? await guild.members.fetchMe();
      const permissions = channel.permissionsFor(member);
      const missingPermissions = REQUIRED_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, label]) => label);
      const everyonePermissions = channel.permissionsFor(guild.roles.everyone);
      return {
        channel,
        inspection: {
          available: missingPermissions.length === 0,
          ...(missingPermissions.length ? { reason: "missing_permissions" as const } : {}),
          missingPermissions,
          everyoneVisible: everyonePermissions ? everyonePermissions.has(PermissionFlagsBits.ViewChannel) : null
        }
      };
    } catch (error) {
      warn(guild.id, channelId, "inspection", error);
      return unavailable("lookup_failed");
    }
  }

  return {
    async inspect(guild: Guild, channelId: string): Promise<LogChannelInspection> {
      return (await resolve(guild, channelId)).inspection;
    },
    async send(guild: Guild, lines: readonly string[], options: { channelId?: string } = {}): Promise<LogDeliveryResult> {
      if (!lines.length || !lines.join("\n").trim()) return "disabled";
      let channelId = options.channelId;
      let stage = "configuration";
      try {
        if (channelId === undefined) {
          const configuration = await repository.get(guild.id);
          if (!configuration) return "disabled";
          if (configuration.discordGuildId !== guild.id) {
            warn(guild.id, undefined, "configuration_tenant_mismatch");
            return "failed";
          }
          channelId = configuration.discordChannelId;
        }
        stage = "destination";
        const { channel, inspection } = await resolve(guild, channelId);
        if (!channel || !inspection.available) {
          warn(guild.id, channelId, inspection.reason ?? stage);
          return "failed";
        }
        stage = "send";
        for (const content of splitLogFeedText(lines)) {
          await channel.send({
            content,
            flags: MessageFlags.SuppressEmbeds,
            allowedMentions: { parse: [], repliedUser: false }
          });
        }
        return "sent";
      } catch (error) {
        warn(guild.id, channelId, stage, error);
        return "failed";
      }
    }
  };
}

export type LogFeedService = ReturnType<typeof createLogFeedService>;

/** Lossless ordered text, with no broken Unicode, mentions or timestamp tokens. */
export function splitLogFeedText(lines: readonly string[]): string[] {
  let remaining = lines.join("\n");
  const messages: string[] = [];
  while (remaining.length) {
    let end = Math.min(2_000, remaining.length);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf("\n", end - 1);
      if (newline >= 0 && remaining.slice(0, newline + 1).trim()) end = newline + 1;
      const mentionStart = remaining.lastIndexOf("<", end - 1);
      const mentionEnd = remaining.indexOf(">", mentionStart);
      if (mentionStart > 0 && mentionEnd >= end && /^<(?:(?:@!?|@&|#)\d+|t:\d+:F)>$/.test(remaining.slice(mentionStart, mentionEnd + 1))) {
        end = mentionStart;
      }
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    messages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return messages;
}
