import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import { CharacterRecoveryRequiredError, CharacterRegistrationLimitError, type createMembershipRepository } from "../db/membershipRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import type { AlbionClient } from "../services/albion/client.js";
import { getAlbionServerLabel, type AlbionServer } from "../services/albion/servers.js";
import type { AlbionPlayer } from "../services/albion/types.js";
import { applyEffectiveNickname } from "../services/membership/discordMemberUpdates.js";
import { reconcileRegisteredCharacterMembership } from "../services/membership/reconciliation.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import {
  CHARACTER_SEARCH_LIMIT,
  buildCharacterSearchResultsEmbed,
  buildCharacterSearchSelectRow,
  parseCharacterSelectionCustomId
} from "./characterSelection.js";
import {
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatCharacterUserMentionPair,
  readAlbionServer,
  rejectNonGuildInteraction,
  respondInvalidServer,
  respondServerAutocomplete
} from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export const registerCommand = new SlashCommandBuilder()
  .setName("register")
  .setDescription("Register one of your Albion Online characters.")
  .setDefaultMemberPermissions(0)
  .addStringOption((option) =>
    option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((option) =>
    option.setName("character").setDescription("Albion Online character name or partial name.").setMinLength(1).setMaxLength(64).setRequired(true)
  );

export async function handleRegisterCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

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
      cards: [buildCharacterSearchResultsEmbed(server, characterName, players, "Select a character to register.")],
      actionRows: [buildCharacterSearchSelectRow("register", interaction.user.id, server, players)]
    }));
    return;
  }

  const player = await albionClient.getPlayer(server, players[0].id);
  await completeSelfRegistration(interaction, albionClient, membershipRepository, server, player, regearObserver);
}

export async function handleRegisterCharacterSelect(
  interaction: StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<boolean> {
  const parsed = parseCharacterSelectionCustomId(interaction.customId);
  if (!parsed || parsed.action !== "register") {
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
      cards: [buildNotFoundEmbed("Selection Not Allowed", "Only the person who started this registration can use this selection.")],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  await interaction.deferUpdate();
  const player = await albionClient.getPlayer(parsed.server, interaction.values[0]);
  await completeSelfRegistration(interaction, albionClient, membershipRepository, parsed.server, player, regearObserver);
  return true;
}

async function completeSelfRegistration(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  server: AlbionServer,
  player: AlbionPlayer,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  const existing = await membershipRepository.getRegisteredCharacter(interaction.guildId!, server, player.id);
  if (existing && existing.discordUserId !== interaction.user.id) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Character Already Registered", `${formatCharacterUserMentionPair(player.name, existing.discordUserId)} is already registered.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  const lifecycle = await membershipRepository.getCharacterRegistrationLifecycle(interaction.guildId!, server, player.id);
  if (lifecycle) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Officer Recovery Required", `${player.name}'s registration is ${lifecycle.state}. Ask an officer with access to \`/character register\` to reconnect this character.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  if (await membershipRepository.hasOrphanProfilesForCharacter(interaction.guildId!, server, player.id)) {
    await editFeedback(interaction, {
      cards: [
        buildNotFoundEmbed(
          "Character Is Orphaned",
          `${player.name} has orphaned membership profiles. Ask someone with access to \`/character register\` to reassign this character.`
        )
      ],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }

  let registered;
  try {
    registered = await membershipRepository.registerCharacter({
      discordGuildId: interaction.guildId!,
      discordUserId: interaction.user.id,
      albionServer: server,
      player
    });
  } catch (error) {
    if (error instanceof CharacterRecoveryRequiredError) {
      await editFeedback(interaction, {
        cards: [buildNotFoundEmbed("Officer Recovery Required", "This character requires recovery through `/character register` before self-registration is available.")],
        actionRows: []
      }, "body", "message" in interaction);
      return;
    }
    if (!(error instanceof CharacterRegistrationLimitError)) throw error;
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed("Character Registration Limit Reached", `A Discord user can have at most ${error.limit} registered characters in this server. Unregister one before adding another.`)],
      actionRows: []
    }, "body", "message" in interaction);
    return;
  }
  const warnings = interaction.guild
    ? [
      ...await reconcileRegisteredCharacterMembership(interaction.guild, albionClient, membershipRepository, interaction.user.id, player, server),
      ...await applyEffectiveNickname(interaction.guild, membershipRepository, interaction.user.id)
    ]
    : [];
  const pendingNotice = interaction.guild && regearObserver
    ? (await regearObserver.observeCharacterRegistration(interaction.guild, server, registered.albionCharacterId)).hasPendingClaims
      ? `\n${registered.characterName} has pending re-gear requests.`
      : ""
    : "";

  await editFeedback(interaction, {
    cards: [
      buildSuccessEmbed(
        "Character Registered",
        `${formatCharacterUserMentionPair(registered.characterName, interaction.user.id)} was registered on ${getAlbionServerLabel(server)}.${pendingNotice}${warnings.length > 0 ? `\n\n${warnings.map((warning) => warning.message).join("\n")}` : ""}`
      )
    ],
    actionRows: []
  }, "body", "message" in interaction);
}

export async function handleRegisterAutocomplete(interaction: AutocompleteInteraction): Promise<boolean> {
  if (interaction.commandName !== "register") return false;
  if (interaction.options.getFocused(true).name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }
  return false;
}
