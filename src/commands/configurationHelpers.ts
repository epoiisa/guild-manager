import {
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Role
} from "discord.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { TAILWIND_500_COLORS } from "../discord/tailwindColors.js";
import {
  ALBION_SERVER_VALUES,
  getAlbionServerLabel,
  isAlbionServer,
  type AlbionServer
} from "../services/albion/servers.js";

export const ALL_SERVERS_VALUE = "all";
export const INFO_COLOR: number = TAILWIND_500_COLORS.Slate;
export const SUCCESS_COLOR: number = TAILWIND_500_COLORS.Green;
export const ERROR_COLOR: number = TAILWIND_500_COLORS.Red;
export const INVALID_COLOR: number = TAILWIND_500_COLORS.Yellow;
export const WARNING_COLOR: number = TAILWIND_500_COLORS.Amber;
export const REPORT_COLOR: number = TAILWIND_500_COLORS.Blue;

export type ServerScope = AlbionServer | typeof ALL_SERVERS_VALUE;

export async function rejectNonGuildInteraction(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.inGuild()) {
    return false;
  }

  await interaction.reply(feedbackReply({
    cards: [
      new EmbedBuilder()
        .setColor(INVALID_COLOR)
        .setTitle("Server Only")
        .setDescription("This command can only be used in a Discord server.")
    ],
    flags: MessageFlags.Ephemeral
  }));
  return true;
}

export function readAlbionServer(interaction: ChatInputCommandInteraction, allowAllServers = false): ServerScope | undefined {
  const value = interaction.options.getString("server", false);
  if (!value) return undefined;

  if (allowAllServers && value === ALL_SERVERS_VALUE) {
    return ALL_SERVERS_VALUE;
  }

  return isAlbionServer(value) ? value : undefined;
}

export async function respondInvalidServer(
  interaction: ChatInputCommandInteraction,
  allowAllServers = false
): Promise<void> {
  const valid = [
    ...(allowAllServers ? ["All Servers"] : []),
    ...ALBION_SERVER_VALUES.map(getAlbionServerLabel)
  ].join(", ");

  await interaction.reply(feedbackReply({
    cards: [
      new EmbedBuilder()
        .setColor(INVALID_COLOR)
        .setTitle("Invalid Albion Online Server")
        .setDescription(`Choose an Albion Online server: ${valid}.`)
    ],
    flags: MessageFlags.Ephemeral
  }));
}

export async function respondServerAutocomplete(
  interaction: AutocompleteInteraction,
  allowAllServers = false
): Promise<void> {
  const focused = String(interaction.options.getFocused(true).value ?? "").toLocaleLowerCase();
  const choices = [
    ...(allowAllServers ? [{ name: "All Servers", value: ALL_SERVERS_VALUE }] : []),
    ...ALBION_SERVER_VALUES.map((server) => ({
      name: getAlbionServerLabel(server),
      value: server
    }))
  ];

  await interaction.respond(
    choices
      .filter((choice) =>
        choice.name.toLocaleLowerCase().includes(focused) ||
        choice.value.toLocaleLowerCase().includes(focused)
      )
      .slice(0, 25)
  );
}

export function serverScopeLabel(scope: ServerScope | undefined): string {
  if (!scope || scope === ALL_SERVERS_VALUE) {
    return "All Servers";
  }

  return getAlbionServerLabel(scope);
}

export function serverGroupTitle(server: AlbionServer): string {
  return getAlbionServerLabel(server);
}

export function formatRole(roleId: string): string {
  return `<@&${roleId}>`;
}

export function formatUserMention(discordUserId: string): string {
  return `<@${discordUserId}>`;
}

export async function formatUserText(guild: Guild | null, discordUserId: string): Promise<string> {
  const member = guild?.members.cache.get(discordUserId) ?? await guild?.members.fetch(discordUserId).catch(() => undefined);
  return `@${member?.displayName ?? member?.user.username ?? discordUserId}`;
}

export function formatCharacterUserMentionPair(characterName: string, discordUserId: string): string {
  return `${characterName} • ${formatUserMention(discordUserId)}`;
}

export async function formatCharacterUserTextPair(
  guild: Guild | null,
  characterName: string,
  discordUserId: string
): Promise<string> {
  return `${characterName} • ${await formatUserText(guild, discordUserId)}`;
}

export function formatMemberGroupType(groupType: string): "guild" | "alliance" | "group" {
  if (groupType === "guild") return "guild";
  if (groupType === "alliance") return "alliance";
  return "group";
}

export function formatMemberGroupTypeTitle(groupType: string): "Guild" | "Alliance" | "Group" {
  if (groupType === "guild") return "Guild";
  if (groupType === "alliance") return "Alliance";
  return "Group";
}

export function formatMemberGroupLabel(group: { groupName: string; albionServer: AlbionServer }): string {
  return `${group.groupName} • ${getAlbionServerLabel(group.albionServer)}`;
}

export function formatMemberGroupRoleConfigList(
  configs: Array<{
    memberGroupId: string;
    groupName: string;
    albionServer: AlbionServer;
    discordRoleId: string;
  }>
): string {
  const groups = new Map<string, {
    groupName: string;
    albionServer: AlbionServer;
    discordRoleIds: string[];
  }>();

  for (const config of configs) {
    const existing = groups.get(config.memberGroupId);
    if (existing) {
      if (!existing.discordRoleIds.includes(config.discordRoleId)) {
        existing.discordRoleIds.push(config.discordRoleId);
      }
      continue;
    }

    groups.set(config.memberGroupId, {
      groupName: config.groupName,
      albionServer: config.albionServer,
      discordRoleIds: [config.discordRoleId]
    });
  }

  const sections: string[] = [];
  for (const server of ALBION_SERVER_VALUES) {
    const lines = [...groups.values()]
      .filter((group) => group.albionServer === server)
      .map((group) =>
        `${formatMemberGroupLabel(group)} • ${group.discordRoleIds.map(formatRole).join(" ")}`
      );
    if (lines.length > 0) {
      sections.push(`**${serverGroupTitle(server)}**\n${lines.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}

export function formatMemberGroupCombinedLabel(
  group: { groupName: string; groupType: string; albionServer: AlbionServer }
): string {
  return `${group.groupName} • ${formatMemberGroupType(group.groupType)} • ${getAlbionServerLabel(group.albionServer)}`;
}

export function roleOptionId(role: Role): string {
  return role.id;
}

export function roleName(guild: Guild | null, roleId: string): string {
  return guild?.roles.cache.get(roleId)?.name ?? roleId;
}

export function normalizeQuery(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

export function includesQuery(...values: Array<string | undefined>): (query: string) => boolean {
  return (query) => values.some((value) => value?.toLocaleLowerCase().includes(query));
}

export function truncateChoiceName(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

export function buildSuccessEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(title)
    .setDescription(description);
}

export function buildInfoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(title)
    .setDescription(description);
}

export function buildNotFoundEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INVALID_COLOR)
    .setTitle(title)
    .setDescription(description);
}

export function nonEmptyLines(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") : "None configured.";
}
