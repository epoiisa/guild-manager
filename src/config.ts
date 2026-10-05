import "dotenv/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  botInstanceName: string;
  discordToken: string;
  discordClientId: string;
  databaseUrl: string;
  logLevel: LogLevel;
}

const DEFAULT_INSTANCE_NAME = "Guild Manager";
const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function loadConfig(): AppConfig {
  return {
    botInstanceName: optionalEnv("BOT_INSTANCE_NAME") ?? DEFAULT_INSTANCE_NAME,
    discordToken: requiredEnv("DISCORD_TOKEN"),
    discordClientId: requiredEnv("DISCORD_CLIENT_ID"),
    databaseUrl: requiredEnv("DATABASE_URL"),
    logLevel: parseLogLevel(optionalEnv("LOG_LEVEL") ?? DEFAULT_LOG_LEVEL)
  };
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error("LOG_LEVEL must be one of: debug, info, warn, error");
}
