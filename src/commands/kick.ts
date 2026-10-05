import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import { editFeedback } from "../discord/feedbackMessages.js";
import type { createKickService } from "../services/membership/kick.js";
import { buildNotFoundEmbed, buildSuccessEmbed, rejectNonGuildInteraction } from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export const kickCommand = new SlashCommandBuilder()
  .setName("kick")
  .setDescription("Revoke a Discord user's Guild Manager access until officer reconnection.")
  .setDefaultMemberPermissions(0)
  .addUserOption((option) => option.setName("user").setDescription("Discord user.").setRequired(true));

export async function handleKickCommand(
  interaction: ChatInputCommandInteraction,
  _membershipRepository: MembershipRepository,
  kickService: Pick<ReturnType<typeof createKickService>, "kickMember">
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Server Unavailable", "The Discord server could not be verified. Try again.")] });
    return;
  }
  const user = interaction.options.getUser("user", true);
  if (user.id === interaction.guild.client.user.id) {
    await editFeedback(interaction, { cards: [buildNotFoundEmbed("Cannot Kick Guild Manager", "Guild Manager cannot revoke its own bot access.")] });
    return;
  }
  const { characters, warnings } = await kickService.kickMember(interaction.guild, user.id, interaction.user.id);
  await editFeedback(interaction, {
    cards: [
      buildSuccessEmbed(
        "Member Kicked",
        `${user} is blocked from Guild Manager until an officer reconnects them with /character register. ${characters.length} character registration${characters.length === 1 ? " was" : "s were"} removed. Accounts, re-gears and weapon specialisations were preserved; former authority and positions will not return on reconnection.${warnings.length > 0 ? `\n\nCleanup is pending; reconnection remains blocked.\n${warnings.slice(0, 6).map(warning => warning.message).join("\n")}${warnings.length > 6 ? `\n${warnings.length - 6} additional cleanup issue(s) will also be retried.` : ""}` : ""}`
      )
    ]
  });
}
