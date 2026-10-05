import assert from "node:assert/strict";
import test from "node:test";
import { rejectApplication } from "./rejectService.js";

test("reject service rejects only an open matching application for its configured reviewer", async () => {
  const cases = [
    { name: "missing application", missing: true, expected: "Application Not Found" },
    { name: "wrong channel", channelId: "other", expected: "Wrong Channel" },
    { name: "administrator without reviewer role", roles: ["administrator"], expected: "Reviewer Role Required" },
    { name: "closed channel", channelStatus: "closed" as const, expected: "Application Closed" },
    { name: "decided application", status: "accepted" as const, expected: "Application Already Decided" }
  ];

  for (const entry of cases) {
    const fixture = createFixture(entry);
    const result = await rejectApplication(fixture.input);
    assert.equal(result.kind, "error", entry.name);
    assert.equal(result.kind === "error" && result.title, entry.expected, entry.name);
    assert.deepEqual(fixture.events, [], entry.name);
  }
});

test("reject service marks, retires, removes the active role, renders, then persists a replacement", async () => {
  const fixture = createFixture({ activeRole: true, replacementId: "replacement" });

  assert.deepEqual(await rejectApplication(fixture.input), { kind: "rejected" });
  assert.deepEqual(fixture.events, ["mark", "retire", "remove-active-role", "render", "persist:replacement"]);
});

test("reject service still completes when no replacement message is available", async () => {
  const fixture = createFixture({ replacementId: undefined });

  assert.deepEqual(await rejectApplication(fixture.input), { kind: "rejected" });
  assert.deepEqual(fixture.events, ["mark", "retire", "render"]);
});

function createFixture(options: {
  missing?: boolean;
  resolution?: "selected" | "unresolved" | "not_listed" | "registered_to_other_user";
  noSelectedId?: boolean;
  owner?: string;
  channelId?: string;
  roles?: string[];
  channelStatus?: "open" | "closed";
  status?: "open" | "accepted";
  activeRole?: boolean;
  replacementId?: string;
}) {
  const events: string[] = [];
  const open = {
    applicationId: "application",
    applicationClassId: "class",
    applicantDiscordUserId: "applicant",
    ticketChannelId: "channel",
    channelStatus: options.channelStatus ?? "open",
    status: options.status ?? "open",
    characterResolutionState: options.resolution ?? "selected",
    selectedAlbionCharacterId: options.noSelectedId ? undefined : "exact-character",
    selectedCharacterOwnerDiscordUserId: options.owner
  };
  const application = { reviewerRoleId: "reviewer", activeRoleId: options.activeRole ? "active" : undefined };
  const repository = {
    listQualifiedRoleIdsForUser: async () => [],
    getOpenApplication: async () => options.missing ? undefined : open,
    getApplicationClass: async () => application,
    markApplicationRejected: async () => { events.push("mark"); return open; },
    setApplicationControlMessageId: async (_guildId: string, _applicationId: string, id: string) => { events.push(`persist:${id}`); return open; }
  };
  const member = {
    roles: {
      cache: new Map(options.activeRole ? [["active", {}]] : []),
      remove: async () => { events.push("remove-active-role"); }
    }
  };
  return {
    events,
    input: {
      guild: { id: "guild", members: { fetch: async () => member } } as never,
      guildId: "guild",
      channelId: options.channelId ?? "channel",
      applicationId: "application",
      actor: { userId: "reviewer", roleIds: new Set(options.roles ?? ["reviewer"]) },
      applicationRepository: repository as never,
      presentation: {
        retireUndecidedControls: async () => { events.push("retire"); },
        renderRejected: async () => { events.push("render"); return options.replacementId; }
      }
    }
  };
}

test("reject refuses unresolved, conflict, not-listed and incomplete selection before mutation", async () => {
  for (const options of [
    { resolution: "unresolved" as const },
    { resolution: "registered_to_other_user" as const },
    { resolution: "not_listed" as const },
    { noSelectedId: true }
  ]) {
    const fixture = createFixture(options);
    const result = await rejectApplication(fixture.input);
    assert.equal(result.kind === "error" && result.title, "Character Selection Required");
    assert.deepEqual(fixture.events, []);
  }
});

test("an applicant with a selected character cannot reject without the reviewer role", async () => {
  const fixture = createFixture({ roles: [] });
  fixture.input.actor.userId = "applicant";
  const result = await rejectApplication(fixture.input);
  assert.equal(result.kind === "error" && result.title, "Reviewer Role Required");
  assert.deepEqual(fixture.events, []);
});

test("reject blocks ownership acquired by another user after valid selection", async () => {
  const fixture = createFixture({ owner: "new-owner" });
  const result = await rejectApplication(fixture.input);
  assert.equal(result.kind === "error" && result.title, "Character Already Registered");
  assert.deepEqual(fixture.events, []);
});

test("reject permits the applicant's existing character registration", async () => {
  const fixture = createFixture({ owner: "applicant" });
  assert.deepEqual(await rejectApplication(fixture.input), { kind: "rejected" });
});
