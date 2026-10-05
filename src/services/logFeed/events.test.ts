import assert from "node:assert/strict";
import test from "node:test";
import { isLogCaptureActive, recordLogChange, withLogChanges, type LogChange } from "./events.js";
const change: LogChange = { kind: "role", action: "add", discordUserId: "member", roleId: "role" };

test("operation capture isolates concurrent operations and Discord servers", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withLogChanges("one", async changes => {
    await gate;
    recordLogChange("two", change);
    recordLogChange("one", change);
    return changes;
  });
  const second = withLogChanges("one", async changes => {
    recordLogChange("one", { ...change, roleId: "second" });
    release();
    return changes;
  });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, [change]);
  assert.deepEqual(b, [{ ...change, roleId: "second" }]);
  assert.equal(isLogCaptureActive("one"), false);
});

test("nested work shares its operation but another Discord server stays separate", async () => {
  await withLogChanges("one", async outer => {
    await withLogChanges("one", async inner => {
      assert.equal(inner, outer);
      recordLogChange("one", change);
    });
    await withLogChanges("two", async inner => {
      recordLogChange("one", change);
      assert.equal(inner.length, 0);
    });
    assert.deepEqual(outer, [change]);
  });
});

test("a later failure retains committed evidence for finally and closes detached capture", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let detached!: Promise<void>;
  let retained!: LogChange[];
  await assert.rejects(withLogChanges("one", async changes => {
    retained = changes;
    recordLogChange("one", change);
    detached = gate.then(() => recordLogChange("one", change));
    throw new Error("later work failed");
  }), /later work failed/);
  release();
  await detached;
  assert.deepEqual(retained, [change]);
});
