import assert from "node:assert/strict";
import test from "node:test";
import type { MemberUpdateScheduleRecord } from "../../db/memberUpdateScheduleRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createMemberUpdateScheduler } from "./memberUpdateScheduler.js";
import type { MembershipReconciliationResult } from "./reconciliation.js";

test("scheduled reconciliation logs an aggregate partial summary without warning details", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const runs: Array<{ success: boolean; error?: string }> = [];
  const result = reconciliationResult({ warnings: [{ message: "Private Albion Online character warning" }] });
  const scheduler = createMemberUpdateScheduler(
    {
      listSchedules: async () => [dueSchedule()],
      markScheduleRun: async (_guildId: string, _runKey: string, success: boolean, error?: string) => { runs.push({ success, error }); }
    } as never,
    {} as never,
    {} as never,
    capturingLogger(logs),
    { reconcileMembershipForGuild: async () => result }
  );

  await scheduler.runDueSchedules([{ id: "guild-id" } as never], new Date("2026-09-02T12:00:00Z"));

  assert.deepEqual(runs, [{ success: true, error: undefined }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "warn");
  assert.equal(logs[0]?.message, "scheduled membership reconciliation completed with warnings");
  assert.deepEqual(logs[0]?.context, {
    discordGuildId: "guild-id",
    runKey: "2026-09-02",
    durationMilliseconds: logs[0]?.context?.durationMilliseconds,
    selectedGroups: 2,
    registeredCharactersChecked: 3,
    managedRosterCharacters: 4,
    profilesApplied: 5,
    profilesOrphaned: 6,
    usersReconciled: 7,
    outcomeCount: 0,
    warningCount: 1,
    outcome: "partial"
  });
  assert.equal(typeof logs[0]?.context?.durationMilliseconds, "number");
  assert.equal(JSON.stringify(logs).includes("Private Albion Online character warning"), false);
});

test("scheduled reconciliation logs aggregate success", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const scheduler = createMemberUpdateScheduler(
    {
      listSchedules: async () => [dueSchedule()],
      markScheduleRun: async () => undefined
    } as never,
    {} as never,
    {} as never,
    capturingLogger(logs),
    { reconcileMembershipForGuild: async () => reconciliationResult() }
  );

  await scheduler.runDueSchedules([{ id: "guild-id" } as never], new Date("2026-09-02T12:00:00Z"));

  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "info");
  assert.equal(logs[0]?.message, "scheduled membership reconciliation completed");
  assert.equal(logs[0]?.context?.outcome, "success");
  assert.equal(logs[0]?.context?.warningCount, 0);
});

test("scheduled reconciliation logs bounded failure diagnostics", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const runs: Array<{ success: boolean; error?: string }> = [];
  const failure = Object.assign(new Error("database unavailable"), { code: "ECONNRESET" });
  const scheduler = createMemberUpdateScheduler(
    {
      listSchedules: async () => [dueSchedule()],
      markScheduleRun: async (_guildId: string, _runKey: string, success: boolean, error?: string) => { runs.push({ success, error }); }
    } as never,
    {} as never,
    {} as never,
    capturingLogger(logs),
    { reconcileMembershipForGuild: async () => { throw failure; } }
  );

  await scheduler.runDueSchedules([{ id: "guild-id" } as never], new Date("2026-09-02T12:00:00Z"));

  assert.deepEqual(runs, [{ success: false, error: "database unavailable" }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, "error");
  assert.equal(logs[0]?.message, "scheduled membership reconciliation failed");
  assert.equal(logs[0]?.context?.outcome, "failure");
  assert.equal(logs[0]?.context?.error, "database unavailable");
  assert.equal(logs[0]?.context?.errorCode, "ECONNRESET");
  assert.match(String(logs[0]?.context?.errorStack), /database unavailable/);
  assert.equal("guildName" in (logs[0]?.context ?? {}), false);
});

function dueSchedule(): MemberUpdateScheduleRecord {
  return {
    discordGuildId: "guild-id",
    cadence: "daily",
    weekday: null,
    hourUtc: 12,
    minuteUtc: 0,
    lastRunKey: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    createdByDiscordUserId: "creator-id",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z")
  };
}

function reconciliationResult(overrides: Partial<MembershipReconciliationResult> = {}): MembershipReconciliationResult {
  return {
    selectedGroups: 2,
    registeredCharactersChecked: 3,
    managedRosterCharacters: 4,
    profilesApplied: 5,
    profilesOrphaned: 6,
    usersReconciled: 7,
    outcomes: [],
    warnings: [],
    ...overrides
  };
}

function capturingLogger(logs: Array<{ level: string; message: string; context?: Record<string, unknown> }>): Logger {
  return {
    debug: (message, context) => logs.push({ level: "debug", message, context }),
    info: (message, context) => logs.push({ level: "info", message, context }),
    warn: (message, context) => logs.push({ level: "warn", message, context }),
    error: (message, context) => logs.push({ level: "error", message, context })
  };
}
