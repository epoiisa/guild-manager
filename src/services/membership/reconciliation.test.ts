import assert from "node:assert/strict";
import test from "node:test";
import { withLogChanges } from "../logFeed/events.js";
import { formatLogChanges } from "../logFeed/formatting.js";
import {
  auditMembershipForGuild,
  reconcileMembershipForGuild,
  reconcileRegisteredCharacterMembership
} from "./reconciliation.js";

test("membership log capture records one applied summary and keeps audit silent", async () => {
  const fixture = createManagedRosterFixture();
  await withLogChanges("discord-guild-1", async (changes) => {
    await auditMembershipForGuild(fixture.guild as any, fixture.albionClient as any, fixture.membershipRepository as any);
    assert.equal(changes.length, 0);
    const result = await reconcileMembershipForGuild(fixture.guild as any, fixture.albionClient as any, fixture.membershipRepository as any);
    assert.deepEqual(changes.filter(change => change.kind === "reconciliation"), [{ kind: "reconciliation", outcomes: result.outcomes, warningCount: 0 }]);
    assert.equal(changes.filter(change => change.kind === "profile" && change.action === "left").length, 2);
  });
});

test("exceptional membership update records a neutral incomplete marker", async () => {
  const fixture = createManagedRosterFixture();
  fixture.membershipRepository.listMemberGroups = async () => { throw new Error("private database detail"); };
  await withLogChanges("discord-guild-1", async (changes) => {
    await assert.rejects(reconcileMembershipForGuild(fixture.guild as any, fixture.albionClient as any, fixture.membershipRepository as any), /private database detail/);
    assert.deepEqual(changes, [{ kind: "incomplete", area: "membership" }]);
  });
});

test("server owner nickname exception preserves membership and role reconciliation", async () => {
  const f = createManagedRosterFixture();
  const guild = { ...f.guild, ownerId: "user-add", members: {
    fetch: async (value?: string | { user: string }) => f.guild.members.fetch(typeof value === "object" ? value.user : value)
  } };
  const repository = {
    ...f.membershipRepository,
    getEffectiveNickname: async (_guildId: string, userId: string) => {
      if (userId === guild.ownerId) assert.fail("owner nickname lookup must be skipped");
      return undefined;
    },
    listConfiguredRoleIdsForGuild: async () => ["member-role"],
    listQualifiedRoleIdsForUser: async (_guildId: string, userId: string) => userId === guild.ownerId ? ["member-role"] : []
  };
  await withLogChanges(guild.id, async (changes) => {
    const audit = await auditMembershipForGuild(guild as any, f.albionClient as any, repository as any);
    assert.deepEqual(audit.warnings, []);
    assert.deepEqual(f.roleMutations, []);
    const result = await reconcileMembershipForGuild(guild as any, f.albionClient as any, repository as any);
    assert.deepEqual(result.warnings, []);
    assert.ok(f.mutations.includes("register:character-add:user-add"));
    assert.deepEqual(f.roleMutations, ["add:member-role"]);
    assert.equal(result.outcomes.some(outcome => outcome.kind === "nickname"), false);
    assert.equal(changes.some(change => change.kind === "incomplete"), false);
    assert.ok(result.outcomes.some(outcome => outcome.kind === "role" && outcome.discordUserId === guild.ownerId));
  });
  const owner = await f.guild.members.fetch(guild.ownerId);
  assert.ok(owner && !(owner instanceof Map));
  owner.roles.add = async () => { throw new Error("Missing Permissions"); };
  const failed = await reconcileMembershipForGuild(guild as any, f.albionClient as any, repository as any);
  assert.deepEqual(failed.warnings, [{ message: "Role update failed for <@user-add>: Missing Permissions" }]);
});

test("profile audit plans additions, records, reassignments, and removals without mutations", async () => {
  const fixture = createManagedRosterFixture();

  const result = await auditMembershipForGuild(
    fixture.guild as any,
    fixture.albionClient as any,
    fixture.membershipRepository as any
  );

  assert.deepEqual(result.outcomes, expectedProfileOutcomes);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.mutations, []);
  assert.equal(fixture.nicknameMutations.length, 0);
  assert.equal(fixture.roleMutations.length, 0);
  assert.equal(fixture.reactionLookups, 0);
});

test("profile update confirms successful additions, records, reassignments, and removals", async () => {
  const fixture = createManagedRosterFixture();

  const result = await reconcileMembershipForGuild(
    fixture.guild as any,
    fixture.albionClient as any,
    fixture.membershipRepository as any
  );

  assert.deepEqual(result.outcomes, expectedProfileOutcomes);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.mutations, [
    "verify:character-add",
    "register:character-add:user-add",
    "verify:character-record",
    "orphan:character-record",
    "verify:character-reassign",
    "register:character-reassign:user-new",
    "verify:character-claim",
    "register:character-claim:user-claim",
    "verify:character-existing",
    "remove:character-remove:user-remove",
    "remove:character-orphan-noop:null"
  ]);
  assert.equal(fixture.nicknameMutations.length, 0);
  assert.equal(fixture.roleMutations.length, 0);
  assert.equal(fixture.reactionLookups, 0);
});

test("profile update omits a planned addition when the database mutation is not confirmed", async () => {
  const fixture = createManagedRosterFixture("character-add");

  const result = await reconcileMembershipForGuild(
    fixture.guild as any,
    fixture.albionClient as any,
    fixture.membershipRepository as any
  );

  assert.equal(
    result.outcomes.some((outcome) =>
      outcome.kind === "profile"
      && outcome.characterName === "Added"
    ),
    false
  );
  assert.deepEqual(
    result.outcomes,
    expectedProfileOutcomes.filter((outcome) => outcome.characterName !== "Added")
  );
});

test("a managed roster omission does not depart profiles while individual evidence is unavailable", async () => {
  const f = createManagedRosterFixture();
  f.albionClient.getPlayer = async () => { throw Error("temporary failure"); };
  const result = await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(f.mutations.some(mutation => mutation.startsWith("remove:")), false);
  assert.equal(result.warnings.length, 2);
});

test("managed roster presence cannot silently recover a held registration", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(profile => profile.albionCharacterId === "character-claim"
    ? { ...profile, registrationState: "hold" as const } : profile);
  await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(f.mutations.includes("register:character-claim:user-claim"), false);
});

test("a fresh positive result cannot revive a profile whose lifecycle revision changed", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(profile => profile.albionCharacterId === "character-claim"
    ? { ...profile, lifecycleState: "departed", departureExpiresAt: new Date(Date.now() + 60_000) } : profile);
  (f.membershipRepository as any).restoreDepartedMembership = async () => false;
  await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(f.mutations.includes("register:character-claim:user-claim"), false);
});

test("managed return after the buffer retains the profile with no second profile write", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(profile => profile.albionCharacterId === "character-claim"
    ? { ...profile, lifecycleState: "departed", departureExpiresAt: new Date(Date.now() - 1) } : profile);
  (f.membershipRepository as any).restoreDepartedMembership = async (departed: any, revision: number) => {
    assert.equal(revision, 1);
    return { ...departed, discordUserId: "user-claim", lifecycleState: "current", lifecycleRevision: 2 };
  };
  const result = await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(f.mutations.includes("register:character-claim:user-claim"), false);
  assert.ok(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "restore" && outcome.characterName === "Claimed"));
  assert.equal(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "expire"), false);
});

test("audit uses neutral roster and character check warnings", async () => {
  const managedGroup = {
    memberGroupId: "group-managed",
    discordGuildId: "discord-guild-1",
    albionServer: "europe",
    groupType: "guild",
    groupName: "Managed Guild",
    albionGuildId: "guild-managed",
    albionGuildName: "Managed Guild",
    managed: true
  };
  const checkedGroup = {
    ...managedGroup,
    memberGroupId: "group-checked",
    groupName: "Checked Guild",
    albionGuildId: "guild-checked",
    albionGuildName: "Checked Guild",
    managed: false
  };
  const membershipRepository = {
    listMemberGroups: async () => [managedGroup, checkedGroup],
    listConfiguredAlbionGuilds: async () => [managedGroup, checkedGroup],
    listConfiguredAlbionAlliances: async () => [],
    listRegisteredUserIdsForGuild: async () => [],
    listActiveProfileUserIdsForGroups: async () => [],
    listRegisteredCharacters: async () => [{
      discordGuildId: "discord-guild-1",
      discordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Checked Character"
    }],
    listProfilesForGroups: async () => [],
    listProfilesForCharacter: async () => [],
    listConfiguredRoleIdsForGuild: async () => []
  };
  const albionClient = {
    getGuild: async () => {
      throw new Error("roster unavailable");
    },
    getGuildMembers: async () => [],
    getPlayer: async () => {
      throw new Error("character unavailable");
    }
  };
  const guild = {
    id: "discord-guild-1",
    members: { fetch: async () => new Map() }
  };

  const result = await auditMembershipForGuild(
    guild as any,
    albionClient as any,
    membershipRepository as any
  );

  assert.deepEqual(result.warnings.map(({ message }) => ({ message })), [
    { message: "Roster check failed for Managed Guild: roster unavailable" },
    { message: "Character check failed for Checked Character: character unavailable" }
  ]);
});

test("registered alliance reconciliation uses guild fallback and preserves profiles when that lookup is unavailable", async () => {
  const fallback = createRegisteredAllianceFixture({ guildAllianceId: "alliance", existing: false });
  await reconcileRegisteredCharacterMembership(fallback.guild as any, fallback.albionClient as any, fallback.membershipRepository as any, "user", fallback.player, "europe");
  assert.deepEqual(fallback.mutations, ["verify", "add"]);

  const mismatch = createRegisteredAllianceFixture({ guildAllianceId: "other" });
  await reconcileRegisteredCharacterMembership(mismatch.guild as any, mismatch.albionClient as any, mismatch.membershipRepository as any, "user", mismatch.player, "europe");
  assert.deepEqual(mismatch.mutations, ["verify", "orphan"]);

  const unavailable = createRegisteredAllianceFixture({ guildLookupError: new Error("Albion unavailable") });
  const warnings = await reconcileRegisteredCharacterMembership(unavailable.guild as any, unavailable.albionClient as any, unavailable.membershipRepository as any, "user", unavailable.player, "europe");
  assert.deepEqual(unavailable.mutations, ["verify"]);
  assert.deepEqual(warnings.map(({ message }) => ({ message })), [{ message: "Alliance membership check failed for Character in Alliance: Albion unavailable" }]);
});

test("registered guild reconciliation adds profiles from blank-detail fallback evidence and preserves them when unavailable", async () => {
  const confirmed = createRegisteredGuildFixture({ roster: [{ id: "character", name: "Character" }] });
  await reconcileRegisteredCharacterMembership(confirmed.guild as any, confirmed.albionClient as any, confirmed.membershipRepository as any, "user", confirmed.player, "europe");
  assert.deepEqual(confirmed.mutations, ["verify", "add"]);

  const unavailable = createRegisteredGuildFixture({ existing: true, searchError: new Error("search unavailable"), rosterError: new Error("roster unavailable") });
  const warnings = await reconcileRegisteredCharacterMembership(unavailable.guild as any, unavailable.albionClient as any, unavailable.membershipRepository as any, "user", unavailable.player, "europe");
  assert.deepEqual(unavailable.mutations, ["verify"]);
  assert.deepEqual(warnings.map(({ message }) => ({ message })), [{ message: "Guild membership check failed for Character in Guild: search unavailable" }]);
});

function createRegisteredGuildFixture(options: { roster?: Array<{ id: string; name: string }>; existing?: boolean; searchError?: Error; rosterError?: Error }) {
  const mutations: string[] = [];
  const configured = {
    memberGroupId: "guild-group", discordGuildId: "discord-guild-1", albionServer: "europe",
    groupType: "guild", groupName: "Guild", albionGuildId: "guild", albionGuildName: "Guild", managed: false
  };
  const profile = {
    memberGroupProfileId: "profile", memberGroupId: "guild-group", discordGuildId: "discord-guild-1",
    discordUserId: "user", albionServer: "europe", albionCharacterId: "character", characterName: "Character"
  };
  return {
    player: { id: "character", name: "Character" },
    mutations,
    guild: {
      id: "discord-guild-1",
      members: {
        fetch: async () => ({
          id: "user", guild: { id: "discord-guild-1" }, nickname: null,
          roles: { cache: { has: () => false }, add: async () => undefined, remove: async () => undefined },
          setNickname: async () => undefined
        })
      }
    },
    albionClient: {
      searchCharacters: async () => {
        if (options.searchError) throw options.searchError;
        return { players: [{ id: "character", name: "Character" }], guilds: [] };
      },
      getGuildMembers: async () => {
        if (options.rosterError) throw options.rosterError;
        return options.roster ?? [];
      }
    },
    membershipRepository: {
      listMemberGroups: async () => [configured],
      listConfiguredAlbionGuilds: async () => [configured],
      listConfiguredAlbionAlliances: async () => [],
      upsertVerifiedCharacter: async () => { mutations.push("verify"); },
      listProfilesForCharacter: async () => options.existing ? [profile] : [],
      addRegisteredProfile: async () => { mutations.push("add"); return profile; },
      markMembershipDeparted: async () => { mutations.push("orphan"); return { ...profile, discordUserId: null }; },
      listConfiguredRoleIdsForGuild: async () => [],
      listDormantReactionRoleSubscriptions: async () => [],
      listQualifiedRoleIdsForUser: async () => [],
      getEffectiveNickname: async () => undefined
    }
  };
}

function createRegisteredAllianceFixture(options: { guildAllianceId?: string; guildLookupError?: Error; existing?: boolean }) {
  const mutations: string[] = [];
  const alliance = {
    memberGroupId: "alliance-group", discordGuildId: "discord-guild-1", albionServer: "europe",
    groupType: "alliance", groupName: "Alliance", albionAllianceId: "alliance", albionAllianceName: "Alliance"
  };
  const player = { id: "character", name: "Character", guildId: "guild" };
  const existingProfile = {
    memberGroupProfileId: "profile", memberGroupId: "alliance-group", discordGuildId: "discord-guild-1",
    discordUserId: "user", albionServer: "europe", albionCharacterId: "character", characterName: "Character"
  };
  return {
    player,
    mutations,
    guild: {
      id: "discord-guild-1",
      members: {
        fetch: async () => ({
          id: "user", guild: { id: "discord-guild-1" }, nickname: null,
          roles: { cache: { has: () => false }, add: async () => undefined, remove: async () => undefined },
          setNickname: async () => undefined
        })
      }
    },
    albionClient: {
      getGuild: async () => {
        if (options.guildLookupError) throw options.guildLookupError;
        return { id: "guild", name: "Guild", allianceId: options.guildAllianceId };
      }
    },
    membershipRepository: {
      listMemberGroups: async () => [alliance],
      listConfiguredAlbionGuilds: async () => [],
      listConfiguredAlbionAlliances: async () => [alliance],
      upsertVerifiedCharacter: async () => { mutations.push("verify"); },
      listProfilesForCharacter: async () => options.existing === false ? [] : [existingProfile],
      addRegisteredProfile: async () => { mutations.push("add"); return existingProfile; },
      markMembershipDeparted: async () => { mutations.push("orphan"); return { ...existingProfile, discordUserId: null }; },
      listConfiguredRoleIdsForGuild: async () => [],
      listDormantReactionRoleSubscriptions: async () => [],
      listQualifiedRoleIdsForUser: async () => [],
      getEffectiveNickname: async () => undefined
    }
  };
}

const expectedProfileOutcomes = [
  {
    kind: "profile",
    action: "add",
    characterName: "Added",
    discordUserId: "user-add",
    previousDiscordUserId: undefined,
    groupName: "Managed Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "record",
    characterName: "Recorded",
    discordUserId: undefined,
    previousDiscordUserId: undefined,
    groupName: "Managed Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "reassign",
    characterName: "Reassigned",
    discordUserId: "user-new",
    previousDiscordUserId: "user-old",
    groupName: "Managed Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "reassign",
    characterName: "Claimed",
    discordUserId: "user-claim",
    previousDiscordUserId: null,
    groupName: "Managed Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile",
    action: "depart",
    characterName: "Removed",
    discordUserId: "user-remove",
    previousDiscordUserId: undefined,
    groupName: "Managed Guild",
    albionServerLabel: "Europe"
  },
  {
    kind: "profile", action: "depart", characterName: "Already Orphaned", discordUserId: null,
    previousDiscordUserId: undefined, groupName: "Managed Guild", albionServerLabel: "Europe"
  }
] as const;

function createManagedRosterFixture(unconfirmedCharacterId?: string) {
  const mutations: string[] = [];
  const nicknameMutations: Array<string | null> = [];
  const roleMutations: string[] = [];
  let reactionLookups = 0;
  const configuredGuild = {
    memberGroupId: "group-1",
    discordGuildId: "discord-guild-1",
    albionServer: "europe",
    groupType: "guild",
    groupName: "Managed Guild",
    albionGuildId: "albion-guild-1",
    albionGuildName: "Managed Guild",
    managed: true
  };
  const roster = [
    rosterMember("character-add", "Added"),
    rosterMember("character-record", "Recorded"),
    rosterMember("character-reassign", "Reassigned"),
    rosterMember("character-claim", "Claimed"),
    rosterMember("character-existing", "Existing")
  ];
  const existingProfiles = [
    profile("character-reassign", "user-old", "Reassigned"),
    profile("character-claim", null, "Claimed"),
    profile("character-existing", "user-existing", "Existing"),
    profile("character-remove", "user-remove", "Removed"),
    profile("character-orphan-noop", null, "Already Orphaned")
  ];
  const registeredUsers = new Map([
    ["character-add", "user-add"],
    ["character-reassign", "user-new"],
    ["character-claim", "user-claim"],
    ["character-existing", "user-existing"]
  ]);
  const discordUserIds = [
    "user-add",
    "user-new",
    "user-old",
    "user-claim",
    "user-existing",
    "user-remove"
  ];
  const members = new Map(discordUserIds.map((discordUserId) => [
    discordUserId,
    {
      id: discordUserId,
      nickname: null,
      guild: { id: "discord-guild-1" },
      setNickname: async (nickname: string | null) => {
        nicknameMutations.push(nickname);
      },
      roles: {
        cache: { has: () => false },
        add: async (roleId: string) => {
          roleMutations.push(`add:${roleId}`);
        },
        remove: async (roleId: string) => {
          roleMutations.push(`remove:${roleId}`);
        }
      }
    }
  ]));

  const guild = {
    id: "discord-guild-1",
    members: {
      fetch: async (discordUserId?: string) => discordUserId
        ? members.get(discordUserId)
        : members
    }
  };
  const albionClient = {
    getGuild: async () => ({
      id: "albion-guild-1",
      name: "Managed Guild"
    }),
    getGuildMembers: async () => roster,
    getPlayer: async (_server: string, id: string) => ({ id, name: existingProfiles.find(profile => profile.albionCharacterId === id)?.characterName ?? id }),
    searchCharacters: async (_server: string, name: string) => ({ players: existingProfiles.filter(profile => profile.characterName === name).map(profile => ({ id: profile.albionCharacterId, name })) })
  };
  const membershipRepository = {
    listMemberGroups: async () => [configuredGuild],
    listConfiguredAlbionGuilds: async () => [configuredGuild],
    listConfiguredAlbionAlliances: async () => [],
    listRegisteredUserIdsForGuild: async () => [],
    listActiveProfileUserIdsForGroups: async () => [],
    listProfilesForGroups: async () => existingProfiles,
    getRegisteredCharacter: async (
      _discordGuildId: string,
      _server: string,
      characterId: string
    ) => {
      const discordUserId = registeredUsers.get(characterId);
      return discordUserId
        ? {
          discordGuildId: "discord-guild-1",
          discordUserId,
          albionServer: "europe",
          albionCharacterId: characterId,
          characterName: roster.find((member) => member.id === characterId)?.name
        }
        : undefined;
    },
    upsertVerifiedCharacter: async (_server: string, player: { id: string }) => {
      mutations.push(`verify:${player.id}`);
    },
    addRegisteredProfile: async (input: {
      discordUserId: string;
      albionCharacterId: string;
    }) => {
      mutations.push(`register:${input.albionCharacterId}:${input.discordUserId}`);
      if (input.albionCharacterId === unconfirmedCharacterId) return undefined;
      return profile(input.albionCharacterId, input.discordUserId);
    },
    addOrphanProfile: async (input: { albionCharacterId: string }) => {
      mutations.push(`orphan:${input.albionCharacterId}`);
      return { ...profile(input.albionCharacterId, null), entitlementPreserved: false, lifecycleState: "unregistered" };
    },
    markMembershipDeparted: async (input: {
      discordUserId: string;
      albionCharacterId: string;
    }) => {
      mutations.push(`remove:${input.albionCharacterId}:${existingProfiles.find(profile => profile.albionCharacterId === input.albionCharacterId)?.discordUserId}`);
      return profile(input.albionCharacterId, null);
    },
    getEffectiveNickname: async () => undefined,
    listConfiguredRoleIdsForGuild: async () => [],
    listDormantReactionRoleSubscriptions: async () => {
      reactionLookups += 1;
      return [];
    }
  };

  return {
    guild,
    albionClient,
    membershipRepository,
    mutations,
    nicknameMutations,
    roleMutations,
    get reactionLookups() {
      return reactionLookups;
    }
  };
}

function rosterMember(id: string, name: string) {
  return {
    id,
    name,
    guildId: "albion-guild-1",
    guildName: "Managed Guild"
  };
}

function profile(
  albionCharacterId: string,
  discordUserId: string | null,
  characterName?: string
) {
  return {
    memberGroupProfileId: `profile-${albionCharacterId}`,
    memberGroupId: "group-1",
    discordGuildId: "discord-guild-1",
    discordUserId,
    albionServer: "europe",
    albionCharacterId,
    characterName, lifecycleState: discordUserId ? "current" : "manual", entitlementPreserved: true, lifecycleRevision: 1
  };
}

test("audit distinguishes a new departure from an observation prune and update uses the committed deadline", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(row => ({ ...row,
    entitlementPreserved: row.albionCharacterId !== "character-orphan-noop" }));
  const deadline = new Date("2030-01-04T00:00:00Z");
  f.membershipRepository.markMembershipDeparted = async (input: any) => ({ ...input,
    entitlementPreserved: input.albionCharacterId !== "character-orphan-noop",
    departureExpiresAt: input.albionCharacterId === "character-orphan-noop" ? undefined : deadline });
  const audit = await auditMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  const planned = audit.outcomes.filter(outcome => outcome.kind === "profile" && ["depart", "prune"].includes(outcome.action));
  assert.deepEqual(planned.map(outcome => outcome.action), ["depart", "prune"]);
  assert.equal(planned.some(outcome => "departureExpiresAt" in outcome), false);
  const update = await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  const applied = update.outcomes.find(outcome => outcome.kind === "profile" && outcome.action === "depart");
  assert.equal(applied && "departureExpiresAt" in applied ? applied.departureExpiresAt : undefined, deadline);
});

test("already-departed membership reports its existing deadline without a new mutation", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  const deadline = new Date("2030-01-04T00:00:00Z");
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(row => row.albionCharacterId === "character-remove"
    ? { ...row, lifecycleState: "departed", departureExpiresAt: deadline } : row);
  const result = await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(f.mutations.some(mutation => mutation.startsWith("remove:character-remove:")), false);
  assert.ok(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "waiting" && outcome.departureExpiresAt === deadline));
});

test("stale departure writes do not claim a started grace period", async () => {
  const f = createManagedRosterFixture();
  (f.membershipRepository as any).markMembershipDeparted = async () => undefined;
  const result = await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.equal(result.outcomes.some(outcome => outcome.kind === "profile" && ["depart", "prune"].includes(outcome.action)), false);
});

test("grace logs use committed deadlines and exclude previews, prunes, waiting rows and stale writes", async () => {
  for (const scenario of ["started", "waiting", "stale", "failed"] as const) {
    const f = createManagedRosterFixture();
    const deadline = new Date("2030-01-04T00:00:00Z");
    const registrationDeadline = new Date("2030-01-03T12:00:00Z");
    const list = f.membershipRepository.listProfilesForGroups;
    f.membershipRepository.listProfilesForGroups = async () => (await list()).map(row => ({ ...row,
      groupName: "Managed Guild", entitlementPreserved: row.albionCharacterId !== "character-orphan-noop",
      ...(scenario === "waiting" && row.albionCharacterId === "character-remove"
        ? { lifecycleState: "departed", departureExpiresAt: deadline } : {})
    }));
    (f.membershipRepository as any).markMembershipDeparted = async (input: any) => {
      if (scenario === "stale") return undefined;
      if (scenario === "failed") throw new Error("write failed");
      return { ...input, departureExpiresAt: input.entitlementPreserved ? deadline : undefined,
        registrationExpiresAt: registrationDeadline };
    };
    await withLogChanges(f.guild.id, async changes => {
      await auditMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
      assert.deepEqual(changes, []);
      const update = reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
      if (scenario === "failed") await assert.rejects(update, /write failed/);
      else await update;
      const graceLines = formatLogChanges(changes).filter(line => line.includes("grace period"));
      assert.deepEqual(graceLines, scenario === "started" ? [
        `Removed • Europe started a 72-hour membership grace period in Managed Guild. Deadline: <t:${deadline.getTime() / 1000}:F>. Discord registration recovery deadline: <t:${registrationDeadline.getTime() / 1000}:F>.`
      ] : [], scenario);
    });
  }
});

test("all failed membership scopes retain warning identities and never become departure evidence", async () => {
  const f = createManagedRosterFixture();
  const managed = (await f.membershipRepository.listMemberGroups())[0];
  const checked = { ...managed, memberGroupId: "checked", groupName: "Checked Guild", albionGuildName: "Checked Guild", albionGuildId: "other", managed: false };
  f.membershipRepository.listMemberGroups = async () => [managed, checked];
  f.membershipRepository.listConfiguredAlbionGuilds = async () => [managed, checked];
  const repository = f.membershipRepository as any;
  const existing = await repository.listProfilesForGroups();
  repository.listProfilesForGroups = async (_guild: string, groups: string[]) => groups.includes("group-1") ? existing :
    [ { ...existing.find((row: any) => row.albionCharacterId === "character-orphan-noop"), memberGroupId: "checked" } ];
  repository.listRegisteredCharacters = async () => [{ discordGuildId: f.guild.id, discordUserId: "user-remove", albionServer: "europe", albionCharacterId: "character-remove", characterName: "Removed" }];
  repository.listProfilesForCharacter = async () => [];
  const requests: string[] = [];
  f.albionClient.getPlayer = async (_server: string, id: string) => {
    requests.push(id);
    throw Object.assign(new Error("retry deferred"), { kind: "rate_limited" });
  };
  const result = await auditMembershipForGuild(f.guild as any, f.albionClient as any, repository);
  assert.deepEqual(requests.sort(), ["character-orphan-noop", "character-orphan-noop", "character-remove", "character-remove"]);
  assert.equal(result.warnings.length, 4);
  assert.equal(result.warnings.every(warning => warning.checkFailure?.reason === "Albion Online API rate limit (HTTP 429)"), true);
  assert.equal(result.outcomes.some(outcome => outcome.kind === "profile" && ["depart", "prune"].includes(outcome.action)), false);
  assert.deepEqual(f.mutations, []);
});

test("a later phase fetches fresh character evidence after a newer profile snapshot", async () => {
  const f = createManagedRosterFixture();
  const managed = (await f.membershipRepository.listMemberGroups())[0];
  const checked = { ...managed, memberGroupId: "checked", groupName: "Checked Guild", albionGuildName: "Checked Guild", albionGuildId: "other", managed: false };
  f.membershipRepository.listMemberGroups = async () => [managed, checked];
  f.membershipRepository.listConfiguredAlbionGuilds = async () => [managed, checked];
  const repository = f.membershipRepository as any;
  const existing = await repository.listProfilesForGroups();
  repository.listProfilesForGroups = async (_guild: string, groups: string[]) => groups.includes("group-1") ? existing : [];
  repository.listRegisteredCharacters = async () => [{ discordGuildId: f.guild.id, discordUserId: "user-remove", albionServer: "europe", albionCharacterId: "character-remove", characterName: "Removed" }];
  let newSnapshot = false, calls = 0;
  repository.listProfilesForCharacter = async () => {
    newSnapshot = true;
    return [{ ...existing.find((row: any) => row.albionCharacterId === "character-remove"), memberGroupId: "checked", lifecycleRevision: 2 }];
  };
  f.albionClient.getPlayer = async (_server: string, id: string) => {
    if (id !== "character-remove") return { id, name: "Other" };
    calls++;
    return { id, name: "Removed", guildId: newSnapshot ? "other" : "old-guild" };
  };
  const result = await auditMembershipForGuild(f.guild as any, f.albionClient as any, repository);
  assert.equal(calls, 2);
  assert.equal(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "depart" && outcome.groupName === "Checked Guild"), false);
});

test("managed roster positives replace registered alliance player requests by exact character ID", async () => {
  for (const mode of ["audit", "update"] as const) {
    const f = createManagedRosterFixture();
    const repository = f.membershipRepository as any;
    const alliance = {
      memberGroupId: "alliance-group", discordGuildId: f.guild.id, albionServer: "europe",
      groupType: "alliance", groupName: "Alliance", albionAllianceId: "alliance-1",
      albionAllianceName: "Alliance"
    };
    const managed = (await f.membershipRepository.listMemberGroups())[0];
    repository.listMemberGroups = async () => [managed, alliance];
    repository.listConfiguredAlbionAlliances = async () => [alliance];
    repository.listRegisteredCharacters = async () => [
      ...["character-add", "character-reassign", "character-existing"].map(id => ({
        discordGuildId: f.guild.id, discordUserId: "user-add", albionServer: "europe",
        albionCharacterId: id, characterName: id
      })),
      { discordGuildId: f.guild.id, discordUserId: "user-add", albionServer: "europe",
        albionCharacterId: "absent", characterName: "Added" }
    ];
    repository.listProfilesForCharacter = async () => [];
    const listProfiles = f.membershipRepository.listProfilesForGroups;
    repository.listProfilesForGroups = async (_guild: string, groups: string[]) =>
      groups.includes("group-1") ? listProfiles() : [];
    f.albionClient.getGuild = async () => ({ id: "albion-guild-1", name: "Managed Guild", allianceId: "alliance-1" });
    const playerRequests: string[] = [];
    const getPlayer = f.albionClient.getPlayer;
    f.albionClient.getPlayer = async (server: string, id: string) => {
      playerRequests.push(id);
      return id === "absent" ? { id, name: "Absent", allianceId: "alliance-1" } : getPlayer(server, id);
    };

    const result = mode === "audit"
      ? await auditMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any)
      : await reconcileMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
    assert.deepEqual(playerRequests.filter(id => ["character-add", "character-reassign", "character-existing", "absent"].includes(id)), ["absent"], mode);
    assert.equal(result.outcomes.filter(outcome => outcome.kind === "profile"
      && outcome.groupName === "Alliance" && outcome.action === "add").length, 4, mode);
  }
});

test("incomplete or conflicting managed roster evidence falls back to individual character evidence", async () => {
  for (const evidence of ["incomplete alliance", "conflicting guild"] as const) {
    const f = createManagedRosterFixture();
    const repository = f.membershipRepository as any;
    const managed = (await f.membershipRepository.listMemberGroups())[0];
    const alliance = {
      memberGroupId: "alliance-group", discordGuildId: f.guild.id, albionServer: "europe",
      groupType: "alliance", groupName: "Alliance", albionAllianceId: "alliance-1",
      albionAllianceName: "Alliance"
    };
    repository.listMemberGroups = async () => [managed, alliance];
    repository.listConfiguredAlbionAlliances = async () => [alliance];
    repository.listRegisteredCharacters = async () => [{
      discordGuildId: f.guild.id, discordUserId: "user-add", albionServer: "europe",
      albionCharacterId: "character-add", characterName: "Added"
    }];
    repository.listProfilesForCharacter = async () => [];
    const listProfiles = f.membershipRepository.listProfilesForGroups;
    repository.listProfilesForGroups = async (_guild: string, groups: string[]) =>
      groups.includes("group-1") ? listProfiles() : [];
    if (evidence === "conflicting guild") {
      f.albionClient.getGuild = async () => ({ id: "albion-guild-1", name: "Managed Guild", allianceId: "alliance-1" });
    }
    const getGuildMembers = f.albionClient.getGuildMembers;
    f.albionClient.getGuildMembers = async () => (await getGuildMembers()).map(member => ({ ...member,
      allianceId: "alliance-1",
      ...(evidence === "conflicting guild" && member.id === "character-add" ? { guildId: "other-guild" } : {})
    }));
    const getPlayer = f.albionClient.getPlayer;
    const requests: string[] = [];
    f.albionClient.getPlayer = async (server: string, id: string) => {
      requests.push(id);
      return id === "character-add" ? { id, name: "Added", allianceId: "alliance-1" } : getPlayer(server, id);
    };
    await auditMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
    assert.equal(requests.filter(id => id === "character-add").length, 1);
  }
});

test("an existing selected profile requires fresh character evidence after its snapshot", async () => {
  const f = createManagedRosterFixture();
  const repository = f.membershipRepository as any;
  const managed = (await f.membershipRepository.listMemberGroups())[0];
  const alliance = {
    memberGroupId: "alliance-group", discordGuildId: f.guild.id, albionServer: "europe",
    groupType: "alliance", groupName: "Alliance", albionAllianceId: "alliance-1",
    albionAllianceName: "Alliance"
  };
  repository.listMemberGroups = async () => [managed, alliance];
  repository.listConfiguredAlbionAlliances = async () => [alliance];
  repository.listRegisteredCharacters = async () => [{
    discordGuildId: f.guild.id, discordUserId: "user-add", albionServer: "europe",
    albionCharacterId: "character-add", characterName: "Added"
  }];
  repository.listProfilesForCharacter = async () => [{
    ...profile("character-add", "user-add", "Added"), memberGroupId: "alliance-group", lifecycleRevision: 2
  }];
  const listProfiles = f.membershipRepository.listProfilesForGroups;
  repository.listProfilesForGroups = async (_guild: string, groups: string[]) =>
    groups.includes("group-1") ? listProfiles() : [];
  f.albionClient.getGuild = async () => ({ id: "albion-guild-1", name: "Managed Guild", allianceId: "alliance-1" });
  const getPlayer = f.albionClient.getPlayer;
  const requests: string[] = [];
  f.albionClient.getPlayer = async (server: string, id: string) => {
    requests.push(id);
    return id === "character-add" ? { id, name: "Added", allianceId: "alliance-1" } : getPlayer(server, id);
  };
  const result = await auditMembershipForGuild(f.guild as any, f.albionClient as any, repository);
  assert.equal(requests.filter(id => id === "character-add").length, 1);
  assert.equal(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "depart" && outcome.groupName === "Alliance"), false);
});

test("managed fallback verification reports an existing registration hold consistently", async () => {
  const f = createManagedRosterFixture();
  const list = f.membershipRepository.listProfilesForGroups;
  const deadline = new Date("2030-01-04T00:00:00Z");
  f.membershipRepository.listProfilesForGroups = async () => (await list()).map(row => row.albionCharacterId === "character-orphan-noop"
    ? { ...row, registrationState: "hold", registrationExpiresAt: deadline } : row);
  f.albionClient.getPlayer = async (_server: string, id: string) => ({ id, name: "Ownerless", guildId: "albion-guild-1" });
  const result = await auditMembershipForGuild(f.guild as any, f.albionClient as any, f.membershipRepository as any);
  assert.ok(result.outcomes.some(outcome => outcome.kind === "profile" && outcome.action === "waiting" && outcome.registrationExpiresAt === deadline));
  assert.deepEqual(f.mutations, []);
});
