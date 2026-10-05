import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import type { UtcChannelService } from "../services/utcChannel.js";
import {
  INVALID_COLOR,
  buildInfoEmbed,
  buildSuccessEmbed,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

export const utcCommand = new SlashCommandBuilder()
  .setName("utc")
  .setDescription("Manage the UTC time voice channel.")
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Create the UTC time voice channel.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove the UTC time voice channel.")
  );

export async function handleUtcCommand(
  interaction: ChatInputCommandInteraction,
  utcChannelService: UtcChannelService
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) {
    return;
  }

  if (!interaction.guild) {
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await utcChannelService.add(interaction.guild);
    const embed = result.created
      ? buildSuccessEmbed("UTC Channel Added", `Created the UTC time voice channel ${result.channel.toString()}.`)
      : buildInfoEmbed("UTC Channel Already Exists", `The UTC time voice channel is already managed at ${result.channel.toString()}.`);

    await editFeedback(interaction, { cards: [embed] });
    return;
  }

  if (subcommand === "remove") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await utcChannelService.remove(interaction.guild);
    const embed = result.removed
      ? buildSuccessEmbed("UTC Channel Removed", "Removed the managed UTC time voice channel.")
      : buildInfoEmbed("No UTC Channel", "No UTC time voice channel is currently managed.");

    await editFeedback(interaction, { cards: [embed] });
    return;
  }

  await interaction.reply(feedbackReply({
    cards: [
      new EmbedBuilder()
        .setColor(INVALID_COLOR)
        .setTitle("Unknown UTC Command")
        .setDescription("Choose `/utc add` or `/utc remove`.")
    ],
    flags: MessageFlags.Ephemeral
  }, "context"));
}
