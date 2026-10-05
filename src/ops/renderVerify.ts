import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { activeGuildCommands, activationGuildCommands } from "../discord/commands.js";
import { createPostgresPool } from "../db/postgres.js";
import { CURRENT_SCHEMA_VERSION } from "../db/schema.js";

export const EXPECTED_ACTIVE_COMMAND_COUNT = 50;
export const EXPECTED_ACTIVATION_COMMAND_COUNT = 1;
// Production is on schema 29. Migrations 30 through 32 are applied by the
// replacement runtime after it acquires the advisory lock.
export const MINIMUM_COMPATIBLE_SCHEMA_VERSION = 29;

export async function verifyRenderRuntime(): Promise<Record<string, unknown>> {
  const configuredKeys = requiredConfigurationNames();
  const config = loadConfig();
  const postgres = createPostgresPool(config.databaseUrl);

  try {
    await postgres.query("select 1");
    const schema = await postgres.query<{ version: number }>(
      "select coalesce(max(version), 0)::integer as version from guild_manager_schema_migrations"
    );
    const schemaVersion = schema.rows[0]?.version ?? 0;
    assertCompatibleSchemaVersion(schemaVersion);

    assertCommandSurface(activeGuildCommands, EXPECTED_ACTIVE_COMMAND_COUNT, "active");
    assertCommandSurface(activationGuildCommands, EXPECTED_ACTIVATION_COMMAND_COUNT, "activation-only");

    return {
      postgres: "ok",
      schemaVersion,
      schemaTargetVersion: CURRENT_SCHEMA_VERSION,
      schemaMigrationPending: schemaVersion !== CURRENT_SCHEMA_VERSION,
      activeCommandCount: activeGuildCommands.length,
      activationCommandCount: activationGuildCommands.length,
      defaultPermissions: "hidden",
      configuredKeys
    };
  } finally {
    await postgres.end();
  }
}

export function assertCompatibleSchemaVersion(schemaVersion: number): void {
  if (schemaVersion < MINIMUM_COMPATIBLE_SCHEMA_VERSION || schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Expected schema version ${MINIMUM_COMPATIBLE_SCHEMA_VERSION} through ${CURRENT_SCHEMA_VERSION}, found ${schemaVersion}`
    );
  }
}

function requiredConfigurationNames(): string[] {
  const names = [
    "BOT_INSTANCE_NAME",
    "DATABASE_URL",
    "DISCORD_CLIENT_ID",
    "DISCORD_TOKEN",
    "LOG_LEVEL",
    "NODE_ENV"
  ];
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required Render configuration names: ${missing.join(", ")}`);
  }
  return names;
}

function assertCommandSurface(
  commands: Array<{ default_member_permissions?: string | null }>,
  expectedCount: number,
  label: string
): void {
  if (commands.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} ${label} commands, found ${commands.length}`);
  }
  if (commands.some((command) => command.default_member_permissions !== "0")) {
    throw new Error(`${label} commands must default to hidden permissions`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyRenderRuntime()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      }));
      process.exitCode = 1;
    });
}
