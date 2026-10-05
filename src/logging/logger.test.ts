import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, logErrorContext } from "./logger.js";

test("logger preserves reserved fields and redacts sensitive context", () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => { lines.push(String(line)); };

  try {
    createLogger("info", { instance: "test" }).info("expected message", {
      timestamp: "overridden",
      level: "error",
      message: "overridden",
      discordToken: "secret-value",
      guildName: "Private Guild",
      nested: { databaseUrl: "postgresql://user:password@example.invalid/db" }
    });
  } finally {
    console.log = originalLog;
  }

  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "expected message");
  assert.notEqual(entry.timestamp, "overridden");
  assert.equal(entry.discordToken, "[REDACTED]");
  assert.equal("guildName" in entry, false);
  assert.deepEqual(entry.nested, { databaseUrl: "[REDACTED]" });
});

test("logger redacts credentials embedded in strings", () => {
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.warn = (line?: unknown) => { lines.push(String(line)); };

  try {
    createLogger("info").warn("connection failed", {
      error: "Could not reach postgresql://guild_manager:private@example.invalid/database"
    });
  } finally {
    console.warn = originalWarn;
  }

  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.error, "Could not reach postgresql://[REDACTED]@example.invalid/database");
});

test("logErrorContext records bounded diagnostic fields", () => {
  const error = Object.assign(new Error("request failed"), { code: "ECONNRESET", status: 503 });
  assert.deepEqual(logErrorContext(error), {
    error: "request failed",
    errorType: "Error",
    errorCode: "ECONNRESET",
    errorStatus: 503
  });
  assert.match(String(logErrorContext(error, true).errorStack), /request failed/);
});
