import assert from "node:assert/strict";
import test from "node:test";
import { createMemberActionGuard } from "./memberActionGuard.js";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("kick drains running guild actions and queued actors recheck the committed block", async () => {
  const entered = latch(), finish = latch();
  let blocked = false;
  const events: string[] = [];
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async (_guild, user) => user === "member" && blocked });
  const active = guard.run("guild", "member", async () => {
    events.push("start"); entered.release(); await finish.promise; events.push("finish");
  });
  await entered.promise;
  const kick = guard.run("guild", "officer", async () => {
    events.push("kick"); blocked = true;
    await guard.runSystem("guild", async () => events.push("nested cleanup"));
  }, true);
  const queued = guard.run("guild", "member", async () => { events.push("must not run"); });
  assert.equal(guard.isExclusivePending("guild"), true);
  assert.deepEqual(await guard.run("other-guild", "officer", async () => "unrelated"), { allowed: true, value: "unrelated" });
  assert.deepEqual(events, ["start"]);
  finish.release();
  await active;
  assert.equal((await kick).allowed, true);
  assert.deepEqual(await queued, { allowed: false });
  assert.deepEqual(events, ["start", "finish", "kick", "nested cleanup"]);
  assert.equal(guard.isExclusivePending("guild"), false);
});

test("access blocks include privileged actors and remain isolated to the invoking guild", async () => {
  const reads: string[] = [];
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async (guild, user) => { reads.push(`${guild}:${user}`); return guild === "blocked"; } });
  const work = async () => "allowed";
  assert.deepEqual(await guard.run("blocked", "administrator", work, true), { allowed: false });
  assert.deepEqual(await guard.run("other", "administrator", work), { allowed: true, value: "allowed" });
  assert.deepEqual(reads, ["blocked:administrator", "other:administrator"]);
});

test("exclusive cleanup retries cannot re-arm source state midway through officer recovery", async () => {
  const snapshotRead = latch(), finishRecovery = latch(), retryStarted = latch(), finishRetry = latch();
  let cleanupPending = false;
  const events: string[] = [];
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false });
  const recovery = guard.run("guild", "officer", async () => {
    assert.equal(cleanupPending, false);
    events.push("snapshot"); snapshotRead.release(); await finishRecovery.promise;
    assert.equal(cleanupPending, false);
    events.push("recovery completed");
  });
  await snapshotRead.promise;
  const retry = guard.runSystem("guild", async () => {
    cleanupPending = true; events.push("cleanup re-armed"); retryStarted.release(); await finishRetry.promise;
    // A failed retry retains pending state for the next officer recovery.
  }, true);
  assert.equal(guard.isExclusivePending("guild"), true);
  assert.equal(cleanupPending, false);
  finishRecovery.release(); await recovery; await retryStarted.promise;
  const nextRecovery = guard.run("guild", "officer", async () => {
    assert.equal(cleanupPending, true); events.push("recovery denied");
  });
  assert.deepEqual(events, ["snapshot", "recovery completed", "cleanup re-armed"]);
  finishRetry.release(); await Promise.all([retry, nextRecovery]);
  assert.deepEqual(events, ["snapshot", "recovery completed", "cleanup re-armed", "recovery denied"]);
});

test("minute maintenance releases shared work before acquiring exclusive cleanup access", async () => {
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false });
  const events: string[] = [];
  await guard.runSystem("guild", async () => {
    assert.equal(guard.isExclusivePending("guild"), false);
    await guard.run("guild", "member", async () => { events.push("ordinary action"); });
    events.push("departure checks complete");
  });
  await guard.runSystem("guild", async () => {
    assert.equal(guard.isExclusivePending("guild"), true);
    // Nested maintenance helpers reuse the exclusive lease without upgrading.
    await guard.runSystem("guild", async () => { events.push("kick retry"); });
  }, true);
  assert.deepEqual(events, ["ordinary action", "departure checks complete", "kick retry"]);
  assert.equal(guard.isExclusivePending("guild"), false);
});

test("failed access reads fail closed and both read and action errors release their barrier", async () => {
  let unavailable = true;
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => { if (unavailable) throw Error("unavailable"); return false; } });
  await assert.rejects(guard.run("guild", "user", async () => assert.fail("must fail closed")), /unavailable/);
  unavailable = false;
  await assert.rejects(guard.run("guild", "officer", async () => { throw Error("action failed"); }, true), /action failed/);
  assert.deepEqual(await guard.run("guild", "user", async () => "next"), { allowed: true, value: "next" });
});

test("expired async context cannot bypass a later exclusive barrier", async () => {
  const runLater = latch(), detachedStarted = latch(), finishKick = latch();
  const events: string[] = [];
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false });
  let detached!: Promise<void>;
  await guard.runSystem("guild", async () => {
    detached = (async () => {
      await runLater.promise;
      detachedStarted.release();
      await guard.runSystem("guild", async () => { events.push("detached"); });
    })();
  });
  const kick = guard.runSystem("guild", async () => {
    events.push("kick"); runLater.release(); await finishKick.promise; events.push("kick complete");
  }, true);
  await detachedStarted.promise;
  assert.deepEqual(events, ["kick"]);
  finishKick.release();
  await Promise.all([kick, detached]);
  assert.deepEqual(events, ["kick", "kick complete", "detached"]);
});

test("stopping the runtime rejects queued work after the active action releases", async () => {
  const entered = latch(), finish = latch();
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false });
  const active = guard.runSystem("guild", async () => { entered.release(); await finish.promise; }, true);
  await entered.promise;
  const pending = guard.run("guild", "user", async () => assert.fail("stopped action must not run"));
  guard.stop();
  finish.release();
  await active;
  await assert.rejects(pending, /stopping/);
});
