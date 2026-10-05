import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import type { createResetRepository } from "../db/resetRepository.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import { ERROR_COLOR, INFO_COLOR, INVALID_COLOR, SUCCESS_COLOR, WARNING_COLOR } from "./configurationHelpers.js";

type ResetRepository = ReturnType<typeof createResetRepository>;

const RESET_CUSTOM_ID_PREFIX = "gm-reset";

export const resetCommand = new SlashCommandBuilder()
  .setName("reset")
  .setDescription("Delete this Discord server's Guild Manager data.")
  .setDefaultMemberPermissions(0);

export async function handleResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply(feedbackReply({
      accentColor: INVALID_COLOR,
      text: "Guild Manager can only be reset from a Discord server.",
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply(feedbackReply({
      accentColor: ERROR_COLOR,
      text: "Only a server administrator can reset this Discord server's Guild Manager data.",
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  await interaction.reply(v2Reply({
    accentColor: WARNING_COLOR,
    text:
      "Reset Guild Manager for this Discord server? This permanently deletes only this Discord server's Guild Manager data and configuration. Cancellation changes nothing.",
    actionRows: [createResetActionRow(interaction.guildId, interaction.user.id)],
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleResetButton(
  interaction: ButtonInteraction,
  resetRepository: ResetRepository,
  onReset: () => Promise<void>,
  beforeReset?: () => Promise<void>,
  logFeedRuntime?: import("../services/logFeed/runtime.js").LogFeedRuntime
): Promise<boolean> {
  const button = parseResetCustomId(interaction.customId);
  if (!button) {
    return false;
  }

  if (!interaction.inGuild() || interaction.guildId !== button.discordGuildId || interaction.user.id !== button.userId) {
    await interaction.reply(feedbackReply({
      accentColor: ERROR_COLOR,
      text: "Only the administrator who started the reset can use these buttons.",
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply(feedbackReply({
      accentColor: ERROR_COLOR,
      text: "Only a server administrator can reset this Discord server's Guild Manager data.",
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }

  if (button.action === "cancel") {
    await completeFeedbackPrompt(interaction, {
      accentColor: INFO_COLOR,
      text: "Reset cancelled. Nothing was changed.",
      actionRows: []
    });
    return true;
  }

  await interaction.deferUpdate();
  await beforeReset?.();
  if (logFeedRuntime && interaction.guild) await logFeedRuntime.terminal(interaction.guild, "reset",
    () => resetRepository.purgeGuildData(interaction.guildId!), interaction);
  else await resetRepository.purgeGuildData(interaction.guildId);
  await onReset();
  await editFeedback(interaction, {
    accentColor: SUCCESS_COLOR,
    text: "This Discord server's Guild Manager data was reset. Guild Manager is ready to configure again.",
    actionRows: []
  }, "body", true);
  return true;
}

function createResetActionRow(discordGuildId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(createResetCustomId("reset", discordGuildId, userId))
      .setLabel("RESET")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(createResetCustomId("cancel", discordGuildId, userId))
      .setLabel("CANCEL")
      .setStyle(ButtonStyle.Secondary)
  );
}

function createResetCustomId(action: "reset" | "cancel", discordGuildId: string, userId: string): string {
  return `${RESET_CUSTOM_ID_PREFIX}:${action}:${discordGuildId}:${userId}`;
}

function parseResetCustomId(customId: string): {
  action: "reset" | "cancel";
  discordGuildId: string;
  userId: string;
} | undefined {
  const [prefix, action, discordGuildId, userId] = customId.split(":");
  if (prefix !== RESET_CUSTOM_ID_PREFIX || (action !== "reset" && action !== "cancel")) {
    return undefined;
  }
  if (!discordGuildId || !userId) {
    return undefined;
  }
  return { action, discordGuildId, userId };
}
