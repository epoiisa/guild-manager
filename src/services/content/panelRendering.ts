import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type InteractionReplyOptions,
  type MessageCreateOptions,
} from "discord.js";
import type { ContentPanelEntry } from "../../db/contentPanelRepository.js";
import { INFO_COLOR } from "../../commands/configurationHelpers.js";
import { getContentCleanupAt } from "./lifecycle.js";

export const CONTENT_PANEL_PREFIX = "content-panel:";
export const PANEL_TEXT_LIMIT = 3800;
export const PANEL_ALLOWED_MENTIONS = {
  parse: [] as never[],
  users: [] as string[],
  roles: [] as string[],
  repliedUser: false,
};
export function parseContentPanelId(id: string):
  | {
      generation: string;
      action: "unscheduled" | "scheduled" | "list" | "page";
      page?: number;
    }
  | undefined {
  const match =
    /^content-panel:([a-zA-Z0-9_-]{1,25}):(unscheduled|scheduled|list|page)(?::(\d+))?$/.exec(
      id,
    );
  if (!match || (match[2] === "page") !== (match[3] !== undefined))
    return undefined;
  return {
    generation: match[1]!,
    action: match[2] as "unscheduled" | "scheduled" | "list" | "page",
    ...(match[3] !== undefined ? { page: Number(match[3]) } : {}),
  };
}
export function renderContentPanelRows(
  entries: readonly ContentPanelEntry[],
  now = new Date(),
): string[] {
  const order = {
    unscheduled: 0,
    active: 1,
    scheduled: 2,
    ended: 3,
    cancelled: 4,
    archived: 5,
  };
  return entries
    .filter(
      ({ content: c }) => order[c.state] < 3 && getContentCleanupAt(c) > now,
    )
    .slice()
    .sort(
      (a, b) =>
        order[a.content.state] - order[b.content.state] ||
        (a.content.state === "active"
          ? (a.content.startedAt ?? a.content.createdAt)
          : (a.content.scheduledStartAt ?? a.content.createdAt)
        ).getTime() -
          (b.content.state === "active"
            ? (b.content.startedAt ?? b.content.createdAt)
            : (b.content.scheduledStartAt ?? b.content.createdAt)
          ).getTime() ||
        a.content.contentId.localeCompare(b.content.contentId),
    )
    .map(({ content: c, filledRoles, totalRoles, signedUpUsers = 0 }) => {
      const title = c.title
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[\\`*_{}\[\]()<>~|]/g, "\\$&");
      const url = `https://discord.com/channels/${c.discordGuildId}/${c.threadChannelId}${c.controlMessageId ? `/${c.controlMessageId}` : ""}`;
      const time =
        c.state === "active"
          ? c.startedAt
            ? `started <t:${Math.floor(c.startedAt.getTime() / 1000)}:R>`
            : "started • time unavailable"
          : c.state === "unscheduled" || !c.scheduledStartAt
            ? "unscheduled"
            : c.scheduledStartAt.getTime() - now.getTime() <= 86400000
              ? `<t:${Math.floor(c.scheduledStartAt.getTime() / 1000)}:R>`
              : `<t:${Math.floor(c.scheduledStartAt.getTime() / 1000)}:d> • <t:${Math.floor(c.scheduledStartAt.getTime() / 1000)}:t>`;
      const fraction =
        c.state === "scheduled" &&
        c.scheduledStartAt &&
        c.scheduledStartAt.getTime() - now.getTime() > 86400000
          ? ""
          : c.multiSignupEnabled ? ` • ${signedUpUsers} signed up` : ` • ${filledRoles}/${totalRoles}`;
      return `- [${title}](${url}) • ${time}${fraction} • <@${c.hostDiscordUserId}>`;
    });
}
function button(
  generation: string,
  action: string,
  label: string,
  style = ButtonStyle.Primary,
) {
  return new ButtonBuilder()
    .setCustomId(`${CONTENT_PANEL_PREFIX}${generation}:${action}`)
    .setLabel(label)
    .setStyle(style);
}
function container(text: string) {
  return new ContainerBuilder()
    .setAccentColor(INFO_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}
export function buildContentPanelMessage(
  entries: readonly ContentPanelEntry[],
  generation: string,
  now = new Date(),
) {
  const rows = renderContentPanelRows(entries, now);
  let shown = rows.length;
  const textFor = (count: number) =>
    `# Content\n\n${rows.length ? rows.slice(0, count).join("\n") : "No content is open for signups."}${count < rows.length ? `\n\n${rows.length - count} more parties.` : ""}`;
  while (shown && textFor(shown).length > PANEL_TEXT_LIMIT) shown--;
  const card = container(textFor(shown));
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(generation, "unscheduled", "Host Unscheduled"),
    button(generation, "scheduled", "Host Scheduled"),
  );
  if (shown < rows.length)
    controls.addComponents(
      button(generation, "list", "View All Content", ButtonStyle.Secondary),
    );
  card.addActionRowComponents(controls);
  const payload: MessageCreateOptions = {
    components: [card],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
    allowedMentions: PANEL_ALLOWED_MENTIONS,
  };
  return {
    payload,
    hash: createHash("sha256")
      .update(JSON.stringify(card.toJSON()))
      .digest("hex"),
    overflow: rows.length - shown,
  };
}
export function buildContentPanelListPage(
  entries: readonly ContentPanelEntry[],
  generation: string,
  requestedPage = 0,
  now = new Date(),
): InteractionReplyOptions {
  const rows = renderContentPanelRows(entries, now);
  const pages: string[][] = [[]];
  for (const row of rows) {
    if (row.length > PANEL_TEXT_LIMIT - 64)
      throw new Error("Content panel row exceeds page budget");
    if (pages.at(-1)!.join("\n").length + row.length + 65 > PANEL_TEXT_LIMIT)
      pages.push([]);
    pages.at(-1)!.push(row);
  }
  const page = Math.max(
    0,
    Math.min(
      Number.isSafeInteger(requestedPage) ? requestedPage : 0,
      pages.length - 1,
    ),
  );
  const card = container(
    `# Content • ${page + 1}/${pages.length}\n\n${pages[page]!.join("\n") || "No content is open for signups."}`,
  );
  if (pages.length > 1)
    card.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          generation,
          `page:${Math.max(0, page - 1)}`,
          "Previous",
          ButtonStyle.Secondary,
        ).setDisabled(page === 0),
        button(
          generation,
          `page:${Math.min(pages.length - 1, page + 1)}`,
          "Next",
          ButtonStyle.Secondary,
        ).setDisabled(page === pages.length - 1),
      ),
    );
  return {
    components: [card],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    allowedMentions: PANEL_ALLOWED_MENTIONS,
  };
}
