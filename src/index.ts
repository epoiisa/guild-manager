import { loadConfig } from "./config.js";
import { createPostgresPool, checkPostgresConnection } from "./db/postgres.js";
import { migrateDatabaseSchema } from "./db/schema.js";
import { createDiscordClient } from "./discord/client.js";
import { createLogger } from "./logging/logger.js";
import {
  acquireRuntimeLock,
  RuntimeLockAcquisitionAbortedError,
  type RuntimeLock
} from "./runtime/runtimeLock.js";

const startedAt = new Date();
const config = loadConfig();
const logger = createLogger(config.logLevel, { instance: config.botInstanceName });
const postgres = createPostgresPool(config.databaseUrl);
const shutdownController = new AbortController();
let runtimeLock: RuntimeLock | undefined;
let discordRuntime: ReturnType<typeof createDiscordClient> | undefined;
let shutdownPromise: Promise<void> | undefined;
let shutdownRequested = false;
let shutdownExitCode = 0;

logger.info("config loaded", {
  clientId: config.discordClientId
});

const shutdown = (reason: string, exitCode: number): Promise<void> => {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shutdownExitCode !== 0) process.exitCode = shutdownExitCode;
  if (shutdownPromise) return shutdownPromise;

  shutdownRequested = true;
  shutdownController.abort();
  shutdownPromise = (async () => {
    logger.info("shutdown requested", { reason, exitCode: shutdownExitCode });
    discordRuntime?.stop(reason);
    discordRuntime?.client.destroy();
    await runtimeLock?.release().catch(() => undefined);
    await postgres.end().catch(() => undefined);
    logger.info("shutdown complete", { reason, exitCode: shutdownExitCode });
    process.exitCode = shutdownExitCode;
  })();
  return shutdownPromise;
};

process.once("SIGINT", () => void shutdown("SIGINT", 0));
process.once("SIGTERM", () => void shutdown("SIGTERM", 0));

try {
  runtimeLock = await acquireRuntimeLock(postgres, {
    signal: shutdownController.signal,
    logger,
    onConnectionLoss: (error) => {
      logger.error("runtime lock connection lost", { error: error.message });
      void shutdown("runtime lock connection lost", 1);
    }
  });
  await checkPostgresConnection(postgres);
  logger.info("postgres connected");
  await migrateDatabaseSchema(postgres);
  logger.info("postgres schema migrated");

  discordRuntime = createDiscordClient({
    config,
    logger,
    postgres,
    startedAt,
    onFatalError: (error) => {
      logger.error("fatal discord runtime error", { error: error.message });
      void shutdown("fatal discord runtime error", 1);
    }
  });

  await discordRuntime.client.login(config.discordToken);
  logger.info("discord login requested");
} catch (error) {
  if (shutdownRequested && error instanceof RuntimeLockAcquisitionAbortedError) {
    await shutdownPromise;
  } else {
    logger.error("startup failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await shutdown("startup failed", 1);
  }
}
