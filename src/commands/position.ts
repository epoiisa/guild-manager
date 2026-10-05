import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Role
} from "discord.js";
import type {
  GroupPositionAppointment as Appointment,
  MemberGroup,
  MemberGroupProfile,
  GroupPosition as Position,
  createMembershipRepository
} from "../db/membershipRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { cleanupConfiguredRoles } from "../services/membership/discordMemberUpdates.js";
import {
  REPORT_COLOR,
  SUCCESS_COLOR,
  buildInfoEmbed,
  buildNotFoundEmbed,
  formatCharacterUserMentionPair,
  formatCharacterUserTextPair,
  formatMemberGroupCombinedLabel,
  formatMemberGroupLabel,
  formatMemberGroupType,
  formatMemberGroupTypeTitle,
  formatRole,
  normalizeQuery,
  rejectNonGuildInteraction,
  roleName,
  roleOptionId,
  truncateChoiceName
} from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

const INLINE_CONTENT_LIMIT = 1900;

export const positionCommand = new SlashCommandBuilder()
  .setName("position")
  .setDescription("Manage group-scoped positions.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a group-scoped position.")
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured member group.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("name").setDescription("Position name.").setMinLength(1).setMaxLength(100).setRequired(true)
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Discord role.").setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a group-scoped position.")
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured member group.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("position").setDescription("Configured position.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("appoint")
      .setDescription("Appoint a character to a group-scoped position.")
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured member group.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("position").setDescription("Configured position.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("character").setDescription("Member group profile.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("dismiss")
      .setDescription("Dismiss a character from a group-scoped position.")
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured member group.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("position").setDescription("Configured position.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("character").setDescription("Appointed member group profile.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List group-scoped positions.")
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured member group.").setRequired(false).setAutocomplete(true)
      )
  );

export async function handlePositionCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "create") {
    await handleCreate(interaction, membershipRepository);
    return;
  }
  if (subcommand === "delete") {
    await handleDelete(interaction, membershipRepository);
    return;
  }
  if (subcommand === "appoint") {
    await handleAppoint(interaction, membershipRepository);
    return;
  }
  if (subcommand === "dismiss") {
    await handleDismiss(interaction, membershipRepository);
    return;
  }
  if (subcommand === "list") {
    await handleList(interaction, membershipRepository);
    return;
  }

  await interaction.reply(feedbackReply({
    text: "Unknown position subcommand.",
    flags: MessageFlags.Ephemeral
  }));
}

export async function handlePositionAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "position") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "group") {
    await respondGroupAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "position") {
    await respondPositionAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "character") {
    await respondCharacterAutocomplete(interaction, membershipRepository);
    return true;
  }
  return false;
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const group = await requireMemberGroup(interaction, membershipRepository);
  if (!group) return;

  const name = interaction.options.getString("name", true).trim();
  const role = interaction.options.getRole("role", true) as Role;
  if (await membershipRepository.isReactionRoleConfigured(interaction.guildId!, role.id)) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Reaction Role Conflict", "A reaction role cannot also be used for a group-scoped position.")], flags: MessageFlags.Ephemeral }));
    return;
  }
  const created = await membershipRepository.createGroupPosition({
    discordGuildId: interaction.guildId!,
    memberGroupId: group.memberGroupId,
    name,
    discordRoleId: roleOptionId(role)
  });
  if (!created) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Group Not Found", "Choose a configured member group from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  await interaction.reply(feedbackReply({
    cards: [buildPositionChangeEmbed("Position Created", created)],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const group = await requireMemberGroup(interaction, membershipRepository);
  if (!group) return;
  const position = await requirePosition(interaction, membershipRepository, group.memberGroupId);
  if (!position) return;

  const result = await membershipRepository.deleteGroupPosition(interaction.guildId!, position.memberGroupPositionId);
  if (!result.deleted) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Position Not Found", "Choose a configured position from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  const warnings = await reconcileUsers(interaction, membershipRepository, result.affectedDiscordUserIds);
  await interaction.reply(feedbackReply({
    cards: [buildPositionChangeEmbed("Position Deleted", result.deleted, undefined, warnings)],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleAppoint(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const group = await requireMemberGroup(interaction, membershipRepository);
  if (!group) return;
  const position = await requirePosition(interaction, membershipRepository, group.memberGroupId);
  if (!position) return;

  const appointment = await membershipRepository.appointGroupPosition(
    interaction.guildId!,
    position.memberGroupPositionId,
    interaction.options.getString("character", true)
  );
  if (!appointment) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Profile Not Found", "Choose a member group profile from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  const warnings = appointment.discordUserId
    ? await reconcileUsers(interaction, membershipRepository, [appointment.discordUserId])
    : [{ message: `${appointment.characterName} is orphaned, so no Discord role was applied.` }];
  await interaction.reply(feedbackReply({
    cards: [buildPositionChangeEmbed("Appointment Created", appointment, appointment, warnings)],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleDismiss(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const group = await requireMemberGroup(interaction, membershipRepository);
  if (!group) return;
  const position = await requirePosition(interaction, membershipRepository, group.memberGroupId);
  if (!position) return;

  const appointment = await membershipRepository.dismissGroupPosition(
    interaction.guildId!,
    position.memberGroupPositionId,
    interaction.options.getString("character", true)
  );
  if (!appointment) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Appointment Not Found", "Choose an appointed character from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  const warnings = appointment.discordUserId
    ? await reconcileUsers(interaction, membershipRepository, [appointment.discordUserId])
    : [];
  await interaction.reply(feedbackReply({
    cards: [buildPositionChangeEmbed("Appointment Removed", appointment, appointment, warnings)],
    flags: MessageFlags.Ephemeral
  }));
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const groupId = interaction.options.getString("group", false) ?? undefined;
  const [positions, appointments] = await Promise.all([
    membershipRepository.listGroupPositions(interaction.guildId!, groupId),
    membershipRepository.listGroupPositionAppointments(interaction.guildId!, groupId)
  ]);

  await interaction.reply(feedbackReply({
    structured: positions.length > 0,
    ...formatPositionReport(positions, appointments),
    flags: MessageFlags.Ephemeral
  }));
}

async function requireMemberGroup(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<MemberGroup | undefined> {
  const groupId = interaction.options.getString("group", true);
  const group = (await membershipRepository.listMemberGroups(interaction.guildId!))
    .find((candidate) => candidate.memberGroupId === groupId);
  if (!group) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Group Not Found", "Choose a configured member group from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
  }
  return group;
}

async function requirePosition(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  memberGroupId: string
): Promise<Position | undefined> {
  const position = await membershipRepository.getGroupPosition(
    interaction.guildId!,
    interaction.options.getString("position", true),
    memberGroupId
  );
  if (!position) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Position Not Found", "Choose a configured position from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
  }
  return position;
}

async function respondGroupAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const groups = (await membershipRepository.listMemberGroups(interaction.guildId ?? ""))
    .filter((group) => groupMatchesQuery(group, query))
    .slice(0, 25);

  await interaction.respond(groups.map((group) => ({
    name: truncateChoiceName(formatGroupChoice(group)),
    value: group.memberGroupId
  })));
}

async function respondPositionAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const groupId = interaction.options.getString("group") ?? undefined;
  const positions = (await membershipRepository.listGroupPositions(interaction.guildId ?? "", groupId))
    .filter((position) => position.name.toLocaleLowerCase().includes(query) || roleName(interaction.guild, position.discordRoleId).toLocaleLowerCase().includes(query))
    .slice(0, 25);

  await interaction.respond(positions.map((position) => ({
    name: truncateChoiceName(`${position.name} • ${formatRoleChoice(interaction.guild, position.discordRoleId)}`),
    value: position.memberGroupPositionId
  })));
}

async function respondCharacterAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const subcommand = interaction.options.getSubcommand(false);
  const groupId = interaction.options.getString("group");
  const positionId = interaction.options.getString("position");

  if (!groupId) {
    await interaction.respond([]);
    return;
  }

  if (subcommand === "dismiss" && positionId) {
    const appointments = (await membershipRepository.listGroupPositionAppointments(interaction.guildId ?? "", groupId, positionId))
      .filter((appointment) => appointment.characterName.toLocaleLowerCase().includes(query) || (appointment.discordUserId ?? "").includes(query))
      .slice(0, 25);
    await interaction.respond(await Promise.all(appointments.map(async (appointment) => ({
      name: truncateChoiceName(await formatProfileChoice(interaction.guild, appointment)),
      value: appointment.memberGroupProfileId
    }))));
    return;
  }

  const profiles = (await membershipRepository.listProfilesForGroups(interaction.guildId ?? "", [groupId]))
    .filter((profile) => (profile.characterName ?? profile.albionCharacterId).toLocaleLowerCase().includes(query) || (profile.discordUserId ?? "").includes(query))
    .slice(0, 25);
  await interaction.respond(await Promise.all(profiles.map(async (profile) => ({
    name: truncateChoiceName(await formatProfileChoice(interaction.guild, profile)),
    value: profile.memberGroupProfileId
  }))));
}

function formatPositionReport(
  positions: Position[],
  appointments: Appointment[]
): { cards: EmbedBuilder[]; files?: AttachmentBuilder[] } {
  if (positions.length === 0) {
    return {
      cards: [buildInfoEmbed("Positions", "No positions are configured.")]
    };
  }

  const lines = formatPositionReportLines(positions, appointments);
  const content = lines.join("\n");

  if (content.length <= INLINE_CONTENT_LIMIT) {
    return {
      cards: buildPositionReportEmbeds(positions, appointments)
    };
  }

  return {
    cards: [
      new EmbedBuilder()
        .setColor(REPORT_COLOR)
        .setTitle("Positions")
        .setDescription("Report is attached as report.txt.")
    ],
    files: [
      new AttachmentBuilder(Buffer.from(content, "utf8"), {
        name: "report.txt"
      })
    ]
  };
}

function buildPositionReportEmbeds(
  positions: Position[],
  appointments: Appointment[]
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  const grouped = groupPositionsByGroup(positions);

  let embed = new EmbedBuilder()
    .setColor(REPORT_COLOR)
    .setTitle("Positions");

  for (const groupPositions of grouped.values()) {
    const group = groupPositions[0];
    const field = {
      name: formatGroupListLabel(group),
      value: formatGroupPositionFieldValue(groupPositions, appointments),
      inline: false
    };

    if ((embed.data.fields?.length ?? 0) >= 25) {
      embeds.push(embed);
      embed = new EmbedBuilder()
        .setColor(REPORT_COLOR)
        .setTitle("Positions");
    }
    embed.addFields(field);
  }

  embeds.push(embed);
  return embeds;
}

function formatPositionReportLines(
  positions: Position[],
  appointments: Appointment[]
): string[] {
  const lines: string[] = [];
  const grouped = groupPositionsByGroup(positions);

  for (const groupPositions of grouped.values()) {
    const group = groupPositions[0];
    if (lines.length > 0) lines.push("");
    lines.push(`## ${formatGroupListLabel(group)}`);
    for (const position of groupPositions) {
      lines.push("", `### ${position.name} ${formatRole(position.discordRoleId)}`, "");
      const positionAppointments = appointments.filter((appointment) => appointment.memberGroupPositionId === position.memberGroupPositionId);
      if (positionAppointments.length === 0) {
        lines.push("No appointments.");
      } else {
        lines.push(...positionAppointments.map((appointment) => `- ${formatAppointmentListEntry(appointment)}`));
      }
    }
  }

  return lines;
}

function groupPositionsByGroup(positions: Position[]): Map<string, Position[]> {
  const grouped = new Map<string, Position[]>();
  for (const position of positions) {
    grouped.set(position.memberGroupId, [...(grouped.get(position.memberGroupId) ?? []), position]);
  }
  return grouped;
}

function formatGroupPositionFieldValue(
  positions: Position[],
  appointments: Appointment[]
): string {
  return positions.map((position) => {
    const positionAppointments = appointments.filter((appointment) => appointment.memberGroupPositionId === position.memberGroupPositionId);
    const members = positionAppointments.length === 0
      ? ["- No appointments."]
      : positionAppointments.map((appointment) => `- ${formatAppointmentListEntry(appointment)}`);
    return [
      `${position.name} ${formatRole(position.discordRoleId)}`,
      ...members
    ].join("\n");
  }).join("\n\n");
}

function formatAppointmentListEntry(
  appointment: Pick<Appointment, "characterName" | "discordUserId">
): string {
  return appointment.discordUserId
    ? `${appointment.characterName} <@${appointment.discordUserId}>`
    : `${appointment.characterName} • orphaned`;
}

async function reconcileUsers(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  discordUserIds: string[]
): Promise<Array<{ message: string }>> {
  if (!interaction.guild) return [];

  const warnings: Array<{ message: string }> = [];
  for (const discordUserId of [...new Set(discordUserIds)]) {
    warnings.push(...await cleanupConfiguredRoles(interaction.guild, membershipRepository, discordUserId));
  }
  return warnings;
}

function formatWarnings(warnings: Array<{ message: string }>): string {
  return warnings.length > 0
    ? `\n\n${warnings.map((warning) => warning.message).join("\n")}`
    : "";
}

function formatGroupChoice(group: MemberGroup): string {
  return formatMemberGroupCombinedLabel(group);
}

function formatGroupFieldValue(group: Pick<MemberGroup, "groupName" | "albionServer">): string {
  return formatMemberGroupLabel(group);
}

function formatGroupListLabel(group: Pick<MemberGroup, "groupName" | "albionServer" | "groupType">): string {
  return formatMemberGroupCombinedLabel(group);
}

function formatGroupFieldName(groupType: MemberGroup["groupType"]): string {
  return formatMemberGroupTypeTitle(groupType);
}

function formatPositionFieldValue(position: Pick<Position, "name" | "discordRoleId">): string {
  return `${position.name} • ${formatRole(position.discordRoleId)}`;
}

function formatAppointmentFieldValue(appointment: Pick<Appointment, "characterName" | "discordUserId">): string {
  return appointment.discordUserId ? formatCharacterUserMentionPair(appointment.characterName, appointment.discordUserId) : `${appointment.characterName} • orphaned`;
}

function formatRoleChoice(guild: Guild | null, discordRoleId: string): string {
  return `@${roleName(guild, discordRoleId)}`;
}

async function formatProfileChoice(
  guild: Guild | null,
  profile: Pick<MemberGroupProfile, "characterName" | "albionCharacterId" | "discordUserId">
): Promise<string> {
  const characterName = profile.characterName ?? profile.albionCharacterId;
  return profile.discordUserId ? formatCharacterUserTextPair(guild, characterName, profile.discordUserId) : `${characterName} • orphaned`;
}

function buildPositionChangeEmbed(
  title: string,
  position: Pick<Position, "name" | "discordRoleId" | "groupName" | "albionServer" | "groupType">,
  appointment?: Pick<Appointment, "characterName" | "discordUserId">,
  warnings: Array<{ message: string }> = []
): EmbedBuilder {
  const group = `${position.groupType === "group" ? "group" : `Albion Online ${position.groupType}`} ${formatGroupFieldValue(position)}`;
  const place = `${position.name} (${formatRole(position.discordRoleId)})`;
  const description = appointment
    ? `${title === "Appointment Created" ? "Appointed" : "Removed"} ${formatAppointmentFieldValue(appointment)} ${title === "Appointment Created" ? "to" : "from"} ${place} for ${group}.`
    : `${title === "Position Created" ? "Created" : "Deleted"} position ${place} for ${group}.`;
  if (warnings.length === 0 && description.length <= 500 && !/[\r\n]/u.test(description)) {
    return new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle(title).setDescription(description);
  }
  const embed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(title)
    .addFields(
      { name: formatGroupFieldName(position.groupType), value: formatGroupFieldValue(position), inline: false },
      { name: "Position", value: formatPositionFieldValue(position), inline: false }
    );

  if (appointment) {
    embed.addFields({ name: "Appointment", value: formatAppointmentFieldValue(appointment), inline: false });
  }

  if (warnings.length > 0) {
    embed.addFields({ name: "Warnings", value: warnings.map((warning) => warning.message).join("\n"), inline: false });
  }

  return embed;
}

function groupMatchesQuery(group: MemberGroup, query: string): boolean {
  return group.groupName.toLocaleLowerCase().includes(query) ||
    getAlbionServerLabel(group.albionServer).toLocaleLowerCase().includes(query) ||
    formatMemberGroupType(group.groupType).toLocaleLowerCase().includes(query);
}
