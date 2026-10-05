import assert from "node:assert/strict";
import test from "node:test";
import { applicationChoices, canApplicationAction, canTicketAction, createCacheLabels, resolveApplicationTarget, resolveTicketTarget, ticketChoices, type Actor, type ApplicationTarget, type TicketTarget } from "./operationalTargets.js";

const actor = (userId: string, roles: string[] = []): Actor => ({ userId, roleIds: new Set(roles) });
const app = (overrides: Partial<ApplicationTarget> = {}): ApplicationTarget => ({ applicationId: "a1", applicationName: "Raiders", applicantDiscordUserId: "applicant", ticketChannelId: "101", status: "open", channelStatus: "open", characterResolutionState: "selected", selectedAlbionCharacterId: "character", reviewerRoleId: "reviewer", ...overrides });
const ticket = (overrides: Partial<TicketTarget> = {}): TicketTarget => ({ ticketId: "t1", ticketName: "General", openerDiscordUserId: "opener", ticketChannelId: "201", status: "open", reviewerRoleId: "reviewer", ...overrides });
const labels = { channel: (id?: string) => id ? `#${id}` : "#unknown", user: (id: string) => `@${id}` };

test("application and ticket targets resolve every supported input and outcome", () => {
  const targets = [app(), app({ applicationId: "a2", ticketChannelId: "102" })];
  const applicationCases = [
    ["101", undefined, "resolved", "a1"], ["999", "a1", "resolved", "a1"], ["999", "101", "resolved", "a1"], ["999", "<#101>", "resolved", "a1"],
    ["101", "a2", "mismatch", undefined], ["999", undefined, "required", undefined], ["999", "deleted", "not_found", undefined]
  ] as const;
  for (const [channel, supplied, kind, id] of applicationCases) {
    const result = resolveApplicationTarget(targets, channel, supplied);
    assert.equal(result.kind, kind);
    if (result.kind === "resolved") assert.equal(result.target.applicationId, id);
  }
  assert.equal(resolveApplicationTarget([app({ channelStatus: "deleted" })], "999", "a1").kind, "not_found");
  assert.equal(resolveTicketTarget([ticket({ status: "deleted" })], "999", "t1").kind, "not_found");
  const tickets = [ticket(), ticket({ ticketId: "t2", ticketChannelId: "202" })];
  for (const [channel, supplied, kind, id] of [["201", undefined, "resolved", "t1"], ["999", "t1", "resolved", "t1"], ["999", "201", "resolved", "t1"], ["999", "<#201>", "resolved", "t1"], ["201", "t2", "mismatch", undefined], ["999", undefined, "required", undefined], ["999", "deleted", "not_found", undefined]] as const) {
    const result = resolveTicketTarget(tickets, channel, supplied);
    assert.equal(result.kind, kind);
    if (result.kind === "resolved") assert.equal(result.target.ticketId, id);
  }
});

test("application eligibility exhaustively enforces action state and reviewer authority", () => {
  const cases = [
    ["accept", app(), actor("reviewer", ["reviewer"]), true], ["reject", app(), actor("reviewer", ["reviewer"]), true], ["search", app(), actor("applicant"), true],
    ["verify", app({ status: "awaiting_ingame_membership" }), actor("reviewer", ["reviewer"]), true], ["cancel", app({ status: "awaiting_ingame_membership" }), actor("reviewer", ["reviewer"]), true],
    ["close", app({ status: "accepted" }), actor("applicant"), true], ["close", app({ status: "rejected" }), actor("reviewer", ["reviewer"]), true], ["close", app({ status: "withdrawn" }), actor("applicant"), true],
    ["reopen", app({ channelStatus: "closed" }), actor("applicant"), true], ["delete", app({ channelStatus: "closed" }), actor("reviewer", ["reviewer"]), true]
  ] as const;
  for (const [action, target, who, expected] of cases) assert.equal(canApplicationAction(action, who, target), expected);
  for (const action of ["accept", "reject", "search", "verify", "cancel", "close", "reopen", "delete"] as const) {
    assert.equal(canApplicationAction(action, actor("outsider", ["administrator"]), app({ status: action === "verify" || action === "cancel" ? "awaiting_ingame_membership" : action === "close" ? "accepted" : "open", channelStatus: action === "reopen" || action === "delete" ? "closed" : "open" })), false);
  }
});

test("ticket eligibility, application labels, query filtering, stable ordering, and cap are enforced", () => {
  assert.equal(ticketChoices("close", actor("opener"), [ticket()], "general", labels).length, 1);
  assert.equal(ticketChoices("delete", actor("opener"), [ticket({ status: "closed" })], "", labels).length, 0);
  assert.equal(ticketChoices("delete", actor("reviewer", ["reviewer"]), [ticket({ status: "closed" })], "t1", labels)[0]?.value, "t1");
  assert.equal(ticketChoices("close", actor("opener"), Array.from({ length: 30 }, (_, index) => ticket({ ticketId: `t${index}` })), "", labels).length, 25);
  assert.equal(canTicketAction("close", actor("outsider", ["administrator"]), ticket()), false);
  assert.equal(canTicketAction("reopen", actor("opener"), ticket({ status: "closed" })), true);
  assert.equal(canTicketAction("delete", actor("opener"), ticket({ status: "closed" })), false);
  const cacheLabels = createCacheLabels(new Map([["201", { name: "support" }]]), new Map([["opener", { displayName: "Opener", username: "fallback" }]]));
  assert.equal(ticketChoices("close", actor("opener"), [ticket()], "support", cacheLabels)[0]?.name.includes("#support • General • @Opener"), true);
  assert.equal(ticketChoices("close", actor("missing"), [ticket({ ticketChannelId: "missing", openerDiscordUserId: "missing" })], "#missing", cacheLabels)[0]?.name.includes("#missing • General • @missing"), true);
  assert.equal(applicationChoices("accept", actor("reviewer", ["reviewer"]), [app({ channelStatus: "deleted" })], "", labels).length, 0);
  assert.equal(applicationChoices("accept", actor("reviewer", ["reviewer"]), [app({ targetMemberGroupName: "Hearties", applicantDiscordUserId: "epoiisa" })], "", labels)[0]?.name, "Hearties • @epoiisa • open/open");
  assert.equal(applicationChoices("accept", actor("reviewer", ["reviewer"]), [app({ applicationName: "Legacy Registration" })], "", labels)[0]?.name, "Legacy Registration • @applicant • open/open");
  assert.equal(canApplicationAction("close", actor("applicant"), app({ status: "accepted", channelStatus: "closed" })), true);
  assert.equal(ticketChoices("close", actor("opener"), [ticket({ status: "deleted" })], "", labels).length, 0);
});

 test("decision eligibility and autocomplete require exact selection while undecided close is reviewer-only", () => {
  const reviewer = actor("reviewer", ["reviewer"]);
  for (const invalid of [
    { characterResolutionState: "unresolved" as const },
    { characterResolutionState: "registered_to_other_user" as const },
    { characterResolutionState: "not_listed" as const },
    { selectedAlbionCharacterId: undefined }
  ]) {
    const target = app(invalid);
    for (const action of ["accept", "reject"] as const) {
      assert.equal(canApplicationAction(action, reviewer, target), false);
      assert.deepEqual(applicationChoices(action, reviewer, [target], "", labels), []);
    }
    for (const channelStatus of ["open", "closed"] as const) {
      const retained = { ...target, channelStatus };
      assert.equal(canApplicationAction("close", reviewer, retained), true);
      assert.equal(canApplicationAction("close", actor("applicant"), retained), false);
      assert.equal(applicationChoices("close", reviewer, [retained], "", labels).length, 1);
      assert.deepEqual(applicationChoices("close", actor("applicant"), [retained], "", labels), []);
    }
  }
});

test("accept and reject autocomplete omit selected characters acquired by another owner", () => {
  for (const action of ["accept", "reject"] as const) {
    const reviewer = actor("reviewer", ["reviewer"]);
    assert.equal(canApplicationAction(action, reviewer, app({ selectedCharacterOwnerDiscordUserId: "other" })), false);
    assert.equal(canApplicationAction(action, reviewer, app({ selectedCharacterOwnerDiscordUserId: "applicant" })), true);
    assert.deepEqual(applicationChoices(action, reviewer, [app({ selectedCharacterOwnerDiscordUserId: "other" })], "", labels), []);
  }
});
