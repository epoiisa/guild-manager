import type { ChatInputCommandInteraction } from "discord.js";
import type { LogChannelRepository } from "../db/logChannelRepository.js";
import { replyEntryState } from "../services/entryPanels/access.js";
import type { LogFeedService } from "../services/logFeed/delivery.js";
import { LOG_DELIVERY_WARNING } from "../services/logFeed/runtime.js";

export interface LogChannelDependencies {
  logChannelRepository: LogChannelRepository;
  logFeedService: LogFeedService;
  runExclusive<T>(guildId: string, task: () => Promise<T>): Promise<T>;
}

export async function describeLogChannel(interaction: ChatInputCommandInteraction, channelId: string | undefined, service: LogFeedService): Promise<string> {
  if (!channelId) return "Not configured.";
  const state = await service.inspect(interaction.guild!, channelId);
  return `<#${channelId}> • ${state.available ? "Available" : "Unavailable"}.${state.missingPermissions.length ? ` Missing: ${state.missingPermissions.join(", ")}.` : ""}${exposure(state.everyoneVisible)}`;
}

/** Called only after the shared /channel handler's live Administrator check. */
export async function handleLogChannelAction(interaction: ChatInputCommandInteraction, action: "set" | "clear", dependencies: LogChannelDependencies, live: () => boolean): Promise<void> {
  const { logChannelRepository: repository, logFeedService: delivery } = dependencies;
  const guild = interaction.guild!;
  const again = () => replyEntryState(interaction, "Start Again", "This command is no longer current. Run the command again.");
  const channelId = action === "set" ? interaction.options.getChannel("channel", true).id : undefined;
  const inspection = channelId ? await delivery.inspect(guild, channelId) : undefined;
  if (!live()) { await again(); return; }
  if (inspection && !inspection.available) {
    await replyEntryState(interaction, "Channel Unavailable", "Choose a text or announcement channel where Guild Manager has View Channel and Send Messages.");
    return;
  }
  const result = await dependencies.runExclusive(guild.id, async () => {
    if (!live()) return undefined;
    const previous = await repository.get(guild.id);
    if (!live()) return undefined;
    if (action === "clear") {
      if (!previous) return { title: "Log Channel Cleared", body: "No log channel is configured." };
      await repository.clear(guild.id);
      const sent = await delivery.send(guild, ["Audit logging disabled."], { channelId: previous.discordChannelId });
      return { title: "Audit Feed Disabled", body: `Guild Manager will no longer post Discord audit entries.${sent === "failed" ? `\n${LOG_DELIVERY_WARNING}` : ""}` };
    }
    if (previous?.discordChannelId === channelId) return { title: "Audit Feed Configured", body: `Guild Manager will post member and membership audit entries in <#${channelId}>.${exposure(inspection!.everyoneVisible)}` };
    if (await delivery.send(guild, ["Audit logging enabled here."], { channelId }) !== "sent") return { title: "Channel Unavailable", body: "The audit test entry could not be delivered. The log channel setting was not changed." };
    if (!live()) return undefined;
    try { await repository.set(guild.id, channelId!, interaction.user.id); }
    catch { return { title: "Log Channel Not Saved", body: "The test entry was sent, but the log channel setting could not be saved. Run the command again." }; }
    let warning = "";
    if (previous && await delivery.send(guild, [`Audit logging moved to <#${channelId}>.`], { channelId: previous.discordChannelId }) === "failed") warning = `\n${LOG_DELIVERY_WARNING}`;
    return { title: "Audit Feed Configured", body: `Guild Manager will post member and membership audit entries in <#${channelId}>.${exposure(inspection!.everyoneVisible)}${warning}` };
  });
  if (!result || !live()) { await again(); return; }
  await replyEntryState(interaction, result.title, result.body, "body");
}

function exposure(everyoneVisible: boolean | null): string {
  return everyoneVisible === true ? " Warning: @everyone can view this channel." : everyoneVisible === null ? " Channel visibility could not be confirmed." : "";
}
