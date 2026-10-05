import assert from "node:assert/strict";
import test from "node:test";
import { createModalSessions } from "./modalSessions.js";

test("modal envelope preserves full-length original IDs and binds guild, actor and one submission", () => {
  const sessions = createModalSessions();
  const original = "x".repeat(100);
  const token = sessions.issue("guild", "officer", original);
  assert.ok(token.startsWith("gm-modal:")); assert.ok(token.length <= 100);
  assert.equal(sessions.take(token, "other-guild", "officer", null), undefined);
  assert.equal(sessions.take(token, "guild", "other-user", null), undefined);
  assert.deepEqual(sessions.take(token, "guild", "officer", null), { customId: original });
  assert.equal(sessions.take(token, "guild", "officer", null), undefined);
});

test("pre-kick forms never revive after recovery and a newly issued identical form cannot revive its old token", () => {
  let clock = 1000;
  const sessions = createModalSessions({ now: () => clock });
  const old = sessions.issue("guild", "officer", "ticket-message:1:initial");
  clock = 2000;
  const kickedAt = new Date(clock);
  clock = 3000;
  const fresh = sessions.issue("guild", "officer", "ticket-message:1:initial");
  assert.equal(sessions.take(old, "guild", "officer", kickedAt), undefined);
  assert.deepEqual(sessions.take(fresh, "guild", "officer", kickedAt), { customId: "ticket-message:1:initial" });
});

test("issuance time is retained independently of submission time and equal kick timestamps reject", () => {
  let clock = 1000;
  const sessions = createModalSessions({ now: () => clock });
  const old = sessions.issue("guild", "officer", "application-message:1:accepted", 500);
  clock = 5000;
  assert.equal(sessions.take(old, "guild", "officer", new Date(500)), undefined);
});

test("old raw custom IDs, unknown tokens and forms retained across process restart fail closed", () => {
  const sessions = createModalSessions();
  const token = sessions.issue("guild", "officer", "template:edit:1");
  assert.equal(sessions.take("template:edit:1", "guild", "officer", null), undefined);
  assert.equal(sessions.take("gm-modal:unknown", "guild", "officer", null), undefined);
  assert.equal(createModalSessions().take(token, "guild", "officer", null), undefined);
});

test("expired sessions and stopped session stores cannot submit", () => {
  let clock = 1000;
  const sessions = createModalSessions({ now: () => clock });
  const old = sessions.issue("guild", "officer", "message-edit:draft");
  clock += 15 * 60 * 1000;
  assert.equal(sessions.take(old, "guild", "officer", null), undefined);
  const fresh = sessions.issue("guild", "officer", "message-edit:next");
  sessions.stop();
  assert.equal(sessions.take(fresh, "guild", "officer", null), undefined);
  assert.throws(() => sessions.issue("guild", "officer", "message-edit:next"), /stopped/);
});

test("unsubmitted forms cannot grow the store beyond its bounded capacity", () => {
  const sessions = createModalSessions({ now: () => 1000 });
  const oldest = sessions.issue("guild", "officer", "message-compose:first");
  let newest = "";
  for (let i = 0; i < 10_000; i++) newest = sessions.issue("guild", "officer", `message-compose:${i}`);
  assert.equal(sessions.take(oldest, "guild", "officer", null), undefined);
  assert.deepEqual(sessions.take(newest, "guild", "officer", null), { customId: "message-compose:9999" });
});
