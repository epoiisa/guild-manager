import { REST, Routes, type Guild } from "discord.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { activeGuildCommands, activationGuildCommands } from "./commands.js";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

export type GuildCommandState = "activation-only" | "active";

export async function registerActivationOnlyGuildCommands(
  guild: Guild,
  config: AppConfig,
  logger: Logger
): Promise<void> {
  await registerGuildCommands(guild, activationGuildCommands, "activation-only", config, logger);
}

export async function registerActiveGuildCommands(guild: Guild, config: AppConfig, logger: Logger): Promise<void> {
  await registerGuildCommands(guild, activeGuildCommands, "active", config, logger);
}

export async function registerGuildCommands(
  guild: Guild,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
  commandState: GuildCommandState,
  config: AppConfig,
  logger: Logger
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  logger.info("registering guild commands", {
    clientId: config.discordClientId,
    guildId: guild.id,
    guildName: guild.name,
    commandState,
    commandCount: commands.length
  });

  await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, guild.id),
    { body: commands }
  );

  logger.info("registered guild commands", {
    clientId: config.discordClientId,
    guildId: guild.id,
    guildName: guild.name,
    commandState,
    commandCount: commands.length
  });
}
