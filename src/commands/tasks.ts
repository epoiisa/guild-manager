import {
  AttachmentBuilder, ContainerBuilder, FileBuilder, MessageFlags, SlashCommandBuilder, TextDisplayBuilder,
  type ChatInputCommandInteraction
} from "discord.js";
import type { TaskApplication, TasksRepository, TasksSnapshot } from "../db/tasksRepository.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { formatLongDate, formatUtcTime } from "../services/regears/rendering.js";
import { REPORT_COLOR } from "./configurationHelpers.js";

const TEXT_LIMIT = 4_000;
const COMPONENT_LIMIT = 40;
const FULL_REPORTS = `### Full Reports
- Re-gear content: \`/regear content list\`
- Re-gear requests: \`/regear report\`
- Weapon specialisation requests: \`/specialisation requests\`

Open the linked channels for application and ticket details.`;

export const tasksCommand = new SlashCommandBuilder()
  .setName("tasks")
  .setDescription("Show open administrative tasks for this server.")
  .setDefaultMemberPermissions(0);

export async function handleTasksCommand(
  interaction: ChatInputCommandInteraction,
  tasksRepository: TasksRepository
): Promise<void> {
  if (!interaction.inGuild()) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const snapshot = await tasksRepository.getSnapshot(interaction.guildId);
  await interaction.editReply(buildTasksResponse(snapshot));
}

export function buildTasksResponse(snapshot: TasksSnapshot) {
  const queues = queueLines(snapshot);
  const heading = (index: number) => `${index === 0 ? "# Tasks\n" : ""}### ${queues[index]!.heading} (${queues[index]!.lines.length})`;
  const fullSections = queues.map((queue, index) => `${heading(index)}\n${queue.lines.length ? queue.lines.join("\n") : "None"}`);
  const overflow = fullSections.reduce((sum, section) => sum + section.length, FULL_REPORTS.length) > TEXT_LIMIT;
  const sections = overflow
    ? queues.map((queue, index) => `${heading(index)}\n${queue.lines.length ? "See tasks.md for all items in this queue." : "None"}`)
    : fullSections;
  // The budget includes every Text Display, including the title and final guidance.
  const textLength = sections.reduce((sum, section) => sum + section.length, FULL_REPORTS.length);
  const componentCount = 1 + sections.length + 1 + Number(overflow);
  if (textLength > TEXT_LIMIT || componentCount > COMPONENT_LIMIT) {
    throw new Error("Tasks report exceeds Discord's single-message component limits.");
  }
  const container = new ContainerBuilder().setAccentColor(REPORT_COLOR)
    .addTextDisplayComponents(...sections.map((section) => new TextDisplayBuilder().setContent(section)));
  const files: AttachmentBuilder[] = [];
  if (overflow) {
    files.push(new AttachmentBuilder(Buffer.from([...fullSections, FULL_REPORTS].join("\n\n"), "utf8"), { name: "tasks.md" }));
    container.addFileComponents(new FileBuilder().setURL("attachment://tasks.md"));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(FULL_REPORTS));
  return {
    components: [container], flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [] as never[], repliedUser: false }, files
  };
}

function queueLines(items: TasksSnapshot): Array<{ heading: string; lines: string[] }> {
  const guildId = items.discordGuildId;
  return [
    { heading: "Applications", lines: [...items.applications].sort((a, b) => compareTime(a.createdAt, b.createdAt, a.applicationId, b.applicationId))
      .map((item) => `- ${user(item.applicantDiscordUserId)} • ${linkedLabel(`${label(item.targetMemberGroupName ?? item.name)} Application`, guildId, item.ticketChannelId, undefined, "Channel unavailable")} • ${applicationState(item)}`) },
    { heading: "General Tickets", lines: [...items.tickets].sort((a, b) => compareTime(a.createdAt, b.createdAt, a.ticketId, b.ticketId))
      .map((item) => `- ${user(item.openerDiscordUserId)} • ${linkedLabel(label(item.name), guildId, item.ticketChannelId, undefined, "Channel unavailable")}`) },
    { heading: "Open Re-Geared Content", lines: [...items.regearContents].sort((a, b) =>
      compareId(a.contentDate, b.contentDate)
      || (a.contentAt?.getTime() ?? -Infinity) - (b.contentAt?.getTime() ?? -Infinity)
      || compareTime(a.createdAt, b.createdAt, a.regearContentId, b.regearContentId))
      .map((item) => `- ${linkedLabel(label(item.name), guildId, item.channelId, item.announcementMessageId, "Announcement message unavailable", true)} • ${getAlbionServerLabel(item.albionServer)} • Open • ${formatLongDate(item.contentDate)}${item.contentAt ? ` • ${compactUtcTime(item.contentAt)}` : ""}`) },
    { heading: "Pending Re-Gear Requests", lines: [...items.regears].sort((a, b) => compareTime(a.submittedAt, b.submittedAt, a.regearClaimId, b.regearClaimId))
      .map((item) => `- ${user(item.currentOwnerDiscordUserId, "No current owner")} • ${label(item.contentName)} ${formatLongDate(item.contentDate)}${item.contentAt ? ` ${compactUtcTime(item.contentAt)}` : ""} • ${linkedLabel(`${label(item.characterName)} • ${item.requestedValue.toLocaleString("en-US")}`, guildId, item.reviewChannelId, item.reviewMessageId, "Review message unavailable", true)}`) },
    { heading: "Pending Weapon Specialisation Requests", lines: [...items.specialisations].sort((a, b) => compareTime(a.createdAt, b.createdAt, a.specialisationRequestId, b.specialisationRequestId))
      .map((item) => `- ${user(item.currentOwnerDiscordUserId, "No current owner")} • ${linkedLabel(`${label(item.characterName)} • ${label(item.targetDisplayName)}`, guildId, item.reviewChannelId, item.reviewMessageId, "Review message unavailable", true)}`) }
  ];
}

function compareId(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function applicationState(item: TaskApplication): string {
  switch (item.status) {
    case "awaiting_ingame_membership": return "Waiting for in-game membership";
    case "accepted": return "Accepted";
    case "rejected": return "Rejected";
    case "withdrawn": return "Withdrawn";
    case "open": return {
      selected: "Waiting for reviewer decision",
      unresolved: "Character unresolved",
      not_listed: "Character not shown",
      registered_to_other_user: "Character registered to another user"
    }[item.characterResolutionState];
  }
}

function compareTime(a: Date, b: Date, aId: string, bId: string): number {
  return a.getTime() - b.getTime() || (aId < bId ? -1 : aId > bId ? 1 : 0);
}
function compactUtcTime(value: Date): string {
  return value.getUTCMinutes() === 0 ? `${value.getUTCHours()} UTC` : formatUtcTime(value);
}
function user(id: string | undefined, fallback = "None"): string { return id ? `<@${id}>` : fallback; }
function linkedLabel(text: string, guildId: string, channelId: string | undefined, messageId: string | undefined, fallback: string, requireMessage = false): string {
  return channelId && (!requireMessage || messageId)
    ? `[${text}](https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""})`
    : `${text} • ${fallback}`;
}
function label(value: string): string {
  const normalized = value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
  const characters = Array.from(normalized);
  const shortened = characters.length > 160 ? `${characters.slice(0, 159).join("")}…` : normalized;
  return (shortened || "None").replace(/</g, "‹").replace(/>/g, "›").replace(/@/g, "@\u200b").replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&");
}
