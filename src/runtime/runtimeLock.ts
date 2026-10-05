import type { PoolClient } from "pg";
import type { PostgresPool } from "../db/postgres.js";
import type { Logger } from "../logging/logger.js";

// Two stable signed 32-bit keys spell "GMRT" and "LOCK" in ASCII. Changing
// either key would allow old and new Guild Manager runtimes to overlap.
export const RUNTIME_LOCK_KEYS = [0x474d5254, 0x4c4f434b] as const;
export const RUNTIME_LOCK_RETRY_MS = 1_000;

export class RuntimeLockAcquisitionAbortedError extends Error {
  constructor() {
    super("Runtime lock acquisition aborted");
    this.name = "RuntimeLockAcquisitionAbortedError";
  }
}

export interface RuntimeLock {
  release(): Promise<void>;
}

export interface RuntimeLockOptions {
  signal: AbortSignal;
  logger: Logger;
  onConnectionLoss(error: Error): void;
  retryIntervalMs?: number;
}

export async function acquireRuntimeLock(
  pool: PostgresPool,
  options: RuntimeLockOptions
): Promise<RuntimeLock> {
  if (options.signal.aborted) throw new RuntimeLockAcquisitionAbortedError();

  const client = await pool.connect();
  let acquired = false;
  let released = false;
  let waitingLogged = false;

  const connectionError = (error: Error): void => {
    if (acquired && !released) options.onConnectionLoss(error);
  };
  client.on("error", connectionError);

  try {
    while (!options.signal.aborted) {
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1::integer, $2::integer) as acquired",
        [...RUNTIME_LOCK_KEYS]
      );
      if (result.rows[0]?.acquired === true) {
        if (options.signal.aborted) throw new RuntimeLockAcquisitionAbortedError();
        acquired = true;
        options.logger.info("runtime lock acquired");
        return createRuntimeLock(client, connectionError, () => {
          released = true;
        });
      }

      if (!waitingLogged) {
        waitingLogged = true;
        options.logger.info("waiting for runtime lock");
      }
      await abortableDelay(options.retryIntervalMs ?? RUNTIME_LOCK_RETRY_MS, options.signal);
    }

    throw new RuntimeLockAcquisitionAbortedError();
  } catch (error) {
    released = true;
    client.off("error", connectionError);
    client.release(true);
    throw error;
  }
}

function createRuntimeLock(
  client: PoolClient,
  connectionError: (error: Error) => void,
  markReleased: () => void
): RuntimeLock {
  let releasePromise: Promise<void> | undefined;

  return {
    release(): Promise<void> {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        markReleased();
        client.off("error", connectionError);
        let destroyClient = false;
        try {
          await client.query(
            "select pg_advisory_unlock($1::integer, $2::integer)",
            [...RUNTIME_LOCK_KEYS]
          );
        } catch {
          destroyClient = true;
        } finally {
          client.release(destroyClient);
        }
      })();
      return releasePromise;
    }
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new RuntimeLockAcquisitionAbortedError());

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new RuntimeLockAcquisitionAbortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
