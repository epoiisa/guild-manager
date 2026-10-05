import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Role
} from "discord.js";
import type {
  MemberGroup,
  MemberGroupRoleConfig,
  createMembershipRepository
} from "../db/membershipRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import {
  buildInfoEmbed,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatMemberGroupLabel,
  formatMemberGroupRoleConfigList,
  formatRole,
  normalizeQuery,
  readAlbionServer,
  rejectNonGuildInteraction,
  respondInvalidServer,
  respondServerAutocomplete,
  roleName,
  roleOptionId,
  serverGroupTitle,
  truncateChoiceName
} from "./configurationHelpers.js";
import { beginMemberGroupRemoval } from "./memberGroupRemoval.js";
import { replyWithMemberGroupReport, type MemberGroupReportScheduleRepository } from "./memberGroupReport.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
const TRUE_CHOICE_VALUE = "true";

export const groupCommand = new SlashCommandBuilder()
  .setName("group")
  .setDescription("Configure member groups.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a member group.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("name").setDescription("Group name.").setMinLength(1).setMaxLength(100).setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a member group.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Rename a member group.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("rename").setDescription("New group name.").setMinLength(1).setMaxLength(100).setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List member groups.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("report")
      .setDescription("List member profiles for a member group.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("roles")
      .setDescription("Configure roles for member groups.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Configure a role for a member group.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true)
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Discord role.").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a configured role from a member group.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("role").setDescription("Configured Discord role.").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List configured group roles.")
      )
  );

export async function handleGroupCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  scheduleRepository: MemberGroupReportScheduleRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "roles") {
    await handleGroupRoleCommand(interaction, membershipRepository, subcommand);
    return;
  }

  if (subcommand === "list") {
    const groups = await membershipRepository.listGroups(interaction.guildId!);
    await interaction.reply(feedbackReply({ structured: groups.length > 0, cards: [buildGroupListEmbed(groups)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  if (subcommand === "create") {
    const groupName = interaction.options.getString("name", true).trim();
    const created = await membershipRepository.createGroup({
      discordGuildId: interaction.guildId!,
      albionServer: server,
      groupName
    });
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Group Created", `${formatMemberGroupLabel(created)} was created.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const configured = await membershipRepository.getGroup(
    interaction.guildId!,
    interaction.options.getString(subcommand === "create" ? "name" : "group", true),
    server
  );
  if (!configured) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Group Not Found", "Choose a configured group from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  if (subcommand === "report") {
    await replyWithMemberGroupReport(interaction, membershipRepository, configured, scheduleRepository);
    return;
  }

  if (subcommand === "edit") {
    const renamed = await membershipRepository.renameGroup(
      interaction.guildId!,
      configured.memberGroupId,
      interaction.options.getString("rename", true).trim()
    );
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Group Renamed", `${formatMemberGroupLabel(configured)} was renamed to ${renamed ? formatMemberGroupLabel(renamed) : "the new name"}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "delete") {
    await beginMemberGroupRemoval(interaction, membershipRepository, configured, formatMemberGroupLabel(configured));
  }
}

export async function handleGroupAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "group") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }
  if (focused.name === "name" || focused.name === "group") {
    await respondGroupAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "role") {
    await respondGroupRoleAutocomplete(interaction, membershipRepository);
    return true;
  }
  return false;
}

async function handleGroupRoleCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "list") {
    const configs = await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId!, "group");
    await interaction.reply(feedbackReply({ structured: configs.length > 0, cards: [buildRoleListEmbed(configs)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  const configured = await membershipRepository.getGroup(
    interaction.guildId!,
    interaction.options.getString("group", true),
    server
  );
  if (!configured) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Group Not Found", "Choose a configured group from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  if (subcommand === "add") {
    const role = interaction.options.getRole("role", true) as Role;
    if (await membershipRepository.isReactionRoleConfigured(interaction.guildId!, role.id)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Reaction Role Conflict", "A reaction role cannot also be configured as a standard group role.")], flags: MessageFlags.Ephemeral }));
      return;
    }
    await membershipRepository.addMemberGroupRoleConfig(configured.memberGroupId, roleOptionId(role));
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Group Role Configured", `${formatRole(role.id)} was configured for ${formatMemberGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "remove") {
    const roleId = interaction.options.getString("role", true);
    const removed = await membershipRepository.removeMemberGroupRoleConfig(
      interaction.guildId!,
      configured.memberGroupId,
      roleId
    );
    await interaction.reply(feedbackReply({ cards: [removed > 0 ? buildSuccessEmbed("Group Role Removed", `${formatRole(roleId)} was removed from ${formatMemberGroupLabel(configured)}.`) : buildNotFoundEmbed("Group Role Not Found", `${formatRole(roleId)} is not configured for ${formatMemberGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
  }
}

async function respondGroupAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const server = interaction.options.getString("server");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const groups = (await membershipRepository.listGroups(interaction.guildId ?? ""))
    .filter((group) => !isAlbionServer(server ?? "") || group.albionServer === server)
    .filter((group) => group.groupName.toLocaleLowerCase().includes(query))
    .slice(0, 25);

  await interaction.respond(groups.map((group) => ({
    name: truncateChoiceName(formatMemberGroupLabel(group)),
    value: group.memberGroupId
  })));
}

async function respondGroupRoleAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const server = interaction.options.getString("server");
  const memberGroupId = interaction.options.getString("group");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const configs = (await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId ?? "", "group"))
    .filter((config) => !isAlbionServer(server ?? "") || config.albionServer === server)
    .filter((config) => !memberGroupId || config.memberGroupId === memberGroupId)
    .filter((config) => roleName(interaction.guild, config.discordRoleId).toLocaleLowerCase().includes(query) || config.discordRoleId.includes(query))
    .slice(0, 25);

  await interaction.respond(configs.map((config) => ({
    name: truncateChoiceName(roleName(interaction.guild, config.discordRoleId)),
    value: config.discordRoleId
  })));
}

function buildGroupListEmbed(groups: MemberGroup[]) {
  if (groups.length === 0) return buildInfoEmbed("Groups", "No groups are configured.");
  return buildInfoEmbed("Groups", groupByServer(groups, (group) => group.groupName));
}

function buildRoleListEmbed(configs: MemberGroupRoleConfig[]) {
  if (configs.length === 0) return buildInfoEmbed("Group Roles", "No group roles are configured.");
  return buildInfoEmbed("Group Roles", formatMemberGroupRoleConfigList(configs));
}

function groupByServer<T extends { albionServer: AlbionServer }>(
  items: T[],
  format: (item: T) => string,
): string {
  const sections: string[] = [];
  for (const server of ["americas", "asia", "europe"] as const) {
    const scoped = items.filter((item) => item.albionServer === server);
    if (scoped.length === 0) continue;
    sections.push(`**${serverGroupTitle(server)}**\n${scoped.map(format).join("\n")}`);
  }
  return sections.join("\n\n");
}

function readBooleanChoice(interaction: ChatInputCommandInteraction, optionName: string): boolean {
  return interaction.options.getString(optionName, true) === TRUE_CHOICE_VALUE;
}
