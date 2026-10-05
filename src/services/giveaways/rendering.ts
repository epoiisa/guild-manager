import { boundedV2Container } from "../../discord/operationalMessages.js";
import {
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type MessageCreateOptions
} from "discord.js";
import type { GiveawayRecord } from "../../db/giveawayRepository.js";
import { INFO_COLOR, SUCCESS_COLOR } from "../../commands/configurationHelpers.js";

const TEXT_DISPLAY_CONTENT_LIMIT = 4000;
const PUBLIC_DESCRIPTION_DISPLAY_LIMIT = 31;
const GIVEAWAY_ENTRY_INSTRUCTION = "React with 🎁 to enter!";

type PublicGiveawayView = Pick<
  GiveawayRecord,
  "creatorDiscordUserId" | "title" | "description" | "imageAttachmentName" | "notificationRoleId" | "winnerCount"
>;

export function buildOpenGiveawayV2Message(
  giveaway: PublicGiveawayView & Pick<GiveawayRecord, "drawAt">,
  participantDiscordUserIds: string[],
  notifyNotificationRole = false,
  existingImageUrl?: string
): MessageCreateOptions {
  const timestamp = Math.floor(giveaway.drawAt.getTime() / 1000);
  return buildGiveawayV2Message(
    giveaway,
    participantDiscordUserIds,
    [
      `**Draws**\n<t:${timestamp}:F> (<t:${timestamp}:R>)`,
      `**Winners**\n${giveaway.winnerCount}`
    ],
    formatNotificationRoleContent(GIVEAWAY_ENTRY_INSTRUCTION, giveaway.notificationRoleId),
    INFO_COLOR,
    notifyNotificationRole,
    existingImageUrl
  );
}

export function buildClosedGiveawayV2Message(
  giveaway: PublicGiveawayView,
  participantDiscordUserIds: string[],
  closure: { state: "drawn" | "cancelled"; at: Date },
  existingImageUrl?: string
): MessageCreateOptions {
  const timestamp = Math.floor(closure.at.getTime() / 1000);
  const drawn = closure.state === "drawn";
  return buildGiveawayV2Message(
    giveaway,
    participantDiscordUserIds,
    [
      `**${drawn ? "Drawn" : "Cancelled"}**\n<t:${timestamp}:F> (<t:${timestamp}:R>)`,
      `**Winners**\n${giveaway.winnerCount}`
    ],
    formatNotificationRoleContent(
      drawn
        ? "The giveaway is closed. Entries are no longer accepted."
        : "The giveaway is cancelled. Entries are no longer accepted.",
      giveaway.notificationRoleId
    ),
    drawn ? SUCCESS_COLOR : INFO_COLOR,
    false,
    existingImageUrl
  );
}

function buildGiveawayV2Message(
  giveaway: PublicGiveawayView,
  participantDiscordUserIds: string[],
  statusLines: string[],
  closingContent: string,
  accentColor: number,
  notifyNotificationRole: boolean,
  existingImageUrl?: string
): MessageCreateOptions {
  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Giveaway"),
      new TextDisplayBuilder().setContent(`## ${escapeMarkdown(giveaway.title)}`),
      ...buildTextDisplays(giveaway.description, PUBLIC_DESCRIPTION_DISPLAY_LIMIT)
    );

  if (giveaway.imageAttachmentName) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(existingImageUrl ?? `attachment://${giveaway.imageAttachmentName}`)
          .setDescription(giveaway.title)
      )
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Host**\n<@${giveaway.creatorDiscordUserId}>`),
    ...statusLines.map((line) => new TextDisplayBuilder().setContent(line)),
    ...buildParticipantTextDisplays(participantDiscordUserIds),
    new TextDisplayBuilder().setContent(closingContent)
  );

  return boundedV2Container(container, {
    overflowName: "giveaway.md", versioned: true,
    summaryText: ["# Giveaway", `## ${escapeMarkdown(giveaway.title)}`, `**Host**\n<@${giveaway.creatorDiscordUserId}>`, ...statusLines,
      `**Participants (${participantDiscordUserIds.length})**\nSee the complete response attached.`, closingContent],
    allowedMentions: notifyNotificationRole && giveaway.notificationRoleId
      ? { parse: [], roles: [giveaway.notificationRoleId], repliedUser: false }
      : { parse: [], repliedUser: false }
  });
}

function formatNotificationRoleContent(
  content: string,
  notificationRoleId?: string
): string {
  if (!notificationRoleId) return content;
  const roleMention = `<@&${notificationRoleId}>`;
  return `${roleMention} ${content}`;
}

function buildParticipantTextDisplays(
  participantDiscordUserIds: string[]
): TextDisplayBuilder[] {
  if (participantDiscordUserIds.length === 0) {
    return [new TextDisplayBuilder().setContent("**Participants (0)**\nNone")];
  }

  const mentions = participantDiscordUserIds.map((id) => `<@${id}>`);
  const chunks: string[] = [];
  let prefix = `**Participants (${mentions.length})**`;
  let current = prefix;
  for (const mention of mentions) {
    const next = `${current}${current === prefix ? "\n" : " "}${mention}`;
    if (next.length > TEXT_DISPLAY_CONTENT_LIMIT) {
      chunks.push(current);
      prefix = "**Participants (continued)**";
      current = `${prefix}\n${mention}`;
    } else {
      current = next;
    }
  }

  chunks.push(current);
  return chunks.map((content) => new TextDisplayBuilder().setContent(content));
}

export function buildDrawAnnouncement(
  giveaway: Pick<GiveawayRecord, "creatorDiscordUserId" | "title" | "drawAt" | "drawnAt">,
  winnerDiscordUserIds: string[],
  originalMessageUrl: string
): MessageCreateOptions {
  const timestamp = Math.floor((giveaway.drawnAt ?? giveaway.drawAt).getTime() / 1000);
  const winnerMentions = winnerDiscordUserIds.map((id) => `<@${id}>`);
  const notification = winnerDiscordUserIds.length === 0
    ? `<@${giveaway.creatorDiscordUserId}>, your giveaway has ended with no eligible winners.`
    : `🎉 Congratulations ${winnerMentions.join(" ")}! You are the ${winnerDiscordUserIds.length === 1 ? "winner" : "winners"} of <@${giveaway.creatorDiscordUserId}>’s giveaway!`;
  const container = new ContainerBuilder()
    .setAccentColor(SUCCESS_COLOR)
    .addTextDisplayComponents(
      ...[
        "# Giveaway Drawn",
        notification,
        `**Giveaway**\n[${escapeMarkdownLinkText(giveaway.title)}](${originalMessageUrl})`,
        `**Host**\n<@${giveaway.creatorDiscordUserId}>`,
        `**Drawn**\n<t:${timestamp}:F> (<t:${timestamp}:R>)`,
        `**${winnerDiscordUserIds.length === 1 ? "Winner" : "Winners"}**\n${winnerMentions.join(" ") || "No eligible winners."}`
      ].map((content) => new TextDisplayBuilder().setContent(content))
    );

  return boundedV2Container(container, {
    overflowName: "giveaway.md", versioned: true,
    allowedMentions: {
      parse: [],
      users: [...new Set([...winnerDiscordUserIds, giveaway.creatorDiscordUserId])],
      repliedUser: false
    }
  });
}

export function buildRedrawAnnouncement(
  giveaway: Pick<GiveawayRecord, "creatorDiscordUserId" | "title">,
  replacementDiscordUserId: string,
  updatedAt: Date,
  originalMessageUrl: string
): MessageCreateOptions {
  const timestamp = Math.floor(updatedAt.getTime() / 1000);
  const notification = `🎉 Congratulations <@${replacementDiscordUserId}>! You are the winner of <@${giveaway.creatorDiscordUserId}>’s giveaway!`;
  const container = new ContainerBuilder()
    .setAccentColor(SUCCESS_COLOR)
    .addTextDisplayComponents(
      ...[
        "# Giveaway Redrawn",
        notification,
        `**Giveaway**\n[${escapeMarkdownLinkText(giveaway.title)}](${originalMessageUrl})`,
        `**Replacement Winner**\n<@${replacementDiscordUserId}>`,
        `**Host**\n<@${giveaway.creatorDiscordUserId}>`,
        `**Updated**\n<t:${timestamp}:F> (<t:${timestamp}:R>)`
      ].map((line) => new TextDisplayBuilder().setContent(line))
    );
  return boundedV2Container(container, {
    overflowName: "giveaway.md", versioned: true,
    allowedMentions: {
      parse: [],
      users: [...new Set([replacementDiscordUserId, giveaway.creatorDiscordUserId])],
      repliedUser: false
    }
  });
}

export function buildGiveawayStatusEmbed(
  title: string,
  description: string,
  accentColor = INFO_COLOR
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(accentColor)
    .setTitle(title)
    .setDescription(description);
}

export function buildGiveawayCreatedEmbed(input: {
  title: string;
  creatorDiscordUserId: string;
  drawAt: Date;
  winnerCount: number;
  notificationRoleId?: string;
  messageUrl: string;
}): EmbedBuilder {
  const timestamp = Math.floor(input.drawAt.getTime() / 1000);
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("Giveaway Created")
    .addFields(
      {
        name: "Giveaway",
        value: `[${escapeMarkdownLinkText(input.title)}](${input.messageUrl})`
      },
      { name: "Host", value: `<@${input.creatorDiscordUserId}>` },
      { name: "Draws", value: `<t:${timestamp}:F> (<t:${timestamp}:R>)` },
      { name: "Winners", value: String(input.winnerCount) },
      { name: "Notification", value: input.notificationRoleId ? `<@&${input.notificationRoleId}>` : "None" }
    );
}

function buildTextDisplays(content: string, maximumDisplays: number): TextDisplayBuilder[] {
  const chunks = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const lineChunks: string[] = [];
      for (let offset = 0; offset < line.length; offset += TEXT_DISPLAY_CONTENT_LIMIT) {
        lineChunks.push(line.slice(offset, offset + TEXT_DISPLAY_CONTENT_LIMIT));
      }
      return lineChunks;
    });

  if (chunks.length === 0) return [new TextDisplayBuilder().setContent("None")];
  if (chunks.length <= maximumDisplays) {
    return chunks.map((chunk) => new TextDisplayBuilder().setContent(chunk));
  }

  const visibleChunks = chunks.slice(0, maximumDisplays - 1);
  const overflow = chunks.slice(maximumDisplays - 1).join("\n");
  return [
    ...visibleChunks.map((chunk) => new TextDisplayBuilder().setContent(chunk)),
    new TextDisplayBuilder().setContent(overflow)
  ];
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}
