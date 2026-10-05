import assert from "node:assert/strict";
import test from "node:test";
import { runContentInvalidatingOperation } from "./client.js";
import { createKeyedSerialQueue } from "../services/reactionRoles/keyedSerialQueue.js";

test("destructive transition invalidates running work, arrivals while queued and arrivals during purge even on failure", async () => {
  for (const fail of [false, true]) {
    const queue = createKeyedSerialQueue();
    const adapter = { async runExclusive<T>(guild: string, task: () => Promise<T>) { let value!: T; await queue.enqueue(guild, async () => { value = await task(); }); return value; } };
    let epoch = 0;
    const fence = () => { const captured = epoch; return () => captured === epoch; };
    let releaseExisting!: () => void;
    const existing = adapter.runExclusive("g", () => new Promise<void>(resolve => { releaseExisting = resolve; }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const runningFence = fence();
    let duringFence!: () => boolean;
    const destructive = runContentInvalidatingOperation(adapter, () => { epoch++; }, "g", async () => {
      duringFence = fence();
      if (fail) throw new Error("purge failed");
    });
    const result = destructive.catch(() => undefined);
    assert.equal(runningFence(), false);
    const waitingFence = fence();
    let waitingAccepted = true;
    const waiting = adapter.runExclusive("g", async () => { waitingAccepted = waitingFence(); });
    releaseExisting(); await existing; await result; await waiting;
    assert.equal(waitingAccepted, false);
    assert.equal(duringFence(), false);
    assert.equal(fence()(), true);
    assert.equal(epoch, 3);
  }
});
