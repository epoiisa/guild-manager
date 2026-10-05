import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type User
} from "discord.js";
import type { createAccountRepository } from "../db/accountRepository.js";
import type { MemberGroup, MemberGroupProfile, RegisteredCharacter, createMembershipRepository } from "../db/membershipRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import { getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import {
  applyEffectiveNickname,
  reconcileConfiguredRoles
} from "../services/membership/discordMemberUpdates.js";
import {
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatCharacterUserMentionPair,
  formatMemberGroupLabel,
  normalizeQuery,
  rejectNonGuildInteraction,
  truncateChoiceName
} from "./configurationHelpers.js";
import { buildMemberProfileEmbeds } from "./selfService.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type AccountRepository = ReturnType<typeof createAccountRepository>;

export const memberCommand = new SlashCommandBuilder()
  .setName("member")
  .setDescription("Manage member profiles and group membership.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a registered character to a group.")
      .addStringOption((option) => option.setName("character").setDescription("Registered character.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a character from a group.")
      .addStringOption((option) => option.setName("character").setDescription("Member group character.").setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName("group").setDescription("Configured group.").setRequired(true).setAutocomplete(true))
  )
  .addSubcommandGroup((group) =>
    group
      .setName("main")
      .setDescription("Manage main character selections.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set a user's main character.")
          .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
          .addStringOption((option) => option.setName("character").setDescription("Registered character.").setRequired(true).setAutocomplete(true))
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("nickname")
      .setDescription("Manage custom Discord nicknames.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set a user's full custom nickname.")
          .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
          .addStringOption((option) => option.setName("nickname").setDescription("Full Discord nickname.").setMinLength(1).setMaxLength(32).setRequired(true))
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reset")
          .setDescription("Reset a user's custom nickname.")
          .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("lookup")
      .setDescription("Look up member registrations and profiles.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("user")
          .setDescription("Look up a Discord user's full member profile.")
          .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true))
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("character")
          .setDescription("Look up the registered owner's full member profile.")
          .addStringOption((option) => option.setName("character").setDescription("Stored character.").setRequired(true).setAutocomplete(true))
      )
  );

export async function handleMemberCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  accountRepository: AccountRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (!group && (subcommand === "add" || subcommand === "remove")) {
    await handleGroupProfileChange(interaction, membershipRepository, subcommand);
    return;
  }
  if (group === "main" && subcommand === "set") {
    await handleMainSet(interaction, membershipRepository);
    return;
  }
  if (group === "nickname" && (subcommand === "set" || subcommand === "reset")) {
    await handleNickname(interaction, membershipRepository, subcommand);
    return;
  }
  if (group === "lookup") {
    await handleLookup(interaction, membershipRepository, accountRepository, subcommand);
  }
}

export async function handleMemberAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "member") return false;
  const focused = interaction.options.getFocused(true);
  if (focused.name === "character") {
    await respondCharacterAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "group") {
    await respondGroupAutocomplete(interaction, membershipRepository);
    return true;
  }
  return false;
}

async function handleMainSet(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const character = await requireRegisteredCharacterOption(interaction, membershipRepository, user.id);
  if (!character) return;
  await membershipRepository.setMainCharacter(character);
  const warnings = interaction.guild ? await applyEffectiveNickname(interaction.guild, membershipRepository, user.id) : [];
  await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Main Character Set", `${character.characterName} is now the main character for ${user}.${formatWarnings(warnings)}`)], flags: MessageFlags.Ephemeral }));
}

async function handleNickname(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  const user = interaction.options.getUser("user", true);
  if (subcommand === "set") {
    await membershipRepository.setCustomNickname(interaction.guildId!, user.id, interaction.options.getString("nickname", true));
  } else {
    await membershipRepository.resetCustomNickname(interaction.guildId!, user.id);
  }
  const warnings = interaction.guild ? await applyEffectiveNickname(interaction.guild, membershipRepository, user.id) : [];
  await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed(subcommand === "set" ? "Nickname Set" : "Nickname Reset", `${user}'s nickname preference was ${subcommand === "set" ? "set" : "reset"}.${formatWarnings(warnings)}`)], flags: MessageFlags.Ephemeral }));
}

async function handleGroupProfileChange(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "remove") {
    await handleGroupProfileRemoval(interaction, membershipRepository);
    return;
  }

  const character = await requireRegisteredCharacterOption(interaction, membershipRepository);
  if (!character) return;
  const group = await requireGroupOption(interaction, membershipRepository, character.albionServer);
  if (!group) return;

  const profile = await membershipRepository.addRegisteredProfile({
    memberGroupId: group.memberGroupId,
    discordGuildId: interaction.guildId!,
    discordUserId: character.discordUserId,
    albionServer: character.albionServer,
    albionCharacterId: character.albionCharacterId
  });
  if (!profile) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Registered Character Required", `${character.characterName} is not actively registered.`)], flags: MessageFlags.Ephemeral }));
    return;
  }
  const warnings = interaction.guild ? await reconcileConfiguredRoles(interaction.guild, membershipRepository, character.discordUserId) : [];
  await interaction.reply(feedbackReply({ cards: [buildSuccessEmbed("Member Added", `${formatCharacterUserMentionPair(character.characterName, character.discordUserId)} was added to ${formatMemberGroupLabel(group)}.${formatWarnings(warnings)}`)], flags: MessageFlags.Ephemeral }));
}

async function handleGroupProfileRemoval(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const ref = parseCharacterRef(interaction.options.getString("character", true));
  if (!ref) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Character Not Found", "Choose a character from a member group.")], flags: MessageFlags.Ephemeral }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const group = await membershipRepository.getGroup(interaction.guildId!, interaction.options.getString("group", true), ref.server);
  if (!group) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Group Not Found", "Choose a group on the character's Albion Online server.")] }, "context");
    return;
  }

  const profile = await membershipRepository.removeCustomGroupProfile({
    memberGroupId: group.memberGroupId,
    discordGuildId: interaction.guildId!,
    albionServer: ref.server,
    albionCharacterId: ref.characterId
  });
  if (!profile) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Profile Not Found", `The selected character has no profile in ${formatMemberGroupLabel(group)}.`)] });
    return;
  }

  const warnings = interaction.guild && profile.discordUserId
    ? await reconcileConfiguredRoles(interaction.guild, membershipRepository, profile.discordUserId)
    : [];
  const characterName = profile.characterName ?? profile.albionCharacterId;
  const memberLabel = profile.discordUserId
    ? formatCharacterUserMentionPair(characterName, profile.discordUserId)
    : characterName;
  await editFeedback(interaction, { cards: [buildSuccessEmbed("Member Removed", `${memberLabel} was removed from ${formatMemberGroupLabel(group)}.${formatWarnings(warnings)}`)] });
}

async function handleLookup(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  accountRepository: AccountRepository,
  subcommand: string
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === "user") {
    const user = interaction.options.getUser("user", true);
    await replyWithMemberProfile(interaction, membershipRepository, accountRepository, user);
    return;
  }

  const ref = parseCharacterRef(interaction.options.getString("character", true));
  if (!ref) {
    await replyInvalidLookupCharacter(interaction, true);
    return;
  }
  const registered = await membershipRepository.getRegisteredCharacter(interaction.guildId!, ref.server, ref.characterId);
  if (!registered) {
    await replyInvalidLookupCharacter(interaction, true);
    return;
  }
  const user = await interaction.client.users.fetch(registered.discordUserId).catch(() => undefined);
  if (!user) {
    await replyInvalidLookupCharacter(interaction, true);
    return;
  }
  await replyWithMemberProfile(interaction, membershipRepository, accountRepository, user);
}

async function replyWithMemberProfile(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  accountRepository: AccountRepository,
  user: User
): Promise<void> {
  const [characters, memberships, positions, accounts] = await Promise.all([
    membershipRepository.listSelfServiceCharacters(interaction.guildId!, user.id),
    membershipRepository.listSelfServiceMemberships(interaction.guildId!, user.id),
    membershipRepository.listSelfServicePositions(interaction.guildId!, user.id),
    accountRepository.listAccountsForUser(interaction.guildId!, user.id)
  ]);
  const member = await interaction.guild?.members.fetch({ user: user.id, force: true }).catch(() => undefined);
  const displayName = member?.displayName ?? user.displayName ?? user.username;
  const embeds = buildMemberProfileEmbeds({
    discordUserId: user.id,
    discordUsername: user.username,
    displayName,
    characters,
    memberships,
    positions,
    accounts
  });
  await interaction.editReply(v2Edit({ cards: embeds.slice(0, 10) }));
  for (let index = 10; index < embeds.length; index += 10) {
    await interaction.followUp(v2Reply({ cards: embeds.slice(index, index + 10), flags: MessageFlags.Ephemeral }));
  }
}

async function replyInvalidLookupCharacter(interaction: ChatInputCommandInteraction, deferred = false): Promise<void> {
  const embeds = [buildNotFoundEmbed("Member Not Found", "Choose a currently registered character from autocomplete.")];
  if (deferred) {
    await editFeedback(interaction, { cards: embeds }, "context");
  } else {
    await interaction.reply(feedbackReply({ cards: embeds, flags: MessageFlags.Ephemeral }, "context"));
  }
}

async function requireRegisteredCharacterOption(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  requiredUserId?: string
): Promise<RegisteredCharacter | undefined> {
  const ref = parseCharacterRef(interaction.options.getString("character", true));
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

async function requireGroupOption(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  server: AlbionServer
): Promise<MemberGroup | undefined> {
  const group = await membershipRepository.getGroup(interaction.guildId!, interaction.options.getString("group", true), server);
  if (!group) {
    await interaction.reply(feedbackReply({ cards: [buildNotFoundEmbed("Group Not Found", "Choose a group on the character's Albion Online server.")], flags: MessageFlags.Ephemeral }, "context"));
  }
  return group;
}

async function respondCharacterAutocomplete(interaction: AutocompleteInteraction, membershipRepository: MembershipRepository): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  if (group === "lookup" && subcommand === "character") {
    const knownCharacters = (await membershipRepository.listRegisteredCharacters(interaction.guildId ?? ""))
      .filter((character) => character.characterName.toLocaleLowerCase().includes(query) || getAlbionServerLabel(character.albionServer).toLocaleLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(knownCharacters.map((character) => ({
      name: truncateChoiceName(`${character.characterName} • ${getAlbionServerLabel(character.albionServer)}`),
      value: `${character.albionServer}:${character.albionCharacterId}`
    })));
    return;
  }

  if (!group && subcommand === "remove") {
    const selectedGroupId = interaction.options.getString("group");
    const groupIds = selectedGroupId
      ? [selectedGroupId]
      : (await membershipRepository.listGroups(interaction.guildId ?? "")).map((group) => group.memberGroupId);
    const profiles = (await membershipRepository.listProfilesForGroups(interaction.guildId ?? "", groupIds))
      .filter((profile) => profile.groupType === "group")
      .filter((profile) => profile.characterName?.toLocaleLowerCase().includes(query) || getAlbionServerLabel(profile.albionServer).toLocaleLowerCase().includes(query));
    const characters = [...new Map(profiles.map((profile) => [formatProfileCharacterRef(profile), profile])).values()];
    await interaction.respond(characters.slice(0, 25).map((profile) => ({
      name: truncateChoiceName(`${profile.characterName ?? profile.albionCharacterId} • ${getAlbionServerLabel(profile.albionServer)}`),
      value: formatProfileCharacterRef(profile)
    })));
    return;
  }

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

async function respondGroupAutocomplete(interaction: AutocompleteInteraction, membershipRepository: MembershipRepository): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(false);
  const characterRef = parseCharacterRef(interaction.options.getString("character") ?? "");
  if (!group && subcommand === "remove" && characterRef) {
    const profiles = (await membershipRepository.listProfilesForCharacter(interaction.guildId ?? "", characterRef.server, characterRef.characterId))
      .filter((profile) => profile.groupType === "group")
      .filter((profile) => (profile.groupName ?? "").toLocaleLowerCase().includes(query) || getAlbionServerLabel(profile.albionServer).toLocaleLowerCase().includes(query))
      .slice(0, 25);
    await interaction.respond(profiles.map((profile) => ({
      name: truncateChoiceName(formatMemberGroupLabel(profileToMemberGroup(profile))),
      value: profile.memberGroupId
    })));
    return;
  }

  const groups = (await membershipRepository.listGroups(interaction.guildId ?? ""))
    .filter((group) => !characterRef || group.albionServer === characterRef.server)
    .filter((group) => group.groupName.toLocaleLowerCase().includes(query) || getAlbionServerLabel(group.albionServer).toLocaleLowerCase().includes(query))
    .slice(0, 25);
  await interaction.respond(groups.map((group) => ({
    name: truncateChoiceName(formatMemberGroupLabel(group)),
    value: group.memberGroupId
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

function formatProfileCharacterRef(profile: MemberGroupProfile): string {
  return `${profile.albionServer}:${profile.albionCharacterId}`;
}

function profileToMemberGroup(profile: MemberGroupProfile): MemberGroup {
  return {
    memberGroupId: profile.memberGroupId,
    discordGuildId: profile.discordGuildId,
    albionServer: profile.albionServer,
    groupType: profile.groupType ?? "group",
    groupName: profile.groupName ?? "Unknown"
  };
}

function formatWarnings(warnings: Array<{ message: string }>): string {
  return warnings.length > 0 ? `\n\n${warnings.map((warning) => warning.message).join("\n")}` : "";
}
