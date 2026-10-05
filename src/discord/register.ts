import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "../config.js";
import { createGuildLifecycleRepository } from "../db/guildLifecycleRepository.js";
import { createPostgresPool } from "../db/postgres.js";
import { migrateDatabaseSchema } from "../db/schema.js";
import { createLogger } from "../logging/logger.js";
import { registerActiveGuildCommands, registerActivationOnlyGuildCommands } from "./guildCommandRegistration.js";

const config = loadConfig();
const logger = createLogger(config.logLevel, { instance: config.botInstanceName });
const postgres = createPostgresPool(config.databaseUrl);
const lifecycleRepository = createGuildLifecycleRepository(postgres);

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once(Events.ClientReady, async (readyClient) => {
  logger.info("discord logged in for command registration", {
    botUserId: readyClient.user.id,
    botUsername: readyClient.user.tag,
    guildCount: readyClient.guilds.cache.size
  });

  try {
    await migrateDatabaseSchema(postgres);
    for (const guild of readyClient.guilds.cache.values()) {
      if (await lifecycleRepository.isGuildActive(guild.id)) {
        await registerActiveGuildCommands(guild, config, logger);
      } else {
        await registerActivationOnlyGuildCommands(guild, config, logger);
      }
    }
  } finally {
    readyClient.destroy();
    await postgres.end();
  }
});

try {
  await client.login(config.discordToken);
} catch (error) {
  await postgres.end().catch(() => undefined);
  throw error;
}
