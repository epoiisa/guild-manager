import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Role,
  type StringSelectMenuInteraction
} from "discord.js";
import { CharacterAlreadyRegisteredError, CharacterRecoveryRequiredError, CharacterRegistrationLimitError, MembershipLifecycleConflictError, MembershipRecoveryVerificationUnavailableError, type RegisteredCharacter, type createMembershipRepository } from "../db/membershipRepository.js";
import { fetchGuildMemberIfPresent } from "../discord/guildMembers.js";
import { KickCleanupPendingError, MemberAccessBlockedError } from "../db/memberAccessRepository.js";
import { retainsAuthority } from "../services/membership/kick.js";
import { inspectKickCommandPermissions } from "../services/membership/kickCommandPermissions.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import { TAILWIND_500_COLORS } from "../discord/tailwindColors.js";
import type { AlbionClient } from "../services/albion/client.js";
import {
  ALBION_SERVER_VALUES,
  getAlbionServerLabel,
  isAlbionServer,
  type AlbionServer
} from "../services/albion/servers.js";
import type { AlbionPlayer, AlbionSearchPlayer } from "../services/albion/types.js";
import { applyEffectiveNickname, cleanupConfiguredRoles, reconcileConfiguredRoles } from "../services/membership/discordMemberUpdates.js";
import { reconcileRegisteredCharacterMembership } from "../services/membership/reconciliation.js";
import { verifyConfiguredCharacterMemberships } from "../services/membership/departureVerification.js";
import { recordLogChange } from "../services/logFeed/events.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import {
  CHARACTER_SEARCH_LIMIT,
  buildCharacterLookupDetailsEmbed,
  buildCharacterLookupResultsEmbed,
  buildCharacterLookupSelectRow,
  buildCharacterSearchResultsEmbed,
  buildCharacterSearchSelectRow,
  parseCharacterSelectionCustomId
} from "./characterSelection.js";
import {
  ALL_SERVERS_VALUE,
  INVALID_COLOR,
  buildInfoEmbed,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatCharacterUserMentionPair,
  formatRole,
  normalizeQuery,
  readAlbionServer,
  rejectNonGuildInteraction,
  respondInvalidServer,
  respondServerAutocomplete,
  roleName,
  roleOptionId,
  serverScopeLabel,
  truncateChoiceName
} from "./configurationHelpers.js";

import { handleCharacterStatusCommand } from "./characterStatus.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

const TRUE_CHOICE_VALUE = "true";
const CHARACTER_SWITCH_SELECT_PREFIX = "cs:";

export const characterCommand = new SlashCommandBuilder()
  .setName("character")
  .setDescription("Search, register, switch, and configure Albion Online characters.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("register")
      .setDescription("Register an Albion Online character to a Discord user.")
      .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
      .addStringOption((option) => option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("character").setDescription("Albion Online character name or partial name.").setMinLength(1).setMaxLength(64).setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("unregister")
      .setDescription("Unregister an exact user-character pairing.")
      .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
      .addStringOption((option) => option.setName("character").setDescription("Registered character.").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("switch")
      .setDescription("Switch a user's registration from one character to another.")
      .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
      .addStringOption((option) => option.setName("from").setDescription("Currently registered character.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("server").setDescription("Replacement character's Albion Online server.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("to").setDescription("Replacement Albion Online character name or partial name.").setMinLength(1).setMaxLength(64).setRequired(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("lookup")
      .setDescription("Look up an Albion Online character.")
      .addStringOption((option) =>
        option
          .setName("server")
          .setDescription("Albion Online server.")
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Albion Online character name or partial name.")
          .setMinLength(1)
          .setMaxLength(64)
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) => subcommand
    .setName("status")
    .setDescription("Show an exact Albion Online character’s stored registration and entitlements.")
    .addStringOption((option) => option.setName("character").setDescription("Stored Albion Online character.").setRequired(true).setAutocomplete(true))
  )
  .addSubcommandGroup((group) =>
    group
      .setName("roles")
      .setDescription("Configure roles for registered Albion Online characters.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Configure a Discord role for registered characters.")
          .addStringOption((option) =>
            option
              .setName("server")
              .setDescription("Albion Online server or all servers.")
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addRoleOption((option) =>
            option
              .setName("role")
              .setDescription("Discord role.")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a configured character role.")
          .addStringOption((option) =>
            option
              .setName("server")
              .setDescription("Albion Online server or all servers.")
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addStringOption((option) =>
            option
              .setName("role")
              .setDescription("Configured Discord role.")
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List configured character roles.")
      )
  );

export async function handleCharacterCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) {
    return;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (subcommandGroup === "roles") {
    await handleCharacterRoleCommand(interaction, membershipRepository, subcommand);
    return;
  }

  if (!subcommandGroup && subcommand === "register") {
    await handleCharacterRegisterCommand(interaction, albionClient, membershipRepository, regearObserver);
    return;
  }

  if (!subcommandGroup && subcommand === "unregister") {
    await handleCharacterUnregisterCommand(interaction, membershipRepository, regearObserver);
    return;
  }

  if (!subcommandGroup && subcommand === "switch") {
    await handleCharacterSwitchCommand(interaction, albionClient, membershipRepository, regearObserver);
    return;
  }

  if (!subcommandGroup && subcommand === "status") {
    await handleCharacterStatusCommand(interaction, membershipRepository);
    return;
  }

  if (!subcommandGroup && subcommand === "lookup") {
    await handleCharacterLookupCommand(interaction, albionClient);
    return;
  }

  await interaction.reply(feedbackReply({
    text: "Unknown character subcommand.", accentColor: TAILWIND_500_COLORS.Yellow,
    flags: MessageFlags.Ephemeral
  }));
}

async function handleCharacterRegisterCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const characterName = interaction.options.getString("character", true).trim();

  const search = await albionClient.searchCharacters(server, characterName);
  const players = search.players.slice(0, CHARACTER_SEARCH_LIMIT);

  if (players.length === 0) {
    await editFeedback(interaction, {
      cards: [buildCharacterSearchResultsEmbed(server, characterName, players)]
    });
    return;
  }

  if (players.length > 1) {
    await interaction.editReply(v2Edit({
      cards: [buildCharacterSearchResultsEmbed(server, characterName, players, `Select a character to register to ${user.username}.`)],
      actionRows: [buildCharacterSearchSelectRow("character-register", interaction.user.id, server, players, user.id)]
    }));
    return;
  }

  await completeCharacterRegistration(interaction, albionClient, membershipRepository, server, players[0].id, user.id, regearObserver);
}

async function handleCharacterUnregisterCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const character = await requireRegisteredCharacterOption(interaction, membershipRepository, user.id);
  if (!character) return;
  await membershipRepository.unregisterCharacter(character);
  if (interaction.guild && regearObserver) {
    await regearObserver.observeCharacterRegistration(interaction.guild, character.albionServer, character.albionCharacterId);
  }
  const warnings = interaction.guild
    ? [
      ...await cleanupConfiguredRoles(interaction.guild, membershipRepository, user.id),
      ...await applyEffectiveNickname(interaction.guild, membershipRepository, user.id)
    ]
    : [];
  await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Character Unregistered", `${character.characterName} was unregistered from ${user} and profiles were left orphaned.${formatWarnings(warnings)}`)], flags: MessageFlags.Ephemeral }));
}

async function handleCharacterSwitchCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const from = await requireRegisteredCharacterOption(interaction, membershipRepository, user.id, "from");
  if (!from) return;

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const query = interaction.options.getString("to", true).trim();
  const search = await albionClient.searchCharacters(server, query);
  const players = search.players.slice(0, CHARACTER_SEARCH_LIMIT);

  if (players.length === 0) {
    await editFeedback(interaction, {
      cards: [buildCharacterSearchResultsEmbed(server, query, players)]
    });
    return;
  }

  if (players.length > 1) {
    await interaction.editReply(v2Edit({
      cards: [
        buildCharacterSearchResultsEmbed(
          server,
          query,
          players,
          `Select the replacement character for ${from.characterName} registered to ${user.username}.`
        )
      ],
      actionRows: [buildCharacterSwitchSelectRow(interaction.user.id, user.id, from, server, players)]
    }));
    return;
  }

  const player = await albionClient.getPlayer(server, players[0].id);
  await completeCharacterSwitch(interaction, albionClient, membershipRepository, from, server, player, user.id, regearObserver);
}

async function handleCharacterLookupCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient
): Promise<void> {
  const query = interaction.options.getString("name", true).trim();
  const serverOption = interaction.options.getString("server", true);

  if (!isAlbionServer(serverOption)) {
    await interaction.reply(feedbackReply({
      cards: [buildInvalidServerEmbed(serverOption)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await albionClient.searchCharacters(serverOption, query);
  const players = result.players.slice(0, CHARACTER_SEARCH_LIMIT);

  await editFeedback(interaction, {
    cards: [buildCharacterLookupResultsEmbed(serverOption, query, players)],
    actionRows: players.length > 0
      ? [buildCharacterLookupSelectRow(interaction.user.id, serverOption, players)]
      : []
  });
}

async function handleCharacterRoleCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "list") {
    const configs = await membershipRepository.listCharacterRoleConfigs(interaction.guildId!);
    await interaction.reply(feedbackReply({
      structured: configs.length > 0,
      cards: [buildCharacterRoleListEmbed(configs)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const serverScope = readAlbionServer(interaction, true);
  if (!serverScope) {
    await respondInvalidServer(interaction, true);
    return;
  }

  const albionServer = serverScope === ALL_SERVERS_VALUE ? undefined : serverScope;

  if (subcommand === "add") {
    const role = interaction.options.getRole("role", true) as Role;
    if (await membershipRepository.isReactionRoleConfigured(interaction.guildId!, role.id)) {
      await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Reaction Role Conflict", "A reaction role cannot also be configured as a standard character role.")], flags: MessageFlags.Ephemeral }));
      return;
    }
    await membershipRepository.addCharacterRoleConfig(interaction.guildId!, albionServer, roleOptionId(role));
    await interaction.reply(feedbackReply({
      cards: [
        buildSuccessEmbed(
          "Character Role Configured",
          `${formatRole(role.id)} applies to registered characters for ${serverScopeLabel(serverScope)}.`
        )
      ],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  if (subcommand === "remove") {
    const roleId = interaction.options.getString("role", true);
    const removed = await membershipRepository.removeCharacterRoleConfig(interaction.guildId!, albionServer, roleId);
    await interaction.reply(feedbackReply({
      cards: [
        removed
          ? buildSuccessEmbed(
            "Character Role Removed",
            `${formatRole(roleId)} was removed from ${serverScopeLabel(serverScope)} Albion Online character role configuration.`
          )
          : buildNotFoundEmbed(
            "Character Role Not Found",
            `${formatRole(roleId)} is not configured for ${serverScopeLabel(serverScope)}.`
          )
      ],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  await interaction.reply(feedbackReply({
    text: "Unknown character roles subcommand.", accentColor: TAILWIND_500_COLORS.Yellow,
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleCharacterAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "character") {
    return false;
  }

  const focusedOption = interaction.options.getFocused(true);
  if (focusedOption.name === "character" && interaction.options.getSubcommand(false) === "status") {
    const choices = interaction.guildId ? await membershipRepository.listCharacterStatusChoices(interaction.guildId, String(focusedOption.value).trim()) : [];
    await interaction.respond(choices.map(c => ({ name: truncateChoiceName(`${c.characterName} • ${getAlbionServerLabel(c.albionServer)} • ${c.albionCharacterId}`), value: `${c.albionServer}:${c.albionCharacterId}` })));
    return true;
  }

  if (focusedOption.name === "server") {
    await respondServerAutocomplete(interaction, interaction.options.getSubcommandGroup(false) === "roles");
    return true;
  }

  if (focusedOption.name === "character" && interaction.options.getSubcommand(false) === "unregister") {
    await respondRegisteredCharacterAutocomplete(interaction, membershipRepository);
    return true;
  }

  if (focusedOption.name === "from" && interaction.options.getSubcommand(false) === "switch") {
    await respondRegisteredCharacterAutocomplete(interaction, membershipRepository);
    return true;
  }

  if (focusedOption.name !== "role" || interaction.options.getSubcommandGroup(false) !== "roles") {
    return false;
  }

  const server = interaction.options.getString("server");
  const query = normalizeQuery(focusedOption.value);
  const configs = (await membershipRepository.listCharacterRoleConfigs(interaction.guildId ?? ""))
    .filter((config) =>
      server === ALL_SERVERS_VALUE
        ? !config.albionServer
        : isAlbionServer(server ?? "") && config.albionServer === server
    )
    .filter((config) => {
      const name = roleName(interaction.guild, config.discordRoleId);
      return name.toLocaleLowerCase().includes(query) || config.discordRoleId.includes(query);
    })
    .slice(0, 25);

  await interaction.respond(configs.map((config) => ({
    name: `${roleName(interaction.guild, config.discordRoleId)} • ${serverScopeLabel(config.albionServer)}`,
    value: config.discordRoleId
  })));
  return true;
}

export async function handleCharacterRegisterSelect(
  interaction: StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<boolean> {
  if (await handleCharacterSwitchSelect(interaction, albionClient, membershipRepository, regearObserver)) {
    return true;
  }

  const parsed = parseCharacterSelectionCustomId(interaction.customId);
  if (!parsed || (parsed.action !== "character-register" && parsed.action !== "member-register")) {
    return false;
  }

  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Server Only", "This selection can only be used in a Discord server.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (interaction.user.id !== parsed.requesterDiscordUserId) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Selection Not Allowed", "Only the person who started this character registration can use this selection.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (!parsed.targetDiscordUserId) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Invalid Selection", "That character registration selection is no longer valid. Run `/character register` again.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  await interaction.deferUpdate();
  await completeCharacterRegistration(
    interaction,
    albionClient,
    membershipRepository,
    parsed.server,
    interaction.values[0],
    parsed.targetDiscordUserId,
    regearObserver
  );
  return true;
}

async function handleCharacterSwitchSelect(
  interaction: StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<boolean> {
  const parsed = parseCharacterSwitchCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Server Only", "This selection can only be used in a Discord server.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (interaction.user.id !== parsed.requesterDiscordUserId) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed("Selection Not Allowed", "Only the person who started this character switch can use this selection.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  await interaction.deferUpdate();
  const from = await membershipRepository.getRegisteredCharacterForUser(
    interaction.guildId,
    parsed.targetDiscordUserId,
    parsed.fromAlbionServer,
    parsed.fromAlbionCharacterId
  );

  if (!from) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Registration Not Found", "That character switch selection is no longer valid. Run `/character switch` again.")],
      actionRows: []
    }, "body", true);
    return true;
  }

  const player = await albionClient.getPlayer(parsed.toAlbionServer, interaction.values[0]);
  await completeCharacterSwitch(
    interaction,
    albionClient,
    membershipRepository,
    from,
    parsed.toAlbionServer,
    player,
    parsed.targetDiscordUserId,
    regearObserver
  );
  return true;
}

export async function handleCharacterLookupSelect(
  interaction: StringSelectMenuInteraction,
  albionClient: AlbionClient
): Promise<boolean> {
  const parsed = parseCharacterSelectionCustomId(interaction.customId);
  if (!parsed || parsed.action !== "lookup") {
    return false;
  }

  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      text: "This selection can only be used in a server.", accentColor: TAILWIND_500_COLORS.Yellow,
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (interaction.user.id !== parsed.requesterDiscordUserId) {
    await interaction.reply(feedbackReply({
      text: "Only the person who started this character lookup can use this selection.", accentColor: TAILWIND_500_COLORS.Red,
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const player = await albionClient.getPlayer(parsed.server, interaction.values[0]);
  await interaction.editReply(v2Edit({
    cards: [buildCharacterLookupDetailsEmbed(parsed.server, player)]
  }));
  return true;
}

function buildInvalidServerEmbed(serverOption: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(INVALID_COLOR)
    .setTitle("Invalid Albion Online Server")
    .setDescription(`Choose one of: ${ALBION_SERVER_VALUES.map(getAlbionServerLabel).join(", ")}.`)
    .setFooter({ text: `Received: ${serverOption}` });
}

function buildCharacterRoleListEmbed(configs: Array<{
  albionServer?: AlbionServer;
  discordRoleId: string;
}>): EmbedBuilder {
  if (configs.length === 0) {
    return buildInfoEmbed("Character Roles", "No character roles are configured.");
  }

  const formatScopedConfigs = (scoped: typeof configs): string => scoped.map((config) => formatRole(config.discordRoleId)).join("\n");

  const allServers = configs.filter((config) => !config.albionServer);
  const lines = [
    allServers.length > 0 ? `**All Servers**\n${formatScopedConfigs(allServers)}` : undefined,
    ...ALBION_SERVER_VALUES.map((server) => {
      const scoped = configs.filter((config) => config.albionServer === server);
      return scoped.length > 0
        ? `**${getAlbionServerLabel(server)}**\n${formatScopedConfigs(scoped)}`
        : undefined;
    })
  ].filter((line) => line !== undefined);

  return buildInfoEmbed("Character Roles", lines.join("\n\n"));
}

async function completeCharacterRegistration(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  server: AlbionServer,
  characterId: string,
  targetDiscordUserId: string,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (!interaction.guild || !await fetchGuildMemberIfPresent(interaction.guild, targetDiscordUserId)) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Member Not In Server", "The selected user must be in this Discord server before an officer can register their character.")],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }
  const existing = await membershipRepository.getRegisteredCharacter(interaction.guildId!, server, characterId);
  if (existing && existing.discordUserId !== targetDiscordUserId) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Character Already Registered", `${formatCharacterUserMentionPair(existing.characterName, existing.discordUserId)} is already registered.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  // Snapshot before remote verification: the transaction rejects any departure,
  // expiry, or recovery that changed this character while the checks ran.
  const [registrationLifecycle, profiles, kickSnapshot, memberAccess, authorityRoleIds] = await Promise.all([
    membershipRepository.getCharacterRegistrationLifecycle(interaction.guildId!, server, characterId),
    membershipRepository.listProfilesForCharacter(interaction.guildId!, server, characterId),
    membershipRepository.getKickRecoverySnapshot(interaction.guildId!, targetDiscordUserId, server, characterId),
    membershipRepository.getMemberAccess(interaction.guildId!, targetDiscordUserId),
    membershipRepository.listKickAuthorityRoleIds(interaction.guildId!)
  ]);
  if (memberAccess?.cleanupPending) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Kick Cleanup Pending", "Resolve the remaining kick cleanup before reconnecting this user. Guild Manager access remains blocked.")], actionRows: [] }, "body", "message" in interaction);
    return;
  }
  const player = await albionClient.getPlayer(server, characterId);
  if (player.id !== characterId || !player.name?.trim()) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Character Verification Unavailable", "The selected Albion Online character could not be verified. No registration was changed; try `/character register` again.")],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }
  const verified = await verifyConfiguredCharacterMemberships(interaction.guildId!, albionClient, membershipRepository, server, player);
  const currentMember = await fetchGuildMemberIfPresent(interaction.guild, targetDiscordUserId);
  if (!currentMember) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Member Not In Server", "The selected user left this Discord server before registration could be completed.")],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }
  const { characterKickRecoveryRequired, ...kickRevisions } = kickSnapshot;
  let kickAuthorityRoleIds: string[] | undefined;
  if (memberAccess?.blocked || characterKickRecoveryRequired) {
    let directCommandAuthority = false;
    try {
      const roles = await interaction.guild.roles.fetch();
      const administrativeRoles = [...roles.values()]
        .filter(role => role.permissions.has(PermissionFlagsBits.Administrator)).map(role => role.id);
      // Inspect all roles: recovery must not automatically add authority that
      // became eligible/configured while the member or character was disconnected.
      const grants = await inspectKickCommandPermissions(interaction.guild, targetDiscordUserId, roles.keys());
      kickAuthorityRoleIds = [...new Set([...authorityRoleIds, ...administrativeRoles, ...grants.roleIds])];
      directCommandAuthority = grants.requiresManualRemoval;
    } catch {
      await editFeedback(interaction, { cards: [buildNotFoundEmbed("Command Access Review Required", "Discord role and command permissions could not be checked. Try reconnection again once Discord is available.")], actionRows: [] }, "body", "message" in interaction);
      return;
    }
    // A different, unblocked owner keeps independently granted authority. The
    // snapshot suppresses automatic additions; it does not demote that owner.
    if (memberAccess?.blocked && retainsAuthority(interaction.guild, currentMember, [...memberAccess.revokedRoleIds, ...kickAuthorityRoleIds])) {
      await editFeedback(interaction, { cards: [buildNotFoundEmbed("Authority Removal Required", "Remove this user's former manager/reviewer and Administrator access before reconnection. Guild Manager access remains blocked.")], actionRows: [] }, "body", "message" in interaction);
      return;
    }
    if (memberAccess?.blocked && directCommandAuthority) {
      await editFeedback(interaction, { cards: [buildNotFoundEmbed("Command Access Review Required", "Remove this user's administrative command grants in Discord Integrations before reconnection.")], actionRows: [] }, "body", "message" in interaction);
      return;
    }
  }

  let registered;
  try {
    registered = await membershipRepository.registerCharacterAndAdoptOrphans({
      discordGuildId: interaction.guildId!,
      discordUserId: targetDiscordUserId,
      albionServer: server,
      player,
      recovery: {
        ...kickRevisions,
        ...(kickAuthorityRoleIds ? { kickAuthorityRoleIds } : {}),
        expectedRegistrationRevision: registrationLifecycle?.revision ?? null,
        expectedProfileRevisions: Object.fromEntries(profiles.map(profile => [profile.memberGroupId, profile.lifecycleRevision ?? 0])),
        verifiedMemberGroupIds: verified.qualifiedGroupIds,
        unavailableMemberGroupIds: verified.unavailableGroupIds
      }
    });
  } catch (error) {
    const feedback = error instanceof KickCleanupPendingError
      ? ["Kick Cleanup Pending", "Resolve the remaining kick cleanup before reconnecting this user. Guild Manager access remains blocked."]
      : error instanceof MemberAccessBlockedError
      ? ["Officer Reconnection Required", "This user's kick state changed. Run /character register again after cleanup completes."]
      : error instanceof MembershipRecoveryVerificationUnavailableError
      ? ["Membership Verification Unavailable", "A preserved Albion Online membership could not be verified. Recovery remains pending; run `/character register` again when verification is available."]
      : error instanceof MembershipLifecycleConflictError
      ? ["Membership Changed", "The character's membership changed during verification. Run `/character register` again to recover its current state."]
      : error instanceof CharacterAlreadyRegisteredError
        ? ["Character Already Registered", "The character was registered to another Discord user during verification."]
        : error instanceof CharacterRegistrationLimitError
          ? ["Character Registration Limit Reached", `A Discord user can have at most ${error.limit} registered characters in this server. Unregister one before adding another.`]
          : undefined;
    if (!feedback) throw error;
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed(feedback[0], feedback[1])],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }
  const warnings = interaction.guild
    ? [
      ...verified.warnings,
      ...await reconcileConfiguredRoles(interaction.guild, membershipRepository, targetDiscordUserId),
      ...await applyEffectiveNickname(interaction.guild, membershipRepository, targetDiscordUserId)
    ]
    : [];
  const observation = interaction.guild && regearObserver
    ? await regearObserver.observeCharacterRegistration(interaction.guild, server, registered.albionCharacterId)
    : undefined;
  warnings.push(...observation?.warnings ?? []);
  const pendingNotice = observation?.hasPendingClaims ? `\n${registered.characterName} has pending re-gear requests.` : "";
  if (registrationLifecycle) recordLogChange(interaction.guildId!, {
    kind: "membershipLifecycle", action: "restored", characterName: registered.characterName,
    albionServer: server, discordUserId: targetDiscordUserId
  });
  await editFeedback(interaction, {
    cards: [buildSuccessEmbed("Character Registered", `${formatCharacterUserMentionPair(registered.characterName, targetDiscordUserId)} was registered.${pendingNotice}${formatWarnings(warnings)}`)],
    actionRows: []
  }, "body", "message" in interaction);
}

async function completeCharacterSwitch(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  from: RegisteredCharacter,
  server: AlbionServer,
  player: AlbionPlayer,
  targetDiscordUserId: string,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (from.albionServer === server && from.albionCharacterId === player.id) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Same Character", `${formatCharacterUserMentionPair(player.name, targetDiscordUserId)} is already registered.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  let result;
  try {
    result = await membershipRepository.switchRegisteredCharacter({
      discordGuildId: interaction.guildId!,
      discordUserId: targetDiscordUserId,
      fromAlbionServer: from.albionServer,
      fromAlbionCharacterId: from.albionCharacterId,
      toAlbionServer: server,
      player
    });
  } catch (error) {
    if (!(error instanceof CharacterRecoveryRequiredError)) throw error;
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Officer Recovery Required", "This character requires recovery through `/character register` before it can be used in a character switch.")],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  if (result.existing) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Character Already Registered", `${formatCharacterUserMentionPair(player.name, result.existing.discordUserId)} is already registered.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  if (!result.from || !result.to) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Registration Not Found", "The original registration no longer exists. Run `/character switch` again.")],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  const warnings = interaction.guild
    ? [
      ...await reconcileRegisteredCharacterMembership(interaction.guild, albionClient, membershipRepository, targetDiscordUserId, player, server),
      ...await cleanupConfiguredRoles(interaction.guild, membershipRepository, targetDiscordUserId),
      ...await applyEffectiveNickname(interaction.guild, membershipRepository, targetDiscordUserId)
    ]
    : [];
  let pendingNotice = "";
  if (interaction.guild && regearObserver) {
    await regearObserver.observeCharacterRegistration(interaction.guild, result.from.albionServer, result.from.albionCharacterId);
    if ((await regearObserver.observeCharacterRegistration(interaction.guild, result.to.albionServer, result.to.albionCharacterId)).hasPendingClaims) {
      pendingNotice = `\n${result.to.characterName} has pending re-gear requests.`;
    }
  }
  const mergeNote = result.mergedOrphanProfiles > 0
    ? ` ${result.mergedOrphanProfiles} duplicate orphaned profile${result.mergedOrphanProfiles === 1 ? " was" : "s were"} merged.`
    : "";
  await editFeedback(interaction, {
    structured: result.mergedOrphanProfiles > 0,
    cards: [
      buildSuccessEmbed(
        "Character Registration Switched",
        `Switched ${result.from.characterName} to ${result.to.characterName} for <@${targetDiscordUserId}>; ${result.switchedProfiles} profile${result.switchedProfiles === 1 ? "" : "s"} moved.${mergeNote}${pendingNotice}${formatWarnings(warnings)}`
      )
    ],
    actionRows: []
  }, "body", "message" in interaction);
}

async function requireRegisteredCharacterOption(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  requiredUserId?: string,
  optionName = "character"
): Promise<RegisteredCharacter | undefined> {
  const ref = parseCharacterRef(interaction.options.getString(optionName, true));
  if (!ref) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Character Not Found", "Choose a registered character from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
    return undefined;
  }
  const registered = requiredUserId
    ? await membershipRepository.getRegisteredCharacterForUser(interaction.guildId!, requiredUserId, ref.server, ref.characterId)
    : await membershipRepository.getRegisteredCharacter(interaction.guildId!, ref.server, ref.characterId);
  if (!registered) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Registration Not Found", "Choose an actively registered character from autocomplete.")], flags: MessageFlags.Ephemeral }, "context"));
  }
  return registered;
}

async function respondRegisteredCharacterAutocomplete(interaction: AutocompleteInteraction, membershipRepository: MembershipRepository): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const userOption = interaction.options.get("user");
  const userId = typeof userOption?.value === "string" ? userOption.value : undefined;
  const characters = (await membershipRepository.listRegisteredCharacters(interaction.guildId ?? "", userId))
    .filter((character) => character.characterName.toLocaleLowerCase().includes(query) || getAlbionServerLabel(character.albionServer).toLocaleLowerCase().includes(query))
    .slice(0, 25);
  await interaction.respond(characters.map((character) => ({
    name: truncateChoiceName(`${character.characterName} • ${getAlbionServerLabel(character.albionServer)}`),
    value: formatCharacterRef(character)
  })));
}

function parseCharacterRef(value: string): { server: AlbionServer; characterId: string } | undefined {
  const [server, ...rest] = value.split(":");
  const characterId = rest.join(":");
  if (!isAlbionServer(server) || !characterId) return undefined;
  return { server, characterId };
}

function formatCharacterRef(character: RegisteredCharacter): string {
  return `${character.albionServer}:${character.albionCharacterId}`;
}

function buildCharacterSwitchSelectRow(
  requesterDiscordUserId: string,
  targetDiscordUserId: string,
  from: RegisteredCharacter,
  toAlbionServer: AlbionServer,
  players: AlbionSearchPlayer[]
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCharacterSwitchCustomId(requesterDiscordUserId, targetDiscordUserId, from, toAlbionServer))
      .setPlaceholder("Choose a replacement character")
      .addOptions(players.map((player) => ({
        label: truncateChoiceName(player.name),
        description: truncateChoiceName([
          player.guildName ?? "No guild",
          formatAllianceLabel(player),
          player.id
        ].filter((value) => value !== undefined).join(" • ")),
        value: player.id
      })))
  );
}

function buildCharacterSwitchCustomId(
  requesterDiscordUserId: string,
  targetDiscordUserId: string,
  from: RegisteredCharacter,
  toAlbionServer: AlbionServer
): string {
  return [
    CHARACTER_SWITCH_SELECT_PREFIX.slice(0, -1),
    requesterDiscordUserId,
    targetDiscordUserId,
    from.albionServer,
    from.albionCharacterId,
    toAlbionServer
  ].join(":");
}

function parseCharacterSwitchCustomId(customId: string): {
  requesterDiscordUserId: string;
  targetDiscordUserId: string;
  fromAlbionServer: AlbionServer;
  fromAlbionCharacterId: string;
  toAlbionServer: AlbionServer;
} | undefined {
  if (!customId.startsWith(CHARACTER_SWITCH_SELECT_PREFIX)) {
    return undefined;
  }

  const [, requesterDiscordUserId, targetDiscordUserId, fromAlbionServer, fromAlbionCharacterId, toAlbionServer] = customId.split(":");
  if (
    !requesterDiscordUserId ||
    !targetDiscordUserId ||
    !isAlbionServer(fromAlbionServer) ||
    !fromAlbionCharacterId ||
    !isAlbionServer(toAlbionServer)
  ) {
    return undefined;
  }

  return {
    requesterDiscordUserId,
    targetDiscordUserId,
    fromAlbionServer,
    fromAlbionCharacterId,
    toAlbionServer
  };
}

function formatAllianceLabel(player: AlbionPlayer | AlbionSearchPlayer): string | undefined {
  if (!player.allianceName && !player.allianceTag) {
    return undefined;
  }

  return player.allianceName
    ? `${player.allianceName}${player.allianceTag ? ` [${player.allianceTag}]` : ""}`
    : `[${player.allianceTag}]`;
}

function formatWarnings(warnings: Array<{ message: string }>): string {
  return warnings.length > 0 ? `\n\n${warnings.map((warning) => warning.message).join("\n")}` : "";
}

function readBooleanChoice(interaction: ChatInputCommandInteraction, optionName: string): boolean {
  return interaction.options.getString(optionName, true) === TRUE_CHOICE_VALUE;
}
