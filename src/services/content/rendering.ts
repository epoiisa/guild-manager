import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import { createHash } from "node:crypto";
import { INFO_COLOR } from "../../commands/configurationHelpers.js";
import type { ContentItem, ContentSnapshot } from "../../db/contentRepository.js";
import { feedbackMessage } from "../../discord/feedbackMessages.js";
import { boundedV2Container } from "../../discord/operationalMessages.js";
import { canUnstartContent } from "./lifecycle.js";

export const CONTENT_CUSTOM_PREFIX = "content:";
export const CONTENT_MODAL_PREFIX = "content-modal:";
export const TEMPLATE_MODAL_PREFIX = "template-modal:";
export const STANDBY_SIGNUP_VALUE = "standby";
export const MAX_APPROVAL_ROLE_LENGTH = 1850;

export function approvalRoleValidationError(roleLabels: readonly string[], approvalRequired: boolean): string | undefined {
  return approvalRequired && roleLabels.some((label) => label.length > MAX_APPROVAL_ROLE_LENGTH)
    ? "Keep each role to 1,850 characters or fewer when host approval is required."
    : undefined;
}

const PARTY_LIST_PAGE_TEXT_LIMIT = 3800;
const NOTIFICATION_USER_LIMIT = 100;
// Leave room for the party title, event details and attachment guidance.
const NOTIFICATION_MENTION_TEXT_LIMIT = 2800;
const PARTY_LIST_FOOTER = "*Archived parties are not shown.*";
const UTC_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type ContentButtonAction = "join" | "standby" | "leave" | "start" | "unstart" | "end" | "edit" | "cancel" | "archive";

export interface ParsedContentButtonId {
  action: ContentButtonAction;
  contentId: string;
  startRevision?: string;
}

export interface ParsedSlotSelectId {
  contentId: string;
  targetUserId: string;
  hostAssignment?: boolean;
}

export interface ParsedContentModalId {
  action: "create" | "edit";
  contentId?: string;
  editId?: string;
  templateId?: string;
  scheduledStartAt?: Date | null;
  approvalRequired?: boolean;
  multiSignupEnabled?: boolean;
}

export interface ParsedTemplateModalId {
  action: "create" | "edit" | "capture";
  templateId?: string;
  contentId?: string;
}

interface PartyListSection {
  heading: string;
  lines: string[];
}

const PARTY_LIST_SECTIONS: ReadonlyArray<{
  state: ContentItem["state"];
  heading: string;
  newestFirst: boolean;
}> = [
  { state: "scheduled", heading: "Upcoming", newestFirst: false },
  { state: "unscheduled", heading: "Unscheduled", newestFirst: false },
  { state: "active", heading: "Started", newestFirst: false },
  { state: "ended", heading: "Ended", newestFirst: true },
  { state: "cancelled", heading: "Cancelled", newestFirst: true }
];

export function buildPartyListV2Messages(
  content: readonly ContentItem[],
  now = new Date()
): InteractionReplyOptions[] {
  const pages: PartyListSection[][] = [];
  let page: PartyListSection[] = [];
  let pageLength = 64 + PARTY_LIST_FOOTER.length;

  for (const definition of PARTY_LIST_SECTIONS) {
    const lines = content
      .filter((item) => item.state === definition.state)
      .sort((left, right) => comparePartyListItems(left, right, definition.newestFirst))
      .map((item) => renderPartyListLine(item, now));

    for (const line of lines.length > 0 ? lines : ["- None"]) {
      let section = page.at(-1)?.heading === definition.heading ? page.at(-1) : undefined;
      const addedLength = line.length + (section ? 1 : `## ${definition.heading}\n`.length);
      if (page.length > 0 && pageLength + addedLength > PARTY_LIST_PAGE_TEXT_LIMIT) {
        pages.push(page);
        page = [];
        pageLength = 64 + PARTY_LIST_FOOTER.length;
        section = undefined;
      }
      if (!section) {
        section = { heading: definition.heading, lines: [] };
        page.push(section);
      }
      section.lines.push(line);
      pageLength += addedLength;
    }
  }
  pages.push(page);

  return pages.map((sections, index) => {
    const heading = pages.length === 1 ? "# Parties" : `# Parties • ${index + 1}/${pages.length}`;
    const container = new ContainerBuilder()
      .setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(heading),
        ...sections.map((section) =>
          new TextDisplayBuilder().setContent(`## ${section.heading}\n${section.lines.join("\n")}`)
        ),
        new TextDisplayBuilder().setContent(PARTY_LIST_FOOTER)
      );
    return {
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      allowedMentions: { parse: [], repliedUser: false }
    };
  });
}

function comparePartyListItems(left: ContentItem, right: ContentItem, newestFirst: boolean): number {
  const timeOrder = (left.scheduledStartAt ?? left.startedAt ?? left.createdAt).getTime() - (right.scheduledStartAt ?? right.startedAt ?? right.createdAt).getTime();
  const order = timeOrder || left.contentId.localeCompare(right.contentId);
  return newestFirst ? -order : order;
}

function renderPartyListLine(content: ContentItem, now: Date): string {
  const title = escapeMarkdownLinkText(content.title.replace(/\s+/g, " ").trim());
  const threadUrl = `https://discord.com/channels/${content.discordGuildId}/${content.threadChannelId}`;
  if (!content.scheduledStartAt) return `- [${title}](${threadUrl}) • Unscheduled • <@${content.hostDiscordUserId}>`;
  return `- [${title}](${threadUrl}) • ${formatPartyListUtcDay(content.scheduledStartAt, now)} • ${formatPartyListUtcTime(content.scheduledStartAt)} • <@${content.hostDiscordUserId}>`;
}

function formatPartyListUtcDay(value: Date, now: Date): string {
  if (value.getUTCFullYear() === now.getUTCFullYear()
    && value.getUTCMonth() === now.getUTCMonth()
    && value.getUTCDate() === now.getUTCDate()) {
    return "Today";
  }
  return `${UTC_WEEKDAYS[value.getUTCDay()]} ${value.getUTCDate()} ${UTC_MONTHS[value.getUTCMonth()]}`;
}

function formatPartyListUtcTime(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

export function buildContentCreatedMessage(
  content: Pick<ContentItem, "title" | "scheduledStartAt">,
  announcementUrl: string
) {
  const title = escapeMarkdown(content.title.replace(/\s+/g, " ").trim()).replaceAll("[", "\\[").replaceAll("]", "\\]");
  const timestamp = content.scheduledStartAt ? toDiscordTimestamp(content.scheduledStartAt) : undefined;
  return {
    content: `Created [${title}](${announcementUrl}), ${timestamp ? `scheduled for ${timestamp.full} (${timestamp.relative})` : "unscheduled"}.`,
    flags: MessageFlags.SuppressEmbeds as const,
    allowedMentions: { parse: [] as never[], users: [], roles: [], repliedUser: false }
  };
}

export function buildContentAnnouncementV2Message(
  content: Pick<ContentItem, "title" | "description" | "scheduledStartAt"> & Partial<Pick<ContentItem, "contentId" | "state">>
): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(INFO_COLOR);
  if (!content.scheduledStartAt) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# UNSCHEDULED"));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${escapeMarkdown(content.title)}`));
  if (content.scheduledStartAt) {
    const timestamp = toDiscordTimestamp(content.scheduledStartAt);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${timestamp.full} (${timestamp.relative})`));
  }

  return boundedV2Container(container, { overflowName: "party.md", versioned: true });
}

export function buildContentDetailsV2Message(content: ContentItem, existingGraphicUrl?: string | null): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(INFO_COLOR);
  if (content.description) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.description));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Host** <@${content.hostDiscordUserId}>`));
  if (content.graphicAttachmentName && existingGraphicUrl !== null) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(existingGraphicUrl ?? `attachment://${content.graphicAttachmentName}`)
      )
    );
  }
  const actionRows = buildContentHostActionRows(content);
  if (actionRows.length > 0) container.addActionRowComponents(actionRows);
  return boundedV2Container(container, { overflowName: "party.md", versioned: true });
}

export function buildContentControlV2Message(snapshot: ContentSnapshot): MessageCreateOptions {
  const container = new ContainerBuilder().setAccentColor(INFO_COLOR);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("# Roles"),
    new TextDisplayBuilder({ content: renderControlRoleLines(snapshot).join("\n") })
  );
  const standby = getStandbyUserIds(snapshot);
  if (standby.length) container.addTextDisplayComponents(
    new TextDisplayBuilder({ content: `**Standby**\n${standby.map(user => `<@${user}>`).join(" ")}` })
  );
  const settings = [
    `**Host approval** ${snapshot.content.approvalRequired ? "Required" : "Not required"}`,
    `**Multi-signup** ${snapshot.content.multiSignupEnabled ? "On" : "Off"}`
  ];
  container.addTextDisplayComponents(...settings.map(text => new TextDisplayBuilder().setContent(text)));
  const actionRows = buildContentActionRows(snapshot);
  if (actionRows.length > 0) container.addActionRowComponents(actionRows);
  return boundedV2Container(container, { overflowName: "party.md", versioned: true, summaryText: ["# Roles", ...settings] });
}

export function buildContentRescheduleMessage(snapshot: ContentSnapshot, recipients = notificationUsers(snapshot)): MessageCreateOptions {
  validateRecipients(recipients);
  const users = notificationUsers(snapshot);
  if (!snapshot.content.scheduledStartAt) throw new Error("Unscheduled content cannot be rescheduled.");
  const timestamp = toDiscordTimestamp(snapshot.content.scheduledStartAt);
  const text = `${escapeMarkdown(snapshot.content.title)} rescheduled to ${timestamp.full} (${timestamp.relative}). FYI ${users.map(userId => `<@${userId}>`).join(" ")}`;
  if (users.length <= 5 && text.length <= 500 && !/[\r\n]/u.test(text)) {
    return feedbackMessage({ text, allowedMentions: { users: recipients, parse: [], repliedUser: false } });
  }
  const container = new ContainerBuilder()
    .setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder({ content: [
        "-# *Activity Details Updated*",
        `**${escapeMarkdown(snapshot.content.title)}**\n${timestamp.full} (${timestamp.relative})`,
        `FYI ${users.map((userId) => `<@${userId}>`).join(" ")}`
      ].join("\n\n") })
    );

  return boundedV2Container(container, {
    overflowName: "party-rescheduled.md", allowedMentions: { users: recipients, parse: [], repliedUser: false },
    summaryText: ["-# *Activity Details Updated*", `**${escapeMarkdown(snapshot.content.title)}**\n${timestamp.full} (${timestamp.relative})`,
      `FYI ${recipients.map(user => `<@${user}>`).join(" ")}`]
  });
}

export function buildContentCancellationMessage(snapshot: ContentSnapshot, recipients = notificationUsers(snapshot)): MessageCreateOptions {
  validateRecipients(recipients);
  const signedUpUserIds = notificationUsers(snapshot);
  const text = `Content cancelled.${signedUpUserIds.length ? ` ${signedUpUserIds.map(userId => `<@${userId}>`).join(" ")}` : ""}`;
  if (signedUpUserIds.length <= 5 && text.length <= 500) {
    return feedbackMessage({ text, actionRows: [buildArchiveActionRow(snapshot.content.contentId)], allowActionRows: true,
      allowedMentions: { users: recipients, parse: [], repliedUser: false } });
  }
  const container = new ContainerBuilder()
    .setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Content Cancelled")
    );

  if (signedUpUserIds.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder({ content: signedUpUserIds.map((userId) => `<@${userId}>`).join(" ") })
    );
  }

  container.addActionRowComponents(buildArchiveActionRow(snapshot.content.contentId));

  return boundedV2Container(container, { overflowName: "party-cancelled.md", allowedMentions: { users: recipients, parse: [], repliedUser: false } });
}

export function buildStartNotification(snapshot: ContentSnapshot, recipients = notificationUsers(snapshot).slice(0, NOTIFICATION_USER_LIMIT)): MessageCreateOptions {
  validateRecipients(recipients);
  const { content } = snapshot;
  if (!content.startedAt) throw new Error("A start notification requires the actual start time.");
  const timestamp = Math.floor(content.startedAt.getTime() / 1000);
  const attributed = !content.scheduledStartAt || content.startedAt < content.scheduledStartAt;
  const startLine = attributed
    ? `<@${content.startedByDiscordUserId ?? content.hostDiscordUserId}> started the content at <t:${timestamp}:t> (<t:${timestamp}:R>).`
    : `Content started at <t:${timestamp}:t> (<t:${timestamp}:R>).`;
  const threadUrl = `https://discord.com/channels/${content.discordGuildId}/${content.threadChannelId}`;
  const detailsUrl = content.detailsMessageId ? `${threadUrl}/${content.detailsMessageId}` : threadUrl;
  const rolesUrl = content.controlMessageId ? `${threadUrl}/${content.controlMessageId}` : threadUrl;
  const title = `# ${escapeMarkdown(content.title)}`;
  const links = `[Details](${detailsUrl}) • [Signups](${rolesUrl})`;
  const footer = `*Sign-ups are still active in the [pinned message](${rolesUrl}).*`;
  const container = new ContainerBuilder().setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder({ content: [title, startLine, links, ...renderRoleLines(snapshot), footer].join("\n") }));
  if (canUnstartContent(content)) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buildContentButtonId("unstart", content.contentId, content.startRevision!))
      .setLabel("Unstart").setStyle(ButtonStyle.Secondary)
  ));
  return boundedV2Container(container, {
    overflowName: "party-started.md",
    allowedMentions: { parse: [], users: recipients, repliedUser: false },
    summaryText: [title, startLine, links, ...(recipients.length ? [recipients.map(user => `<@${user}>`).join(" ")] : []), footer]
  });
}

export function buildContentUnstartedMessage(content: ContentItem): MessageCreateOptions {
  const text = `<@${content.hostDiscordUserId}> has unstarted the content. ${content.scheduledStartAt
    ? "Content will start again at the scheduled time."
    : "Content is waiting for the host to start it again."}`;
  return { ...feedbackMessage({ text }), flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications };
}

function notificationUsers(snapshot: ContentSnapshot): string[] {
  return [...new Set(snapshot.signups.map(signup => signup.discordUserId))];
}

function validateRecipients(users: readonly string[]): void {
  if (users.length > NOTIFICATION_USER_LIMIT) throw new Error("Use party notification batches for more than 100 recipients.");
}

/** Prepare every payload before any delivery claim or send. The full report stays
 * on the primary message; each recipient is allowlisted in exactly one batch. */
function notificationMessages(
  snapshot: ContentSnapshot,
  primary: (snapshot: ContentSnapshot, recipients: string[]) => MessageCreateOptions,
  event: string
): MessageCreateOptions[] {
  const groups: string[][] = [[]];
  let length = 0;
  for (const user of notificationUsers(snapshot)) {
    const size = `<@${user}> `.length;
    if (size > NOTIFICATION_MENTION_TEXT_LIMIT) throw new Error("A party notification recipient exceeds the text budget.");
    if (groups.at(-1)!.length === NOTIFICATION_USER_LIMIT || length + size > NOTIFICATION_MENTION_TEXT_LIMIT) {
      groups.push([]);
      length = 0;
    }
    groups.at(-1)!.push(user);
    length += size;
  }
  return groups.map((users, index) => {
    if (index === 0) return primary(snapshot, users);
    const text = `# ${escapeMarkdown(snapshot.content.title)}\n${event}\n${users.map(user => `<@${user}>`).join(" ")}`;
    return boundedV2Container(new ContainerBuilder().setAccentColor(INFO_COLOR)
      .addTextDisplayComponents(new TextDisplayBuilder({ content: text })), {
      overflowName: "party-notification.md", allowedMentions: { parse: [], users, repliedUser: false }
    });
  });
}

export function buildStartNotifications(snapshot: ContentSnapshot): MessageCreateOptions[] {
  return [buildStartNotification(snapshot)];
}

export function buildContentRescheduleMessages(snapshot: ContentSnapshot): MessageCreateOptions[] {
  if (!snapshot.content.scheduledStartAt) throw new Error("Unscheduled content cannot be rescheduled.");
  const time = toDiscordTimestamp(snapshot.content.scheduledStartAt);
  return notificationMessages(snapshot, buildContentRescheduleMessage, `Rescheduled to ${time.full} (${time.relative}).`);
}

export function buildContentCancellationMessages(snapshot: ContentSnapshot): MessageCreateOptions[] {
  return notificationMessages(snapshot, buildContentCancellationMessage, "Content cancelled.");
}

export function renderRoleLines(snapshot: ContentSnapshot): string[] {
  const signupBySlotId = roleSignupBySlotId(snapshot);
  const lines = snapshot.slots.map((slot) => {
    const users = signupBySlotId.get(slot.contentRoleSlotId) ?? [];
    return `${slot.slotIndex}. ${escapeMarkdown(slot.label)}${users.length ? ` ${users.map(user => `<@${user}>`).join(" ")}` : ""}`;
  });
  const standbyUserIds = getStandbyUserIds(snapshot);
  if (standbyUserIds.length > 0) {
    lines.push("**Standby**", standbyUserIds.map((userId) => `<@${userId}>`).join(" "));
  }
  return lines;
}

export function renderControlRoleLines(snapshot: ContentSnapshot): string[] {
  const signupBySlotId = roleSignupBySlotId(snapshot);
  return snapshot.slots.map((slot) => {
    const users = signupBySlotId.get(slot.contentRoleSlotId) ?? [];
    return `${slot.slotIndex}. ${escapeMarkdown(slot.label)}${users.length ? ` — ${users.map(user => `<@${user}>`).join(" ")}` : ""}`;
  });
}

export function buildContentActionRows(snapshot: Pick<ContentSnapshot, "content">): ActionRowBuilder<ButtonBuilder>[] {
  const contentId = snapshot.content.contentId;
  if (snapshot.content.state === "ended" || snapshot.content.state === "cancelled" || snapshot.content.state === "archived") {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("join", contentId))
      .setLabel("Join")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("standby", contentId))
      .setLabel("Standby")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("leave", contentId))
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary)
  );

  return [row];
}

function buildContentHostActionRows(content: Pick<ContentItem, "contentId" | "state">): ActionRowBuilder<ButtonBuilder>[] {
  if (content.state !== "scheduled" && content.state !== "unscheduled" && content.state !== "active") return [];
  const active = content.state === "active";
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildContentButtonId(active ? "end" : "start", content.contentId))
      .setLabel(active ? "End" : "Start")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("edit", content.contentId))
      .setLabel("Edit")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("cancel", content.contentId))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  )];
}

export function buildArchiveActionRow(contentId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildContentButtonId("archive", contentId))
      .setLabel("Archive")
      .setStyle(ButtonStyle.Secondary)
  );
}

/** The value retains the exact role shown when a private selector was opened. */
export function buildRoleSlotSelectValue(slot: ContentSnapshot["slots"][number]): string {
  const signature = createHash("sha256")
    .update(JSON.stringify([slot.contentRoleSlotId, slot.slotIndex, slot.label]))
    .digest("hex").slice(0, 16);
  return `${slot.contentRoleSlotId}~${signature}`;
}

export function buildRoleSlotSelectRows(
  snapshot: ContentSnapshot,
  targetUserId: string,
  hostAssignment = false
): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const occupiedSlotIds = new Set(
    snapshot.signups
      .filter((signup) => signup.signupType === "role" && signup.contentRoleSlotId !== null)
      .map((signup) => signup.contentRoleSlotId as string)
  );
  const currentSignup = snapshot.signups.find((signup) => signup.discordUserId === targetUserId);
  const options = snapshot.slots
    .filter((slot) => snapshot.content.multiSignupEnabled || !occupiedSlotIds.has(slot.contentRoleSlotId) || slot.contentRoleSlotId === currentSignup?.contentRoleSlotId)
    .map((slot) => ({
      label: `${slot.slotIndex}. ${slot.label}`.slice(0, 100),
      value: buildRoleSlotSelectValue(slot),
      default: slot.contentRoleSlotId === currentSignup?.contentRoleSlotId
    }));

  const optionGroups = Array.from(
    { length: Math.ceil(options.length / 25) },
    (_, index) => options.slice(index * 25, (index + 1) * 25)
  );

  return optionGroups.map((group, index) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(buildSlotSelectId(
          snapshot.content.contentId,
          targetUserId,
          optionGroups.length > 1 ? index + 1 : undefined,
          hostAssignment
        ))
        .setPlaceholder("Choose a role")
        .addOptions(group)
    )
  );
}

function roleSignupBySlotId(snapshot: ContentSnapshot): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const signup of snapshot.signups) {
    if (signup.signupType !== "role" || signup.contentRoleSlotId === null) continue;
    const users = groups.get(signup.contentRoleSlotId) ?? [];
    users.push(signup.discordUserId);
    groups.set(signup.contentRoleSlotId, users);
  }
  return groups;
}

function getStandbyUserIds(snapshot: ContentSnapshot): string[] {
  return snapshot.signups
    .filter((signup) => signup.signupType === "standby")
    .map((signup) => signup.discordUserId);
}

export function toDiscordTimestamp(date: Date): { full: string; relative: string } {
  const timestamp = Math.floor(date.getTime() / 1000);
  return {
    full: `<t:${timestamp}:F>`,
    relative: `<t:${timestamp}:R>`
  };
}

export function parseRoleLines(rolesText: string): string[] {
  return rolesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function buildContentButtonId(action: ContentButtonAction, contentId: string, startRevision?: string): string {
  return `${CONTENT_CUSTOM_PREFIX}${action}:${contentId}${startRevision ? `:${startRevision}` : ""}`;
}

export function parseContentButtonId(customId: string): ParsedContentButtonId | undefined {
  const [prefix, action, contentId, startRevision, extra] = customId.split(":");
  if (prefix !== "content" || !isContentButtonAction(action) || !contentId) return undefined;
  if (action === "unstart") {
    if (extra || !startRevision || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(startRevision)) return undefined;
    return { action, contentId, startRevision };
  }
  return { action, contentId };
}

export function buildSlotSelectId(contentId: string, targetUserId: string, page?: number, hostAssignment = false): string {
  return `${CONTENT_CUSTOM_PREFIX}slot:${contentId}:${targetUserId}${page ? `:${page}` : ""}${hostAssignment ? ":host" : ""}`;
}

export function parseSlotSelectId(customId: string): ParsedSlotSelectId | undefined {
  const [prefix, type, contentId, targetUserId] = customId.split(":");
  if (prefix !== "content" || type !== "slot" || !contentId || !targetUserId) return undefined;
  return { contentId, targetUserId, ...(customId.endsWith(":host") ? { hostAssignment: true } : {}) };
}

export function buildContentCreateModalId(templateId: string | undefined, scheduledStartAt: Date | null, approvalRequired = false, multiSignupEnabled = false): string {
  return `${CONTENT_MODAL_PREFIX}create:${templateId ?? "none"}:${scheduledStartAt?.toISOString() ?? "unscheduled"}${approvalRequired ? ":approval" : ""}${multiSignupEnabled ? ":multi" : ""}`;
}

export function buildContentEditModalId(contentId: string, editId?: string): string {
  return `${CONTENT_MODAL_PREFIX}edit:${contentId}${editId ? `:${editId}` : ""}`;
}

export function parseContentModalId(customId: string): ParsedContentModalId | undefined {
  if (!customId.startsWith(CONTENT_MODAL_PREFIX)) return undefined;
  const multiSignupEnabled = customId.endsWith(":multi");
  if (multiSignupEnabled) customId = customId.slice(0, -":multi".length);
  const approvalRequired = customId.endsWith(":approval");
  const parts = (approvalRequired ? customId.slice(0, -":approval".length) : customId).slice(CONTENT_MODAL_PREFIX.length).split(":");
  const approval = { ...(approvalRequired ? { approvalRequired: true } : {}), ...(multiSignupEnabled ? { multiSignupEnabled: true } : {}) };
  if (parts[0] === "edit" && parts[1]) {
    return { action: "edit", contentId: parts[1], editId: parts[2] };
  }
  if (parts[0] === "create" && parts[2]) {
    if (parts[2] === "unscheduled" && parts.length === 3) {
      return { action: "create", templateId: parts[1] === "none" ? undefined : parts[1], scheduledStartAt: null, ...approval };
    }
    const scheduledStartAt = new Date(parts.slice(2).join(":"));
    if (Number.isNaN(scheduledStartAt.getTime())) return undefined;
    return { action: "create", templateId: parts[1] === "none" ? undefined : parts[1], scheduledStartAt, ...approval };
  }
  return undefined;
}

export function buildTemplateModalId(action: "create"): string;
export function buildTemplateModalId(action: "edit", templateId: string): string;
export function buildTemplateModalId(action: "capture", contentId: string): string;
export function buildTemplateModalId(action: "create" | "edit" | "capture", id?: string): string {
  return `${TEMPLATE_MODAL_PREFIX}${action}${id ? `:${id}` : ""}`;
}

export function parseTemplateModalId(customId: string): ParsedTemplateModalId | undefined {
  if (!customId.startsWith(TEMPLATE_MODAL_PREFIX)) return undefined;
  const [action, id] = customId.slice(TEMPLATE_MODAL_PREFIX.length).split(":");
  if (action === "create") return { action };
  if (action === "edit" && id) return { action, templateId: id };
  if (action === "capture" && id) return { action, contentId: id };
  return undefined;
}

export function isContentComponentInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction
): boolean {
  return interaction.customId.startsWith(CONTENT_CUSTOM_PREFIX);
}

export function isContentModalSubmit(interaction: ModalSubmitInteraction): boolean {
  return interaction.customId.startsWith(CONTENT_MODAL_PREFIX);
}

export function isTemplateModalSubmit(interaction: ModalSubmitInteraction): boolean {
  return interaction.customId.startsWith(TEMPLATE_MODAL_PREFIX);
}

export function getInteractionChannelId(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
): string | undefined {
  return interaction.channelId ?? interaction.channel?.id;
}

function isContentButtonAction(action: string): action is ContentButtonAction {
  return ["join", "standby", "leave", "start", "unstart", "end", "edit", "cancel", "archive"].includes(action);
}
