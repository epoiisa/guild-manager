import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { QueryResult } from "pg";
import type { PostgresPool } from "../db/postgres.js";
import type { Logger } from "../logging/logger.js";
import {
  acquireRuntimeLock,
  RuntimeLockAcquisitionAbortedError,
  type RuntimeLock
} from "./runtimeLock.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

class FakeLockDatabase {
  holder: FakePoolClient | undefined;
}

class FakePoolClient extends EventEmitter {
  released = false;
  destroyed = false;

  constructor(
    private readonly database: FakeLockDatabase,
    private readonly beforeTryResult?: () => void
  ) {
    super();
  }

  async query<Row extends Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
    if (sql.includes("pg_try_advisory_lock")) {
      const acquired = !this.database.holder || this.database.holder === this;
      if (acquired) this.database.holder = this;
      this.beforeTryResult?.();
      return { rows: [{ acquired } as unknown as Row] } as QueryResult<Row>;
    }
    if (sql.includes("pg_advisory_unlock")) {
      if (this.database.holder === this) this.database.holder = undefined;
      return { rows: [{} as Row] } as QueryResult<Row>;
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  release(destroy = false): void {
    this.released = true;
    this.destroyed = destroy;
    if (this.database.holder === this) this.database.holder = undefined;
  }
}

function fakePool(client: FakePoolClient): PostgresPool {
  return { connect: async () => client } as unknown as PostgresPool;
}

function lockOptions(signal: AbortSignal, onConnectionLoss = (_error: Error): void => undefined) {
  return { signal, logger, onConnectionLoss, retryIntervalMs: 2 };
}

test("runtime lock acquires and releases its dedicated connection", async () => {
  const database = new FakeLockDatabase();
  const client = new FakePoolClient(database);
  const lock = await acquireRuntimeLock(fakePool(client), lockOptions(new AbortController().signal));

  assert.equal(database.holder, client);
  await lock.release();
  await lock.release();
  assert.equal(database.holder, undefined);
  assert.equal(client.released, true);
  assert.equal(client.destroyed, false);
});

test("a waiting runtime acquires only after lock handover", async () => {
  const database = new FakeLockDatabase();
  const first = await acquireRuntimeLock(
    fakePool(new FakePoolClient(database)),
    lockOptions(new AbortController().signal)
  );
  let secondStarted = false;
  const secondPromise = acquireRuntimeLock(
    fakePool(new FakePoolClient(database)),
    lockOptions(new AbortController().signal)
  ).then((lock) => {
    secondStarted = true;
    return lock;
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(secondStarted, false);
  await first.release();
  const second = await secondPromise;
  assert.equal(secondStarted, true);
  await second.release();
});

test("signal aborts a runtime waiting for the lock", async () => {
  const database = new FakeLockDatabase();
  const first = await acquireRuntimeLock(
    fakePool(new FakePoolClient(database)),
    lockOptions(new AbortController().signal)
  );
  const controller = new AbortController();
  const waitingClient = new FakePoolClient(database);
  const waiting = acquireRuntimeLock(fakePool(waitingClient), lockOptions(controller.signal));

  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(waiting, RuntimeLockAcquisitionAbortedError);
  assert.equal(waitingClient.destroyed, true);
  await first.release();
});

test("signal during the acquisition query releases the newly acquired lock", async () => {
  const database = new FakeLockDatabase();
  const controller = new AbortController();
  const client = new FakePoolClient(database, () => controller.abort());

  await assert.rejects(
    acquireRuntimeLock(fakePool(client), lockOptions(controller.signal)),
    RuntimeLockAcquisitionAbortedError
  );
  assert.equal(database.holder, undefined);
  assert.equal(client.destroyed, true);
});

test("loss of the lock-holding connection is fatal", async () => {
  const database = new FakeLockDatabase();
  const client = new FakePoolClient(database);
  let fatalError: Error | undefined;
  const lock = await acquireRuntimeLock(
    fakePool(client),
    lockOptions(new AbortController().signal, (error) => { fatalError = error; })
  );

  client.emit("error", new Error("connection dropped"));
  assert.equal(fatalError?.message, "connection dropped");
  await lock.release();
});

test("two simulated workers cannot both start Discord-facing work", async () => {
  const database = new FakeLockDatabase();
  const started: string[] = [];
  const startWorker = async (name: string, client: FakePoolClient): Promise<RuntimeLock> => {
    const lock = await acquireRuntimeLock(
      fakePool(client),
      lockOptions(new AbortController().signal)
    );
    started.push(name);
    return lock;
  };

  const first = await startWorker("first", new FakePoolClient(database));
  const secondPromise = startWorker("second", new FakePoolClient(database));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(started, ["first"]);
  await first.release();
  const second = await secondPromise;
  assert.deepEqual(started, ["first", "second"]);
  await second.release();
});
