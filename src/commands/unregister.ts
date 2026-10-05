import { MessageFlags, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import type { RegisteredCharacter, createMembershipRepository } from "../db/membershipRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { applyEffectiveNickname, cleanupConfiguredRoles } from "../services/membership/discordMemberUpdates.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import {
  buildNotFoundEmbed,
  buildSuccessEmbed,
  normalizeQuery,
  readAlbionServer,
  rejectNonGuildInteraction,
  respondInvalidServer,
  respondServerAutocomplete,
  truncateChoiceName
} from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export const unregisterCommand = new SlashCommandBuilder()
  .setName("unregister")
  .setDescription("Unregister one of your Albion Online characters.")
  .setDefaultMemberPermissions(0)
  .addStringOption((option) =>
    option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((option) =>
    option.setName("character").setDescription("Registered character name.").setMinLength(1).setMaxLength(64).setRequired(true).setAutocomplete(true)
  );

export async function handleUnregisterCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const server = readAlbionServer(interaction);
  if (!server || server === "all") {
    await respondInvalidServer(interaction);
    return;
  }

  const characterName = interaction.options.getString("character", true).trim();
  const matches = await membershipRepository.listRegisteredCharactersByName(
    interaction.guildId!,
    characterName,
    interaction.user.id
  );
  const character = matches.find((match) => match.albionServer === server);
  if (!character) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Registration Not Found", `You do not have ${characterName} registered on ${getAlbionServerLabel(server)}.`)], flags: MessageFlags.Ephemeral }));
    return;
  }

  await membershipRepository.unregisterCharacter(character);
  if (interaction.guild && regearObserver) {
    await regearObserver.observeCharacterRegistration(interaction.guild, character.albionServer, character.albionCharacterId);
  }
  const warnings = interaction.guild
    ? [
      ...await cleanupConfiguredRoles(interaction.guild, membershipRepository, interaction.user.id),
      ...await applyEffectiveNickname(interaction.guild, membershipRepository, interaction.user.id)
    ]
    : [];

  await interaction.reply(feedbackReply({
    cards: [
      buildSuccessEmbed(
        "Character Unregistered",
        `${character.characterName} was unregistered and membership profiles were left orphaned.${warnings.length > 0 ? `\n\n${warnings.map((warning) => warning.message).join("\n")}` : ""}`
      )
    ],
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleUnregisterAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "unregister") return false;
  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }
  if (focused.name === "character") {
    const server = interaction.options.getString("server");
    const query = normalizeQuery(focused.value);
    const characters = (await membershipRepository.listRegisteredCharacters(interaction.guildId ?? "", interaction.user.id))
      .filter((character) => !server || character.albionServer === server)
      .filter((character) => character.characterName.toLocaleLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(characters.map(characterChoice));
    return true;
  }
  return false;
}

function characterChoice(character: RegisteredCharacter) {
  return {
    name: truncateChoiceName(`${character.characterName} • ${getAlbionServerLabel(character.albionServer)}`),
    value: character.characterName
  };
}
