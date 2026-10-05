import assert from "node:assert/strict";
import test from "node:test";
import type {
  MembershipReconciliationOutcome,
  MembershipReconciliationResult
} from "../services/membership/reconciliation.js";
import { formatAuditUpdateResponse as formatResponse } from "./update.js";

const generatedAt = new Date("2026-09-30T12:34:56Z");

function formatAuditUpdateResponse(mode: "audit" | "update", result: MembershipReconciliationResult) {
  const response = formatResponse(mode, result, "Frostborn Exiles", generatedAt);
  return { ...response, message: response.content, content: (response.files[0].attachment as Buffer).toString("utf8") };
}

const outcomes: MembershipReconciliationOutcome[] = [
  {
    kind: "profile",
    action: "add",
    characterName: "Added",
    discordUserId: "user-1",
    groupName: "Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "remove",
    characterName: "Removed",
    discordUserId: "user-2",
    groupName: "Alliance",
    albionServerLabel: "Asia"
  },
  {
    kind: "profile",
    action: "record",
    characterName: "Unregistered",
    groupName: "Guild",
    albionServerLabel: "North America"
  },
  {
    kind: "profile",
    action: "reassign",
    characterName: "Reassigned",
    previousDiscordUserId: "user-old",
    discordUserId: "user-new",
    groupName: "Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "reassign",
    characterName: "Claimed",
    previousDiscordUserId: null,
    discordUserId: "user-new",
    groupName: "Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "role",
    action: "add",
    discordUserId: "user-1",
    roleId: "role-add"
  },
  {
    kind: "role",
    action: "remove",
    discordUserId: "user-2",
    roleId: "role-remove"
  },
  {
    kind: "nickname",
    action: "set",
    discordUserId: "user-1",
    nickname: "New Nickname"
  },
  {
    kind: "nickname",
    action: "clear",
    discordUserId: "user-2"
  }
];

test("audit formats every planned outcome in the approved future tense", () => {
  const response = formatAuditUpdateResponse("audit", createResult(outcomes));

  assert.equal(response.content, [
    "Audit",
    "Frostborn Exiles",
    "30/09/2026 • 12:34 UTC",
    "",
    "Added • <@user-1> will be added to Guild • Europe.",
    "Removed • <@user-2> will be removed from Alliance • Asia.",
    "Unregistered • not registered will be recorded in Guild • North America.",
    "Reassigned • profile will be reassigned from <@user-old> to <@user-new> in Guild • Europe.",
    "Claimed • profile will be assigned to <@user-new> in Guild • Europe.",
    "<@&role-add> will be added to <@user-1>.",
    "<@&role-remove> will be removed from <@user-2>.",
    "<@user-1>'s nickname will be set to `New Nickname`.",
    "<@user-2>'s nickname will be cleared.",
    "",
    "Audit only. /update checks current membership again before applying changes."
  ].join("\n"));
});

test("update formats every confirmed outcome in the approved completed-action tense", () => {
  const response = formatAuditUpdateResponse("update", createResult(outcomes));

  assert.equal(response.content, [
    "Update",
    "Frostborn Exiles",
    "30/09/2026 • 12:34 UTC",
    "",
    "Added • <@user-1> added to Guild • Europe.",
    "Removed • <@user-2> removed from Alliance • Asia.",
    "Unregistered • not registered recorded in Guild • North America.",
    "Reassigned • profile reassigned from <@user-old> to <@user-new> in Guild • Europe.",
    "Claimed • profile assigned to <@user-new> in Guild • Europe.",
    "<@&role-add> added to <@user-1>.",
    "<@&role-remove> removed from <@user-2>.",
    "<@user-1>'s nickname set to `New Nickname`.",
    "<@user-2>'s nickname cleared."
  ].join("\n"));
});

test("empty audit and update reports distinguish warnings from clean no-ops", () => {
  assert.equal(
    formatAuditUpdateResponse("audit", createResult()).content,
    "Audit\nFrostborn Exiles\n30/09/2026 • 12:34 UTC\n\nNo changes found."
  );
  assert.equal(
    formatAuditUpdateResponse("audit", createResult([], ["Roster check failed for Guild: unavailable"])).content,
    "Audit\nFrostborn Exiles\n30/09/2026 • 12:34 UTC\n\nNo changes were identified in the checks that completed.\n\nWarnings\n- Roster check failed for Guild: unavailable"
  );
  assert.equal(
    formatAuditUpdateResponse("update", createResult()).content,
    "Update\nFrostborn Exiles\n30/09/2026 • 12:34 UTC\n\nNo changes were needed."
  );
  assert.equal(
    formatAuditUpdateResponse("update", createResult([], ["Role update failed for <@user-1>: Missing permissions"])).content,
    "Update\nFrostborn Exiles\n30/09/2026 • 12:34 UTC\n\nNo changes were confirmed.\n\nWarnings\n- Role update failed for <@user-1>: Missing permissions"
  );
});

test("all report lengths use a complete text attachment and a short standard message", () => {
  for (const mode of ["audit", "update"] as const) {
    const response = formatAuditUpdateResponse(
      mode,
      createResult([{
        kind: "profile",
        action: "record",
        characterName: "x".repeat(2100),
        groupName: "Guild",
        albionServerLabel: "Europe"
      }])
    );

    assert.ok(response.content.length > 2000);
    assert.equal(response.message, `${mode === "audit" ? "Audit" : "Update"} report for Frostborn Exiles at <t:1790771696:F>.`);
    assert.equal(response.files?.length, 1);
    assert.equal(response.files?.[0].name, `${mode}-frostborn-exiles-20260930T1234Z.txt`);
  }
});

test("filenames normalize Discord server names and keep the UTC minute", () => {
  const named = formatResponse("audit", createResult(), "Élite / Café!", generatedAt);
  assert.equal(named.files[0].name, "audit-élite-café-20260930T1234Z.txt");
  assert.match((named.files[0].attachment as Buffer).toString("utf8"), /^Audit\nÉlite \/ Café!\n30\/09\/2026 • 12:34 UTC\n/);

  const unnamed = formatResponse("update", createResult(), "!!!", generatedAt);
  assert.equal(unnamed.files[0].name, "update-unnamed-20260930T1234Z.txt");
});

function createResult(
  resultOutcomes: MembershipReconciliationOutcome[] = [],
  warningMessages: string[] = []
): MembershipReconciliationResult {
  return {
    selectedGroups: 0,
    registeredCharactersChecked: 0,
    managedRosterCharacters: 0,
    profilesApplied: 0,
    profilesOrphaned: 0,
    usersReconciled: 0,
    outcomes: resultOutcomes,
    warnings: warningMessages.map((message) => ({ message }))
  };
}

test("ownerless departure reports the action without grace or deadline details", () => {
  const outcome = { kind: "profile" as const, action: "depart" as const, characterName: "Legacy",
    groupName: "Guild", albionServerLabel: "Asia", departureExpiresAt: new Date("2030-01-04T00:00:00Z"),
    registrationExpiresAt: new Date("2030-01-02T00:00:00Z") };
  const audit = formatAuditUpdateResponse("audit", createResult([{ ...outcome, departureExpiresAt: undefined }])).content;
  assert.match(audit, /Legacy • not registered will be marked departed/);
  assert.doesNotMatch(audit, /grace|deadline|2030-01/);
  assert.doesNotMatch(audit, /<@undefined>|<@null>|will be removed/);
  const update = formatAuditUpdateResponse("update", createResult([outcome])).content;
  assert.match(update, /marked departed/);
  assert.doesNotMatch(update, /grace|deadline|2030-01/);
});

test("non-entitled observations are pruned without suggesting grace or account loss", () => {
  for (const mode of ["audit", "update"] as const) {
    const text = formatAuditUpdateResponse(mode, createResult([{ kind: "profile", action: "prune",
      characterName: "Observation", groupName: "Guild", albionServerLabel: "Asia" }])).content;
    assert.match(text, /unregistered roster entry .*removed from Guild/);
    assert.match(text, /no retained entitlements/);
    assert.doesNotMatch(text, /72-hour|<@undefined>|<@null>/);
  }
});

test("restoration and departure cleanup lines omit timing details", () => {
  const outcomes: MembershipReconciliationOutcome[] = [
    { kind: "profile", action: "restore", characterName: "Returned", groupName: "Guild",
      albionServerLabel: "Asia", registrationExpiresAt: new Date("2030-01-02T00:00:00Z") },
    { kind: "profile", action: "expire", characterName: "Gone", groupName: "Guild",
      albionServerLabel: "Asia", departureExpiresAt: new Date("2030-01-04T00:00:00Z") }
  ];
  const audit = formatAuditUpdateResponse("audit", createResult(outcomes)).content;
  assert.match(audit, /Returned • not registered • membership in Guild • Asia will be restored\./);
  assert.match(audit, /Gone • not registered • departed membership in Guild • Asia will be removed\./);
  const update = formatAuditUpdateResponse("update", createResult(outcomes)).content;
  assert.match(update, /Returned • not registered • membership in Guild • Asia restored\./);
  assert.match(update, /Gone • not registered • departed membership in Guild • Asia removed\./);
  assert.doesNotMatch(`${audit}\n${update}`, /2030-01|grace|deadline|retained entitlements/);
});

test("unchanged waiting states are omitted from both reports", () => {
  const outcome = { kind: "profile" as const, action: "waiting" as const, characterName: "Held",
    groupName: "Guild", albionServerLabel: "Asia", departureExpiresAt: new Date("2030-01-04T00:00:00Z") };
  for (const mode of ["audit", "update"] as const) {
    const text = formatAuditUpdateResponse(mode, createResult([outcome, {
      ...outcome, characterName: "Registration held", departureExpiresAt: undefined,
      registrationExpiresAt: new Date(0)
    }])).content;
    assert.match(text, mode === "audit" ? /No changes found/ : /No changes were needed/);
    assert.doesNotMatch(text, /Held|deadline|grace|Audit only/);
  }
});

test("failed checks group by cause and membership scope while retaining every affected name", () => {
  const result = createResult();
  result.warnings = [
    { message: "first", checkFailure: { reason: "HTTP 429", scope: "Asia • Guild", subject: "Alice" } },
    { message: "second", checkFailure: { reason: "HTTP 429", scope: "Asia • Guild", subject: "Bob" } },
    { message: "again", checkFailure: { reason: "HTTP 429", scope: "Asia • Guild", subject: "Alice" } },
    { message: "third", checkFailure: { reason: "HTTP 429", scope: "Asia • Alliance", subject: "Alice" } }
  ];
  const text = formatAuditUpdateResponse("audit", result).content;
  assert.equal(text.match(/HTTP 429/g)?.length, 1);
  assert.match(text, /Asia • Guild: Alice, Bob/);
  assert.match(text, /Asia • Alliance: Alice/);
  assert.match(text, /No departures inferred from these failures/);
  assert.doesNotMatch(text, /will be removed|will be marked departed/);
});

test("waiting rows stay omitted when warnings are present", () => {
  const result = createResult([{ kind: "profile", action: "waiting", characterName: "x".repeat(2100),
    groupName: "Guild", albionServerLabel: "Asia", departureExpiresAt: new Date("2030-01-04T00:00:00Z") }], ["Unavailable check"]);
  const response = formatAuditUpdateResponse("audit", result);
  const text = (response.files![0].attachment as Buffer).toString("utf8");
  assert.match(text, /No changes were identified in the checks that completed/);
  assert.doesNotMatch(text, /2030-01-04|x{2100}|Audit only/);
  assert.doesNotMatch(response.message, /Unavailable check|Some checks were unavailable/);
  assert.match(text, /Unavailable check/);
});

test("an overdue registration hold is omitted", () => {
  const text = formatAuditUpdateResponse("audit", createResult([{ kind: "profile", action: "waiting",
    characterName: "Held", groupName: "Guild", albionServerLabel: "Asia", registrationExpiresAt: new Date(0) }])).content;
  assert.match(text, /No changes found/);
  assert.doesNotMatch(text, /Held|deadline|hold/);
});

test("multiple departures each get a short standalone line", () => {
  const text = formatAuditUpdateResponse("audit", createResult(["Alice", "Bob"].map(characterName => ({
    kind: "profile", action: "depart", characterName, groupName: "Guild", albionServerLabel: "Asia"
  })))).content;
  assert.equal(text.match(/will be marked departed/g)?.length, 2);
  assert.doesNotMatch(text, /grace|deadline/);
  assert.match(text, /checks current membership again before applying changes/);
});
