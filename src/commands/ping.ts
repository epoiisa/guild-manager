import { v2Reply } from "../discord/operationalMessages.js";
import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { AppConfig } from "../config.js";
import { checkPostgresConnection, type PostgresPool } from "../db/postgres.js";
import { ERROR_COLOR, SUCCESS_COLOR } from "./configurationHelpers.js";

export const pingCommand = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check Guild Manager health.")
  .setDefaultMemberPermissions(0);

export interface PingDependencies {
  config: AppConfig;
  startedAt: Date;
  postgres: PostgresPool;
}

export async function handlePingCommand(interaction: ChatInputCommandInteraction, dependencies: PingDependencies): Promise<void> {
  const databaseStartedAt = Date.now();
  let databaseStatus = "OK";

  try {
    await checkPostgresConnection(dependencies.postgres);
  } catch {
    databaseStatus = "FAILED";
  }

  const databaseLatencyMs = Date.now() - databaseStartedAt;
  const uptimeSeconds = Math.floor((Date.now() - dependencies.startedAt.getTime()) / 1000);

  const embed = new EmbedBuilder()
    .setTitle("Guild Manager Ping")
    .setColor(databaseStatus === "OK" ? SUCCESS_COLOR : ERROR_COLOR)
    .addFields(
      { name: "Instance", value: dependencies.config.botInstanceName, inline: true },
      { name: "Discord", value: "OK", inline: true },
      { name: "PostgreSQL", value: `${databaseStatus} (${databaseLatencyMs} ms)`, inline: true },
      { name: "Uptime", value: formatDuration(uptimeSeconds), inline: true }
    )
    .setTimestamp(new Date());

  await interaction.reply(v2Reply({ cards: [embed], flags: MessageFlags.Ephemeral }));
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
