import {
  ActionRowBuilder,
  AttachmentBuilder,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
  type AutocompleteInteraction,
  type BaseChannel,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type ForumThreadChannel,
  type Message,
  type ModalSubmitInteraction,
  type SendableChannels
} from "discord.js";
import { randomUUID } from "node:crypto";
import { COMPOSED_MESSAGE_MAX_LENGTH, buildComposedMessage, readComposedMessage, replaceComposedMessageText } from "../discord/composedMessage.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import { messageColorChoices, resolveMessageColor } from "../discord/tailwindColors.js";
import type { Logger } from "../logging/logger.js";
import {
  ERROR_COLOR,
  INFO_COLOR,
  INVALID_COLOR,
  SUCCESS_COLOR,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

const MESSAGE_MAX_LENGTH = 2000;
const FORUM_TITLE_MAX_LENGTH = 100;
const COMPOSE_MODAL_PREFIX = "message-compose:";
const V2_MODAL_PREFIX = "message-v2:";
const EDIT_MODAL_PREFIX = "message-edit:";
const FORUM_MODAL_PREFIX = "message-forum:";
const MODAL_DRAFT_TTL_MS = 15 * 60 * 1000;
const MODAL_FETCH_TIMEOUT_MS = 2_000;
const INELIGIBLE_EDIT_DESCRIPTION = "Only Guild Manager-authored plain messages with ordinary buttons, or messages created with `/message v2`, can be edited with this command. Embeds, operational cards, polls, stickers, and other component layouts are not supported.";

type PendingAttachment = {
  name: string;
  url: string;
};

type PendingMessageDraft = {
  attachment?: PendingAttachment;
  accentColor?: number;
  channelId: string;
  guildId: string;
  timeout: NodeJS.Timeout;
  userId: string;
};

type PendingMessageEdit = {
  channelId: string;
  guildId: string;
  initialContent: string;
  initialEditedTimestamp: number | null;
  initialPresentation: string;
  messageId: string;
  timeout: NodeJS.Timeout;
  userId: string;
};

const pendingComposes = new Map<string, PendingMessageDraft>();
const pendingV2Composes = new Map<string, PendingMessageDraft>();
const pendingEdits = new Map<string, PendingMessageEdit>();
const pendingForums = new Map<string, PendingMessageDraft>();

export const messageCommand = new SlashCommandBuilder()
  .setName("message")
  .setDescription("Post messages as Guild Manager.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("post")
      .setDescription("Post a message as Guild Manager.")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to post in. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Message text.")
          .setMaxLength(MESSAGE_MAX_LENGTH)
      )
      .addAttachmentOption((option) =>
        option
          .setName("attachment")
          .setDescription("Attachment to include.")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("compose")
      .setDescription("Open a multiline editor and post as Guild Manager.")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to post in. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
      .addAttachmentOption((option) =>
        option
          .setName("attachment")
          .setDescription("Attachment to include.")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("v2")
      .setDescription("Compose a message with a coloured container and optional image.")
      .addStringOption((option) => option
        .setName("color")
        .setDescription("Accent colour. Defaults to Slate. Choose a colour or enter #RRGGBB.")
        .setAutocomplete(true))
      .addChannelOption((option) => option
        .setName("channel")
        .setDescription("Channel to post in. Defaults to the current channel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread,
          ChannelType.PrivateThread, ChannelType.AnnouncementThread))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("forum")
      .setDescription("Open an editor and create a forum post as Guild Manager.")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Forum channel. Defaults to the current forum when used from a forum thread.")
          .addChannelTypes(ChannelType.GuildForum)
      )
      .addAttachmentOption((option) =>
        option
          .setName("attachment")
          .setDescription("Attachment to include.")
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit a message posted as Guild Manager.")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Message ID to edit.")
          .setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel containing the message. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("repost")
      .setDescription("Repost an existing message as Guild Manager.")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Message ID to repost.")
          .setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName("source")
          .setDescription("Channel containing the original message. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
      .addChannelOption((option) =>
        option
          .setName("destination")
          .setDescription("Channel to repost in. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("pin")
      .setDescription("Pin an existing message without changing other pins.")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Message ID to pin.")
          .setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel containing the message. Defaults to the current channel.")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
      )
  );

export async function handleMessageCommand(
  interaction: ChatInputCommandInteraction,
  logger: Logger
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "v2") {
    await handleV2Command(interaction);
    return;
  }

  if (subcommand === "compose") {
    await handleComposeCommand(interaction);
    return;
  }

  if (subcommand === "forum") {
    await handleForumCommand(interaction);
    return;
  }

  if (subcommand === "edit") {
    await handleEditCommand(interaction);
    return;
  }

  if (subcommand === "repost") {
    await handleRepostCommand(interaction, logger);
    return;
  }

  if (subcommand === "pin") {
    await handlePinCommand(interaction, logger);
    return;
  }

  if (subcommand === "post") {
    await handlePostCommand(interaction, logger);
    return;
  }

  await interaction.reply(feedbackReply({
    cards: [buildMessageEmbed("Unknown Message Action", "Choose one of the supported message commands.", INVALID_COLOR)],
    flags: MessageFlags.Ephemeral
  }, "context"));
}

export async function handleMessageModalSubmit(
  interaction: ModalSubmitInteraction,
  logger: Logger
): Promise<boolean> {
  if (interaction.customId.startsWith(V2_MODAL_PREFIX)) {
    await handleV2ModalSubmit(interaction, logger);
    return true;
  }

  if (interaction.customId.startsWith(COMPOSE_MODAL_PREFIX)) {
    await handleComposeModalSubmit(interaction, logger);
    return true;
  }

  if (interaction.customId.startsWith(EDIT_MODAL_PREFIX)) {
    await handleEditModalSubmit(interaction, logger);
    return true;
  }

  if (interaction.customId.startsWith(FORUM_MODAL_PREFIX)) {
    await handleForumModalSubmit(interaction, logger);
    return true;
  }

  return false;
}

export async function handleMessageAutocomplete(interaction: AutocompleteInteraction): Promise<boolean> {
  if (interaction.commandName !== "message") return false;
  const focused = interaction.options.getFocused(true);
  await interaction.respond(interaction.inGuild() && interaction.options.getSubcommand() === "v2" && focused.name === "color"
    ? messageColorChoices(String(focused.value)) : []);
  return true;
}

async function handleV2Command(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const colorInput = interaction.options.getString("color");
  const accentColor = colorInput === null ? INFO_COLOR : resolveMessageColor(colorInput);
  if (accentColor === undefined) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Colour", "Choose a Tailwind v3 colour by name or enter a six-digit hexadecimal colour such as #64748B.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  const channel = getSendableChannel(interaction.options.getChannel("channel") ?? interaction.channel);
  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  const draftId = createPendingDraft(pendingV2Composes, {
    accentColor, channelId: channel.id, guildId: interaction.guild.id, userId: interaction.user.id
  });
  await interaction.showModal(new ModalBuilder().setCustomId(`${V2_MODAL_PREFIX}${draftId}`).setTitle("Post V2 Message")
    .addLabelComponents(
      new LabelBuilder().setLabel("Message").setTextInputComponent(new TextInputBuilder()
        .setCustomId("message").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(COMPOSED_MESSAGE_MAX_LENGTH)),
      new LabelBuilder().setLabel("Image").setDescription("Optional image shown below the message.").setFileUploadComponent(
        new FileUploadBuilder().setCustomId("image").setRequired(false).setMinValues(0).setMaxValues(1))
    ));
}

async function handleV2ModalSubmit(interaction: ModalSubmitInteraction, logger: Logger): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  const draftId = interaction.customId.slice(V2_MODAL_PREFIX.length);
  const draft = pendingV2Composes.get(draftId);
  if (!draft) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Expired", "That message draft has expired. Run `/message v2` again.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  if (!isDraftOwner(interaction, draft)) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Not Yours", "That message draft does not belong to this interaction.", ERROR_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  takePendingDraft(pendingV2Composes, draftId);
  const text = interaction.fields.getTextInputValue("message").trim();
  const images = [...(interaction.fields.getUploadedFiles("image", false)?.values() ?? [])];
  if (images.length > 1 || images.some((image) => !image.contentType?.toLowerCase().startsWith("image/"))) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Image", "Upload one image file, or leave Image empty.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  if ((!text && images.length === 0) || text.length > COMPOSED_MESSAGE_MAX_LENGTH) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Message Content", "Provide message text, an image, or both. Message text must be at most 4,000 characters.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = getSendableChannel(await interaction.guild.channels.fetch(draft.channelId).catch(() => null));
  if (!channel) {
    await editFeedback(interaction, { cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)] }, "context");
    return;
  }
  const image = images[0];
  const imageName = image ? `message-image${/\.[a-z0-9]+$/i.exec(image.name)?.[0].toLowerCase() ?? ""}` : undefined;
  const payload = buildComposedMessage(text, draft.accentColor ?? INFO_COLOR, imageName);
  const posted = await channel.send({ ...payload, files: image ? [new AttachmentBuilder(image.url, { name: imageName })] : [] });
  logger.info("message v2 composed", { guildId: interaction.guild.id, channelId: channel.id, messageId: posted.id, userId: interaction.user.id });
  await editFeedback(interaction, { cards: [buildMessageConfirmationEmbed("Message Posted", channel, posted.id, posted.url)] });
}

async function handlePostCommand(interaction: ChatInputCommandInteraction<"cached">, logger: Logger): Promise<void> {
  const messageText = interaction.options.getString("message")?.trim();
  const attachment = interaction.options.getAttachment("attachment");

  if (!messageText && !attachment) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Missing Message Content", "Provide a message, an attachment, or both.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const channel = getSendableChannel(interaction.options.getChannel("channel") ?? interaction.channel);

  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const postedMessage = await sendBotMessage(channel, {
    content: messageText || undefined,
    files: attachment ? [new AttachmentBuilder(attachment.url, { name: attachment.name })] : []
  });

  logger.info("message posted", {
    guildId: interaction.guild.id,
    channelId: channel.id,
    messageId: postedMessage.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildMessageConfirmationEmbed("Message Posted", channel, postedMessage.id, postedMessage.url)]
  });
}

async function handleComposeCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const channel = getSendableChannel(interaction.options.getChannel("channel") ?? interaction.channel);

  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const attachment = interaction.options.getAttachment("attachment") ?? undefined;
  const composeId = createPendingDraft(pendingComposes, {
    attachment: attachment ? toPendingAttachment(attachment) : undefined,
    channelId: channel.id,
    guildId: interaction.guild.id,
    userId: interaction.user.id
  });

  const modal = new ModalBuilder()
    .setCustomId(`${COMPOSE_MODAL_PREFIX}${composeId}`)
    .setTitle("Post Message");

  const messageInput = new TextInputBuilder()
    .setCustomId("message")
    .setLabel("Message")
    .setRequired(!attachment)
    .setMaxLength(MESSAGE_MAX_LENGTH)
    .setStyle(TextInputStyle.Paragraph);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput));

  await interaction.showModal(modal);
}

async function handleForumCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const channel = getForumChannel(interaction.options.getChannel("channel") ?? interaction.channel);

  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Forum", "Choose a forum channel where Guild Manager can create posts.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const attachment = interaction.options.getAttachment("attachment") ?? undefined;
  const forumId = createPendingDraft(pendingForums, {
    attachment: attachment ? toPendingAttachment(attachment) : undefined,
    channelId: channel.id,
    guildId: interaction.guild.id,
    userId: interaction.user.id
  });

  const modal = new ModalBuilder()
    .setCustomId(`${FORUM_MODAL_PREFIX}${forumId}`)
    .setTitle("Create Forum Post");

  const titleInput = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Title")
    .setRequired(true)
    .setMaxLength(FORUM_TITLE_MAX_LENGTH)
    .setStyle(TextInputStyle.Short);

  const messageInput = new TextInputBuilder()
    .setCustomId("message")
    .setLabel("Message")
    .setRequired(!attachment)
    .setMaxLength(MESSAGE_MAX_LENGTH)
    .setStyle(TextInputStyle.Paragraph);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput)
  );

  await interaction.showModal(modal);
}

async function handleEditCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const messageId = interaction.options.getString("id", true).trim();
  const channel = getSendableChannel(interaction.options.getChannel("channel") ?? interaction.channel);

  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can fetch and edit messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const message = await fetchBeforeModal(channel.messages.fetch({ message: messageId, force: true }));

  if (!message) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Message Not Found", "I could not find that message in the selected channel.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!isEditableBotPost(message, interaction.client.user.id)) {
    await interaction.reply(v2Reply({
      cards: [buildMessageEmbed("Message Cannot Be Edited", INELIGIBLE_EDIT_DESCRIPTION, INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const composed = readComposedMessage(message);
  const initialContent = composed?.text ?? message.content;
  const editId = createPendingEdit({
    channelId: channel.id,
    guildId: interaction.guild.id,
    initialContent,
    initialEditedTimestamp: message.editedTimestamp,
    initialPresentation: messagePresentationSnapshot(message),
    messageId: message.id,
    userId: interaction.user.id
  });
  const modal = new ModalBuilder()
    .setCustomId(`${EDIT_MODAL_PREFIX}${editId}`)
    .setTitle("Edit Message");
  const messageInput = new TextInputBuilder()
    .setCustomId("message")
    .setLabel("Message")
    .setRequired(false)
    .setMaxLength(composed ? COMPOSED_MESSAGE_MAX_LENGTH : MESSAGE_MAX_LENGTH)
    .setStyle(TextInputStyle.Paragraph);

  if (initialContent) {
    messageInput.setValue(initialContent);
  }

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput));
  await interaction.showModal(modal);
}

async function fetchBeforeModal<T>(fetch: Promise<T>): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fetch.catch(() => null),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), MODAL_FETCH_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function handleRepostCommand(interaction: ChatInputCommandInteraction<"cached">, logger: Logger): Promise<void> {
  const messageId = interaction.options.getString("id", true).trim();
  const sourceChannel = getSendableChannel(interaction.options.getChannel("source") ?? interaction.channel);
  const destinationChannel = getSendableChannel(interaction.options.getChannel("destination") ?? interaction.channel);

  if (!sourceChannel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Source Channel", "Choose a text channel where Guild Manager can fetch the original message.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!destinationChannel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Destination Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const originalMessage = await sourceChannel.messages.fetch(messageId).catch(() => null);

  if (!originalMessage) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Message Not Found", "I could not find that message in the source channel.", INVALID_COLOR)]
    }, "context");
    return;
  }

  if (originalMessage.flags.has(MessageFlags.IsComponentsV2)) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Message Cannot Be Reposted", "Components V2 messages cannot be reposted with this command yet. Use `/message v2` to compose a new message.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const messageText = originalMessage.content.trim();

  if (!messageText && originalMessage.attachments.size === 0) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Empty Message", "That message has no text or attachments to repost.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const postedMessage = await sendBotMessage(destinationChannel, {
    content: messageText || undefined,
    files: originalMessage.attachments.map((attachment) =>
      new AttachmentBuilder(attachment.url, { name: attachment.name })
    )
  });

  logger.info("message reposted", {
    guildId: interaction.guild.id,
    sourceChannelId: sourceChannel.id,
    destinationChannelId: destinationChannel.id,
    originalMessageId: originalMessage.id,
    messageId: postedMessage.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildMessageConfirmationEmbed("Message Reposted", destinationChannel, postedMessage.id, postedMessage.url)]
  });
}

async function handlePinCommand(interaction: ChatInputCommandInteraction<"cached">, logger: Logger): Promise<void> {
  const messageId = interaction.options.getString("id", true).trim();
  const channel = getSendableChannel(interaction.options.getChannel("channel") ?? interaction.channel);

  if (!channel) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can fetch and pin messages.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const message = await channel.messages.fetch(messageId).catch(() => null);

  if (!message) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Message Not Found", "I could not find that message in the selected channel.", INVALID_COLOR)]
    }, "context");
    return;
  }

  if (!message.pinned) {
    await message.pin(`Pinned by ${interaction.user.tag} using /message pin`);
  }

  logger.info("message pinned", {
    guildId: interaction.guild.id,
    channelId: channel.id,
    messageId: message.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildMessageConfirmationEmbed("Message Pinned", channel, message.id, message.url)]
  });
}

async function handleComposeModalSubmit(interaction: ModalSubmitInteraction, logger: Logger): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const composeId = interaction.customId.slice(COMPOSE_MODAL_PREFIX.length);
  const pendingCompose = takePendingDraft(pendingComposes, composeId);

  if (!pendingCompose) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Expired", "That message draft has expired. Run `/message compose` again.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!isDraftOwner(interaction, pendingCompose)) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Not Yours", "That message draft does not belong to this interaction.", ERROR_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const messageText = interaction.fields.getTextInputValue("message").trim();

  if (!messageText && !pendingCompose.attachment) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Missing Message Content", "Provide a message, an attachment, or both.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = getSendableChannel(await interaction.guild.channels.fetch(pendingCompose.channelId).catch(() => null));

  if (!channel) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can send messages.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const postedMessage = await sendBotMessage(channel, {
    content: messageText || undefined,
    files: pendingCompose.attachment
      ? [new AttachmentBuilder(pendingCompose.attachment.url, { name: pendingCompose.attachment.name })]
      : []
  });

  logger.info("message composed", {
    guildId: interaction.guild.id,
    channelId: channel.id,
    messageId: postedMessage.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildMessageConfirmationEmbed("Message Posted", channel, postedMessage.id, postedMessage.url)]
  });
}

async function handleEditModalSubmit(interaction: ModalSubmitInteraction, logger: Logger): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const editId = interaction.customId.slice(EDIT_MODAL_PREFIX.length);
  const pendingEdit = pendingEdits.get(editId);

  if (!pendingEdit) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Expired", "That message edit has expired. Run `/message edit` again.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!isEditOwner(interaction, pendingEdit)) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Not Yours", "That message edit does not belong to this interaction.", ERROR_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }
  takePendingEdit(editId);

  const messageText = interaction.fields.getTextInputValue("message").trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = getSendableChannel(await interaction.guild.channels.fetch(pendingEdit.channelId).catch(() => null));

  if (!channel) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Invalid Channel", "Choose a text channel where Guild Manager can fetch and edit messages.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const message = await channel.messages.fetch({ message: pendingEdit.messageId, force: true }).catch(() => null);

  if (!message) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Message Not Found", "I could not find that message in the selected channel.", INVALID_COLOR)]
    }, "context");
    return;
  }

  if (!isEditableBotPost(message, interaction.client.user.id)) {
    await interaction.editReply(v2Edit({
      cards: [buildMessageEmbed("Message Cannot Be Edited", INELIGIBLE_EDIT_DESCRIPTION, INVALID_COLOR)]
    }));
    return;
  }

  const composed = readComposedMessage(message);
  if ((composed?.text ?? message.content) !== pendingEdit.initialContent
    || message.editedTimestamp !== pendingEdit.initialEditedTimestamp
    || messagePresentationSnapshot(message) !== pendingEdit.initialPresentation) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Message Changed", "That message changed after the editor opened. Run `/message edit` again.", INVALID_COLOR)]
    }, "context");
    return;
  }

  if (messageText.length > (composed ? COMPOSED_MESSAGE_MAX_LENGTH : MESSAGE_MAX_LENGTH)) {
    await editFeedback(interaction, { cards: [buildMessageEmbed("Message Too Long", `Message text must be at most ${composed ? "4,000" : "2,000"} characters.`, INVALID_COLOR)] }, "context");
    return;
  }

  if (!messageText && message.attachments.size === 0) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Missing Message Content", "A message must have text or at least one existing attachment.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const composedUpdate = composed && replaceComposedMessageText(composed.container, messageText);
  if (composed && !composedUpdate) {
    await editFeedback(interaction, { cards: [buildMessageEmbed("Message Components Full", "That message has reached Discord's component limit and cannot include another text field.", INVALID_COLOR)] }, "context");
    return;
  }
  const editedMessage = await message.edit(composedUpdate ? {
    components: [composedUpdate],
    allowedMentions: { parse: [], repliedUser: false }
  } : {
    content: messageText || null,
    allowedMentions: {
      parse: ["users", "roles", "everyone"]
    }
  });

  logger.info("message edited", {
    guildId: interaction.guild.id,
    channelId: channel.id,
    messageId: editedMessage.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildMessageConfirmationEmbed("Message Edited", channel, editedMessage.id, editedMessage.url)]
  });
}

async function handleForumModalSubmit(interaction: ModalSubmitInteraction, logger: Logger): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const forumId = interaction.customId.slice(FORUM_MODAL_PREFIX.length);
  const pendingForum = takePendingDraft(pendingForums, forumId);

  if (!pendingForum) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Expired", "That forum draft has expired. Run `/message forum` again.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!isDraftOwner(interaction, pendingForum)) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Draft Not Yours", "That forum draft does not belong to this interaction.", ERROR_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const title = interaction.fields.getTextInputValue("title").trim();
  const messageText = interaction.fields.getTextInputValue("message").trim();

  if (!title) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Missing Forum Title", "Provide a forum post title.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  if (!messageText && !pendingForum.attachment) {
    await interaction.reply(feedbackReply({
      cards: [buildMessageEmbed("Missing Message Content", "Provide a message, an attachment, or both.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const forumChannel = getForumChannel(await interaction.guild.channels.fetch(pendingForum.channelId).catch(() => null));

  if (!forumChannel) {
    await editFeedback(interaction, {
      cards: [buildMessageEmbed("Invalid Forum", "Choose a forum channel where Guild Manager can create posts.", INVALID_COLOR)]
    }, "context");
    return;
  }

  const forumThread = await createForumPost(forumChannel, {
    title,
    content: messageText || undefined,
    files: pendingForum.attachment
      ? [new AttachmentBuilder(pendingForum.attachment.url, { name: pendingForum.attachment.name })]
      : []
  });

  logger.info("forum post created", {
    guildId: interaction.guild.id,
    channelId: forumChannel.id,
    threadId: forumThread.id,
    userId: interaction.user.id
  });

  await editFeedback(interaction, {
    cards: [buildForumPostConfirmationEmbed(forumChannel, forumThread)]
  });
}

function createPendingDraft(
  drafts: Map<string, PendingMessageDraft>,
  input: Omit<PendingMessageDraft, "timeout">
): string {
  const id = randomUUID();
  const timeout = setTimeout(() => {
    drafts.delete(id);
  }, MODAL_DRAFT_TTL_MS);
  timeout.unref();

  drafts.set(id, { ...input, timeout });
  return id;
}

function createPendingEdit(input: Omit<PendingMessageEdit, "timeout">): string {
  const id = randomUUID();
  const timeout = setTimeout(() => {
    pendingEdits.delete(id);
  }, MODAL_DRAFT_TTL_MS);
  timeout.unref();

  pendingEdits.set(id, { ...input, timeout });
  return id;
}

function takePendingDraft(drafts: Map<string, PendingMessageDraft>, id: string): PendingMessageDraft | undefined {
  const draft = drafts.get(id);
  if (draft) {
    drafts.delete(id);
    clearTimeout(draft.timeout);
  }

  return draft;
}

function takePendingEdit(id: string): PendingMessageEdit | undefined {
  const edit = pendingEdits.get(id);
  if (edit) {
    pendingEdits.delete(id);
    clearTimeout(edit.timeout);
  }

  return edit;
}

function isDraftOwner(interaction: ModalSubmitInteraction<"cached">, draft: PendingMessageDraft): boolean {
  return draft.userId === interaction.user.id && draft.guildId === interaction.guild.id;
}

function isEditOwner(interaction: ModalSubmitInteraction<"cached">, edit: PendingMessageEdit): boolean {
  return edit.userId === interaction.user.id && edit.guildId === interaction.guild.id;
}

function isEditableBotPost(message: Message, botUserId: string): boolean {
  return message.author.id === botUserId
    && message.embeds.length === 0
    && (message.flags.has(MessageFlags.IsComponentsV2) ? readComposedMessage(message) !== undefined : message.components.every((component) =>
      component.type === ComponentType.ActionRow
      && component.components.every((child) => child.type === ComponentType.Button)
    ))
    && message.stickers.size === 0
    && !message.poll;
}

function messagePresentationSnapshot(message: Message): string {
  return JSON.stringify({
    content: message.content,
    components: message.components.map((component) => typeof component.toJSON === "function" ? component.toJSON() : component),
    attachmentIds: [...message.attachments.keys()].sort()
  }, (key, value: unknown) => {
    // Discord can refresh signed attachment URLs between the two message fetches.
    // Their path identifies the retained image; changing only its signature is not an edit.
    if ((key === "url" || key === "proxy_url") && typeof value === "string") {
      try {
        const url = new URL(value);
        if (["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) && url.pathname.startsWith("/attachments/")) {
          return `${url.origin}${url.pathname}`;
        }
      } catch { /* attachment:// references are compared verbatim. */ }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
}

function getSendableChannel(channel: BaseChannel | null): SendableChannels | undefined {
  if (!channel || !channel.isTextBased() || !("send" in channel) || !("messages" in channel)) {
    return undefined;
  }

  return channel as SendableChannels;
}

function getForumChannel(channel: BaseChannel | null): ForumChannel | undefined {
  if (!channel) {
    return undefined;
  }

  if (channel.type === ChannelType.GuildForum) {
    return channel as ForumChannel;
  }

  if (channel.isThread() && channel.parent?.type === ChannelType.GuildForum) {
    return channel.parent as ForumChannel;
  }

  return undefined;
}

function toPendingAttachment(attachment: Attachment): PendingAttachment {
  return {
    name: attachment.name,
    url: attachment.url
  };
}

async function sendBotMessage(
  channel: SendableChannels,
  message: { content?: string; files: AttachmentBuilder[] }
): Promise<Message> {
  return await channel.send({
    content: message.content,
    files: message.files,
    allowedMentions: {
      parse: ["users", "roles", "everyone"]
    }
  });
}

async function createForumPost(
  channel: ForumChannel,
  post: { title: string; content?: string; files: AttachmentBuilder[] }
): Promise<ForumThreadChannel> {
  return await channel.threads.create({
    name: post.title,
    message: {
      content: post.content,
      files: post.files,
      allowedMentions: {
        parse: ["users", "roles", "everyone"]
      }
    }
  });
}

function buildMessageConfirmationEmbed(
  title: string,
  channel: { toString(): string },
  messageId: string,
  messageLink: string
): EmbedBuilder {
  const verb = ({ "Message Posted": "Posted", "Message Edited": "Edited", "Message Reposted": "Reposted", "Message Pinned": "Pinned", "Forum Post Created": "Created" } as Record<string, string>)[title];
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(title)
    .setDescription(`${verb} [${title === "Forum Post Created" ? "forum post" : "message"} ${messageId}](${messageLink}) in ${channel.toString()}.`);
}

function buildForumPostConfirmationEmbed(channel: ForumChannel, thread: ForumThreadChannel): EmbedBuilder {
  return buildMessageConfirmationEmbed(
    "Forum Post Created",
    channel,
    thread.id,
    `https://discord.com/channels/${thread.guildId}/${thread.id}/${thread.id}`
  );
}

function buildMessageEmbed(title: string, description: string, color: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);
}
