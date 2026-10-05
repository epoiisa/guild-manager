import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import { INFO_COLOR, INVALID_COLOR, REPORT_COLOR, SUCCESS_COLOR } from "../../commands/configurationHelpers.js";
import type { RegearClaim, RegearContent } from "../../db/regearRepository.js";
import { feedbackMessage } from "../../discord/feedbackMessages.js";
import { getAlbionServerLabel } from "../albion/servers.js";

export interface PendingRegearEvidence {
  attachmentIds: [string, string];
  attachmentUrls: [string, string];
}

export function buildRegearContentAnnouncement(content: RegearContent): MessageCreateOptions & MessageEditOptions {
  const summary = [
    getAlbionServerLabel(content.albionServer),
    formatLongDateWithWeekday(content.contentDate),
    ...(content.contentAt ? [formatCompactUtcTime(content.contentAt)] : []),
    titleCase(content.state)
  ].join(" • ");
  const lines = [
    "**Re-Geared Content**",
    `# ${sanitizeUserText(content.name)}`,
    summary
  ];
  const container = new ContainerBuilder()
    .setAccentColor(content.state === "open" ? INFO_COLOR : INVALID_COLOR)
    .addTextDisplayComponents(...lines.map((line) => new TextDisplayBuilder().setContent(line)));
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false }
  };
}

export function buildPendingRegearReview(
  claim: Pick<RegearClaim,
    | "regearClaimId"
    | "currentOwnerDiscordUserId"
    | "characterName"
    | "albionServer"
    | "contentName"
    | "contentDate"
    | "contentAt"
    | "requestedValue">,
  evidenceUrls: [string, string],
  disabled = false,
  reviewerRoleIds: readonly string[] = []
): MessageCreateOptions & MessageEditOptions {
  const owner = claim.currentOwnerDiscordUserId ? `<@${claim.currentOwnerDiscordUserId}>` : "No current eligible owner";
  const reviewers = [...new Set(reviewerRoleIds)].sort().map((roleId) => `<@&${roleId}>`).join(" ") || "None configured";
  const container = new ContainerBuilder()
    .setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent([
        "# Re-gear Request",
        `- **Owner** ${owner}`,
        `- **Content** ${formatClaimContent(claim)}`,
        `- **Character** ${sanitizeUserText(claim.characterName)} • ${getAlbionServerLabel(claim.albionServer)}`,
        `- **Requested** ${formatSilver(claim.requestedValue)}`,
        `- **Managers** ${reviewers}`
      ].join("\n"))
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(evidenceUrls[0]).setDescription("Screenshot/Evidence 1"),
        new MediaGalleryItemBuilder().setURL(evidenceUrls[1]).setDescription("Screenshot/Evidence 2")
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`regear:withdraw:${claim.regearClaimId}`).setLabel("Withdraw").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`regear:accept:${claim.regearClaimId}`).setLabel("Accept").setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`regear:reject:${claim.regearClaimId}`).setLabel("Reject").setStyle(ButtonStyle.Danger).setDisabled(disabled)
      )
    );
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false }
  };
}

export function buildPendingRegearReviewEdit(
  claim: Parameters<typeof buildPendingRegearReview>[0],
  evidence: PendingRegearEvidence,
  disabled = false,
  reviewerRoleIds: readonly string[] = []
): MessageEditOptions {
  return {
    // attachment:// resolves filenames, not IDs. Reuse the fetched message's
    // image URLs and separately retain its backing attachments by ID.
    ...buildPendingRegearReview(claim, evidence.attachmentUrls, disabled, reviewerRoleIds),
    attachments: evidence.attachmentIds.map((id) => ({ id }))
  };
}

/**
 * Returns the canonical Pending evidence in Evidence 1 / Evidence 2 order.
 * Components V2 media uploads are reported in the gallery item's API media
 * metadata, not necessarily in Message#attachments.
 */
export function inspectPendingRegearEvidence(message: Pick<Message, "components" | "attachments">): PendingRegearEvidence | undefined {
  const galleries = findMediaGalleries(message.components);
  if (galleries.length === 1) {
    const items = galleries[0].items;
    if (items.length === 2
      && items[0].description === "Screenshot/Evidence 1"
      && items[1].description === "Screenshot/Evidence 2") {
      const evidence = items.map((item) => {
        const media = "data" in item.media ? item.media.data : item.media;
        return {
          id: normalizePendingEvidenceAttachmentId(media),
          url: media.url,
          contentType: media.content_type
        };
      });
      if (evidence.every((item) => Boolean(item.id?.trim()) && Boolean(item.url?.trim()) && item.contentType?.toLocaleLowerCase().startsWith("image/"))
        && evidence[0].id !== evidence[1].id) {
        return {
          attachmentIds: [evidence[0].id!, evidence[1].id!],
          attachmentUrls: [evidence[0].url!, evidence[1].url!]
        };
      }
    }
  }

  // Compatibility for the short-lived detached cards made before gallery
  // attachment IDs were retained. This is deliberately narrow.
  const attachments = [...message.attachments.values()]
    .filter((attachment) => /^regear-evidence-[12]\.[a-z0-9]+$/i.test(attachment.name ?? "")
      && Boolean(attachment.id?.trim())
      && Boolean(attachment.url?.trim())
      && attachment.contentType?.toLocaleLowerCase().startsWith("image/"));
  const first = attachments.find((attachment) => /^regear-evidence-1\./i.test(attachment.name ?? ""));
  const second = attachments.find((attachment) => /^regear-evidence-2\./i.test(attachment.name ?? ""));
  if (!first || !second || first.id === second.id || attachments.length !== 2) return undefined;
  return { attachmentIds: [first.id, second.id], attachmentUrls: [first.url, second.url] };
}

interface PendingEvidenceGallery {
  items: Array<{
    description: string | null;
    media: PendingEvidenceMedia | { data: PendingEvidenceMedia };
  }>;
}

interface PendingEvidenceMedia {
  attachment_id?: string;
  id?: string;
  url?: string;
  content_type?: string | null;
}

function normalizePendingEvidenceAttachmentId(media: PendingEvidenceMedia): string | undefined {
  return media.attachment_id?.trim() || media.id?.trim() || undefined;
}

function findMediaGalleries(components: readonly { components?: readonly unknown[]; items?: unknown[]; type?: number }[]): PendingEvidenceGallery[] {
  const found: PendingEvidenceGallery[] = [];
  for (const component of components) {
    if (component.type === 12 && Array.isArray(component.items)) found.push(component as never);
    if (Array.isArray(component.components)) found.push(...findMediaGalleries(component.components as never));
  }
  return found;
}

export function buildAcceptedRegearOutcome(claim: RegearClaim): MessageCreateOptions {
  const ownerLine = claim.currentOwnerDiscordUserId
    ? `<@${claim.currentOwnerDiscordUserId}>, your re-gear request has been accepted.`
    : `${sanitizeUserText(claim.characterName)}'s re-gear request has been accepted.`;
  const adjusted = claim.acceptedValue !== undefined && claim.acceptedValue !== claim.requestedValue;
  const amount = adjusted
    ? `${formatSilver(claim.requestedValue)} → ${formatSilver(claim.acceptedValue!)}`
    : formatSilver(claim.acceptedValue ?? claim.requestedValue);
  const reason = claim.acceptanceReason?.trim();
  const lines = [
    ownerLine,
    `- **Content** ${formatClaimContent(claim)}`,
    `- **Character** ${sanitizeUserText(claim.characterName)}`,
    `- **Amount** ${amount}`,
    `- **Reviewer** ${claim.acceptedByDiscordUserId ? `<@${claim.acceptedByDiscordUserId}>` : "Unknown"}`
  ];
  return {
    components: [new ContainerBuilder()
      .setAccentColor(SUCCESS_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n")),
        ...(reason ? [new TextDisplayBuilder().setContent(`**notes**\n${sanitizeUserText(reason)}`)] : [])
      )],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: {
      parse: [],
      users: [...new Set([claim.currentOwnerDiscordUserId, claim.acceptedByDiscordUserId].filter((id): id is string => Boolean(id)))],
      repliedUser: false
    }
  };
}

export function buildRejectedRegearOutcome(
  claim: RegearClaim,
  reviewerDiscordUserId: string,
  reason?: string
): MessageCreateOptions {
  const ownerLine = claim.currentOwnerDiscordUserId
    ? `<@${claim.currentOwnerDiscordUserId}>, your re-gear request was rejected.`
    : `${sanitizeUserText(claim.characterName)}'s re-gear request was rejected.`;
  const notes = reason?.trim();
  const lines = [
    ownerLine,
    `- **Content** ${formatClaimContent(claim)}`,
    `- **Character** ${sanitizeUserText(claim.characterName)}`,
    `- **Requested** ${formatSilver(claim.requestedValue)}`,
    `- **Reviewer** <@${reviewerDiscordUserId}>`
  ];
  return {
    components: [new ContainerBuilder()
      .setAccentColor(INVALID_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n")),
        ...(notes ? [new TextDisplayBuilder().setContent(`**Notes**\n${sanitizeUserText(notes)}`)] : [])
      )],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: {
      parse: [],
      users: [...new Set([claim.currentOwnerDiscordUserId, reviewerDiscordUserId].filter((id): id is string => Boolean(id)))],
      repliedUser: false
    }
  };
}

export function buildEvidenceDeletedNotification(claim: RegearClaim): MessageCreateOptions {
  const prefix = claim.currentOwnerDiscordUserId ? `<@${claim.currentOwnerDiscordUserId}>, ` : "";
  const content = `${prefix}${sanitizeUserText(claim.characterName)}'s ${formatSilver(claim.requestedValue)} re-gear request for ${sanitizeUserText(claim.contentName)} on ${formatAustralianShortDate(claim.contentDate)} was removed because its review evidence was deleted. Use \`/regearme\` to submit it again.`;
  return feedbackMessage({
    text: content,
    accentColor: INVALID_COLOR,
    allowedMentions: claim.currentOwnerDiscordUserId
      ? { parse: [], users: [claim.currentOwnerDiscordUserId], repliedUser: false }
      : { parse: [], repliedUser: false }
  });
}

export function buildRegearStatusEmbed(title: string, description: string, color = INFO_COLOR): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

export function buildRegearHistoryEmbed(claims: RegearClaim[], page: number, pageCount: number): EmbedBuilder {
  const lines = claims.map((claim) => {
    const amount = claim.status === "accepted" && claim.acceptedValue !== undefined
      ? claim.acceptedValue === claim.requestedValue
        ? `${formatSilver(claim.acceptedValue)} • Credited to account`
        : `${formatSilver(claim.requestedValue)} → ${formatSilver(claim.acceptedValue)} • Credited to account`
      : `${formatSilver(claim.requestedValue)} • Pending requested value`;
    const link = claim.status === "accepted" && claim.outcomeMessageId && claim.outcomeChannelId
      ? ` • [Message](${discordMessageUrl(claim.discordGuildId, claim.outcomeChannelId, claim.outcomeMessageId)})`
      : claim.status === "pending"
        ? ` • [Message](${discordMessageUrl(claim.discordGuildId, claim.reviewChannelId, claim.reviewMessageId)})`
        : "";
    return `**${sanitizeUserText(claim.characterName)} • ${getAlbionServerLabel(claim.albionServer)}**\n${sanitizeUserText(claim.contentName)} • ${formatAustralianShortDate(claim.contentDate)} • ${amount} • ${titleCase(claim.status)}${link}`;
  });
  return new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle("Re-Gears")
    .setDescription(lines.join("\n\n") || "No Pending or Accepted re-gear requests were found.")
    .setFooter({ text: `Page ${page + 1} of ${pageCount}` });
}

export function discordMessageUrl(discordGuildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${discordGuildId}/${channelId}/${messageId}`;
}

export function formatSilver(value: bigint): string {
  return value.toLocaleString("en-AU");
}

export function formatAustralianShortDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `${day}/${month}/${String(year).slice(-2)}`;
}

export function formatLongDate(value: string): string {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

export function formatLongDateWithWeekday(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  const weekday = date.toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "long" });
  return `${weekday}, ${formatLongDate(value)}`;
}

export function formatUtcTime(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function formatClaimContent(claim: Pick<RegearClaim, "contentName" | "contentDate" | "contentAt">): string {
  return `${sanitizeUserText(claim.contentName)} • ${formatLongDate(claim.contentDate)}${claim.contentAt ? ` • ${formatUtcTime(claim.contentAt)}` : ""}`;
}

export function sanitizeUserText(value: string): string {
  return escapeMarkdown(value).replaceAll("@", "@\u200b");
}

function formatCompactUtcTime(value: Date): string {
  const hour = String(value.getUTCHours()).padStart(2, "0");
  const minute = value.getUTCMinutes();
  return minute === 0 ? `${hour} UTC` : `${hour}:${String(minute).padStart(2, "0")} UTC`;
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}
