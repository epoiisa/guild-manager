import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "../logging/logger.js";
import { createDiscordLifecycle } from "./discordLifecycle.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

test("Discord lifecycle starts and stops scheduler work idempotently across reconnects", () => {
  let starts = 0;
  let stops = 0;
  const lifecycle = createDiscordLifecycle({
    logger,
    startWork: () => { starts += 1; },
    stopWork: () => { stops += 1; },
    onWatchdogExpired: () => undefined,
    watchdogMilliseconds: 1_000
  });

  assert.equal(lifecycle.connected("ready"), true);
  assert.equal(lifecycle.connected("shard-ready", 0), false);
  lifecycle.disconnected("shard-disconnect", 0);
  lifecycle.disconnected("shard-reconnecting", 0);
  assert.equal(lifecycle.connected("shard-resume", 0), true);
  assert.equal(lifecycle.connected("shard-ready", 0), false);
  assert.equal(starts, 2);
  assert.equal(stops, 1);
  lifecycle.stop("test complete");
  lifecycle.stop("duplicate stop");
  assert.equal(stops, 2);
});

test("Discord lifecycle records one recovery with the original disconnect context", () => {
  const infos: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  let currentTime = 1_000;
  const lifecycle = createDiscordLifecycle({
    logger: {
      ...logger,
      info: (message, fields) => { infos.push({ message, fields }); }
    },
    startWork: () => undefined,
    stopWork: () => undefined,
    onWatchdogExpired: () => undefined,
    now: () => currentTime
  });

  lifecycle.connected("ready");
  lifecycle.disconnected("shard-disconnect", 2);
  currentTime = 1_250;
  lifecycle.disconnected("shard-reconnecting", 2);
  currentTime = 1_600;
  lifecycle.connected("shard-resume", 2);

  assert.deepEqual(infos, [
    { message: "discord runtime work started", fields: { event: "ready", shardId: undefined } },
    {
      message: "discord runtime work recovered",
      fields: {
        durationMilliseconds: 600,
        startEvent: "shard-disconnect",
        startShardId: 2,
        recoveryEvent: "shard-resume",
        recoveryShardId: 2
      }
    }
  ]);
  lifecycle.stop("test complete");
});

test("Discord disconnect watchdog expires while the runtime remains unusable", async () => {
  let expired = 0;
  const lifecycle = createDiscordLifecycle({
    logger,
    startWork: () => undefined,
    stopWork: () => undefined,
    onWatchdogExpired: () => { expired += 1; },
    watchdogMilliseconds: 10
  });

  lifecycle.connected("ready");
  lifecycle.disconnected("shard-disconnect", 0);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(expired, 1);
});

test("Discord reconnect cancels the disconnect watchdog", async () => {
  let expired = 0;
  const lifecycle = createDiscordLifecycle({
    logger,
    startWork: () => undefined,
    stopWork: () => undefined,
    onWatchdogExpired: () => { expired += 1; },
    watchdogMilliseconds: 15
  });

  lifecycle.connected("ready");
  lifecycle.disconnected("shard-disconnect", 0);
  lifecycle.connected("shard-resume", 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(expired, 0);
  lifecycle.stop("test complete");
});

test("shutdown cancels the disconnect watchdog and prevents restart", async () => {
  let expired = 0;
  let starts = 0;
  const lifecycle = createDiscordLifecycle({
    logger,
    startWork: () => { starts += 1; },
    stopWork: () => undefined,
    onWatchdogExpired: () => { expired += 1; },
    watchdogMilliseconds: 10
  });

  lifecycle.connected("ready");
  lifecycle.disconnected("shard-disconnect", 0);
  lifecycle.stop("SIGTERM");
  assert.equal(lifecycle.connected("shard-resume", 0), false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(expired, 0);
  assert.equal(starts, 1);
});
