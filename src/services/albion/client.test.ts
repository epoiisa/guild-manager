import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "../../logging/logger.js";
import { AlbionApiError, createAlbionClient } from "./client.js";

test("getPlayer normalizes the selected lifetime fame totals", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    Id: "player-id",
    Name: "Player",
    KillFame: 13_371_709,
    LifetimeStatistics: {
      PvE: { Total: 1_180_243_625 },
      Gathering: { All: { Total: 55_783 } },
      Crafting: { Total: 330_400_199 }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const player = await createAlbionClient().getPlayer("asia", "player-id");
    assert.deepEqual(player, {
      id: "player-id",
      name: "Player",
      guildId: undefined,
      guildName: undefined,
      allianceId: undefined,
      allianceName: undefined,
      allianceTag: undefined,
      pvpFame: 13_371_709,
      pveFame: 1_180_243_625,
      gatheringFame: 55_783,
      craftingFame: 330_400_199
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs successful Albion Online API requests with operation metadata only", async () => {
  const originalFetch = globalThis.fetch;
  const entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
  const logger = createCapturingLogger(entries);
  globalThis.fetch = async () => new Response(JSON.stringify({
    Id: "player-id",
    Name: "Private Player"
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    await createAlbionClient({ logger }).getPlayer("asia", "player-id");
    assert.deepEqual(entries, [{
      level: "debug",
      message: "Albion Online API request completed",
      context: {
        operation: "getPlayer",
        albionServer: "asia",
        durationMilliseconds: entries[0]?.context?.durationMilliseconds,
        httpStatus: 200,
        attempt: 1
      }
    }]);
    assert.equal(typeof entries[0]?.context?.durationMilliseconds, "number");
    assert.equal(JSON.stringify(entries).includes("player-id"), false);
    assert.equal(JSON.stringify(entries).includes("Private Player"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs expected missing Albion Online API resources at info without search details", async () => {
  const originalFetch = globalThis.fetch;
  const entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
  const logger = createCapturingLogger(entries);
  globalThis.fetch = async () => new Response("not found", { status: 404, statusText: "Not Found" });

  try {
    await assert.rejects(createAlbionClient({ logger }).search("europe", "Private Search Query"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, "info");
    assert.equal(entries[0]?.message, "Albion Online API request failed");
    assert.deepEqual(entries[0]?.context, {
      operation: "search",
      albionServer: "europe",
      durationMilliseconds: entries[0]?.context?.durationMilliseconds,
      attempt: 1,
      failureKind: "client",
      httpStatus: 404
    });
    assert.equal(typeof entries[0]?.context?.durationMilliseconds, "number");
    assert.equal(JSON.stringify(entries).includes("Private Search Query"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs Albion Online API server failures at warn", async () => {
  const originalFetch = globalThis.fetch;
  const entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
  const logger = createCapturingLogger(entries);
  globalThis.fetch = async () => new Response("unavailable", { status: 503, statusText: "Unavailable" });

  try {
    await assert.rejects(createAlbionClient({ logger }).getGuild("americas", "guild-id"));
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.level, "warn");
    assert.equal(entries[1]?.level, "warn");
    assert.deepEqual(entries[1]?.context, {
      operation: "getGuild",
      albionServer: "americas",
      durationMilliseconds: entries[1]?.context?.durationMilliseconds,
      attempt: 2,
      failureKind: "server",
      httpStatus: 503
    });
    assert.equal(JSON.stringify(entries).includes("guild-id"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createCapturingLogger(entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }>): Logger {
  const capture = (level: string) => (message: string, context?: Record<string, unknown>) => entries.push({ level, message, context });
  return { debug: capture("debug"), info: capture("info"), warn: capture("warn"), error: capture("error") };
}

test("getPlayer leaves missing and malformed fame totals undefined", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    Id: "player-id",
    Name: "Player",
    KillFame: null,
    LifetimeStatistics: {
      PvE: { Total: "not-a-number" },
      Gathering: {},
      Crafting: { Total: null }
    }
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const player = await createAlbionClient().getPlayer("asia", "player-id");
    assert.equal(player.pvpFame, undefined);
    assert.equal(player.pveFame, undefined);
    assert.equal(player.gatheringFame, undefined);
    assert.equal(player.craftingFame, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries network failures once and returns a normalized response", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset");
      return jsonResponse({ Id: "player-id", Name: "Player" });
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    random: () => 0
  });

  assert.equal((await client.getPlayer("asia", "player-id")).name, "Player");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]);
});

test("retries a 429 using a sane Retry-After delay", async () => {
  let calls = 0;
  let now = 0;
  const sleeps: number[] = [];
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : jsonResponse({ Id: "player-id", Name: "Player" });
    },
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    random: () => 0
  });

  await client.getPlayer("asia", "player-id");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test("does not retry before a Retry-After that exceeds the overall deadline", async () => {
  let calls = 0;
  const client = createAlbionClient({
    timeoutMs: 1_000,
    fetch: async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    },
    sleep: async () => assert.fail("must not retry before Retry-After"),
    now: () => 0
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "rate_limited");
    return true;
  });
  assert.equal(calls, 1);
});

test("shares a long cooldown across operations and resumes when Retry-After expires", async () => {
  let calls = 0;
  let now = 0;
  const entries: Array<{ level: string; message: string; context: Record<string, unknown> | undefined }> = [];
  const client = createAlbionClient({
    timeoutMs: 1_000,
    logger: createCapturingLogger(entries),
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
        : jsonResponse({ Id: "guild-id", Name: "Guild" });
    },
    sleep: async () => assert.fail("a cooldown must not queue later requests"),
    now: () => now
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error) => assertRateLimitError(error, 30_000, false));
  await assert.rejects(client.getGuildMembers("asia", "guild-id"), (error) => assertRateLimitError(error, 30_000, true));
  now = 29_999;
  await assert.rejects(client.search("asia", "private query"), (error) => assertRateLimitError(error, 30_000, true));
  assert.equal(calls, 1);
  assert.equal(entries.filter(({ level }) => level === "warn").length, 1);
  assert.equal(entries.filter(({ level }) => level === "debug").length, 2);
  assert.equal(JSON.stringify(entries).includes("private query"), false);

  now = 30_000;
  assert.equal((await client.getGuild("asia", "guild-id")).name, "Guild");
  assert.equal(calls, 2);
});

test("honors an HTTP-date Retry-After across requests without blocking", async () => {
  let calls = 0;
  const now = Date.parse("2026-09-29T00:00:00Z");
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "Tue, 29 Sep 2026 00:02:00 GMT" } });
    },
    now: () => now,
    sleep: async () => assert.fail("must not wait beyond the request deadline")
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error) => assertRateLimitError(error, now + 120_000, false));
  await assert.rejects(client.getPlayer("asia", "other-player"), (error) => assertRateLimitError(error, now + 120_000, true));
  assert.equal(calls, 1);
});

test("uses a shared fallback cooldown when Retry-After is missing or invalid", async () => {
  for (const header of [undefined, "invalid", "-1", " ", "Infinity", "1e308"]) {
    let calls = 0;
    const client = createAlbionClient({
      fetch: async () => {
        calls += 1;
        return new Response("slow down", { status: 429, headers: header === undefined ? {} : { "retry-after": header } });
      },
      now: () => Date.parse("2026-09-29T00:00:00Z"),
      sleep: async () => assert.fail("must not repeatedly probe a rate-limited server")
    });

    const retryAt = Date.parse("2026-09-29T00:00:00Z") + 30_000;
    await assert.rejects(client.getPlayer("asia", "player-id"), (error) => assertRateLimitError(error, retryAt, false));
    await assert.rejects(client.getAlliance("asia", "alliance-id"), (error) => assertRateLimitError(error, retryAt, true));
    assert.equal(calls, 1);
  }
});

test("keeps cooldowns independent between Albion Online servers and client instances", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
      : jsonResponse({ Id: "player-id", Name: "Player" });
  };
  const client = createAlbionClient({ fetch, now: () => 0 });

  await assert.rejects(client.getPlayer("asia", "player-id"));
  assert.equal((await client.getPlayer("europe", "player-id")).name, "Player");
  assert.equal((await createAlbionClient({ fetch, now: () => 0 }).getPlayer("asia", "player-id")).name, "Player");
  await assert.rejects(client.getPlayer("asia", "player-id"), (error) => assertRateLimitError(error, 30_000, true));
  assert.equal(calls, 3);
});

test("a concurrent shorter Retry-After cannot shorten an existing cooldown", async () => {
  let calls = 0;
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return calls === 1 ? firstResponse : new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    },
    now: () => 0,
    sleep: async () => assert.fail("must preserve the longest active Retry-After")
  });

  const first = assert.rejects(client.getPlayer("asia", "first"), (error) => assertRateLimitError(error, 30_000, false));
  await assert.rejects(client.getPlayer("asia", "second"), (error) => assertRateLimitError(error, 30_000, false));
  releaseFirst(new Response("slow down", { status: 429, headers: { "retry-after": "1" } }));
  await first;
  await assert.rejects(client.getPlayer("asia", "third"), (error) => assertRateLimitError(error, 30_000, true));
  assert.equal(calls, 2);
});

test("persists a cooldown from the final allowed request attempt", async () => {
  let calls = 0;
  let now = 0;
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    },
    now: () => now,
    random: () => 0.5,
    sleep: async (milliseconds) => { now += milliseconds; }
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error) => assertRateLimitError(error, 60_200, false));
  await assert.rejects(client.getPlayer("asia", "other-player"), (error) => assertRateLimitError(error, 60_200, true));
  assert.equal(calls, 2);
});

test("a retry checks for a cooldown established by another concurrent request", async () => {
  let calls = 0;
  let now = 0;
  let signalSleep!: () => void;
  let releaseSleep!: () => void;
  const sleepStarted = new Promise<void>((resolve) => { signalSleep = resolve; });
  const sleepFinished = new Promise<void>((resolve) => { releaseSleep = resolve; });
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    },
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => {
      signalSleep();
      await sleepFinished;
      now += milliseconds;
    }
  });

  const first = assert.rejects(client.getPlayer("asia", "first"), (error) => assertRateLimitError(error, 30_000, true));
  await sleepStarted;
  await assert.rejects(client.getPlayer("asia", "second"), (error) => assertRateLimitError(error, 30_000, false));
  releaseSleep();
  await first;
  assert.equal(calls, 2);
});

test("retries server failures once with bounded exponential backoff", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      return calls === 1 ? new Response("unavailable", { status: 503 }) : jsonResponse({ Id: "player-id", Name: "Player" });
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    random: () => 0.5
  });

  await client.getPlayer("asia", "player-id");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [200]);
});

test("does not retry ordinary client failures", async () => {
  let calls = 0;
  const client = createAlbionClient({
    fetch: async () => { calls += 1; return new Response("bad request", { status: 400 }); },
    sleep: async () => assert.fail("must not sleep")
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "client");
    assert.equal(error.httpStatus, 400);
    return true;
  });
  assert.equal(calls, 1);
});

test("does not exceed the overall deadline before a retry", async () => {
  let now = 0;
  let calls = 0;
  const client = createAlbionClient({
    timeoutMs: 100,
    fetch: async () => { calls += 1; return new Response("unavailable", { status: 503 }); },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds + 1; },
    random: () => 0
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "server");
    return true;
  });
  assert.equal(calls, 1);
});

test("classifies an aborted request as timeout and retries it once", async () => {
  let calls = 0;
  const client = createAlbionClient({
    fetch: async () => {
      calls += 1;
      throw new DOMException("aborted", "AbortError");
    },
    sleep: async () => undefined,
    random: () => 0,
    now: () => 0
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(calls, 2);
});

test("reserves part of the overall timeout budget for a second timed attempt", async () => {
  let calls = 0;
  const client = createAlbionClient({
    timeoutMs: 40,
    fetch: async () => {
      calls += 1;
      return new Promise<Response>(() => undefined);
    },
    sleep: async () => undefined,
    random: () => 0
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(calls, 2);
});

test("keeps the deadline active while consuming a successful response body", async () => {
  let calls = 0;
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => new Promise<unknown>(() => undefined)
  } as Response;
  const client = createAlbionClient({
    timeoutMs: 40,
    fetch: async () => { calls += 1; return response; },
    sleep: async () => undefined,
    random: () => 0
  });

  await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "timeout");
    return true;
  });
  assert.equal(calls, 2);
});

test("classifies malformed JSON and malformed required fields as invalid responses", async () => {
  for (const response of [new Response("{", { status: 200 }), jsonResponse({ Id: "player-id" })]) {
    const client = createAlbionClient({ fetch: async () => response });
    await assert.rejects(client.getPlayer("asia", "player-id"), (error: unknown) => {
      assert.ok(error instanceof AlbionApiError);
      assert.equal(error.kind, "invalid_response");
      assert.equal(error.httpStatus, 200);
      return true;
    });
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function assertRateLimitError(error: unknown, retryAt: number, deferred: boolean): true {
  assert.ok(error instanceof AlbionApiError);
  assert.equal(error.kind, "rate_limited");
  assert.equal(error.httpStatus, 429);
  assert.equal(error.retryAt, retryAt);
  assert.equal(error.retryDeferred, deferred);
  return true;
}
