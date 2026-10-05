import assert from "node:assert/strict";
import test from "node:test";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

test("nested application services retain their outer lock while independent operations wait", { timeout: 2000 }, async () => {
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const first = withApplicationOperationLock("guild", "application", async () => {
    events.push("outer");
    await withApplicationOperationLock("guild", "application", async () => {
      events.push("nested");
      started();
      await gate;
    });
    events.push("presented");
  });
  await entered;
  const second = withApplicationOperationLock("guild", "application", async () => { events.push("second"); });
  await withApplicationOperationLock("other-guild", "application", async () => { events.push("other-tenant"); });
  assert.deepEqual(events, ["outer", "nested", "other-tenant"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["outer", "nested", "other-tenant", "presented", "second"]);
});

test("failed nested application operations release ownership and the queue", async () => {
  await assert.rejects(withApplicationOperationLock("guild", "failed", () =>
    withApplicationOperationLock("guild", "failed", async () => { throw new Error("failed operation"); })
  ), /failed operation/);
  assert.equal(await withApplicationOperationLock("guild", "failed", async () => "recovered"), "recovered");
});
