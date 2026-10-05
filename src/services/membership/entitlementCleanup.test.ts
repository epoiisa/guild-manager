import assert from "node:assert/strict";
import test from "node:test";
import { createMembershipEntitlementCleanupService } from "./entitlementCleanup.js";

function fixture() {
  const jobs = new Map(["transient", "missing", "ok"].map(id => [id, { cleanupId: id, discordGuildId: "guild", channelId: "channel", messageId: id }]));
  const calls: string[] = [];
  let transient = true;
  const repository = {
    listPending: async () => [...jobs.values()],
    markAttempted: async (_guild: string, id: string) => { calls.push(`attempt:${id}`); },
    complete: async (guild: string, id: string) => { assert.equal(guild, "guild"); calls.push(`complete:${id}`); jobs.delete(id); }
  };
  const guild = { id: "guild", channels: { fetch: async () => ({
    isTextBased: () => true,
    messages: { delete: async (id: string) => {
      calls.push(`delete:${id}`);
      if (id === "transient" && transient) throw { code: 50013 };
      if (id === "missing") throw { code: 10008 };
    } }
  }) } };
  const service = createMembershipEntitlementCleanupService(repository, { warn: () => undefined } as never);
  return { jobs, calls, guild: guild as never, service, restoreAccess: () => { transient = false; } };
}

test("expiry presentation cleanup retries failures, completes definitely missing cards, and continues other jobs", async () => {
  const f = fixture();
  await f.service.reconcileGuild(f.guild);
  assert.deepEqual([...f.jobs.keys()], ["transient"]);
  assert.ok(f.calls.includes("delete:ok"));
  f.restoreAccess();
  await f.service.reconcileGuild(f.guild);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.calls.filter(call => call === "delete:ok").length, 1);
  assert.equal(f.calls.filter(call => call === "delete:transient").length, 2);
});

test("a second worker tick does not duplicate in-flight evidence deletion", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let deletes = 0;
  const repository = {
    listPending: async () => [{ cleanupId: "job", discordGuildId: "guild", channelId: "channel", messageId: "message" }],
    markAttempted: async () => undefined,
    complete: async () => undefined
  };
  const guild = { id: "guild", channels: { fetch: async () => ({ isTextBased: () => true,
    messages: { delete: async () => { deletes++; await blocked; } }
  }) } } as never;
  const service = createMembershipEntitlementCleanupService(repository, { warn: () => undefined } as never);
  const first = service.reconcileGuild(guild);
  await service.reconcileGuild(guild);
  release();
  await first;
  assert.equal(deletes, 1);
});
