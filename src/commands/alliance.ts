import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Role
} from "discord.js";
import type {
  ConfiguredAlbionAlliance,
  MemberGroupRoleConfig,
  createMembershipRepository
} from "../db/membershipRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import type { AlbionClient } from "../services/albion/client.js";
import { getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import type { AlbionAlliance } from "../services/albion/types.js";
import {
  INFO_COLOR,
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

export const allianceCommand = new SlashCommandBuilder()
  .setName("alliance")
  .setDescription("Look up and configure Albion Online alliances.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("lookup")
      .setDescription("Look up an Albion Online alliance by ID.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("id").setDescription("Albion Online alliance ID.").setMinLength(1).setMaxLength(128).setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Configure an Albion Online alliance definition.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("id").setDescription("Albion Online alliance ID.").setMinLength(1).setMaxLength(128).setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove an Albion Online alliance definition.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("alliance").setDescription("Configured Albion Online alliance.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List configured Albion Online alliance definitions.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("report")
      .setDescription("List member profiles for a configured Albion Online alliance.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("alliance").setDescription("Configured Albion Online alliance.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("roles")
      .setDescription("Configure roles for Albion Online alliance definitions.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Configure a role for an Albion Online alliance.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("alliance").setDescription("Configured Albion Online alliance.").setRequired(true).setAutocomplete(true)
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Discord role.").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a configured alliance role.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("alliance").setDescription("Configured Albion Online alliance.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("role").setDescription("Configured Discord role.").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List configured alliance roles.")
      )
  );

export async function handleAllianceCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  scheduleRepository: MemberGroupReportScheduleRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "roles") {
    await handleAllianceRoleCommand(interaction, membershipRepository, subcommand);
    return;
  }

  if (subcommand === "list") {
    const alliances = await membershipRepository.listConfiguredAlbionAlliances(interaction.guildId!);
    await interaction.reply(feedbackReply({ structured: alliances.length > 0, cards: [buildAllianceListEmbed(alliances)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  if (subcommand === "lookup") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const alliance = await albionClient.getAlliance(server, interaction.options.getString("id", true).trim());
    await interaction.editReply(v2Edit({ cards: [buildAllianceLookupEmbed(server, alliance)] }));
    return;
  }

  if (subcommand === "add") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const alliance = await albionClient.getAlliance(server, interaction.options.getString("id", true).trim());
    await membershipRepository.configureAlbionAlliance({
      discordGuildId: interaction.guildId!,
      albionServer: server,
      albionAllianceId: alliance.id,
      albionAllianceName: alliance.name,
      albionAllianceTag: alliance.tag
    });
    await editFeedback(interaction, { cards: [buildSuccessEmbed("Alliance Configured", `${formatAllianceGroupLabel({ albionAllianceName: alliance.name, albionAllianceTag: alliance.tag, albionServer: server })} was configured as a member group.`)] });
    return;
  }

  if (subcommand === "remove" || subcommand === "report") {
    const configured = await membershipRepository.getConfiguredAlbionAlliance(
      interaction.guildId!,
      interaction.options.getString("alliance", true),
      server
    );
    if (!configured) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Alliance Not Found", "Choose a configured alliance from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
      return;
    }

    if (subcommand === "report") {
      await replyWithMemberGroupReport(interaction, membershipRepository, configured, scheduleRepository);
      return;
    }

    await beginMemberGroupRemoval(interaction, membershipRepository, configured, formatAllianceGroupLabel(configured));
  }
}

export async function handleAllianceAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "alliance") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }
  if (focused.name === "alliance") {
    await respondConfiguredAllianceAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "role") {
    await respondAllianceRoleAutocomplete(interaction, membershipRepository);
    return true;
  }
  return false;
}

async function handleAllianceRoleCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "list") {
    const configs = await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId!, "alliance");
    await interaction.reply(feedbackReply({ structured: configs.length > 0, cards: [buildRoleListEmbed("Alliance Roles", configs)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  const configured = await membershipRepository.getConfiguredAlbionAlliance(
    interaction.guildId!,
    interaction.options.getString("alliance", true),
    server
  );
  if (!configured) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Alliance Not Found", "Choose a configured alliance from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  if (subcommand === "add") {
    const role = interaction.options.getRole("role", true) as Role;
    if (await membershipRepository.isReactionRoleConfigured(interaction.guildId!, role.id)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Reaction Role Conflict", "A reaction role cannot also be configured as a standard alliance role.")], flags: MessageFlags.Ephemeral }));
      return;
    }
    await membershipRepository.addMemberGroupRoleConfig(configured.memberGroupId, roleOptionId(role));
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Alliance Role Configured", `${formatRole(role.id)} was configured for ${formatAllianceGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "remove") {
    const roleId = interaction.options.getString("role", true);
    const removed = await membershipRepository.removeMemberGroupRoleConfig(interaction.guildId!, configured.memberGroupId, roleId);
    await interaction.reply(feedbackReply({ cards: [removed > 0 ? buildSuccessEmbed("Alliance Role Removed", `${formatRole(roleId)} was removed from ${formatAllianceGroupLabel(configured)}.`) : buildNotFoundEmbed("Alliance Role Not Found", `${formatRole(roleId)} is not configured for ${formatAllianceGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
  }
}

async function respondConfiguredAllianceAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const server = interaction.options.getString("server");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const alliances = (await membershipRepository.listConfiguredAlbionAlliances(interaction.guildId ?? ""))
    .filter((alliance) => !isAlbionServer(server ?? "") || alliance.albionServer === server)
    .filter((alliance) => formatConfiguredAllianceName(alliance).toLocaleLowerCase().includes(query) || alliance.albionAllianceId.toLocaleLowerCase().includes(query))
    .slice(0, 25);

  await interaction.respond(alliances.map((alliance) => ({
    name: truncateChoiceName(formatAllianceGroupLabel(alliance)),
    value: alliance.memberGroupId
  })));
}

async function respondAllianceRoleAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const memberGroupId = interaction.options.getString("alliance");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const configs = (await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId ?? "", "alliance"))
    .filter((config) => !memberGroupId || config.memberGroupId === memberGroupId)
    .filter((config) => roleName(interaction.guild, config.discordRoleId).toLocaleLowerCase().includes(query) || config.discordRoleId.includes(query))
    .slice(0, 25);

  await interaction.respond(configs.map((config) => ({
    name: truncateChoiceName(roleName(interaction.guild, config.discordRoleId)),
    value: config.discordRoleId
  })));
}

function buildAllianceLookupEmbed(server: AlbionServer, alliance: AlbionAlliance): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(formatAllianceName(alliance))
    .addFields(
      { name: "Server", value: getAlbionServerLabel(server), inline: true },
      { name: "Guilds", value: String(alliance.guilds.length), inline: true },
      { name: "Albion Online Alliance ID", value: `\`${alliance.id}\``, inline: false }
    );
}

function buildAllianceListEmbed(alliances: ConfiguredAlbionAlliance[]): EmbedBuilder {
  if (alliances.length === 0) return buildInfoEmbed("Configured Alliances", "No Albion Online alliances are configured.");
  return buildInfoEmbed("Configured Alliances", groupByServer(alliances, (alliance) =>
    `${formatConfiguredAllianceName(alliance)} • \`${alliance.albionAllianceId}\``
  ));
}

function buildRoleListEmbed(title: string, configs: MemberGroupRoleConfig[]): EmbedBuilder {
  if (configs.length === 0) return buildInfoEmbed(title, "No alliance roles are configured.");
  return buildInfoEmbed(title, formatMemberGroupRoleConfigList(configs));
}

function groupByServer<T extends { albionServer: AlbionServer }>(
  items: T[],
  format: (item: T) => string
): string {
  const sections: string[] = [];
  for (const server of ["americas", "asia", "europe"] as const) {
    const scoped = items.filter((item) => item.albionServer === server);
    if (scoped.length === 0) continue;
    sections.push(`**${serverGroupTitle(server)}**\n${scoped.map(format).join("\n")}`);
  }
  return sections.join("\n\n");
}

function formatAllianceName(alliance: AlbionAlliance): string {
  return `${alliance.name}${alliance.tag ? ` [${alliance.tag}]` : ""}`;
}

function formatConfiguredAllianceName(alliance: ConfiguredAlbionAlliance): string {
  return `${alliance.albionAllianceName}${alliance.albionAllianceTag ? ` [${alliance.albionAllianceTag}]` : ""}`;
}

function formatAllianceGroupLabel(alliance: Pick<ConfiguredAlbionAlliance, "albionAllianceName" | "albionAllianceTag" | "albionServer">): string {
  return formatMemberGroupLabel({
    groupName: `${alliance.albionAllianceName}${alliance.albionAllianceTag ? ` [${alliance.albionAllianceTag}]` : ""}`,
    albionServer: alliance.albionServer
  });
}

function readBooleanChoice(interaction: ChatInputCommandInteraction, optionName: string): boolean {
  return interaction.options.getString(optionName, true) === TRUE_CHOICE_VALUE;
}
