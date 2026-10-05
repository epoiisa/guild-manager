import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder
} from "discord.js";
import { getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import type { AlbionPlayer, AlbionSearchPlayer } from "../services/albion/types.js";
import { INFO_COLOR, INVALID_COLOR } from "./configurationHelpers.js";

export const CHARACTER_SEARCH_LIMIT = 10;

const CHARACTER_SELECTION_PREFIX = "albion-character:";

const CHARACTER_WEBSITE_URLS: Record<AlbionServer, { albionDb: string; killboard: string }> = {
  americas: {
    albionDb: "https://albiondb.net/player/",
    killboard: "https://killboard-1.com/us/player/"
  },
  asia: {
    albionDb: "https://east.albiondb.net/player/",
    killboard: "https://killboard-1.com/as/player/"
  },
  europe: {
    albionDb: "https://europe.albiondb.net/player/",
    killboard: "https://killboard-1.com/eu/player/"
  }
};

export function getCharacterWebsiteUrls(server: AlbionServer, characterName: string): { albionDb: string; killboard: string } {
  const websiteUrls = CHARACTER_WEBSITE_URLS[server];
  const encodedName = encodeURIComponent(characterName);
  return {
    albionDb: `${websiteUrls.albionDb}${encodedName}`,
    killboard: `${websiteUrls.killboard}${encodedName}`
  };
}

export type CharacterSelectionAction = "lookup" | "register" | "character-register" | "member-register";

export interface ParsedCharacterSelectionId {
  action: CharacterSelectionAction;
  requesterDiscordUserId: string;
  server: AlbionServer;
  targetDiscordUserId?: string;
}

export function buildCharacterSearchResultsEmbed(
  server: AlbionServer,
  query: string,
  players: AlbionSearchPlayer[],
  footerText = "Select a character to continue."
): EmbedBuilder {
  if (players.length === 0) {
    return new EmbedBuilder()
      .setColor(INVALID_COLOR)
      .setTitle("No Character Found")
      .setDescription(`No Albion Online characters found for "${query}" on ${getAlbionServerLabel(server)}.`);
  }

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Character Matches")
    .setDescription(players.map((player, index) => `${index + 1}. ${formatCharacterSummary(server, player)}`).join("\n"))
    .setFooter({ text: footerText });
}

export function buildCharacterSearchSelectRow(
  action: CharacterSelectionAction,
  requesterDiscordUserId: string,
  server: AlbionServer,
  players: AlbionSearchPlayer[],
  targetDiscordUserId?: string
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCharacterSelectionCustomId(action, requesterDiscordUserId, server, targetDiscordUserId))
      .setPlaceholder("Choose a character")
      .addOptions(players.map((player) => ({
        label: truncateSelectText(player.name),
        description: truncateSelectText(formatCharacterSelectDescription(server, player)),
        value: player.id
      })))
  );
}

export function buildCharacterLookupResultsEmbed(
  server: AlbionServer,
  query: string,
  players: AlbionSearchPlayer[]
): EmbedBuilder {
  if (players.length === 0) {
    return new EmbedBuilder()
      .setColor(INVALID_COLOR)
      .setTitle("No Character Found")
      .setDescription(`No Albion Online characters found for \`${neutralizeInlineCode(query)}\` on ${getAlbionServerLabel(server)}.`);
  }

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Character Matches")
    .setDescription(players.map((player, index) => `${index + 1}. ${formatCharacterLookupSummary(server, player)}`).join("\n"))
    .setFooter({ text: "Select a character to view details." });
}

export function buildCharacterLookupSelectRow(
  requesterDiscordUserId: string,
  server: AlbionServer,
  players: AlbionSearchPlayer[]
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCharacterSelectionCustomId("lookup", requesterDiscordUserId, server))
      .setPlaceholder("Choose a character")
      .addOptions(players.map((player) => ({
        label: truncateSelectText(player.name),
        description: formatCharacterLookupSelectDescription(server, player),
        value: player.id
      })))
  );
}

export function buildCharacterLookupDetailsEmbed(server: AlbionServer, player: AlbionPlayer): EmbedBuilder {
  const websiteUrls = getCharacterWebsiteUrls(server, player.name);

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(player.name)
    .addFields(
      { name: "Server", value: getAlbionServerLabel(server), inline: true },
      { name: "Guild", value: optionalDisplayValue(player.guildName) ?? "—", inline: true },
      { name: "Alliance", value: formatLookupAlliance(player) ?? "—", inline: true },
      { name: "ID", value: `\`\`\`${neutralizeCodeBlock(player.id)}\`\`\``, inline: false },
      {
        name: "Fame",
        value: [
          `PvP ${formatFame(player.pvpFame)}`,
          `PvE ${formatFame(player.pveFame)}`,
          `Gathering ${formatFame(player.gatheringFame)}`,
          `Crafting ${formatFame(player.craftingFame)}`
        ].join("\n"),
        inline: false
      },
      {
        name: "Websites",
        value: [
          `[AlbionDB](${websiteUrls.albionDb})`,
          `[Killboard-1](${websiteUrls.killboard})`
        ].join("\n"),
        inline: false
      }
    );
}

export function parseCharacterSelectionCustomId(customId: string): ParsedCharacterSelectionId | undefined {
  if (!customId.startsWith(CHARACTER_SELECTION_PREFIX)) {
    return undefined;
  }

  const raw = customId.slice(CHARACTER_SELECTION_PREFIX.length);
  const [action, requesterDiscordUserId, server, targetDiscordUserId] = raw.split(":");

  if (!isCharacterSelectionAction(action) || !requesterDiscordUserId || !server || !isAlbionServer(server)) {
    return undefined;
  }

  if ((action === "character-register" || action === "member-register") && !targetDiscordUserId) {
    return undefined;
  }

  return {
    action,
    requesterDiscordUserId,
    server,
    targetDiscordUserId
  };
}

function buildCharacterSelectionCustomId(
  action: CharacterSelectionAction,
  requesterDiscordUserId: string,
  server: AlbionServer,
  targetDiscordUserId?: string
): string {
  return [
    `${CHARACTER_SELECTION_PREFIX}${action}`,
    requesterDiscordUserId,
    server,
    targetDiscordUserId
  ].filter((value) => value !== undefined).join(":");
}

function isCharacterSelectionAction(value: string): value is CharacterSelectionAction {
  return value === "lookup" || value === "register" || value === "character-register" || value === "member-register";
}

function formatCharacterSummary(server: AlbionServer, player: AlbionSearchPlayer): string {
  return [
    player.name,
    player.guildName ? `${player.guildName} • guild • ${getAlbionServerLabel(server)}` : undefined,
    formatAllianceLabel(server, player, true),
    `\`${player.id}\``
  ].filter((value) => value !== undefined).join(" • ");
}

function formatCharacterSelectDescription(server: AlbionServer, player: AlbionSearchPlayer): string {
  return [
    player.guildName ? `${player.guildName} • ${getAlbionServerLabel(server)}` : "No guild",
    formatAllianceLabel(server, player),
    player.id
  ].filter((value) => value !== undefined).join(" • ");
}

export function formatCharacterLookupSummary(server: AlbionServer, player: AlbionSearchPlayer): string {
  return [
    player.name,
    optionalDisplayValue(player.guildName),
    formatLookupAlliance(player),
    getAlbionServerLabel(server),
    `\`${player.id}\``
  ].filter((value) => value !== undefined).join(" • ");
}

function formatCharacterLookupSelectDescription(server: AlbionServer, player: AlbionSearchPlayer): string {
  const prefix = [
    optionalDisplayValue(player.guildName),
    formatLookupAlliance(player)
  ].filter((value) => value !== undefined).join(" • ");
  const suffix = `${getAlbionServerLabel(server)} • ${player.id}`;

  if (!prefix) {
    return truncateSelectText(suffix);
  }

  const description = `${prefix} • ${suffix}`;
  if (description.length <= 100) {
    return description;
  }

  const prefixLimit = 100 - suffix.length - 3;
  if (prefixLimit < 4) {
    return truncateSelectText(suffix);
  }

  return `${truncateSelectText(prefix, prefixLimit)} • ${suffix}`;
}

function formatLookupAlliance(player: AlbionPlayer | AlbionSearchPlayer): string | undefined {
  const name = optionalDisplayValue(player.allianceName);
  const tag = optionalDisplayValue(player.allianceTag);
  if (!name && !tag) {
    return undefined;
  }
  return name ? `${name}${tag ? ` [${tag}]` : ""}` : `[${tag}]`;
}

function optionalDisplayValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function neutralizeInlineCode(value: string): string {
  return value.replaceAll("`", "ˋ");
}

function neutralizeCodeBlock(value: string): string {
  return value.replaceAll("`", "ˋ").replace(/[\r\n]+/g, " ");
}

function formatFame(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function formatAllianceLabel(server: AlbionServer, player: AlbionPlayer | AlbionSearchPlayer, includeType = false): string | undefined {
  if (!player.allianceName && !player.allianceTag) {
    return undefined;
  }

  const allianceName = player.allianceName
    ? `${player.allianceName}${player.allianceTag ? ` [${player.allianceTag}]` : ""}`
    : `[${player.allianceTag}]`;
  return `${allianceName}${includeType ? " • alliance" : ""} • ${getAlbionServerLabel(server)}`;
}

function truncateSelectText(value: string, limit = 100): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}
