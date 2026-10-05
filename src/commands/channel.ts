import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandStringOption
} from "discord.js";
import type { createContentRepository } from "../db/contentRepository.js";
import { currentEntryMember, panelPermissions, replyEntryState } from "../services/entryPanels/access.js";
import type { createEntryPanelService } from "../services/entryPanels/service.js";
import { ENTRY_NAMES, type EntryFeature } from "../services/entryPanels/types.js";
import type { TemporaryVoiceService } from "../services/temporaryVoice.js";
import { rejectNonGuildInteraction } from "./configurationHelpers.js";
import { describeLogChannel, handleLogChannelAction, type LogChannelDependencies } from "./logChannel.js";

export const CHANNEL_SYSTEMS = ["content", "account", "regear", "specialisation", "giveaway", "voice", "log"] as const;
export type ChannelSystem = typeof CHANNEL_SYSTEMS[number];

const ENTRY_SYSTEMS: Record<Exclude<ChannelSystem, "content" | "voice" | "log">, EntryFeature> = {
  account: "accounts",
  regear: "regears",
  specialisation: "specialisation",
  giveaway: "giveaways"
};
const SYSTEM_NAMES: Record<ChannelSystem, string> = {
  content: "Content",
  account: ENTRY_NAMES.accounts,
  regear: ENTRY_NAMES.regears,
  specialisation: ENTRY_NAMES.specialisation,
  giveaway: ENTRY_NAMES.giveaways,
  voice: "Temporary Voice",
  log: "Log"
};

function systemOption(option: SlashCommandStringOption, required: boolean) {
  return option.setName("system").setDescription("System whose channel is being configured.")
    .setRequired(required).addChoices(...CHANNEL_SYSTEMS.map(system => ({ name: system, value: system })));
}

export const channelCommand = new SlashCommandBuilder()
  .setName("channel")
  .setDescription("Configure system channels.")
  .setDefaultMemberPermissions(0)
  .addSubcommand(command => command.setName("set").setDescription("Set a system's channel.")
    .addStringOption(option => systemOption(option, true))
    .addChannelOption(option => option.setName("channel").setDescription("Channel to use for this system.")
      .setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)))
  .addSubcommand(command => command.setName("clear").setDescription("Clear a system's channel.")
    .addStringOption(option => systemOption(option, true)))
  .addSubcommand(command => command.setName("show").setDescription("Show one or all configured system channels.")
    .addStringOption(option => systemOption(option, false)));

export interface ChannelCommandDependencies {
  logChannelRepository?: LogChannelDependencies["logChannelRepository"];
  logFeedService?: LogChannelDependencies["logFeedService"];
  contentRepository: Pick<ReturnType<typeof createContentRepository>, "getContentChannel" | "setContentChannel" | "clearContentChannel">;
  entryPanelService: Pick<ReturnType<typeof createEntryPanelService>, "captureFence" | "runExclusive" | "runGuild" | "configureChannel" | "context" | "content">;
  temporaryVoiceService: Pick<TemporaryVoiceService, "getConfig" | "configureBaseChannel" | "clearConfig" | "getMissingBotPermissions">;
}

export async function handleChannelCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: ChannelCommandDependencies
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction) || !interaction.guild || !interaction.guildId) return;
  const { contentRepository, entryPanelService, temporaryVoiceService } = dependencies;
  const live = entryPanelService.captureFence(interaction.guildId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await currentEntryMember(interaction);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await replyEntryState(interaction, "Administrator Required", "You need Discord Administrator permission to configure system channels.");
    return;
  }
  const again = () => replyEntryState(interaction, "Start Again", "This command is no longer current. Run the command again.");
  if (!live()) { await again(); return; }
  const action = interaction.options.getSubcommand();
  const selectedSystem = interaction.options.getString("system", action !== "show");
  if (selectedSystem && !CHANNEL_SYSTEMS.includes(selectedSystem as ChannelSystem)) {
    await replyEntryState(interaction, "Unknown Channel System", "Choose content, account, regear, specialisation, giveaway, voice, or log.");
    return;
  }
  const system = selectedSystem as ChannelSystem | null;
  const repository = entryPanelService.context.repository;

  async function getChannelId(selected: ChannelSystem): Promise<string | undefined> {
    if (selected === "log") return (await dependencies.logChannelRepository?.get(interaction.guildId!))?.discordChannelId;
    if (selected === "content") return (await contentRepository.getContentChannel(interaction.guildId!))?.discordChannelId;
    if (selected === "voice") return (await temporaryVoiceService.getConfig(interaction.guildId!))?.baseChannelId;
    return (await repository.getChannel(interaction.guildId!, ENTRY_SYSTEMS[selected]))?.discordChannelId;
  }

  if (action === "show") {
    const systems = system ? [system] : [...CHANNEL_SYSTEMS];
    const channels = await Promise.all(systems.map(async selected => {
      const channelId = await getChannelId(selected);
      const description = selected === "log" && dependencies.logFeedService
        ? await describeLogChannel(interaction, channelId, dependencies.logFeedService)
        : channelId ? `<#${channelId}>` : "Not configured.";
      return { system: selected, description };
    }));
    if (!live()) { await again(); return; }
    await replyEntryState(interaction, system ? `${SYSTEM_NAMES[system]} Channel` : "System Channels", channels.map(({ system: selected, description }) =>
      system
        ? description === "Not configured." ? `No ${SYSTEM_NAMES[selected]} channel is configured.` : `${SYSTEM_NAMES[selected]} channel: ${description}`
        : `${SYSTEM_NAMES[selected]}: ${description}`
    ).join("\n"), "body", !system);
    return;
  }
  if (!system || (action !== "set" && action !== "clear")) {
    await replyEntryState(interaction, "Unknown Channel Command", "Choose a system and a supported channel command.");
    return;
  }

  if (system === "log") {
    if (!dependencies.logChannelRepository || !dependencies.logFeedService) throw new Error("Log channel configuration is unavailable.");
    await handleLogChannelAction(interaction, action, {
      logChannelRepository: dependencies.logChannelRepository,
      logFeedService: dependencies.logFeedService,
      runExclusive: (guildId, operation) => entryPanelService.runExclusive(guildId, operation)
    }, live);
    return;
  }

  if (action === "clear") {
    const result = await entryPanelService.runExclusive(interaction.guildId, async () => {
      if (!live()) return undefined;
      if (system === "voice") return { cleared: await temporaryVoiceService.clearConfig(interaction.guildId!) };
      if (system === "content") await contentRepository.clearContentChannel(interaction.guildId!);
      else await repository.clearChannel(interaction.guildId!, ENTRY_SYSTEMS[system]);
      return { cleared: true };
    });
    if (!result) { await again(); return; }
    if (system !== "voice") await entryPanelService.runGuild(interaction.guild);
    if (!live()) { await again(); return; }
    const description = system === "voice"
      ? result.cleared
        ? "New temporary voice channels will no longer be created; existing temporary channels will be removed when empty."
        : "No temporary voice base channel is configured."
      : system === "content"
        ? "The Content channel setting and entry panel were removed; new content threads will use the current channel by default."
        : `The ${SYSTEM_NAMES[system]} channel setting and entry panel have been removed.`;
    await replyEntryState(interaction, system === "voice" && !result.cleared ? "No Temporary Voice Channel" : `${SYSTEM_NAMES[system]} Channel Cleared`, description, "body");
    if (system === "content") await replyContentMaintenance(interaction, entryPanelService);
    return;
  }

  const selectedChannel = interaction.options.getChannel("channel", true);
  const channel = await interaction.guild.channels.fetch(selectedChannel.id).catch(() => null);
  if (!live()) { await again(); return; }
  if (system === "voice") {
    if (channel?.type !== ChannelType.GuildVoice) {
      await replyEntryState(interaction, "Invalid Voice Channel", "Choose an ordinary voice channel.");
      return;
    }
    const missingPermissions = temporaryVoiceService.getMissingBotPermissions(interaction.guild, channel);
    if (missingPermissions.length > 0) {
      await replyEntryState(interaction, "Voice Permissions Missing", `Guild Manager needs these permissions in <#${channel.id}>: ${missingPermissions.join(", ")}.`);
      return;
    }
    const configured = await entryPanelService.runExclusive(interaction.guildId, async () => {
      if (!live()) return false;
      await temporaryVoiceService.configureBaseChannel(interaction.guild!, channel);
      return true;
    });
    if (!configured || !live()) { await again(); return; }
    await replyEntryState(interaction, "Temporary Voice Channel Configured", `Members who join <#${channel.id}> will create a temporary voice channel.`, "body");
    return;
  }

  const requiredPermissions = system === "content"
    ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]
    : panelPermissions(ENTRY_SYSTEMS[system]);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    || !channel.permissionsFor(interaction.guild.members.me ?? interaction.guild.client.user!.id)?.has(requiredPermissions)) {
    await replyEntryState(interaction, "Channel Unavailable", "Choose a text or announcement channel where Guild Manager can post and maintain this system’s messages.");
    return;
  }
  const configured = await entryPanelService.runExclusive(interaction.guildId, async () => {
    if (!live()) return false;
    if (system !== "content") return entryPanelService.configureChannel(interaction.guild!, ENTRY_SYSTEMS[system], channel);
    await contentRepository.setContentChannel(interaction.guildId!, channel.id);
    return true;
  });
  if (!live()) { await again(); return; }
  if (!configured) {
    await replyEntryState(interaction, "Channel Unavailable", "Guild Manager cannot use that channel. Choose a channel where it can post and maintain this system’s messages.");
    return;
  }
  await entryPanelService.runGuild(interaction.guild);
  if (!live()) { await again(); return; }
  await replyEntryState(interaction, `${SYSTEM_NAMES[system]} Channel Set`, system === "content"
    ? `New content threads will be created in <#${channel.id}> by default.`
    : `${SYSTEM_NAMES[system]} channel set to <#${channel.id}>.`, "body");
  if (system === "content") await replyContentMaintenance(interaction, entryPanelService);
}

async function replyContentMaintenance(
  interaction: ChatInputCommandInteraction,
  service: ChannelCommandDependencies["entryPanelService"]
): Promise<void> {
  const warning = service.content.getLastWarning(interaction.guildId!);
  if (warning) await replyEntryState(interaction, "Content Panel Maintenance", warning);
}
