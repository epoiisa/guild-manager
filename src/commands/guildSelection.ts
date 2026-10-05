import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import { getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import type { AlbionGuild, AlbionSearchGuild } from "../services/albion/types.js";
import { INFO_COLOR, INVALID_COLOR } from "./configurationHelpers.js";

export const GUILD_SEARCH_LIMIT = 10;

const GUILD_LOOKUP_SELECTION_PREFIX = "albion-guild:lookup:";

export interface ParsedGuildLookupSelectionId {
  requesterDiscordUserId: string;
  server: AlbionServer;
}

export function buildGuildLookupResultsEmbed(
  server: AlbionServer,
  query: string,
  guilds: AlbionSearchGuild[]
): EmbedBuilder {
  if (guilds.length === 0) {
    return new EmbedBuilder()
      .setColor(INVALID_COLOR)
      .setTitle("No Guild Found")
      .setDescription(`No Albion Online guilds found for \`${neutralizeInlineCode(query)}\` on ${getAlbionServerLabel(server)}.`);
  }

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Guild Matches")
    .setDescription(guilds.map((guild, index) => `${index + 1}. ${formatGuildSummary(guild)}`).join("\n"))
    .setFooter({ text: "Select a guild to view details." });
}

export function buildGuildLookupSelectRow(
  requesterDiscordUserId: string,
  server: AlbionServer,
  guilds: AlbionSearchGuild[]
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildGuildLookupSelectionCustomId(requesterDiscordUserId, server))
      .setPlaceholder("Choose a guild")
      .addOptions(guilds.map((guild) => ({
        label: truncateSelectText(guild.name),
        description: formatGuildSelectDescription(guild),
        value: guild.id
      })))
  );
}

export function buildGuildLookupDetailsEmbed(server: AlbionServer, guild: AlbionGuild): EmbedBuilder {
  const fields = [
    { name: "Server", value: getAlbionServerLabel(server), inline: true },
    { name: "Members", value: guild.memberCount === undefined ? "—" : guild.memberCount.toLocaleString("en-US"), inline: true },
    { name: "Founder", value: optionalDisplayValue(guild.founderName) ?? "—", inline: true },
    { name: "Founded", value: formatFounded(guild.founded), inline: true }
  ];

  if (hasAllianceData(guild)) {
    fields.push(
      { name: "Alliance", value: optionalDisplayValue(guild.allianceName) ?? "—", inline: true },
      { name: "Alliance Tag", value: optionalDisplayValue(guild.allianceTag) ?? "—", inline: true },
      { name: "Alliance ID", value: fencedCode(guild.allianceId) ?? "—", inline: false }
    );
  }

  fields.push({ name: "Guild ID", value: fencedCode(guild.id)!, inline: false });

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(guild.name)
    .addFields(fields);
}

export function parseGuildLookupSelectionCustomId(customId: string): ParsedGuildLookupSelectionId | undefined {
  if (!customId.startsWith(GUILD_LOOKUP_SELECTION_PREFIX)) {
    return undefined;
  }

  const [requesterDiscordUserId, server, ...extra] = customId.slice(GUILD_LOOKUP_SELECTION_PREFIX.length).split(":");
  if (!requesterDiscordUserId || !server || extra.length > 0 || !isAlbionServer(server)) {
    return undefined;
  }

  return { requesterDiscordUserId, server };
}

function buildGuildLookupSelectionCustomId(requesterDiscordUserId: string, server: AlbionServer): string {
  return `${GUILD_LOOKUP_SELECTION_PREFIX}${requesterDiscordUserId}:${server}`;
}

function formatGuildSummary(guild: AlbionSearchGuild): string {
  return [guild.name, formatAlliance(guild), `\`${neutralizeInlineCode(guild.id)}\``]
    .filter((value) => value !== undefined)
    .join(" • ");
}

function formatGuildSelectDescription(guild: AlbionSearchGuild): string {
  const alliance = formatAlliance(guild);
  if (!alliance) return truncateSelectText(guild.id);

  const description = `${alliance} • ${guild.id}`;
  if (description.length <= 100) return description;

  const allianceLimit = 100 - guild.id.length - 3;
  if (allianceLimit < 4) return truncateSelectText(guild.id);
  return `${truncateSelectText(alliance, allianceLimit)} • ${guild.id}`;
}

function formatAlliance(guild: AlbionGuild | AlbionSearchGuild): string | undefined {
  const name = optionalDisplayValue(guild.allianceName);
  const tag = optionalDisplayValue(guild.allianceTag);
  if (!name && !tag) return undefined;
  return name ? `${name}${tag ? ` [${tag}]` : ""}` : `[${tag}]`;
}

function hasAllianceData(guild: AlbionGuild): boolean {
  return Boolean(
    optionalDisplayValue(guild.allianceId)
    || optionalDisplayValue(guild.allianceName)
    || optionalDisplayValue(guild.allianceTag)
  );
}

function formatFounded(value: string | undefined): string {
  const raw = optionalDisplayValue(value);
  if (!raw) return "—";

  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp)
    ? neutralizeCodeValue(raw)
    : `<t:${Math.floor(timestamp / 1000)}:f>`;
}

function fencedCode(value: string | undefined): string | undefined {
  const displayValue = optionalDisplayValue(value);
  return displayValue ? `\`\`\`${neutralizeCodeValue(displayValue)}\`\`\`` : undefined;
}

function optionalDisplayValue(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function neutralizeInlineCode(value: string): string {
  return value.replaceAll("`", "ˋ");
}

function neutralizeCodeValue(value: string): string {
  return value.replaceAll("`", "ˋ").replace(/[\r\n]+/g, " ");
}

function truncateSelectText(value: string, limit = 100): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}
