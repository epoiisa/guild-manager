import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import type { ApplicationClass, OpenApplication } from "../../db/applicationRepository.js";
import { runApplicationLifecycleOperation, type ApplicationLifecycleOperationInput } from "./lifecycleService.js";

function fixture(selected = false) {
  let state: OpenApplication = {
    applicationId: "application", applicationClassId: "class", discordGuildId: "guild",
    applicantDiscordUserId: "applicant", ticketChannelId: "channel", submittedCharacterName: "query",
    modalAnswers: [{ question: "Why?", answer: "To join" }], albionServer: "europe",
    characterResolutionState: selected ? "selected" : "unresolved", characterSearchAttemptCount: 2,
    ...(selected ? { selectedAlbionCharacterId: "exact-id", selectedCharacterName: "Resolved Name" } : {}),
    status: "open", channelStatus: "open"
  };
  const application = { applicationClassId: "class", reviewerRoleId: "reviewer", activeRoleId: "temporary" } as ApplicationClass;
  const roles = new Set(["temporary"]);
  const permissions = new Map<string, boolean>();
  const rendered: OpenApplication[] = [];
  const failure = { permission: false, role: false, render: false, departed: false, otherActive: false };
  const member = { id: "applicant", roles: { cache: roles,
    add: async (id: string) => { if (failure.role) throw new Error("role failure"); roles.add(id); },
    remove: async (id: string) => { if (failure.role) throw new Error("role failure"); roles.delete(id); }
  } };
  const guild = { id: "guild", members: { fetch: async () => { if (failure.departed) throw { code: 10007 }; return member; } } };
  const channel = { type: ChannelType.GuildText, guild, permissionOverwrites: {
    edit: async (id: string, value: { SendMessages: boolean }) => {
      if (failure.permission) throw new Error("permission failure");
      permissions.set(id, value.SendMessages);
    }
  } };
  const repository = {
    getOpenApplication: async () => state,
    getApplicationClass: async () => application,
    markApplicationClosed: async () => state = { ...state, channelStatus: "closed" },
    markApplicationReopened: async () => state = { ...state, channelStatus: "open" },
    listQualifiedRoleIdsForUser: async (guildId: string, userId: string) => {
      assert.deepEqual([guildId, userId], ["guild", "applicant"]);
      return failure.otherActive || (state.channelStatus === "open" && ["open", "awaiting_ingame_membership"].includes(state.status)) ? ["temporary"] : [];
    },
    claimClosedControlMessageId: async (_guild: string, _id: string, _expected: string | undefined, id: string) => {
      state.closedControlMessageId = id; return true;
    },
    setClosedControlMessageId: async (_guild: string, _id: string, id: string | undefined) => { state.closedControlMessageId = id; }
  };
  const input = {
    guildId: "guild", applicationId: "application", guild, channel, applicationRepository: repository,
    actor: { userId: "reviewer-user", roleIds: new Set(["reviewer"]) },
    presentation: {
      renderClosed: async () => { if (failure.render) throw new Error("render failure"); return "closed-card"; },
      renderOpen: async (_application: ApplicationClass, open: OpenApplication) => {
        if (failure.render) throw new Error("render failure"); rendered.push(structuredClone(open));
      },
      retireClosedCandidate: async () => {}
    }
  } as unknown as Omit<ApplicationLifecycleOperationInput, "action">;
  return { input, failure, roles, permissions, rendered, state: () => state,
    run: (action: ApplicationLifecycleOperationInput["action"]) => runApplicationLifecycleOperation({ ...input, action }) };
}

for (const selected of [false, true]) {
  test(`reviewer closes ${selected ? "selected" : "unresolved"} undecided application without changing selection or answers`, async () => {
    const h = fixture(selected);
    const before = structuredClone(h.state());
    assert.deepEqual(await h.run("close"), { kind: "closed", repaired: false, retainedState: "open" });
    assert.equal(h.state().status, "open");
    assert.equal(h.state().characterResolutionState, before.characterResolutionState);
    assert.equal(h.state().selectedAlbionCharacterId, before.selectedAlbionCharacterId);
    assert.deepEqual(h.state().modalAnswers, before.modalAnswers);
    assert.equal(h.state().characterSearchAttemptCount, 2);
    assert.equal(h.roles.has("temporary"), false);
    assert.deepEqual([...h.permissions], [["reviewer", false], ["applicant", false]]);
    assert.equal(h.state().closedControlMessageId, "closed-card");
    assert.deepEqual(await h.run("close"), { kind: "closed", repaired: true, retainedState: "open" });
    h.input.actor = { userId: "applicant", roleIds: new Set() };
    assert.deepEqual(await h.run("reopen"), { kind: "reopened", repaired: false, retainedState: "open" });
    assert.equal(h.roles.has("temporary"), true);
    assert.equal(h.rendered[0]?.characterResolutionState, before.characterResolutionState);
    assert.equal(h.rendered[0]?.selectedAlbionCharacterId, before.selectedAlbionCharacterId);
    assert.equal(h.rendered[0]?.selectedCharacterName, before.selectedCharacterName);
    assert.equal(h.state().closedControlMessageId, undefined);
    assert.deepEqual([...h.permissions], [["reviewer", true], ["applicant", true]]);
  });
}

test("applicant cannot close or repair a closed undecided application", async () => {
  const h = fixture();
  h.input.actor = { userId: "applicant", roleIds: new Set() };
  for (const channelStatus of ["open", "closed"] as const) {
    h.state().channelStatus = channelStatus;
    const result = await h.run("close");
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.title, "Reviewer Role Required");
    assert.equal(h.state().channelStatus, channelStatus);
    assert.equal(h.permissions.size, 0);
    assert.equal(h.roles.has("temporary"), true);
  }
});

test("another active application keeps the shared temporary role", async () => {
  const h = fixture(); h.failure.otherActive = true;
  await h.run("close");
  assert.equal(h.roles.has("temporary"), true);
});

for (const status of ["accepted", "rejected", "withdrawn", "awaiting_ingame_membership"] as const) {
  test(`${status} closure cleans leftovers, and only a waiting reopen restores the application role`, async () => {
    const h = fixture(); h.state().status = status;
    assert.equal((await h.run(status === "awaiting_ingame_membership" ? "cancel" : "close")).kind, "closed");
    assert.equal(h.roles.has("temporary"), false);
    assert.equal((await h.run("reopen")).kind, "reopened");
    assert.equal(h.roles.has("temporary"), status === "awaiting_ingame_membership");
    assert.equal(h.state().status, status);
  });
}

test("departed applicant does not prevent reviewer close or reopen", async () => {
  const h = fixture(); h.failure.departed = true;
  assert.equal((await h.run("close")).kind, "closed");
  assert.deepEqual([...h.permissions], [["reviewer", false]]);
  assert.equal((await h.run("reopen")).kind, "reopened");
  assert.deepEqual([...h.permissions], [["reviewer", true]]);
});

test("a transient member-fetch failure during role synchronization remains retryable", async () => {
  const h = fixture();
  const fetchMember = h.input.guild.members.fetch.bind(h.input.guild.members);
  let reads = 0;
  h.input.guild.members.fetch = (async (...args: unknown[]) => {
    if (++reads === 2) throw new Error("member fetch unavailable");
    return (fetchMember as (...input: unknown[]) => Promise<unknown>)(...args);
  }) as typeof h.input.guild.members.fetch;
  const incomplete = await h.run("close");
  assert.equal(incomplete.kind, "closed");
  assert.match(incomplete.warnings?.[0].message ?? "", /member fetch unavailable/);
  assert.equal(h.state().channelStatus, "closed");
  assert.equal(h.roles.has("temporary"), true);
  assert.deepEqual(await h.run("close"), { kind: "closed", repaired: true, retainedState: "open" });
  assert.equal(h.roles.has("temporary"), false);
});

for (const failurePoint of ["permission", "role", "render"] as const) {
  test(`close recovers after ${failurePoint} failure`, async () => {
    const h = fixture(true); h.failure[failurePoint] = true;
    if (failurePoint === "role") {
      const result = await h.run("close");
      assert.equal(result.kind, "closed");
      assert.match(result.warnings?.[0].message ?? "", /role failure/);
    } else await assert.rejects(h.run("close"), new RegExp(`${failurePoint} failure`));
    assert.equal(h.state().channelStatus, "closed");
    h.failure[failurePoint] = false;
    assert.deepEqual(await h.run("close"), { kind: "closed", repaired: true, retainedState: "open" });
    assert.equal(h.roles.has("temporary"), false);
    assert.equal(h.state().closedControlMessageId, "closed-card");
  });
  test(`reopen recovers after ${failurePoint} failure`, async () => {
    const h = fixture(true); await h.run("close"); h.failure[failurePoint] = true;
    if (failurePoint === "role") {
      const result = await h.run("reopen");
      assert.equal(result.kind, "reopened");
      assert.match(result.warnings?.[0].message ?? "", /role failure/);
    } else await assert.rejects(h.run("reopen"), new RegExp(`${failurePoint} failure`));
    assert.equal(h.state().channelStatus, failurePoint === "permission" ? "closed" : "open");
    h.failure[failurePoint] = false;
    assert.equal((await h.run("reopen")).kind, "reopened");
    assert.equal(h.roles.has("temporary"), true);
    assert.equal(h.state().selectedAlbionCharacterId, "exact-id");
    assert.equal(h.state().closedControlMessageId, undefined);
  });
}
