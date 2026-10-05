import { boundedV2Container } from "../discord/operationalMessages.js";
import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SlashCommandBuilder,
  TextDisplayBuilder,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
  type Role
} from "discord.js";
import type { StatusApplicationClass, StatusMemberGroup, StatusPosition, StatusRepository, StatusSnapshot } from "../db/statusRepository.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { SPECIALISATION_CATALOGUE } from "../services/specialisations/catalogue.js";
import { REPORT_COLOR } from "./configurationHelpers.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show this server's Guild Manager configuration.")
  .setDefaultMemberPermissions(0);

export interface StatusDiscordResolution {
  roles?: ReadonlyMap<string, Role>;
  channels?: ReadonlyMap<string, GuildBasedChannel | null>;
  botNickname?: string;
  botAvatarUrl?: string;
}

export async function handleStatusCommand(interaction: ChatInputCommandInteraction, repository: StatusRepository): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [snapshotResult, rolesResult, channelsResult] = await Promise.allSettled([
    repository.getSnapshot(interaction.guildId), interaction.guild.roles.fetch(), interaction.guild.channels.fetch()
  ]);
  if (snapshotResult.status === "rejected") throw snapshotResult.reason;
  const botMember = interaction.guild.members.me;
  await interaction.editReply(buildStatusResponse(snapshotResult.value, {
    roles: rolesResult.status === "fulfilled" ? rolesResult.value : undefined,
    channels: channelsResult.status === "fulfilled" ? channelsResult.value : undefined,
    botNickname: botMember?.nickname ?? undefined,
    botAvatarUrl: botMember?.avatarURL() ?? undefined
  }));
}

export function buildStatusResponse(snapshot: StatusSnapshot, resolution: StatusDiscordResolution = {}) {
  const groupsById = new Map(snapshot.memberGroups.map((group) => [group.memberGroupId, group]));
  const role = (id: string) => resolvedRole(id, resolution.roles);
  const channel = (id: string) => resolvedChannel(id, resolution.channels);
  const entryChannel = (feature: string) => { const id = snapshot.entryChannels?.find(c => c.feature === feature)?.channelId; return id ? channel(id) ?? "Not configured" : "Not configured"; };
  const entryRoles = (kind: string) => snapshot.entryRoles?.filter(r => r.kind === kind).map(r => role(r.roleId)).filter(Boolean).join(" ") || "None configured";
  const sections: Array<[string, string[]]> = [
    ["Character Roles", linesOrNone(snapshot.characterRoleConfigs.map((config) => `- ${config.albionServer ? getAlbionServerLabel(config.albionServer) : "All Servers"} • ${role(config.discordRoleId) ?? "No Role Set"}`))],
    ["Guilds", groupLines(snapshot.memberGroups.filter((group) => group.groupType === "guild"), role)],
    ["Alliances", groupLines(snapshot.memberGroups.filter((group) => group.groupType === "alliance"), role)],
    ["Groups", groupLines(snapshot.memberGroups.filter((group) => group.groupType === "group"), role)],
    ["Positions", positionLines(snapshot.positions, groupsById, role)],
    ["Reaction Roles", linesOrNone(snapshot.reactionRoles.map((config) => {
      const configuredRole = role(config.discordRoleId) ?? "No Role Set";
      if (!config.emojiPlacement) return `- ${configuredRole} • Not Attached`;
      const placement = config.emojiPlacement;
      return `- ${configuredRole} • ${placement.emojiDisplayValue} • [Message](https://discord.com/channels/${snapshot.discordGuildId}/${placement.channelId}/${placement.messageId}) • ${channel(placement.channelId) ?? "Not Set"}`;
    }))],
    ["Party Templates", linesOrNone(snapshot.partyTemplates.map((template) => `- ${template.name}`))],
    ["Application Classes", linesOrNone(snapshot.applicationClasses.map((item) => applicationLine(item, role, channel)))],
    ["Ticket Classes", linesOrNone(snapshot.ticketClasses.map((item) => `- **${item.name}** • ${role(item.reviewerRoleId) ?? "No Reviewer Set"} • ${item.enabled ? "Enabled" : "Disabled"}`))],
    ["Managers", reviewerLines(snapshot.reviewerBindings, role)],
    ["Update Schedule", snapshot.memberUpdateSchedule ? [`- ${formatSchedule(snapshot.memberUpdateSchedule)}`] : ["None"]],
    ["Special Channels", [
      `- **Content** • ${snapshot.contentChannelId ? channel(snapshot.contentChannelId) ?? "Not Set" : "Not Set"}`,
      `- **Log** • ${snapshot.logChannelId ? `<#${snapshot.logChannelId}>${resolution.channels && !resolution.channels.get(snapshot.logChannelId) ? " • Unavailable" : ""}` : "Not Set"}`,
      `- **UTC** • ${snapshot.utcChannelId ? channel(snapshot.utcChannelId) ?? "Not Set" : "Not Set"}`,
      `- **Temporary VC** • ${snapshot.temporaryVoice ? channel(snapshot.temporaryVoice.baseChannelId) ?? "Not Set" : "Not Set"}`
    ]],
    ["Feature Entry Panels", [
      `- **Accounts Channel** • ${entryChannel("accounts")}`,
      `- **Accounts Managers** • ${entryRoles("accounts_manager")}`,
      `- **Re-gears Channel** • ${entryChannel("regears")}`,
      `- **Weapon Specialisation Channel** • ${entryChannel("specialisation")}`,
      `- **Giveaways Channel** • ${entryChannel("giveaways")}`
    ]],
    ["Weapon Specialisation Catalogue", catalogueLines(snapshot.specialisationCatalogueExclusionKeys)],
    ["Bot Profile", [`- **Name** • ${resolution.botNickname ?? "Default"}`]]
  ];
  const container = new ContainerBuilder().setAccentColor(REPORT_COLOR);
  const textDisplays = sections.map(([heading, lines], index) => `${index === 0 ? "# Status\n" : ""}### ${heading}\n${lines.join("\n")}`);
  container.addTextDisplayComponents(...textDisplays.map((content) => new TextDisplayBuilder({ content })));
  if (resolution.botAvatarUrl) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(resolution.botAvatarUrl).setDescription("Guild Manager bot avatar")
    ));
  }
  return boundedV2Container(container, { overflowName: "status.md" });
}

function groupLines(groups: StatusMemberGroup[], role: (id: string) => string | undefined): string[] {
  return linesOrNone(groups.map((group) => {
    const suffixes = group.groupType === "guild" ? [group.managed ? "Managed" : undefined, group.isDefaultAlbionGuild ? "Default" : undefined].filter(Boolean) : [];
    const name = group.groupType === "alliance" && group.albionAllianceTag ? `${group.groupName} [${group.albionAllianceTag}]` : group.groupName;
    const roles = group.discordRoleIds.map(role).filter((value): value is string => Boolean(value));
    return [`- **${name}**`, getAlbionServerLabel(group.albionServer), roles.length > 0 ? roles.join(" ") : undefined, ...suffixes]
      .filter(Boolean)
      .join(" • ");
  }));
}

function positionLines(positions: StatusPosition[], groupsById: ReadonlyMap<string, StatusMemberGroup>, role: (id: string) => string | undefined): string[] {
  return linesOrNone(positions.map((position) => {
    const group = groupsById.get(position.memberGroupId);
    if (!group) return `- **${position.name}** • Not Set • ${role(position.discordRoleId) ?? "No Role Set"}`;
    return `- **${position.name}** • ${memberGroupDisplayName(group)} • ${getAlbionServerLabel(group.albionServer)} • ${role(position.discordRoleId) ?? "No Role Set"}`;
  }));
}

function applicationLine(item: StatusApplicationClass, role: (id: string) => string | undefined, channel: (id: string) => string | undefined): string {
  return [
    `- **${item.name}** – ${applicationTarget(item)}`,
    getAlbionServerLabel(item.albionServer),
    channel(item.ticketCategoryId) ?? "Not Set",
    role(item.reviewerRoleId) ?? "No Reviewer Set",
    item.activeRoleId ? role(item.activeRoleId) : undefined,
    item.enabled ? "Enabled" : "Disabled"
  ].filter(Boolean).join(" • ");
}

function applicationTarget(item: StatusApplicationClass): string {
  if (!item.memberGroupId) return "Character registration";
  if (!item.memberGroupName) return "Unavailable member group";
  return item.memberGroupType === "alliance" && item.memberGroupName ? item.memberGroupName : item.memberGroupName;
}

function catalogueLines(excludedKeys: string[]): string[] {
  const excluded = new Set(excludedKeys);
  const count = (kind: "tree" | "weapon") => {
    const entries = SPECIALISATION_CATALOGUE.filter((entry) => entry.kind === kind);
    return `${entries.length - entries.filter((entry) => excluded.has(entry.key)).length}/${entries.length} enabled`;
  };
  return [`- **Trees** • ${count("tree")}`, `- **Weapons** • ${count("weapon")}`];
}

function reviewerLines(bindings: StatusSnapshot["reviewerBindings"], role: (id: string) => string | undefined): string[] {
  const result: string[] = [];
  for (const domain of ["regears", "specialisation"] as const) {
    const domainBindings = bindings.filter((binding) => binding.domain === domain);
    const label = domain === "regears" ? "Re-gears" : "Weapon Specialisation";
    if (domainBindings.length === 0) {
      result.push(`- **${label}** • No Manager Set`);
      continue;
    }
    result.push(...domainBindings.map((binding) => `- **${label}** • ${role(binding.discordRoleId) ?? "No Manager Set"}`));
  }
  return result;
}

function formatSchedule(schedule: StatusSnapshot["memberUpdateSchedule"] & {}): string {
  return `${schedule.cadence === "daily" ? "Daily" : WEEKDAYS[schedule.weekday ?? -1] ?? "Unknown"} at ${twoDigits(schedule.hourUtc)}:${twoDigits(schedule.minuteUtc)} UTC`;
}

function linesOrNone(lines: string[]): string[] { return lines.length > 0 ? lines : ["None"]; }
function memberGroupDisplayName(group: StatusMemberGroup): string { return group.groupType === "alliance" && group.albionAllianceTag ? `${group.groupName} [${group.albionAllianceTag}]` : group.groupName; }
function resolvedRole(roleId: string, roles: ReadonlyMap<string, Role> | undefined): string | undefined { return roles?.has(roleId) ? `<@&${roleId}>` : undefined; }
function resolvedChannel(channelId: string, channels: ReadonlyMap<string, GuildBasedChannel | null> | undefined): string | undefined { return channels?.get(channelId) ? `<#${channelId}>` : undefined; }
function twoDigits(value: number): string { return String(value).padStart(2, "0"); }
