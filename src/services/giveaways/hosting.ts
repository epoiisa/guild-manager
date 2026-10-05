import { extname } from "node:path";
import { AttachmentBuilder, PermissionFlagsBits, type Attachment, type Guild, type GuildMember, type PermissionsBitField, type SendableChannels } from "discord.js";
import type { GiveawayRecord, createGiveawayRepository } from "../../db/giveawayRepository.js";
import type { Logger } from "../../logging/logger.js";
import { buildOpenGiveawayV2Message } from "./rendering.js";
import { GIVEAWAY_ENTRY_EMOJI } from "./service.js";

export type GiveawayChannel = SendableChannels & { permissionsFor(member: GuildMember): PermissionsBitField | null };

export class GiveawayPublicationError extends Error {
  constructor(readonly title: string, message: string) { super(message); }
}

export function giveawayPermissionProblem(channel: GiveawayChannel, botMember: GuildMember | null, needsAttachments: boolean): string | undefined {
  if (!botMember) return "Guild Manager could not resolve its server member permissions.";
  const permissions = channel.permissionsFor(botMember);
  const required: Array<[bigint, string]> = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.AddReactions, "Add Reactions"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"]
  ];
  if (needsAttachments) required.push([PermissionFlagsBits.AttachFiles, "Attach Files"]);
  const missing = required.filter(([permission]) => !permissions?.has(permission)).map(([, label]) => label);
  return missing.length ? `Guild Manager needs the following permissions in this channel: ${missing.map((label) => `**${label}**`).join(", ")}.` : undefined;
}

export function giveawayNotificationProblem(channel: GiveawayChannel, botMember: GuildMember | null, roleIsMentionable: boolean): string | undefined {
  if (roleIsMentionable || (botMember && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.MentionEveryone))) return undefined;
  return "The selected role is not mentionable, and Guild Manager does not have Mention Everyone permission in this channel. Make the role mentionable or update the channel permissions.";
}

/** Publication is shared by commands and panels. A receipt failure cannot remove a saved giveaway. */
export async function publishGiveaway(input: {
  guild: Guild;
  channel: GiveawayChannel;
  creatorDiscordUserId: string;
  title: string;
  description: string;
  drawAt: Date;
  winnerCount: number;
  image?: Pick<Attachment, "name" | "url" | "contentType">;
  notificationRoleId?: string;
  repository: ReturnType<typeof createGiveawayRepository>;
  logger: Logger;
  validate(): Promise<boolean>;
  now?: () => number;
}): Promise<{ giveaway: GiveawayRecord; messageUrl: string } | undefined> {
  const { guild, channel, repository, logger } = input;
  const now = input.now ?? Date.now;
  const requireFutureDraw = () => {
    if (!Number.isFinite(input.drawAt.getTime()) || input.drawAt.getTime() <= now()) {
      throw new GiveawayPublicationError("Invalid Draw Time", "Choose a future UTC draw time.");
    }
  };
  if (!input.title || input.title.length > 100 || !input.description || input.description.length > 4000) {
    throw new GiveawayPublicationError("Invalid Giveaway Details", "Provide a title up to 100 characters and a description up to 4,000 characters.");
  }
  requireFutureDraw();
  if (!Number.isInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > 5) {
    throw new GiveawayPublicationError("Invalid Draw Time", "Choose a future UTC draw time and between 1 and 5 winners.");
  }
  if (input.image && !input.image.contentType?.toLocaleLowerCase().startsWith("image/")) {
    throw new GiveawayPublicationError("Invalid Giveaway Image", "The giveaway attachment must be an image.");
  }
  if (giveawayPermissionProblem(channel, guild.members.me, Boolean(input.image))) {
    throw new GiveawayPublicationError("Giveaways Channel Unavailable", "The configured channel is unavailable. Ask a Discord Administrator to check the channel setting.");
  }
  if (input.notificationRoleId) {
    const role = await guild.roles.fetch(input.notificationRoleId, { force: true }).catch(() => undefined);
    if (!role) throw new GiveawayPublicationError("Giveaway Notification Role Not Found", "The selected Discord role no longer exists. Choose another notification role.");
    const problem = giveawayNotificationProblem(channel, guild.members.me, role.mentionable);
    if (problem) throw new GiveawayPublicationError("Giveaway Notification Unavailable", problem);
  }
  if (!await input.validate()) return undefined;
  requireFutureDraw();
  const imageAttachmentName = input.image ? `giveaway-image${extname(input.image.name).toLocaleLowerCase() || ".png"}` : undefined;
  const details = {
    creatorDiscordUserId: input.creatorDiscordUserId,
    title: input.title,
    description: input.description,
    drawAt: input.drawAt,
    winnerCount: input.winnerCount,
    imageAttachmentName,
    notificationRoleId: input.notificationRoleId
  };
  const payload = buildOpenGiveawayV2Message(details, [], true);
  const message = await channel.send({
    ...payload,
    files: [...payload.files ?? [], ...(input.image && imageAttachmentName ? [new AttachmentBuilder(input.image.url, { name: imageAttachmentName })] : [])]
  });
  try {
    await message.react(GIVEAWAY_ENTRY_EMOJI);
  } catch (error) {
    await message.delete().catch(() => undefined);
    logger.warn("giveaway seed reaction failed", { guildId: guild.id, channelId: channel.id, messageId: message.id, error: error instanceof Error ? error.message : String(error) });
    throw new GiveawayPublicationError("Giveaway Not Created", "Guild Manager could not add the gift reaction. Check Add Reactions permission and try again.");
  }
  let giveaway: GiveawayRecord;
  try {
    if (!await input.validate()) {
      await message.delete().catch(() => undefined);
      return undefined;
    }
    requireFutureDraw();
    giveaway = await repository.create({ ...details, discordGuildId: guild.id, channelId: channel.id, originalMessageId: message.id });
  } catch (error) {
    await message.delete().catch(() => undefined);
    throw error;
  }
  logger.info("giveaway created", { guildId: guild.id, giveawayId: giveaway.giveawayId, channelId: channel.id, messageId: message.id, creatorDiscordUserId: input.creatorDiscordUserId });
  return { giveaway, messageUrl: message.url };
}
