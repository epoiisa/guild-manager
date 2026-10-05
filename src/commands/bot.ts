import {
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type Attachment,
  type ChatInputCommandInteraction
} from "discord.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import type { Logger } from "../logging/logger.js";
import {
  ERROR_COLOR,
  INVALID_COLOR,
  SUCCESS_COLOR,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_MISSING_PERMISSIONS_CODE = 50013;

export const botCommand = new SlashCommandBuilder()
  .setName("bot")
  .setDescription("Manage Guild Manager's server profile.")
  .setDefaultMemberPermissions(0)
  .addSubcommandGroup((group) =>
    group
      .setName("name")
      .setDescription("Manage Guild Manager's server nickname.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set Guild Manager's server nickname.")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("Server-specific bot nickname.")
              .setMinLength(1)
              .setMaxLength(32)
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Clear Guild Manager's server nickname.")
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("avatar")
      .setDescription("Manage Guild Manager's server avatar.")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set Guild Manager's server avatar.")
          .addAttachmentOption((option) =>
            option
              .setName("attachment")
              .setDescription("Server-specific bot avatar image.")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("clear")
          .setDescription("Clear Guild Manager's server avatar.")
      )
  );

export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
  logger: Logger
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  if (!interaction.inCachedGuild()) {
    await interaction.reply(feedbackReply({
      cards: [buildBotEmbed("Server Not Cached", "Guild Manager could not load this server. Try again in a moment.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }, "context"));
    return;
  }

  const subcommandGroup = interaction.options.getSubcommandGroup();
  const subcommand = interaction.options.getSubcommand();

  if (subcommandGroup === "name" && subcommand === "set") {
    const name = interaction.options.getString("name", true).trim();
    if (!name) {
      await interaction.reply(feedbackReply({
        cards: [buildBotEmbed("Invalid Name", "Provide a server nickname with at least one visible character.", INVALID_COLOR)],
        flags: MessageFlags.Ephemeral
      }, "context"));
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await editBotProfile(interaction, logger, {
      action: "set bot nickname",
      edit: () => interaction.guild.members.editMe({
        nick: name,
        reason: `Guild Manager bot profile updated by ${interaction.user.tag}`
      }),
      success: () => buildBotEmbed("Bot Name Updated", `Guild Manager's server nickname is now ${name}.`, SUCCESS_COLOR)
    });
    return;
  }

  if (subcommandGroup === "name" && subcommand === "clear") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await editBotProfile(interaction, logger, {
      action: "clear bot nickname",
      edit: () => interaction.guild.members.editMe({
        nick: null,
        reason: `Guild Manager bot profile updated by ${interaction.user.tag}`
      }),
      success: () => buildBotEmbed("Bot Name Cleared", "Guild Manager's server nickname has been cleared.", SUCCESS_COLOR)
    });
    return;
  }

  if (subcommandGroup === "avatar" && subcommand === "set") {
    const attachment = interaction.options.getAttachment("attachment", true);
    const validationError = validateAvatarAttachment(attachment);
    if (validationError) {
      await interaction.reply(feedbackReply({
        cards: [buildBotEmbed(validationError.title, validationError.description, INVALID_COLOR)],
        flags: MessageFlags.Ephemeral
      }, "context"));
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await editBotProfile(interaction, logger, {
      action: "set bot avatar",
      edit: async () => {
        const avatar = await fetchAttachmentAsBuffer(attachment.url);
        await interaction.guild.members.editMe({
          avatar,
          reason: `Guild Manager bot profile updated by ${interaction.user.tag}`
        });
      },
      success: () => buildBotEmbed("Bot Avatar Updated", "Guild Manager's server avatar has been updated.", SUCCESS_COLOR)
    });
    return;
  }

  if (subcommandGroup === "avatar" && subcommand === "clear") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await editBotProfile(interaction, logger, {
      action: "clear bot avatar",
      edit: () => interaction.guild.members.editMe({
        avatar: null,
        reason: `Guild Manager bot profile updated by ${interaction.user.tag}`
      }),
      success: () => buildBotEmbed("Bot Avatar Cleared", "Guild Manager's server avatar has been cleared.", SUCCESS_COLOR)
    });
    return;
  }

  await interaction.reply(feedbackReply({
    cards: [buildBotEmbed("Unknown Bot Action", "Choose one of the supported bot profile commands.", INVALID_COLOR)],
    flags: MessageFlags.Ephemeral
  }, "context"));
}

async function editBotProfile(
  interaction: ChatInputCommandInteraction<"cached">,
  logger: Logger,
  options: {
    action: string;
    edit: () => Promise<unknown>;
    success: () => EmbedBuilder;
  }
): Promise<void> {
  try {
    await options.edit();
    logger.info("bot profile updated", {
      action: options.action,
      guildId: interaction.guildId,
      userId: interaction.user.id
    });
    await editFeedback(interaction, { cards: [options.success()] });
  } catch (error) {
    logger.warn("bot profile update failed", {
      action: options.action,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      error: error instanceof Error ? error.message : String(error)
    });

    const embed = isMissingPermissionsError(error)
      ? buildBotEmbed(
        "Bot Profile Not Updated",
        "Guild Manager does not have permission to update its server profile. Check the bot role position and permissions.",
        ERROR_COLOR
      )
      : buildBotEmbed(
        "Bot Profile Not Updated",
        "Discord rejected the profile update or the attachment could not be loaded.",
        ERROR_COLOR
      );

    await editFeedback(interaction, { cards: [embed] }, "context");
  }
}

function validateAvatarAttachment(attachment: Attachment): { title: string; description: string } | undefined {
  if (!attachment.contentType?.startsWith("image/")) {
    return {
      title: "Invalid Avatar",
      description: "The avatar attachment must be an image."
    };
  }

  if (attachment.size > AVATAR_MAX_BYTES) {
    return {
      title: "Avatar Too Large",
      description: "The avatar attachment must be 8 MB or smaller."
    };
  }

  return undefined;
}

async function fetchAttachmentAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch avatar attachment: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function isMissingPermissionsError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === DISCORD_MISSING_PERMISSIONS_CODE;
}

function buildBotEmbed(title: string, description: string, color: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);
}
