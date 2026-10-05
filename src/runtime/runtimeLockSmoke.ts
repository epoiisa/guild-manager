import "dotenv/config";
import { createPostgresPool } from "../db/postgres.js";
import { createLogger } from "../logging/logger.js";
import { acquireRuntimeLock } from "./runtimeLock.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");

const logger = createLogger("info", { check: "runtime-lock-smoke" });
const firstPool = createPostgresPool(databaseUrl);
const secondPool = createPostgresPool(databaseUrl);
const firstAbort = new AbortController();
const secondAbort = new AbortController();
let firstLock;
let secondLock;

try {
  firstLock = await acquireRuntimeLock(firstPool, {
    signal: firstAbort.signal,
    logger,
    onConnectionLoss: (error) => { throw error; },
    retryIntervalMs: 25
  });

  let secondAcquired = false;
  const secondLockPromise = acquireRuntimeLock(secondPool, {
    signal: secondAbort.signal,
    logger,
    onConnectionLoss: (error) => { throw error; },
    retryIntervalMs: 25
  }).then((lock) => {
    secondAcquired = true;
    return lock;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  if (secondAcquired) throw new Error("Two runtimes acquired the advisory lock simultaneously");

  await firstLock.release();
  firstLock = undefined;
  secondLock = await secondLockPromise;
  console.log(JSON.stringify({ runtimeLock: "handover-ok" }));
} finally {
  secondAbort.abort();
  firstAbort.abort();
  await secondLock?.release().catch(() => undefined);
  await firstLock?.release().catch(() => undefined);
  await Promise.all([
    firstPool.end().catch(() => undefined),
    secondPool.end().catch(() => undefined)
  ]);
}
