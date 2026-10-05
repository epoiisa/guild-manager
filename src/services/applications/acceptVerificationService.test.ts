import assert from "node:assert/strict";
import test from "node:test";
import { withLogChanges } from "../logFeed/events.js";
import type { ApplicationClass, OpenApplication } from "../../db/applicationRepository.js";
import {
  CharacterAlreadyRegisteredError, CharacterRecoveryRequiredError, CharacterRegistrationLimitError,
  type MemberGroup, type MemberGroupProfile, type ConfiguredAlbionGuild, type ConfiguredAlbionAlliance
} from "../../db/membershipRepository.js";
import { AlbionApiError } from "../albion/client.js";
import { acceptOrVerifyApplication, type ApplicationAcceptVerificationInput } from "./acceptVerificationService.js";

test("accept/verify service enforces direct lifecycle gates without an interaction", async () => {
  for (const scenario of [
    { name: "non-reviewer", actorRoles: [], expected: "Reviewer Role Required" },
    { name: "Administrator-like non-reviewer", actorRoles: ["administrator"], expected: "Reviewer Role Required" },
    { name: "wrong channel", wrongChannel: true, expected: "Wrong Channel" },
    { name: "wrong state", status: "accepted", expected: "Application Already Decided" },
    { name: "unresolved character", resolution: "unresolved", expected: "Character Not Resolved" }
  ] as const) {
    const fixture = createFixture({ status: scenario.status, resolution: scenario.resolution, actorRoles: scenario.actorRoles, wrongChannel: scenario.wrongChannel });
    const result = await acceptOrVerifyApplication(fixture.input);
    assert.deepEqual(result, { kind: "error", title: scenario.expected, description: result.kind === "error" ? result.description : "" }, scenario.name);
  assert.equal(fixture.calls.completed, 0, scenario.name);
  }
});

test("accept/verify service returns waiting, departed, ownership, limit, and accepted outcomes directly", async () => {
  const waiting = createFixture({ playerGuildId: "other" });
  assert.deepEqual(await acceptOrVerifyApplication(waiting.input), { kind: "waiting" });
  assert.equal(waiting.calls.waiting, 1);

  const departed = createFixture({ departed: true });
  const departedResult = await acceptOrVerifyApplication(departed.input);
  assert.equal(departedResult.kind, "error");
  assert.equal(departedResult.kind === "error" && departedResult.title, "Applicant Not In Server");

  const conflict = createFixture({ owner: "another-user" });
  const conflictResult = await acceptOrVerifyApplication(conflict.input);
  assert.equal(conflictResult.kind === "error" && conflictResult.title, "Character Already Registered");

  const racedOwner = createFixture({ owner: "retained-owner", registrationError: new CharacterAlreadyRegisteredError() });
  const racedOwnerResult = await acceptOrVerifyApplication(racedOwner.input);
  assert.deepEqual(racedOwnerResult, {
    kind: "error",
    title: "Character Already Registered",
    description: "Applicant Character • <@retained-owner> is already registered."
  });
  assert.equal(racedOwner.calls.profile, 0);
  assert.equal(racedOwner.calls.retired, 0);
  assert.equal(racedOwner.calls.acceptedPresentation, 0);
  assert.equal(racedOwner.calls.controlPersisted, 0);

  const limited = createFixture({ registrationError: new CharacterRegistrationLimitError(25) });
  const limitedResult = await acceptOrVerifyApplication(limited.input);
  assert.equal(limitedResult.kind === "error" && limitedResult.title, "Character Registration Limit Reached");

  const accepted = createFixture({});
  assert.deepEqual(await acceptOrVerifyApplication(accepted.input), { kind: "accepted" });
  assert.equal(accepted.calls.completed, 1);
  assert.equal(accepted.calls.registered, 1);
  assert.equal(accepted.calls.profile, 1);
});

test("accept/verify service accepts direct and guild-backed alliance membership, but leaves unavailable checks retryable", async () => {
  const direct = createFixture({ applicationGroupType: "alliance", playerAllianceId: "alliance" });
  assert.deepEqual(await acceptOrVerifyApplication(direct.input), { kind: "accepted" });
  assert.equal(direct.calls.guildLookups, 0);

  const fallback = createFixture({ applicationGroupType: "alliance", playerGuildId: "guild", playerAllianceId: "other", guildAllianceId: "alliance" });
  assert.deepEqual(await acceptOrVerifyApplication(fallback.input), { kind: "accepted" });
  assert.equal(fallback.calls.guildLookups, 1);

  const mismatch = createFixture({ applicationGroupType: "alliance", playerGuildId: "guild", guildAllianceId: "other" });
  assert.deepEqual(await acceptOrVerifyApplication(mismatch.input), { kind: "waiting" });

  const noGuild = createFixture({ applicationGroupType: "alliance", playerGuildId: "" });
  assert.deepEqual(await acceptOrVerifyApplication(noGuild.input), { kind: "waiting" });

  const unavailable = createFixture({ applicationGroupType: "alliance", playerGuildId: "guild", guildLookupError: new Error("Albion unavailable") });
  assert.deepEqual(await acceptOrVerifyApplication(unavailable.input), {
    kind: "error",
    title: "Alliance Membership Check Unavailable",
    description: "Alliance membership could not be confirmed. Try Accept again."
  });
  assert.equal(unavailable.calls.waiting, 0);
  assert.equal(unavailable.calls.completed, 0);
  assert.equal(unavailable.calls.retired, 0);
  assert.equal(unavailable.calls.controlPersisted, 0);
  assert.equal(unavailable.calls.acceptedPresentation, 0);
  assert.equal(noGuild.calls.guildLookups, 0);

  const unavailableVerify = createFixture({ status: "awaiting_ingame_membership", applicationGroupType: "alliance", playerGuildId: "guild", guildLookupError: new Error("Albion unavailable") });
  unavailableVerify.input.verification = true;
  assert.deepEqual(await acceptOrVerifyApplication(unavailableVerify.input), {
    kind: "error",
    title: "Alliance Membership Check Unavailable",
    description: "Alliance membership could not be confirmed. Try Verify Membership again."
  });
  assert.equal(unavailableVerify.calls.waiting, 0);
  assert.equal(unavailableVerify.calls.retained, 0);
});

test("accept/verify service confirms configured guild membership with the shared search and roster fallbacks", async () => {
  const bySearch = createFixture({ playerGuildId: "", searchGuildId: "target" });
  assert.deepEqual(await acceptOrVerifyApplication(bySearch.input), { kind: "accepted" });

  const byRoster = createFixture({ playerGuildId: "", searchGuildId: "", rosterCharacterIds: ["character"] });
  assert.deepEqual(await acceptOrVerifyApplication(byRoster.input), { kind: "accepted" });

  const unavailable = createFixture({ playerGuildId: "", searchError: new Error("Albion unavailable"), rosterError: new Error("Albion unavailable") });
  assert.deepEqual(await acceptOrVerifyApplication(unavailable.input), {
    kind: "error",
    title: "Guild Membership Check Unavailable",
    description: "Guild membership could not be confirmed. Try Accept again."
  });
});

test("accept/verify service keeps Albion Online character-detail failures retryable", async () => {
  const accept = createFixture({ playerLookupError: new AlbionApiError("timed out", "timeout") });
  assert.deepEqual(await acceptOrVerifyApplication(accept.input), {
    kind: "error",
    title: "Character Verification Unavailable",
    description: "Albion Online character details could not be confirmed. Try Accept again."
  });
  assert.equal(accept.calls.waiting, 0);
  assert.equal(accept.calls.completed, 0);

  const verify = createFixture({
    status: "awaiting_ingame_membership",
    playerLookupError: new AlbionApiError("unavailable", "server", 503)
  });
  verify.input.verification = true;
  assert.deepEqual(await acceptOrVerifyApplication(verify.input), {
    kind: "error",
    title: "Character Verification Unavailable",
    description: "Albion Online character details could not be confirmed. Try Verify Membership again."
  });
});

test("membership transaction failures never present or retain an accepted application", async () => {
  const limited = createFixture({ registrationError: new CharacterRegistrationLimitError(25) });
  const limitResult = await acceptOrVerifyApplication(limited.input);
  assert.equal(limitResult.kind === "error" && limitResult.title, "Character Registration Limit Reached");
  assert.equal(limited.calls.completed, 1);
  assert.equal(limited.calls.profile, 0);

  const failed = createFixture({ registrationError: new Error("profile write failed") });
  await assert.rejects(acceptOrVerifyApplication(failed.input), /profile write failed/);
  assert.equal(failed.calls.completed, 1);
  assert.equal(failed.calls.profile, 0);
});

test("accept/verify service propagates an ownership conflict if the retained owner cannot be resolved", async () => {
  const fixture = createFixture({ registrationError: new CharacterAlreadyRegisteredError() });
  await assert.rejects(acceptOrVerifyApplication(fixture.input), CharacterAlreadyRegisteredError);
  assert.equal(fixture.calls.profile, 0);
});

test("acceptance delegates exact existing registrations at capacity to the atomic membership boundary", async () => {
  const fixture = createFixture({ owner: "applicant", registrationCount: 25 });

  assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
  assert.equal(fixture.calls.completed, 1);
  assert.equal(fixture.calls.listed, 0);
});

test("different applications for one applicant rely on the serialized membership boundary at the registration limit", async () => {
  const first = createFixture({ playerId: "character-25" });
  const second = createFixture({ playerId: "character-26" });
  second.input.applicationId = "application-2";
  const registeredCharacterIds = new Set(Array.from({ length: 24 }, (_, index) => `character-${index + 1}`));
  let entered!: () => void;
  let release!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const releaseFirst = new Promise<void>((resolve) => { release = resolve; });
  let locked = false;
  const complete = async (input: { player: { id: string; name: string } }) => {
    if (!locked) {
      locked = true;
      entered();
      await releaseFirst;
    } else {
      await releaseFirst;
    }
    if (!registeredCharacterIds.has(input.player.id) && registeredCharacterIds.size >= 25) {
      throw new CharacterRegistrationLimitError(25);
    }
    registeredCharacterIds.add(input.player.id);
    return { albionServer: "europe" as const, albionCharacterId: input.player.id, characterName: input.player.name };
  };
  (first.input.membershipRepository as any).completeApplicationAcceptance = complete;
  (second.input.membershipRepository as any).completeApplicationAcceptance = complete;

  const firstResult = acceptOrVerifyApplication(first.input);
  await firstEntered;
  const secondResult = acceptOrVerifyApplication(second.input);
  release();
  const results = await Promise.all([firstResult, secondResult]);
  assert.equal(results.filter((result) => result.kind === "accepted").length, 1);
  assert.equal(results.filter((result) => result.kind === "error" && result.title === "Character Registration Limit Reached").length, 1);
  assert.equal(registeredCharacterIds.size, 25);
});

test("acceptance captures a temporary role removal only after confirmed success", async () => {
  for (const state of ["success", "missing", "failure"] as const) {
    const fixture = createFixture({});
    const application = await fixture.input.applicationRepository.getApplicationClass("guild", "class");
    application!.activeRoleId = "temporary-role";
    const member = await fixture.input.guild.members.fetch("applicant");
    member.roles.cache.has = () => state !== "missing";
    member.roles.remove = async () => {
      if (state === "failure") throw new Error("missing permissions");
      return member;
    };
    await withLogChanges("guild", async (changes) => {
      assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
      assert.deepEqual(changes, state === "success" ? [{
        kind: "role", action: "remove", discordUserId: "applicant", roleId: "temporary-role"
      }] : state === "failure" ? [{ kind: "incomplete", area: "membership" }] : []);
    });
  }
});

for (const targetType of ["group", "guild", "alliance"] as const) {
  for (const verification of targetType === "group" ? [false] : [false, true]) {
    for (const managed of targetType === "group" ? [false, true] : [false]) {
      test(`${targetType} ${verification ? "verification" : "acceptance"} immediately reconciles ${managed ? "managed" : "unmanaged"} Albion Online guild and Albion Online alliance roles`, async () => {
        const fixture = await createReconciliationFixture({ targetType, verification, managed });
        assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
        assert.deepEqual([...fixture.profiles.keys()].sort(), targetType === "group"
          ? ["alliance-group", "group", "guild-group"] : ["alliance-group", "guild-group"]);
        assert.deepEqual(fixture.presented, [{
          roles: targetType === "group" ? ["alliance-role", "guild-role", "members", "registered"] : ["alliance-role", "guild-role", "members"],
          warnings: [], nickname: "Existing Main"
        }]);
        assert.equal(fixture.calls.completed, 1);
        assert.equal((await acceptOrVerifyApplication(fixture.input)).kind, "error");
        assert.equal(fixture.calls.completed, 1);
        assert.equal(fixture.presented.length, 1);
      });
    }
  }
}

test("custom application acceptance uses exact-identity fallbacks to discover other memberships", async () => {
  const fixture = await createReconciliationFixture({ targetType: "group" });
  fixture.input.albionClient.getPlayer = async () => ({ id: "character", name: "Applicant Character" });
  assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
  assert.deepEqual(fixture.presented[0].roles, ["alliance-role", "guild-role", "members", "registered"]);
  assert.deepEqual(fixture.presented[0].warnings, []);
});

for (const existing of [false, true]) {
  test(`custom application acceptance reports unavailable membership checks ${existing ? "without removing existing access" : "without granting unverified access"}`, async () => {
    const fixture = await createReconciliationFixture({ targetType: "group" });
    if (existing) {
      for (const groupId of ["guild-group", "alliance-group"]) fixture.profiles.set(groupId, fixture.profile(groupId));
      for (const roleId of ["guild-role", "alliance-role", "members"]) fixture.roles.set(roleId, true);
    }
    fixture.input.albionClient.getPlayer = async () => ({ id: "character", name: "Applicant Character" });
    fixture.input.albionClient.searchCharacters = async () => { throw new Error("Albion Online API unavailable"); };
    fixture.input.albionClient.getGuildMembers = async () => { throw new Error("Albion Online API unavailable"); };
    assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
    assert.deepEqual([...fixture.profiles.keys()].sort(), existing ? ["alliance-group", "group", "guild-group"] : ["group"]);
    assert.deepEqual(fixture.presented[0].roles, existing ? ["alliance-role", "guild-role", "members", "registered"] : ["registered"]);
    assert.deepEqual(fixture.presented[0].warnings, [
      "Guild membership check failed for Applicant Character in Dreamweavers: Albion Online API unavailable",
      "Alliance membership check failed for Applicant Character in GUCHI: Albion Online API unavailable"
    ]);
  });
}

test("Discord role failure retains accepted memberships and reports the incomplete assignment", async () => {
  const fixture = await createReconciliationFixture({ targetType: "group", failRole: "members" });
  assert.deepEqual(await acceptOrVerifyApplication(fixture.input), { kind: "accepted" });
  assert.deepEqual([...fixture.profiles.keys()].sort(), ["alliance-group", "group", "guild-group"]);
  assert.deepEqual(fixture.presented[0].roles, ["alliance-role", "guild-role", "registered"]);
  assert.deepEqual(fixture.presented[0].warnings, ["Role update failed for <@applicant>: Missing Permissions"]);
});

async function createReconciliationFixture(options: {
  targetType: MemberGroup["groupType"];
  verification?: boolean;
  managed?: boolean;
  failRole?: string;
}) {
  const fixture = createFixture({ applicationGroupType: options.targetType, playerAllianceId: "alliance", guildAllianceId: "alliance" });
  const { input } = fixture;
  const application = (await input.applicationRepository.getApplicationClass("guild", "class"))!;
  const open = (await input.applicationRepository.getOpenApplication("guild", "application"))!;
  input.verification = options.verification ?? false;
  open.status = input.verification ? "awaiting_ingame_membership" : "open";
  const custom: MemberGroup = { memberGroupId: "group", discordGuildId: "guild", albionServer: "europe", groupType: "group", groupName: "Registered" };
  const configuredGuild: ConfiguredAlbionGuild = { ...custom, memberGroupId: "guild-group", groupType: "guild", groupName: "Dreamweavers", albionGuildId: "target", albionGuildName: "Dreamweavers", managed: options.managed ?? false };
  const configuredAlliance: ConfiguredAlbionAlliance = { ...custom, memberGroupId: "alliance-group", groupType: "alliance", groupName: "GUCHI", albionAllianceId: "alliance", albionAllianceName: "GUCHI" };
  const otherServerGuild: ConfiguredAlbionGuild = { ...configuredGuild, memberGroupId: "other-server-guild", albionServer: "asia" };
  const otherServerAlliance: ConfiguredAlbionAlliance = { ...configuredAlliance, memberGroupId: "other-server-alliance", albionServer: "asia" };
  const groups = [custom, configuredGuild, configuredAlliance, otherServerGuild, otherServerAlliance];
  application.memberGroupId = groups.find(group => group.groupType === options.targetType)!.memberGroupId;
  const profiles = new Map<string, MemberGroupProfile>();
  const profile = (memberGroupId: string): MemberGroupProfile => ({
    memberGroupProfileId: `profile-${memberGroupId}`, memberGroupId, discordGuildId: "guild",
    discordUserId: "applicant", albionServer: "europe", albionCharacterId: "character", characterName: "Applicant Character"
  });
  const roles = new Map<string, boolean>();
  const member = {
    id: "applicant", guild: { id: "guild" }, nickname: null as string | null,
    roles: { cache: roles,
      add: async (id: string) => { if (id === options.failRole) throw new Error("Missing Permissions"); roles.set(id, true); },
      remove: async (id: string) => { roles.delete(id); }
    },
    setNickname: async (nickname: string | null) => { member.nickname = nickname; }
  };
  input.guild = { id: "guild", members: { me: { roles: { highest: { comparePositionTo: () => 1 } }, permissions: { has: () => true } }, fetch: async () => member } } as never;
  const membership = input.membershipRepository;
  membership.listMemberGroups = async (guildId, server) => {
    assert.equal(guildId, "guild"); assert.equal(server, "europe");
    return groups.filter(group => group.albionServer === server);
  };
  membership.listConfiguredAlbionGuilds = async () => [configuredGuild, otherServerGuild];
  membership.listConfiguredAlbionAlliances = async () => [configuredAlliance, otherServerAlliance];
  membership.getConfiguredAlbionGuild = async () => configuredGuild;
  membership.getConfiguredAlbionAlliance = async () => configuredAlliance;
  const complete = membership.completeApplicationAcceptance;
  membership.completeApplicationAcceptance = async (acceptance) => {
    const registered = await complete(acceptance);
    profiles.set(acceptance.memberGroupId!, profile(acceptance.memberGroupId!));
    open.status = "accepted";
    return registered;
  };
  membership.listProfilesForCharacter = async (guildId, server, characterId) => {
    assert.deepEqual([guildId, server, characterId], ["guild", "europe", "character"]);
    return [...profiles.values()];
  };
  membership.addRegisteredProfile = async (addition) => {
    assert.deepEqual([addition.discordGuildId, addition.discordUserId, addition.albionServer, addition.albionCharacterId], ["guild", "applicant", "europe", "character"]);
    const added = profile(addition.memberGroupId);
    profiles.set(addition.memberGroupId, added);
    return added;
  };
  membership.orphanRegisteredProfile = async (removal) => {
    const orphan = { ...profiles.get(removal.memberGroupId)!, discordUserId: undefined };
    profiles.set(removal.memberGroupId, orphan);
    return orphan;
  };
  const rolesByGroup = new Map([
    ["group", ["registered"]], ["guild-group", ["guild-role", "members"]], ["alliance-group", ["alliance-role", "members"]]
  ]);
  membership.listConfiguredRoleIdsForGuild = async () => ["registered", "guild-role", "alliance-role", "members"];
  membership.listQualifiedRoleIdsForUser = async (guildId, userId) => {
    assert.deepEqual([guildId, userId], ["guild", "applicant"]);
    return [...new Set([...profiles.values()].filter(value => value.discordUserId === userId).flatMap(value => rolesByGroup.get(value.memberGroupId) ?? []))];
  };
  membership.getEffectiveNickname = async () => "Existing Main";
  const presented: Array<{ roles: string[]; warnings: string[]; nickname: string | null }> = [];
  const render = input.presentation.renderAccepted;
  input.presentation.renderAccepted = async (accepted) => {
    presented.push({ roles: [...roles.keys()].sort(), warnings: accepted.warnings.map(warning => warning.message), nickname: member.nickname });
    return render(accepted);
  };
  return { ...fixture, profiles, profile, roles, presented };
}

function createFixture(options: {
  status?: OpenApplication["status"];
  resolution?: OpenApplication["characterResolutionState"];
  actorRoles?: readonly string[];
  departed?: boolean;
  playerGuildId?: string;
  searchGuildId?: string;
  rosterCharacterIds?: readonly string[];
  searchError?: Error;
  rosterError?: Error;
  playerAllianceId?: string;
  playerId?: string;
  playerLookupError?: Error;
  applicationGroupType?: MemberGroup["groupType"];
  guildAllianceId?: string;
  guildLookupError?: Error;
  owner?: string;
  recoveryState?: "hold" | "abandoned";
  registrationCount?: number;
  registrationError?: Error;
  wrongChannel?: boolean;
}): { input: ApplicationAcceptVerificationInput; calls: Record<string, number> } {
  const calls: Record<string, number> = {
    completed: 0, waiting: 0, listed: 0, registered: 0, profile: 0, guildLookups: 0,
    retired: 0, retained: 0, acceptedPresentation: 0, controlPersisted: 0
  };
  const application: ApplicationClass = {
    applicationClassId: "class", discordGuildId: "guild", name: "Guild Application", outcomeType: "member_group",
    memberGroupId: "group", albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: "reviewer",
    questions: [], enabled: true, createdByDiscordUserId: "owner"
  };
  const openApplication: OpenApplication = {
    applicationId: "application", applicationClassId: "class", discordGuildId: "guild", applicantDiscordUserId: "applicant",
    ticketChannelId: "ticket", submittedCharacterName: "Applicant Character", modalAnswers: [], albionServer: "europe", selectedAlbionCharacterId: options.playerId ?? "character",
    characterResolutionState: options.resolution ?? "selected", characterSearchAttemptCount: 1, status: options.status ?? "open", channelStatus: "open"
  };
  const member = { id: "applicant", guild: { id: "guild" }, nickname: null, roles: { cache: new Map(), add: async () => undefined, remove: async () => undefined }, setNickname: async () => undefined };
  const guild = {
    id: "guild",
    members: { fetch: async (value: unknown) => {
      if (typeof value === "object" && value !== null) {
        if (options.departed) throw { code: 10_007 };
        return member;
      }
      return member;
    } },
    channels: { fetch: async () => undefined }
  };
  const membership = {
    listMemberGroups: async () => [{ memberGroupId: "group", discordGuildId: "guild", groupName: "Configured Guild", groupType: options.applicationGroupType ?? "guild", albionServer: "europe" }],
    listConfiguredAlbionGuilds: async () => [],
    listConfiguredAlbionAlliances: async () => [],
    upsertVerifiedCharacter: async () => undefined,
    listProfilesForCharacter: async () => [],
    getConfiguredAlbionGuild: async () => ({ memberGroupId: "group", albionServer: "europe", albionGuildId: "target", albionGuildName: "Configured Guild" }),
    getConfiguredAlbionAlliance: async () => ({ memberGroupId: "group", albionServer: "europe", albionAllianceId: "alliance", albionAllianceName: "Configured Alliance" }),
    getRegisteredCharacter: async () => options.owner ? { discordUserId: options.owner } : undefined,
    getCharacterRegistrationLifecycle: async () => options.recoveryState ? { state: options.recoveryState } : undefined,
    listRegisteredCharacters: async () => {
      calls.listed++;
      return Array.from({ length: options.registrationCount ?? 0 }, (_, index) => ({ albionCharacterId: `existing-${index}` }));
    },
    registerCharacterAndAdoptOrphans: async () => { calls.registered++; if (options.registrationError) throw options.registrationError; return { albionServer: "europe", albionCharacterId: "character", characterName: "Applicant Character" }; },
    addRegisteredProfile: async () => { calls.profile++; },
    completeApplicationAcceptance: async () => {
      calls.completed++;
      calls.registered++;
      if (options.registrationError) throw options.registrationError;
      calls.profile++;
      return { albionServer: "europe", albionCharacterId: options.playerId ?? "character", characterName: "Applicant Character" };
    },
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => [],
    listQualifiedRoleIdsForUser: async () => [],
    getEffectiveNickname: async () => undefined
  };
  const repository = {
    listQualifiedRoleIdsForUser: (guildId: string, userId: string) => membership.listQualifiedRoleIdsForUser(),
    getOpenApplication: async () => openApplication,
    getApplicationClass: async () => application,
    markApplicationAwaitingMembership: async () => { calls.waiting++; return openApplication; },
    setApplicationControlMessageId: async () => { calls.controlPersisted++; return openApplication; }
  };
  return {
    calls,
    input: {
      verification: false, guild: guild as never, guildId: "guild", channelId: options.wrongChannel ? "other" : "ticket", applicationId: "application",
      actor: { userId: "reviewer", roleIds: new Set(options.actorRoles ?? ["reviewer"]) },
      applicationRepository: repository as never, membershipRepository: membership as never,
      albionClient: {
        getPlayer: async () => {
          if (options.playerLookupError) throw options.playerLookupError;
          return { id: options.playerId ?? "character", name: "Applicant Character", guildId: options.playerGuildId ?? "target", allianceId: options.playerAllianceId };
        },
        searchCharacters: async () => {
          if (options.searchError) throw options.searchError;
          return { players: [{ id: options.playerId ?? "character", name: "Applicant Character", guildId: options.searchGuildId ?? options.playerGuildId ?? "target" }], guilds: [] };
        },
        getGuildMembers: async () => {
          if (options.rosterError) throw options.rosterError;
          return (options.rosterCharacterIds ?? []).map((id) => ({ id, name: "Applicant Character" }));
        },
        getGuild: async () => {
          calls.guildLookups++;
          if (options.guildLookupError) throw options.guildLookupError;
          return { id: options.playerGuildId ?? "target", name: "Guild", allianceId: options.guildAllianceId };
        }
      } as never,
      presentation: {
        retireUndecidedControls: async () => { calls.retired++; },
        retainWaitingControls: async () => { calls.retained++; },
        renderWaiting: async () => "waiting-message",
        renderAccepted: async () => { calls.acceptedPresentation++; return "accepted-message"; }
      }
    }
  };
}

test("accept blocks post-selection ownership conflicts before entering waiting membership", async () => {
  const fixture = createFixture({ owner: "new-owner", playerGuildId: "other", searchGuildId: "other", rosterCharacterIds: [] });
  const result = await acceptOrVerifyApplication(fixture.input);
  assert.equal(result.kind === "error" && result.title, "Character Already Registered");
  assert.equal(fixture.calls.waiting, 0);
  assert.equal(fixture.calls.completed, 0);
  assert.equal(fixture.calls.retired, 0);
});

test("application approval never recovers hold or abandoned registrations, including a transaction race", async () => {
  for (const state of ["hold", "abandoned"] as const) {
    const fixture = createFixture({ recoveryState: state });
    const result = await acceptOrVerifyApplication(fixture.input);
    assert.equal(result.kind === "error" && result.title, "Officer Recovery Required");
    assert.equal(fixture.calls.completed, 0);
    assert.equal(fixture.calls.waiting, 0);
    assert.equal(fixture.calls.acceptedPresentation, 0);
  }
  const raced = createFixture({ registrationError: new CharacterRecoveryRequiredError() });
  const result = await acceptOrVerifyApplication(raced.input);
  assert.equal(result.kind === "error" && result.title, "Officer Recovery Required");
  assert.equal(raced.calls.acceptedPresentation, 0);
});

for (const player of [{ id: "wrong", name: "Wrong" }, { id: "character", name: " " }]) {
  test(`accept refuses unverified endpoint identity ${JSON.stringify(player)}`, async () => {
    const fixture = createFixture({});
    fixture.input.albionClient.getPlayer = async () => player;
    const result = await acceptOrVerifyApplication(fixture.input);
    assert.equal(result.kind === "error" && result.title, "Character Verification Unavailable");
    assert.equal(fixture.calls.waiting, 0);
    assert.equal(fixture.calls.completed, 0);
  });
}
