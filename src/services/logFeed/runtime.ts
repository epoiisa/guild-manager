import { MessageFlags, type Guild, type Interaction, type RepliableInteraction } from "discord.js";
import type { LogChannelRepository } from "../../db/logChannelRepository.js";
import { feedbackReply } from "../../discord/feedbackMessages.js";
import { TAILWIND_500_COLORS } from "../../discord/tailwindColors.js";
import type { Logger } from "../../logging/logger.js";
import type { createLogFeedService } from "./delivery.js";
import { isLogCaptureActive, withLogChanges } from "./events.js";
import { formatLogChanges, type LogOperation } from "./formatting.js";

export const LOG_DELIVERY_WARNING = "The change succeeded, but the audit entry could not be delivered.";
type Delivery = ReturnType<typeof createLogFeedService>;

export function createLogFeedRuntime(repository: LogChannelRepository, delivery: Delivery, logger: Logger) {
  function warn(message: string, guildId: string | null) {
    try { logger.warn(message, { guildId }); } catch { /* Runtime diagnostics cannot change domain results. */ }
  }
  async function configured(guildId: string) {
    try { return await repository.get(guildId); }
    catch { warn("log feed configuration lookup failed", guildId); return null; }
  }

  async function run<T>(guild: Guild, operation: () => Promise<T>, context: LogOperation = {}, interaction?: RepliableInteraction): Promise<T> {
    if (isLogCaptureActive(guild.id)) return operation();
    return withLogChanges(guild.id, async changes => {
      try { return await operation(); }
      catch (error) { context.incomplete = true; throw error; }
      finally {
        // Logging never changes a committed domain outcome or masks its exception.
        try {
          const lines = formatLogChanges(changes, context);
          if (lines.length && await delivery.send(guild, lines) === "failed") await warnInteraction(interaction);
        } catch { warn("log feed publication failed", guild.id); await warnInteraction(interaction); }
      }
    });
  }

  async function warnInteraction(interaction?: RepliableInteraction) {
    if (!interaction || (!interaction.deferred && !interaction.replied)) return;
    try { await interaction.followUp(feedbackReply({ accentColor: TAILWIND_500_COLORS.Amber, text: LOG_DELIVERY_WARNING, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [], repliedUser: false } })); }
    catch { warn("log feed delivery warning unavailable", interaction.guildId); }
  }

  async function interaction(interaction: Interaction, operation: () => Promise<void>): Promise<void> {
    if (!interaction.guild || !interaction.isRepliable() || !isMembershipInteraction(interaction)) return operation();
    const kind = interaction.isChatInputCommand() && interaction.commandName === "kick" ? "kick"
      : interaction.isChatInputCommand() && interaction.commandName === "update" ? "reconciliation" : "membership";
    const discordUserId = kind === "kick" && interaction.isChatInputCommand() ? interaction.options.getUser("user")?.id : undefined;
    const selfService = interaction.isChatInputCommand()
      ? ["register", "unregister"].includes(interaction.commandName)
      : "customId" in interaction && interaction.customId.startsWith("albion-character:register:");
    const actorDiscordUserId = selfService ? undefined : interaction.user.id;
    return run(interaction.guild, operation, { kind, discordUserId, actorDiscordUserId }, interaction);
  }

  async function terminal<T>(guild: Guild, kind: "reset" | "deactivated", operation: () => Promise<T>, interaction?: RepliableInteraction): Promise<T> {
    const previous = await configured(guild.id);
    const result = await operation();
    try {
      const entry = interaction
        ? `<@${interaction.user.id}> ${kind} Guild Manager for this server.`
        : `Guild Manager was ${kind} for this server.`;
      if (previous === null || (previous && await delivery.send(guild, [entry], { channelId: previous.discordChannelId }) === "failed")) await warnInteraction(interaction);
    } catch { warn("log feed terminal entry unavailable", guild.id); await warnInteraction(interaction); }
    return result;
  }
  return { run, interaction, terminal };
}

export type LogFeedRuntime = ReturnType<typeof createLogFeedRuntime>;

function isMembershipInteraction(interaction: RepliableInteraction): boolean {
  if (interaction.isChatInputCommand()) {
    if (["register", "unregister", "kick", "update"].includes(interaction.commandName)) return true;
    if (interaction.commandName === "character") return ["register", "unregister", "switch"].includes(interaction.options.getSubcommand());
    if (interaction.commandName === "member") return ["add", "remove"].includes(interaction.options.getSubcommand());
    if (interaction.commandName === "application") return ["accept", "verify"].includes(interaction.options.getSubcommand());
    return false;
  }
  return "customId" in interaction && /^(albion-character:(register|character-register):|cs:|app:(accept|verify):|member-group-(delete|remove):)/.test(interaction.customId);
}
