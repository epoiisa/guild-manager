import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import type { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { completeFeedbackPrompt, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import { ERROR_COLOR, SUCCESS_COLOR } from "./configurationHelpers.js";

type GuildLifecycleRepository = ReturnType<typeof createGuildLifecycleRepository>;

const DEACTIVATE_CUSTOM_ID_PREFIX = "gm-deactivate";

export const deactivateCommand = new SlashCommandBuilder()
  .setName("deactivate")
  .setDescription("Deactivate Guild Manager and purge this server's data.")
  .setDefaultMemberPermissions(0);

export async function handleDeactivateCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      text: "Guild Manager can only be deactivated from a Discord server.",
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  await interaction.reply(v2Reply({
    cards: [
      new EmbedBuilder()
        .setColor(ERROR_COLOR)
        .setTitle("Deactivate Guild Manager")
        .setDescription([
          "Are you sure you want to deactivate Guild Manager?",
          "- Guild Manager data and configuration will be permanently deleted.",
          "- The UTC time channel will be deleted.",
          "- No other existing channels, messages, roles, and permissions will be changed.",
          "- Only `/activate` will remain available."
        ].join("\n"))
    ],
    actionRows: [createDeactivateActionRow(interaction.guildId, interaction.user.id)],
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleDeactivateButton(
  interaction: ButtonInteraction,
  lifecycleRepository: GuildLifecycleRepository,
  onDeactivated: () => Promise<void>,
  beforeDeactivated?: () => Promise<void>,
  logFeedRuntime?: import("../services/logFeed/runtime.js").LogFeedRuntime
): Promise<boolean> {
  const button = parseDeactivateCustomId(interaction.customId);
  if (!button) {
    return false;
  }

  if (!interaction.inGuild() || interaction.guildId !== button.discordGuildId || interaction.user.id !== button.userId) {
    await interaction.reply(feedbackReply({
      text: "Only the user who started deactivation can use these buttons.",
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (button.action === "cancel") {
    await completeFeedbackPrompt(interaction, {
      text: "Deactivation cancelled.",
      actionRows: []
    });
    return true;
  }

  await interaction.deferUpdate();
  await beforeDeactivated?.();
  if (logFeedRuntime && interaction.guild) await logFeedRuntime.terminal(interaction.guild, "deactivated",
    () => lifecycleRepository.purgeGuildImmediately(interaction.guildId!), interaction);
  else await lifecycleRepository.purgeGuildImmediately(interaction.guildId);
  await onDeactivated();
  await interaction.editReply(v2Edit({
    cards: [
      new EmbedBuilder()
        .setColor(SUCCESS_COLOR)
        .setTitle("Guild Manager Deactivated")
        .setDescription([
          "Guild Manager has been deactivated.",
          "- Guild Manager data and configuration has been permanently deleted.",
          "- The UTC time channel has been deleted.",
          "- No other existing channels, messages, roles, and permissions were changed.",
          "- Use `/activate` to activate Guild Manager again."
        ].join("\n"))
    ],
    actionRows: []
  }));
  return true;
}

function createDeactivateActionRow(
  discordGuildId: string,
  userId: string
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(createDeactivateCustomId("confirm", discordGuildId, userId))
      .setLabel("Deactivate")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(createDeactivateCustomId("cancel", discordGuildId, userId))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function createDeactivateCustomId(action: "confirm" | "cancel", discordGuildId: string, userId: string): string {
  return `${DEACTIVATE_CUSTOM_ID_PREFIX}:${action}:${discordGuildId}:${userId}`;
}

function parseDeactivateCustomId(customId: string): {
  action: "confirm" | "cancel";
  discordGuildId: string;
  userId: string;
} | undefined {
  const [prefix, action, discordGuildId, userId] = customId.split(":");
  if (prefix !== DEACTIVATE_CUSTOM_ID_PREFIX || (action !== "confirm" && action !== "cancel")) {
    return undefined;
  }
  if (!discordGuildId || !userId) {
    return undefined;
  }
  return { action, discordGuildId, userId };
}
