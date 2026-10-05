import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Role,
  type StringSelectMenuInteraction
} from "discord.js";
import type {
  ConfiguredAlbionGuild,
  MemberGroupRoleConfig,
  createMembershipRepository
} from "../db/membershipRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import { TAILWIND_500_COLORS } from "../discord/tailwindColors.js";
import type { AlbionClient } from "../services/albion/client.js";
import { getGuildLookupDetails } from "../services/albion/guildLookup.js";
import { isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
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
import {
  GUILD_SEARCH_LIMIT,
  buildGuildLookupDetailsEmbed,
  buildGuildLookupResultsEmbed,
  buildGuildLookupSelectRow,
  parseGuildLookupSelectionCustomId
} from "./guildSelection.js";
import { beginMemberGroupRemoval } from "./memberGroupRemoval.js";
import { replyWithMemberGroupReport, type MemberGroupReportScheduleRepository } from "./memberGroupReport.js";

const TRUE_CHOICE_VALUE = "true";
type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export const guildCommand = new SlashCommandBuilder()
  .setName("guild")
  .setDescription("Look up and configure Albion Online guilds.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("lookup")
      .setDescription("Look up Albion Online guilds by name.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("name").setDescription("Albion Online guild name or partial name.").setMinLength(1).setMaxLength(64).setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Configure an Albion Online guild definition.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("id").setDescription("Albion Online guild ID.").setMinLength(1).setMaxLength(128).setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("managed").setDescription("Track the full Albion Online guild roster later.").setRequired(true)
          .addChoices(
            { name: "Managed", value: TRUE_CHOICE_VALUE },
            { name: "Not Managed", value: "false" }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit an Albion Online guild definition.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("managed").setDescription("Track the full Albion Online guild roster later.").setRequired(true)
          .addChoices(
            { name: "Managed", value: TRUE_CHOICE_VALUE },
            { name: "Not Managed", value: "false" }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove an Albion Online guild definition.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List configured Albion Online guild definitions.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("report")
      .setDescription("List member profiles for a configured Albion Online guild.")
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("default")
      .setDescription("Configure the default Albion Online guild.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set the default Albion Online guild.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("clear").setDescription("Clear the default Albion Online guild.")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("show").setDescription("Show configured defaults.")
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("roles")
      .setDescription("Configure roles for Albion Online guild definitions.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Configure a role for an Albion Online guild.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
          )
          .addRoleOption((option) =>
            option.setName("role").setDescription("Discord role.").setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a configured guild role.")
          .addStringOption((option) =>
            option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("guild").setDescription("Configured Albion Online guild.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option.setName("role").setDescription("Configured Discord role.").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List configured guild roles.")
      )
  );

export async function handleGuildCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  scheduleRepository: MemberGroupReportScheduleRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === "default") {
    await handleGuildDefaultCommand(interaction, membershipRepository, subcommand);
    return;
  }

  if (group === "roles") {
    await handleGuildRoleCommand(interaction, membershipRepository, subcommand);
    return;
  }

  if (subcommand === "list") {
    const guilds = await membershipRepository.listConfiguredAlbionGuilds(interaction.guildId!);
    await interaction.reply(feedbackReply({ structured: guilds.length > 0, cards: [buildGuildListEmbed(guilds)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  if (subcommand === "lookup") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString("name", true).trim();
    const results = (await albionClient.search(server, query)).guilds.slice(0, GUILD_SEARCH_LIMIT);
    await editFeedback(interaction, {
      cards: [buildGuildLookupResultsEmbed(server, query, results)],
      actionRows: results.length > 0
        ? [buildGuildLookupSelectRow(interaction.user.id, server, results)]
        : []
    });
    return;
  }

  if (subcommand === "add") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = await albionClient.getGuild(server, interaction.options.getString("id", true).trim());
    const memberGroup = await membershipRepository.configureAlbionGuild({
      discordGuildId: interaction.guildId!,
      albionServer: server,
      albionGuildId: guild.id,
      albionGuildName: guild.name,
      managed: readBooleanChoice(interaction, "managed")
    });
    await editFeedback(interaction, { cards: [buildSuccessEmbed("Guild Configured", `${formatMemberGroupLabel(memberGroup)} was configured as a member group.`)] });
    return;
  }

  const configured = await membershipRepository.getConfiguredAlbionGuild(
    interaction.guildId!,
    interaction.options.getString("guild", true),
    server
  );
  if (!configured) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Guild Not Found", "Choose a configured guild from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  if (subcommand === "edit") {
    const updated = await membershipRepository.updateConfiguredAlbionGuild(
      interaction.guildId!,
      configured.memberGroupId,
      readBooleanChoice(interaction, "managed")
    );
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Guild Updated", `${formatMemberGroupLabel(updated ?? configured)} is now ${updated?.managed ? "managed" : "unmanaged"}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "report") {
    await replyWithMemberGroupReport(interaction, membershipRepository, configured, scheduleRepository);
    return;
  }

  if (subcommand === "remove") {
    await beginMemberGroupRemoval(interaction, membershipRepository, configured, formatMemberGroupLabel(configured));
  }
}

export async function handleGuildLookupSelect(
  interaction: StringSelectMenuInteraction,
  albionClient: AlbionClient
): Promise<boolean> {
  const parsed = parseGuildLookupSelectionCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      text: "This selection can only be used in a server.", accentColor: TAILWIND_500_COLORS.Yellow,
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (interaction.user.id !== parsed.requesterDiscordUserId) {
    await interaction.reply(feedbackReply({
      text: "Only the person who started this guild lookup can use this selection.", accentColor: TAILWIND_500_COLORS.Red,
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = await getGuildLookupDetails(albionClient, parsed.server, interaction.values[0]);
  await interaction.editReply(v2Edit({ cards: [buildGuildLookupDetailsEmbed(parsed.server, guild)] }));
  return true;
}

export async function handleGuildAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "guild") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }

  if (focused.name === "guild") {
    await respondConfiguredGuildAutocomplete(interaction, membershipRepository);
    return true;
  }

  if (focused.name === "role") {
    await respondGuildRoleAutocomplete(interaction, membershipRepository);
    return true;
  }

  return false;
}

async function handleGuildDefaultCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "show") {
    const defaultGuild = await membershipRepository.getDefaultAlbionGuild(interaction.guildId!);
    await interaction.reply(feedbackReply({
      cards: [buildDefaultShowEmbed(defaultGuild)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  if (subcommand === "clear") {
    const cleared = await membershipRepository.clearDefaultAlbionGuild(interaction.guildId!);
    await interaction.reply(feedbackReply({
      cards: [
        cleared
          ? buildSuccessEmbed("Default Guild Cleared", "The default Albion Online guild was cleared.")
          : buildInfoEmbed("No Default Guild", "No default Albion Online guild is currently configured.")
      ],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  if (subcommand === "set") {
    const configured = await membershipRepository.setDefaultAlbionGuild(
      interaction.guildId!,
      interaction.options.getString("guild", true),
      server
    );

    if (!configured) {
      await interaction.reply(feedbackReply({
        cards: [buildNotFoundEmbed("Guild Not Found", "Choose a configured guild from autocomplete.")],
        flags: MessageFlags.Ephemeral
      }, "context"));
      return;
    }

    await interaction.reply(feedbackReply({
      cards: [
        buildSuccessEmbed(
          "Default Guild Set",
          `${formatMemberGroupLabel(configured)} is now the default Albion Online guild.`
        )
      ],
      flags: MessageFlags.Ephemeral
    }));
  }
}

async function handleGuildRoleCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "list") {
    const configs = await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId!, "guild");
    await interaction.reply(feedbackReply({ structured: configs.length > 0, cards: [buildRoleListEmbed("Guild Roles", configs)], flags: MessageFlags.Ephemeral }));
    return;
  }

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  const configured = await membershipRepository.getConfiguredAlbionGuild(
    interaction.guildId!,
    interaction.options.getString("guild", true),
    server
  );
  if (!configured) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Guild Not Found", "Choose a configured guild from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  if (subcommand === "add") {
    const role = interaction.options.getRole("role", true) as Role;
    if (await membershipRepository.isReactionRoleConfigured(interaction.guildId!, role.id)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Reaction Role Conflict", "A reaction role cannot also be configured as a standard guild role.")], flags: MessageFlags.Ephemeral }));
      return;
    }
    await membershipRepository.addMemberGroupRoleConfig(configured.memberGroupId, roleOptionId(role));
    await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Guild Role Configured", `${formatRole(role.id)} was configured for ${formatMemberGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  if (subcommand === "remove") {
    const roleId = interaction.options.getString("role", true);
    const removed = await membershipRepository.removeMemberGroupRoleConfig(interaction.guildId!, configured.memberGroupId, roleId);
    await interaction.reply(feedbackReply({ cards: [removed > 0 ? buildSuccessEmbed("Guild Role Removed", `${formatRole(roleId)} was removed from ${formatMemberGroupLabel(configured)}.`) : buildNotFoundEmbed("Guild Role Not Found", `${formatRole(roleId)} is not configured for ${formatMemberGroupLabel(configured)}.`)], flags: MessageFlags.Ephemeral }));
  }
}

async function respondConfiguredGuildAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const server = interaction.options.getString("server");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const guilds = (await membershipRepository.listConfiguredAlbionGuilds(interaction.guildId ?? ""))
    .filter((guild) => !isAlbionServer(server ?? "") || guild.albionServer === server)
    .filter((guild) => guild.albionGuildName.toLocaleLowerCase().includes(query) || guild.albionGuildId.toLocaleLowerCase().includes(query))
    .slice(0, 25);

  await interaction.respond(guilds.map((guild) => ({
    name: truncateChoiceName(formatMemberGroupLabel(guild)),
    value: guild.memberGroupId
  })));
}

async function respondGuildRoleAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const memberGroupId = interaction.options.getString("guild");
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const configs = (await membershipRepository.listMemberGroupRoleConfigs(interaction.guildId ?? "", "guild"))
    .filter((config) => !memberGroupId || config.memberGroupId === memberGroupId)
    .filter((config) => roleName(interaction.guild, config.discordRoleId).toLocaleLowerCase().includes(query) || config.discordRoleId.includes(query))
    .slice(0, 25);

  await interaction.respond(configs.map((config) => ({
    name: truncateChoiceName(roleName(interaction.guild, config.discordRoleId)),
    value: config.discordRoleId
  })));
}

function buildGuildListEmbed(guilds: ConfiguredAlbionGuild[]): EmbedBuilder {
  if (guilds.length === 0) return buildInfoEmbed("Configured Guilds", "No Albion Online guilds are configured.");
  return buildInfoEmbed("Configured Guilds", groupByServer(guilds, (guild) =>
    `${guild.groupName} • ${guild.managed ? "managed" : "unmanaged"} • \`${guild.albionGuildId}\``
  ));
}

function buildRoleListEmbed(title: string, configs: MemberGroupRoleConfig[]): EmbedBuilder {
  if (configs.length === 0) return buildInfoEmbed(title, "No guild roles are configured.");
  return buildInfoEmbed(title, formatMemberGroupRoleConfigList(configs));
}

function buildDefaultShowEmbed(defaultGuild: ConfiguredAlbionGuild | undefined): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Defaults")
    .setDescription(defaultGuild
      ? `Default Albion Online guild: ${formatMemberGroupLabel(defaultGuild)}.`
      : "No default Albion Online guild is configured.");
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

function readBooleanChoice(interaction: ChatInputCommandInteraction, optionName: string): boolean {
  return interaction.options.getString(optionName, true) === TRUE_CHOICE_VALUE;
}
