import assert from "node:assert/strict";
import test from "node:test";
import { formatLogChanges } from "./formatting.js";
import type { LogChange } from "./events.js";

test("departure logs include a committed hold with no added timestamps", () => {
  const change: LogChange = { kind: "membershipLifecycle", action: "hold", characterName: "Character", albionServer: "europe", discordUserId: "member" };
  assert.deepEqual(formatLogChanges([change, change], { kind: "departure", discordUserId: "member", discordUserDisplayName: "Member" }), [
    "@Member left the server.", "Character • Europe entered a registration hold for <@member>."
  ]);
});

test("expiry events distinguish membership expiration from registration abandonment", () => {
  assert.deepEqual(formatLogChanges([
    { kind: "membershipLifecycle", action: "expired", characterName: "One", albionServer: "europe", groupName: "Guild" },
    { kind: "membershipLifecycle", action: "abandoned", characterName: "Two", albionServer: "asia" }
  ]), ["One • Europe membership in Guild expired.", "Two • Asia registration abandoned; retained membership entitlements expired."]);
});
