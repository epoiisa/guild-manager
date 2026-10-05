import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { INVALID_COLOR, SUCCESS_COLOR } from "./configurationHelpers.js";

type GuildLifecycleRepository = ReturnType<typeof createGuildLifecycleRepository>;

export const activateCommand = new SlashCommandBuilder()
  .setName("activate")
  .setDescription("Activate Guild Manager on this Discord server.")
  .setDefaultMemberPermissions(0);

export async function handleActivateCommand(
  interaction: ChatInputCommandInteraction,
  lifecycleRepository: GuildLifecycleRepository,
  onActivated: () => Promise<void>
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(feedbackReply({
      text: "Guild Manager can only be activated from a Discord server.", accentColor: INVALID_COLOR,
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const lifecycle = await lifecycleRepository.getGuildLifecycle(interaction.guildId);
  if (lifecycle?.status === "active") {
    await interaction.reply(feedbackReply({
      text: "Guild Manager is already active on this server.",
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await lifecycleRepository.activateGuild({
    discordGuildId: interaction.guildId,
    guildName: interaction.guild.name,
    actorDiscordUserId: interaction.user.id
  });
  await onActivated();

  const embed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("Guild Manager Activates")
    .setDescription("Guild Manager is active on this server; active commands have been registered.");

  await editFeedback(interaction, { cards: [embed] });
}
