import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedSerialQueue } from "./keyedSerialQueue.js";

test("reaction changes for one user and role finish in gateway order", async () => {
  const queue = createKeyedSerialQueue();
  const events: string[] = [];
  let releaseAdd!: () => void;
  const addGate = new Promise<void>((resolve) => {
    releaseAdd = resolve;
  });

  const add = queue.enqueue("guild:role:user", async () => {
    events.push("add-start");
    await addGate;
    events.push("add-finish");
  });
  const remove = queue.enqueue("guild:role:user", async () => {
    events.push("remove");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["add-start"]);
  assert.equal(queue.size, 1);
  releaseAdd();
  await Promise.all([add, remove]);
  assert.deepEqual(events, ["add-start", "add-finish", "remove"]);
  assert.equal(queue.size, 0);
});

test("reaction changes for different users can progress independently", async () => {
  const queue = createKeyedSerialQueue();
  const events: string[] = [];
  await Promise.all([
    queue.enqueue("guild:role:user-1", async () => {
      events.push("user-1");
    }),
    queue.enqueue("guild:role:user-2", async () => {
      events.push("user-2");
    })
  ]);
  assert.deepEqual(new Set(events), new Set(["user-1", "user-2"]));
});
