import { reconcileApplicationActiveRole } from "../services/applications/activeRoleService.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIButtonComponentWithCustomId,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type InteractionReplyOptions,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  type ModalSubmitInteraction,
  type Role,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  type ApplicationButtonStyle,
  type ApplicationClass,
  type ApplicationMessageType,
  type ApplicationStatus,
  type CharacterResolutionState,
  type createApplicationRepository
} from "../db/applicationRepository.js";
import {
  type MemberGroup,
  type MemberGroupRemovalResult,
  type createMembershipRepository
} from "../db/membershipRepository.js";
import { mergeEntryButtonComponents, removeEntryButtonComponents } from "../discord/entryButtons.js";
import { feedbackEdit, feedbackReply } from "../discord/feedbackMessages.js";
import type { AlbionClient } from "../services/albion/client.js";
import { ALBION_SERVER_VALUES, getAlbionServerLabel, isAlbionServer, type AlbionServer } from "../services/albion/servers.js";
import type { AlbionSearchPlayer } from "../services/albion/types.js";
import {
  retireStoredApplicationControl,
} from "../services/applications/controlPresentation.js";
import * as applicationRendering from "../services/applications/rendering.js";
import { buildApplicationV2Card as buildApplicationV2Payload } from "../services/applications/rendering.js";
import type { RegearCharacterObserver } from "../services/regears/service.js";
import {
  APPLICATION_CUSTOM_PREFIX,
  OPEN_BUTTON_PREFIX,
  beforeApplicationModal,
  buildApplicationCharacterSelectRow as buildApplicationCharacterSelectRowIntake,
  buildCharacterMatchesEmbed as buildCharacterMatchesEmbedIntake,
  buildCharacterRecoveryButtons as buildCharacterRecoveryButtonsIntake,
  buildRemoteApplicationCharacterSelectRow as buildRemoteApplicationCharacterSelectRowIntake,
  handleApplicationIntakeButton,
  handleApplicationIntakeCharacterSelect,
  handleApplicationIntakeModalSubmit,
  handleApplicationSearchCommand as handleApplicationSearchCommandIntake,
  parseApplicationAction,
  refreshApplicationForReopen
} from "./applicationIntake.js";
import {
  handleApplicationAcceptVerifyCommand as handleApplicationAcceptVerifyCommandAdapter,
  handleApplicationButtonOperation,
  handleApplicationDeleteCommand as handleApplicationDeleteCommandAdapter,
  handleApplicationLifecycleCommand as handleApplicationLifecycleCommandAdapter,
  handleApplicationRejectCommand as handleApplicationRejectCommandAdapter
} from "./applicationOperations.js";
import {
  INVALID_COLOR,
  buildInfoEmbed,
  buildNotFoundEmbed,
  buildSuccessEmbed,
  formatMemberGroupCombinedLabel,
  formatMemberGroupType,
  normalizeQuery,
  readAlbionServer,
  respondServerAutocomplete,
  truncateChoiceName
} from "./configurationHelpers.js";
import { beginConversationClassRemoval } from "./conversationClassRemoval.js";
import {
  applicationChoices,
  createCacheLabels,
  type Actor,
  type ApplicationOperationalAction
} from "./operationalTargets.js";
import { setTicketConversationSendPermission } from "./ticketChannelPermissions.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type ComponentsV2Payload = MessageCreateOptions & InteractionReplyOptions & MessageEditOptions;

/**
 * Converts the existing application presentation model to the shared V2 card
 * without changing its copy, colour, fields, footer, or controls.
 */
export function buildApplicationV2Card(
  embed: EmbedBuilder,
  actionRows: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] = [],
  options: { openingMentions?: { applicantId: string; reviewerRoleId: string }; edit?: boolean; ephemeral?: boolean } = {}
): ComponentsV2Payload {
  return buildApplicationV2Payload(embed, actionRows, options);
}

const applicationCard = buildApplicationV2Card;

function applicationResponse(
  embed: EmbedBuilder,
  options: { ephemeral?: boolean; edit?: boolean; actionRows?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] } = {}
): ComponentsV2Payload {
  return buildApplicationV2Card(embed, options.actionRows, {
    ephemeral: options.ephemeral,
    edit: options.edit
  });
}

async function rejectNonGuildApplicationInteraction(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.inGuild()) return false;
  await interaction.reply(applicationFeedback(
    new EmbedBuilder().setColor(INVALID_COLOR).setTitle("Server Only").setDescription("This command can only be used in a Discord server."),
    { ephemeral: true }
  ));
  return true;
}

async function respondInvalidApplicationServer(interaction: ChatInputCommandInteraction): Promise<void> {
  const valid = ALBION_SERVER_VALUES.map(getAlbionServerLabel).join(", ");
  await interaction.reply(applicationFeedback(
    new EmbedBuilder().setColor(INVALID_COLOR).setTitle("Invalid Albion Online Server").setDescription(`Choose an Albion Online server: ${valid}.`),
    { ephemeral: true }
  ));
}
export { runApplicationLifecycleOperation } from "../services/applications/lifecycleService.js";
export type {
  ApplicationLifecycleOperationAction,
  ApplicationLifecycleOperationInput,
  ApplicationLifecycleOperationResult,
  ApplicationLifecyclePresentation
} from "../services/applications/lifecycleService.js";

const QUESTIONS_MODAL_PREFIX = "app:questions:";
const MESSAGE_MODAL_PREFIX = "app:message:";
const MAX_CONFIGURED_QUESTIONS = 4;
const MESSAGE_MAX_LENGTH = 2000;

const REVIEWER_ONLY_FOOTER = "Reviewers only.";

export const applicationsCommand = new SlashCommandBuilder()
  .setName("applications")
  .setDescription("Configure membership application tickets.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List application classes."))
  .addSubcommand((subcommand) => subcommand
    .setName("show")
    .setDescription("Show application class configuration.")
    .addStringOption((option) => option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a membership application class.")
      .addStringOption((option) =>
        option.setName("name").setDescription("Staff-facing application name.").setMinLength(1).setMaxLength(80).setRequired(true)
      )
      .addStringOption((option) =>
        option.setName("server").setDescription("Albion Online server.").setRequired(true).setAutocomplete(true)
      )
      .addStringOption((option) =>
        option.setName("group").setDescription("Target member group.").setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((option) =>
        option
          .setName("category")
          .setDescription("Category where application ticket channels are created.")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(true)
      )
      .addRoleOption((option) =>
        option.setName("reviewer").setDescription("Role allowed to review applications.").setRequired(true)
      )
      .addRoleOption((option) =>
        option.setName("role").setDescription("Optional role granted while a ticket is open.")
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("button")
      .setDescription("Configure application entry buttons.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Attach an application button to a bot-authored message.")
          .addStringOption((option) =>
            option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
          )
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Channel containing the bot-authored message.")
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true)
          )
          .addStringOption((option) =>
            option.setName("id").setDescription("Bot-authored message ID.").setRequired(true)
          )
          .addStringOption((option) =>
            option.setName("label").setDescription("Button label.").setMinLength(1).setMaxLength(80).setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("style")
              .setDescription("Button style.")
              .setRequired(true)
              .addChoices(
                { name: "Primary", value: "primary" },
                { name: "Secondary", value: "secondary" },
                { name: "Success", value: "success" },
                { name: "Danger", value: "danger" }
              )
          )
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("questions")
      .setDescription("Configure application questions.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Open a modal to set optional application questions.")
          .addStringOption((option) =>
            option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Clear optional application questions.")
          .addStringOption((option) =>
            option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
          )
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("messages")
      .setDescription("Configure application ticket messages.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Open a modal to set an application message.")
          .addStringOption((option) =>
            option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option
              .setName("type")
              .setDescription("Message to set.")
              .setRequired(true)
              .addChoices(
                { name: "Initial", value: "initial" },
                { name: "Accepted", value: "accepted" },
                { name: "Rejected", value: "rejected" }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Clear an application message.")
          .addStringOption((option) =>
            option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
          )
          .addStringOption((option) =>
            option
              .setName("type")
              .setDescription("Message to clear.")
              .setRequired(true)
              .addChoices(
                { name: "Initial", value: "initial" },
                { name: "Accepted", value: "accepted" },
                { name: "Rejected", value: "rejected" }
              )
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("disable")
      .setDescription("Disable an application class.")
      .addStringOption((option) =>
        option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Confirm removal of an application class and its channels.")
      .addStringOption((option) =>
          option.setName("application").setDescription("Application class.").setRequired(true).setAutocomplete(true)
      )
  );

export const applicationCommand = new SlashCommandBuilder()
  .setName("application")
  .setDescription("Manage membership application tickets.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("accept").setDescription("Accept an undecided membership application.")))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("reject").setDescription("Reject an undecided membership application.")))
  .addSubcommand((subcommand) => subcommand.setName("search").setDescription("Retry or replace the application character search.")
    .addStringOption((option) => option.setName("character").setDescription("Albion Online character name to search.").setMinLength(1).setMaxLength(64).setRequired(true))
    .addStringOption((option) => option.setName("application").setDescription("Application target; omit in its application channel.").setAutocomplete(true)))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("verify").setDescription("Verify in-game membership for a waiting application.")))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("cancel").setDescription("Close a waiting application without changing its waiting state.")))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("close").setDescription("Close an undecided or completed application channel.")))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("reopen").setDescription("Reopen a closed application channel.")))
  .addSubcommand((subcommand) => addApplicationOperationalTarget(subcommand.setName("delete").setDescription("Permanently delete a closed application channel.")));

function addApplicationOperationalTarget(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return subcommand.addStringOption((option) => option
    .setName("application")
    .setDescription("Application target; omit in its application channel.")
    .setAutocomplete(true)
  );
}

export async function handleApplicationCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient,
  regearObserver?: RegearCharacterObserver
): Promise<void> {
  if (await rejectNonGuildApplicationInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (!group && (subcommand === "cancel" || subcommand === "close" || subcommand === "reopen")) {
    await handleApplicationLifecycleCommandAdapter(interaction, applicationRepository, subcommand, (channel, application, open) => refreshApplicationForReopen(channel, applicationRepository, membershipRepository, albionClient, application, open));
    return;
  }
  if (!group && (subcommand === "accept" || subcommand === "verify")) {
    await handleApplicationAcceptVerifyCommandAdapter(interaction, applicationRepository, membershipRepository, albionClient, subcommand === "verify", regearObserver);
    return;
  }
  if (!group && subcommand === "reject") {
    await handleApplicationRejectCommandAdapter(interaction, applicationRepository);
    return;
  }
  if (!group && subcommand === "search") { await handleApplicationSearchCommandIntake(interaction, applicationRepository, membershipRepository, albionClient); return; }
  if (!group && subcommand === "delete") { await handleApplicationDeleteCommandAdapter(interaction, applicationRepository); return; }
}

export async function handleApplicationsCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository
): Promise<void> {
  if (await rejectNonGuildApplicationInteraction(interaction)) return;

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const classes = await applicationRepository.listApplicationClasses(interaction.guildId!);
    await interaction.editReply((classes.length ? applicationResponse : applicationFeedback)(buildApplicationListEmbed(classes), { edit: true }));
    return;
  }
  if (subcommand === "show") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await handleApplicationShowCommand(interaction, applicationRepository, membershipRepository);
    return;
  }
  if (group === "button" && subcommand === "add") {
    await handleButtonAdd(interaction, applicationRepository);
    return;
  }
  if (group === "questions") {
    await handleQuestionsCommand(interaction, applicationRepository, subcommand);
    return;
  }
  if (group === "messages") {
    await handleMessagesCommand(interaction, applicationRepository, subcommand);
    return;
  }
  if (subcommand === "create") {
    await handleCreate(interaction, applicationRepository, membershipRepository);
    return;
  }
  if (subcommand === "disable") {
    const application = await requireApplication(interaction, applicationRepository);
    if (!application) return;
    await applicationRepository.setApplicationEnabled(interaction.guildId!, application.applicationClassId, false);
    await interaction.reply(applicationFeedback(buildSuccessEmbed("Application Disabled", `Application class ${application.name} was disabled.`), { ephemeral: true }));
    return;
  }
  if (subcommand === "remove") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await beginConversationClassRemoval(interaction, applicationRepository.classRemoval);
  }
}

async function handleApplicationShowCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository
): Promise<void> {
  const application = await requireApplication(interaction, applicationRepository);
  if (!application) return;
  const group = application.memberGroupId
    ? (await membershipRepository.listMemberGroups(interaction.guildId!, application.albionServer))
      .find((candidate) => candidate.memberGroupId === application.memberGroupId)
    : undefined;
  const categoryName = interaction.guild?.channels.cache.get(application.ticketCategoryId)?.name;
  await interaction.editReply(applicationResponse(buildApplicationShowEmbed(application, group, categoryName), { edit: true }));
}

export async function handleApplicationAutocomplete(
  interaction: AutocompleteInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "application" && interaction.commandName !== "applications") return false;

  const focused = interaction.options.getFocused(true);
  if (focused.name === "server") {
    await respondServerAutocomplete(interaction);
    return true;
  }
  if (focused.name === "group") {
    await respondMemberGroupAutocomplete(interaction, membershipRepository);
    return true;
  }
  if (focused.name === "application") {
    const subcommand = interaction.options.getSubcommand(false);
    if (interaction.commandName === "application" && (subcommand === "accept" || subcommand === "reject" || subcommand === "search" || subcommand === "verify" || subcommand === "cancel" || subcommand === "close" || subcommand === "reopen" || subcommand === "delete")) {
      await respondApplicationOperationalAutocomplete(interaction, applicationRepository, subcommand);
      return true;
    }
    await respondApplicationAutocomplete(interaction, applicationRepository);
    return true;
  }
  return false;
}

export async function handleApplicationButton(
  interaction: ButtonInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient,
  regearObserver?: RegearCharacterObserver
): Promise<boolean> {
  if (await handleApplicationIntakeButton(interaction, applicationRepository, membershipRepository)) return true;
  if (!interaction.customId.startsWith(APPLICATION_CUSTOM_PREFIX)) return false;
  if (!interaction.inCachedGuild()) return false;

  const parsed = parseApplicationAction(interaction.customId);
  if (!parsed) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Invalid Application Action", "That application control is no longer valid."), { ephemeral: true }));
    return true;
  }
  if (parsed.action === "retry-character" || parsed.action === "reviewer-character") return true;

  await handleApplicationButtonOperation(interaction, applicationRepository, membershipRepository, albionClient, parsed.applicationId, parsed.action, regearObserver, (channel, application, open) => refreshApplicationForReopen(channel, applicationRepository, membershipRepository, albionClient, application, open));
  return true;
}

export async function handleApplicationModalSubmit(
  interaction: ModalSubmitInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient
): Promise<boolean> {
  if (await handleApplicationIntakeModalSubmit(interaction, applicationRepository, membershipRepository, albionClient, {
    reconcileArchivedActiveRole: async (guild, applications, memberships, target) => {
      await reconcileArchivedApplicationActiveRole(guild, applications, memberships, target);
    }
  })) return true;
  if (interaction.customId.startsWith(QUESTIONS_MODAL_PREFIX)) {
    await handleQuestionsModal(interaction, applicationRepository);
    return true;
  }
  if (interaction.customId.startsWith(MESSAGE_MODAL_PREFIX)) {
    await handleMessageModal(interaction, applicationRepository);
    return true;
  }
  return false;
}

export async function handleApplicationCharacterSelect(
  interaction: StringSelectMenuInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  albionClient: AlbionClient
): Promise<boolean> {
  return handleApplicationIntakeCharacterSelect(interaction, applicationRepository, membershipRepository, albionClient);
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository
): Promise<void> {
  const albionServer = readAlbionServer(interaction);
  if (!albionServer || albionServer === "all") {
    await respondInvalidApplicationServer(interaction);
    return;
  }

  const memberGroupId = interaction.options.getString("group", true);
  const group = (await membershipRepository.listMemberGroups(interaction.guildId!, albionServer))
    .find((candidate) => candidate.memberGroupId === memberGroupId);
  if (!group) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Member Group Not Found", "Choose a configured member group from autocomplete."), { ephemeral: true }));
    return;
  }

  const ticketCategory = interaction.options.getChannel("category", true);
  const reviewerRole = interaction.options.getRole("reviewer", true) as Role;
  const activeRole = interaction.options.getRole("role") as Role | null;
  if (ticketCategory.type !== ChannelType.GuildCategory) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Invalid Ticket Category", "Choose a Discord category channel."), { ephemeral: true }));
    return;
  }

  const created = await applicationRepository.createApplicationClass({
    discordGuildId: interaction.guildId!,
    name: interaction.options.getString("name", true).trim(),
    outcomeType: "member_group",
    memberGroupId,
    albionServer,
    activeRoleId: activeRole?.id,
    ticketCategoryId: ticketCategory.id,
    reviewerRoleId: reviewerRole.id,
    createdByDiscordUserId: interaction.user.id
  });

  await interaction.reply(applicationFeedback(buildSuccessEmbed("Application Created", `Application class ${created.name} was created; add an entry button with \`/applications button add\`.`), { ephemeral: true }));
}

async function handleButtonAdd(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository
): Promise<void> {
  const application = await requireApplication(interaction, applicationRepository);
  if (!application) return;

  const channel = interaction.options.getChannel("channel", true);
  if (!("messages" in channel)) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Invalid Channel", "Choose a text channel containing the message."), { ephemeral: true }));
    return;
  }

  const messageId = interaction.options.getString("id", true).trim();
  const message = await channel.messages.fetch({ message: messageId, force: true }).catch(() => undefined);
  if (!message) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Message Not Found", "Guild Manager could not fetch that message in the selected channel."), { ephemeral: true }));
    return;
  }
  if (message.author.id !== interaction.client.user.id) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Bot Message Required", "Application buttons can only be attached to messages authored by Guild Manager."), { ephemeral: true }));
    return;
  }

  const label = interaction.options.getString("label", true).trim();
  const style = interaction.options.getString("style", true) as ApplicationButtonStyle;
  const buttonApplication = {
    ...application,
    sourceChannelId: channel.id,
    sourceMessageId: message.id,
    buttonLabel: label,
    buttonStyle: style
  };
  const mergedComponents = mergeEntryButtonComponents(message.components, buildApplicationEntryButton(buttonApplication));
  if (!mergedComponents) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Message Buttons Unavailable", "Choose a message with room for another button and at most one container."), { ephemeral: true }));
    return;
  }

  const configured = await applicationRepository.configureApplicationButton(
    interaction.guildId!,
    application.applicationClassId,
    channel.id,
    message.id,
    label,
    style
  );
  if (!configured) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Application Not Found", "Choose a configured application class."), { ephemeral: true }));
    return;
  }

  await message.edit({ components: mergedComponents, allowedMentions: { parse: [], repliedUser: false } });
  await interaction.reply(applicationFeedback(buildSuccessEmbed("Application Button Added", `The ${configured.name} application button was added to ${message.url}.`), { ephemeral: true }));
}

async function handleQuestionsCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  subcommand: string
): Promise<void> {
  if (subcommand === "clear") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const application = await requireApplication(interaction, applicationRepository);
    if (!application) return;
    await applicationRepository.setApplicationQuestions(interaction.guildId!, application.applicationClassId, []);
    await interaction.editReply(applicationFeedback(buildSuccessEmbed("Questions Cleared", `${application.name} now only asks for Character Name.`), { edit: true }));
    return;
  }

  const loaded = await beforeApplicationModal(() => applicationRepository.getApplicationClass(
    interaction.guildId!,
    interaction.options.getString("application", true)
  ));
  const application = loaded.kind === "value" ? loaded.value : undefined;
  if (!application || application.archivedAt) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Application Not Found", "Choose a configured application from autocomplete."), { ephemeral: true }));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${QUESTIONS_MODAL_PREFIX}${application.applicationClassId}`)
    .setTitle("Application Questions")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("questions")
        .setLabel("Questions")
        .setPlaceholder("One question per line. Up to 4 questions.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(800)
        .setValue(application.questions.map((question) => question.label).join("\n"))
    ));
  await interaction.showModal(modal);
}

async function handleMessagesCommand(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository,
  subcommand: string
): Promise<void> {
  const messageType = interaction.options.getString("type", true) as ApplicationMessageType;

  if (subcommand === "clear") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const application = await requireApplication(interaction, applicationRepository);
    if (!application) return;
    await applicationRepository.setApplicationMessage(interaction.guildId!, application.applicationClassId, messageType, undefined);
    await interaction.editReply(applicationFeedback(buildSuccessEmbed("Message Cleared", `${messageTypeLabel(messageType)} message was cleared for ${application.name}.`), { edit: true }));
    return;
  }

  const loaded = await beforeApplicationModal(() => applicationRepository.getApplicationClass(
    interaction.guildId!,
    interaction.options.getString("application", true)
  ));
  const application = loaded.kind === "value" ? loaded.value : undefined;
  if (!application || application.archivedAt) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Application Not Found", "Choose a configured application from autocomplete."), { ephemeral: true }));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MESSAGE_MODAL_PREFIX}${application.applicationClassId}:${messageType}`)
    .setTitle(`${messageTypeLabel(messageType)} Message`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("message")
        .setLabel("Message")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(MESSAGE_MAX_LENGTH)
        .setValue(getConfiguredMessage(application, messageType) ?? "")
    ));
  await interaction.showModal(modal);
}

async function handleQuestionsModal(
  interaction: ModalSubmitInteraction,
  applicationRepository: ApplicationRepository
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Server Only", "Application configuration must be used in a Discord server."), { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const applicationClassId = interaction.customId.slice(QUESTIONS_MODAL_PREFIX.length);
  const questions = interaction.fields.getTextInputValue("questions")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_CONFIGURED_QUESTIONS)
    .map((label) => ({ label }));
  await applicationRepository.setApplicationQuestions(interaction.guildId!, applicationClassId, questions);
  await interaction.editReply(applicationFeedback(buildSuccessEmbed("Questions Set", questions.length === 0 ? "The application now only asks for Character Name." : `${questions.length} optional application question${questions.length === 1 ? "" : "s"} configured.`), { edit: true }));
}

async function handleMessageModal(
  interaction: ModalSubmitInteraction,
  applicationRepository: ApplicationRepository
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply(applicationFeedback(buildNotFoundEmbed("Server Only", "Application configuration must be used in a Discord server."), { ephemeral: true }));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [applicationClassId, messageType] = interaction.customId.slice(MESSAGE_MODAL_PREFIX.length).split(":");
  if (!isApplicationMessageType(messageType)) {
    await interaction.editReply(applicationFeedback(buildNotFoundEmbed("Invalid Message Type", "That application message editor is no longer valid."), { edit: true }));
    return;
  }
  const message = interaction.fields.getTextInputValue("message").trim();
  await applicationRepository.setApplicationMessage(interaction.guildId!, applicationClassId, messageType, message || undefined);
  await interaction.editReply(applicationFeedback(buildSuccessEmbed("Message Set", `${messageTypeLabel(messageType)} application message was updated.`), { edit: true }));
}

async function requireApplication(
  interaction: ChatInputCommandInteraction,
  applicationRepository: ApplicationRepository
): Promise<ApplicationClass | undefined> {
  const applicationId = interaction.options.getString("application", true);
  const application = await applicationRepository.getApplicationClass(interaction.guildId!, applicationId);
  if (!application || application.archivedAt) {
    const embed = buildNotFoundEmbed("Application Not Found", "Choose a configured application from autocomplete.");
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(applicationFeedback(embed, { edit: true }));
    } else {
      await interaction.reply(applicationFeedback(embed, { ephemeral: true }));
    }
  }
  return application;
}

async function respondApplicationAutocomplete(
  interaction: AutocompleteInteraction,
  applicationRepository: ApplicationRepository
): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const classes = (await applicationRepository.listApplicationClasses(interaction.guildId ?? "", interaction.options.getSubcommand(false) === "remove"))
    .filter((application) => application.name.toLocaleLowerCase().includes(query) || application.applicationClassId.includes(query))
    .slice(0, 25);
  await interaction.respond(classes.map((application) => ({
    name: truncateChoiceName(`${application.archivedAt ? "Archived" : application.enabled ? "Enabled" : "Disabled"} • ${application.name}`),
    value: application.applicationClassId
  })));
}

async function respondApplicationOperationalAutocomplete(
  interaction: AutocompleteInteraction,
  applicationRepository: ApplicationRepository,
  action: Extract<ApplicationOperationalAction, "accept" | "reject" | "search" | "verify" | "cancel" | "close" | "reopen" | "delete">
): Promise<void> {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  const actor: Actor = {
    userId: interaction.user.id,
    roleIds: new Set(member?.roles.cache.keys() ?? [])
  };
  const labels = createCacheLabels(interaction.guild?.channels.cache ?? new Map(), interaction.client.users.cache);
  const targets = await applicationRepository.listOperationalApplicationTargets(interaction.guildId ?? "", action === "delete");
  await interaction.respond(applicationChoices(action, actor, targets, String(interaction.options.getFocused(true).value), labels));
}

async function respondMemberGroupAutocomplete(
  interaction: AutocompleteInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  const query = normalizeQuery(interaction.options.getFocused(true).value);
  const server = interaction.options.getString("server");
  const groups = (await membershipRepository.listMemberGroups(
    interaction.guildId ?? "",
    isAlbionServer(server ?? "") ? server as AlbionServer : undefined
  ))
    .filter((group) =>
      group.groupName.toLocaleLowerCase().includes(query) ||
      formatMemberGroupType(group.groupType).includes(query) ||
      getAlbionServerLabel(group.albionServer).toLocaleLowerCase().includes(query)
    )
    .slice(0, 25);
  await interaction.respond(groups.map((group) => ({
    name: truncateChoiceName(formatMemberGroupCombinedLabel(group)),
    value: group.memberGroupId
  })));
}

function buildApplicationEntryButton(application: ApplicationClass): APIButtonComponentWithCustomId {
  return new ButtonBuilder()
    .setCustomId(`${OPEN_BUTTON_PREFIX}${application.applicationClassId}`)
    .setLabel(application.buttonLabel ?? application.name)
    .setStyle(toDiscordButtonStyle(application.buttonStyle ?? "primary"))
    .toJSON() as APIButtonComponentWithCustomId;
}

export async function reconcileArchivedMemberGroupApplicationPresentation(
  guild: Guild,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  result: MemberGroupRemovalResult
): Promise<string[]> {
  const warnings: string[] = [];
  for (const applicationClass of [...result.archivedApplicationClasses, ...result.deletedApplicationClasses]) {
    if (!applicationClass.sourceChannelId || !applicationClass.sourceMessageId) continue;
    try {
      const channel = await guild.channels.fetch(applicationClass.sourceChannelId);
      if (!channel?.isTextBased() || !("messages" in channel)) continue;
      const message = await channel.messages.fetch(applicationClass.sourceMessageId);
      const components = removeEntryButtonComponents(message.components, `${OPEN_BUTTON_PREFIX}${applicationClass.applicationClassId}`);
      await message.edit({ components, allowedMentions: { parse: [], repliedUser: false } });
    } catch (error) {
      warnings.push(`Application entry-button cleanup failed for class ${applicationClass.applicationClassId}: ${formatApplicationCleanupError(error)}`);
    }
  }

  for (const archived of result.archivedApplications) {
    if (!archived.ticketChannelId || archived.channelStatus === "deleted") continue;
    try {
      const channel = await guild.channels.fetch(archived.ticketChannelId);
      if (channel?.type !== ChannelType.GuildText) continue;
      const openApplication = await applicationRepository.getOpenApplication(guild.id, archived.applicationId);
      if (!openApplication) continue;
      await setTicketConversationSendPermission(channel, archived.applicantDiscordUserId, archived.reviewerRoleId, false);
      await retireStoredApplicationControl(channel, openApplication.applicationControlMessageId);
      await retireStoredApplicationControl(channel, openApplication.characterResolutionMessageId);
      await retireStoredApplicationControl(channel, openApplication.closedControlMessageId);
      const activeRoleWarning = await reconcileArchivedApplicationActiveRole(
        guild,
        applicationRepository,
        membershipRepository,
        archived
      );
      if (activeRoleWarning) warnings.push(activeRoleWarning);
      const message = await channel.send(applicationCard(
        withControlFooter(buildInfoEmbed("Application Target Removed", "The target member group was removed. This application and its decision are retained as history, and the channel is closed."), REVIEWER_ONLY_FOOTER),
        [buildArchivedApplicationButtons(archived.applicationId)]
      ));
      await applicationRepository.setClosedControlMessageId(guild.id, archived.applicationId, message.id);
    } catch (error) {
      warnings.push(`Application channel cleanup failed for application ${archived.applicationId}: ${formatApplicationCleanupError(error)}`);
    }
  }
  return warnings;
}

async function reconcileArchivedApplicationActiveRole(
  guild: Guild,
  applicationRepository: ApplicationRepository,
  membershipRepository: MembershipRepository,
  archived: MemberGroupRemovalResult["archivedApplications"][number]
): Promise<string | undefined> {
  const warnings = await reconcileApplicationActiveRole(guild, applicationRepository, archived, archived.applicantDiscordUserId);
  return warnings.length ? `Application active-role cleanup failed for application ${archived.applicationId}: ${warnings.map(warning => warning.message).join("; ")}` : undefined;
}

function buildArchivedApplicationButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildArchivedApplicationButtons(applicationId);
}

function formatApplicationCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildUndecidedButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildUndecidedButtons(applicationId);
}

export function buildWaitingButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildWaitingButtons(applicationId);
}

export function buildCloseButton(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildCloseButton(applicationId);
}

export function buildClosedChannelButtons(applicationId: string): ActionRowBuilder<ButtonBuilder> {
  return applicationRendering.buildClosedChannelButtons(applicationId);
}

export function applicationOpenComponents(status: ApplicationStatus, applicationId: string): ActionRowBuilder<ButtonBuilder>[] {
  return applicationRendering.applicationOpenComponents(status, applicationId);
}

export function buildApplicationCharacterSelectRow(
  server: AlbionServer,
  applicationId: string,
  players: AlbionSearchPlayer[]
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildApplicationCharacterSelectRowIntake(server, applicationId, players);
}

export function buildRemoteApplicationCharacterSelectRow(
  server: AlbionServer,
  applicationId: string,
  actorId: string,
  expiry: number,
  attempt: number,
  players: AlbionSearchPlayer[]
): ActionRowBuilder<StringSelectMenuBuilder> {
  return buildRemoteApplicationCharacterSelectRowIntake(server, applicationId, actorId, expiry, attempt, players);
}

export function buildCharacterRecoveryButtons(
  applicationId: string,
  _state: CharacterResolutionState
): ActionRowBuilder<ButtonBuilder> {
  return buildCharacterRecoveryButtonsIntake(applicationId, _state);
}

export function buildCharacterMatchesEmbed(
  server: AlbionServer,
  query: string,
  players: AlbionSearchPlayer[],
  attemptCount: number
): EmbedBuilder {
  return buildCharacterMatchesEmbedIntake(server, query, players, attemptCount);
}

function withControlFooter(embed: EmbedBuilder, text: string): EmbedBuilder {
  return applicationRendering.withControlFooter(embed, text);
}

function buildApplicationListEmbed(classes: ApplicationClass[]): EmbedBuilder {
  return applicationRendering.buildApplicationListEmbed(classes);
}

function buildApplicationShowEmbed(
  application: ApplicationClass,
  group: MemberGroup | undefined,
  categoryName: string | undefined
): EmbedBuilder {
  return applicationRendering.buildApplicationShowEmbed(application, group, categoryName);
}

export function formatApplicationGroup(group: MemberGroup | undefined, memberGroupId: string | undefined): string {
  return applicationRendering.formatApplicationGroup(group, memberGroupId);
}

function toDiscordButtonStyle(style: ApplicationButtonStyle): ButtonStyle {
  if (style === "secondary") return ButtonStyle.Secondary;
  if (style === "success") return ButtonStyle.Success;
  if (style === "danger") return ButtonStyle.Danger;
  return ButtonStyle.Primary;
}

function getConfiguredMessage(application: ApplicationClass, messageType: ApplicationMessageType): string | undefined {
  if (messageType === "initial") return application.initialMessage;
  if (messageType === "accepted") return application.acceptanceMessage;
  return application.rejectionMessage;
}

function isApplicationMessageType(value: string | undefined): value is ApplicationMessageType {
  return value === "initial" || value === "accepted" || value === "rejected";
}

function messageTypeLabel(messageType: ApplicationMessageType): string {
  if (messageType === "initial") return "Initial";
  if (messageType === "accepted") return "Accepted";
  return "Rejected";
}

export function buildApplicationChannelName(applicationName: string, username: string): string {
  return applicationRendering.buildApplicationChannelName(applicationName, username);
}

function applicationFeedback(embed: EmbedBuilder, options: { ephemeral?: boolean; edit?: boolean } = {}): ComponentsV2Payload {
  const payload = { cards: [embed], flags: options.ephemeral ? MessageFlags.Ephemeral : 0 };
  return (options.edit ? feedbackEdit(payload) : feedbackReply(payload)) as ComponentsV2Payload;
}
