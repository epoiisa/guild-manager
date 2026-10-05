import assert from "node:assert/strict";
import test from "node:test";
import { Collection, type ChatInputCommandInteraction } from "discord.js";
import { CharacterRecoveryRequiredError, MembershipLifecycleConflictError, MembershipRecoveryVerificationUnavailableError, type RegisterCharacterInput } from "../db/membershipRepository.js";
import { messageTexts } from "../testSupport/messageAssertions.js";
import { handleCharacterCommand } from "./character.js";
import { handleRegisterCommand } from "./register.js";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

function fixture(options: { absent?: boolean; leaveDuringVerification?: boolean; recoveryError?: Error; lifecycle?: "hold" | "abandoned"; selfRace?: boolean; wrongPlayer?: boolean; kicked?: boolean; cleanupPending?: boolean; administrator?: boolean; characterGuarded?: boolean; pastKick?: boolean; roleFetchFailure?: boolean; commandPermissionFailure?: boolean } = {}) {
  const replies: unknown[] = [], evidence: RegisterCharacterInput[] = [];
  const checks: string[] = [];
  let verified = false, recovered = false;
  const character = { id: "character", name: "Character", guildId: "in-game" };
  const group = { memberGroupId: "guild-group", discordGuildId: "discord", albionServer: "asia", groupType: "guild", groupName: "Members", albionGuildId: "in-game", albionGuildName: "Members", managed: false };
  const member = { id: "member", guild: { id: "discord" }, nickname: null,
    permissions: new PermissionsBitField(options.administrator ? PermissionFlagsBits.Administrator : 0n),
    roles: { cache: new Collection(), add: async () => undefined, remove: async () => undefined }, setNickname: async () => undefined };
  const allRoles = new Collection<string, any>([["new-admin", { id: "new-admin", permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }], ["new-command-officer", { id: "new-command-officer", permissions: new PermissionsBitField() }]]);
  const permissions = new Collection<string, any[]>();
  const commands = new Collection<string, any>();
  const guild = { id: "discord", roles: { fetch: async () => { checks.push("roles"); if (options.roleFetchFailure) throw Error("roles unavailable"); return allRoles; } }, client: { application: { id: "bot" }, user: { id: "bot" } },
    commands: { fetch: async () => commands, permissions: { fetch: async () => { if (options.commandPermissionFailure) throw Error("permissions unavailable"); return permissions; } } },
    members: { fetch: async () => {
    if (options.absent || (options.leaveDuringVerification && verified)) throw { code: 10007 };
    return member;
  } } };
  const interaction = { guildId: "discord", guild, inGuild: () => true, user: { id: "officer" },
    options: { getSubcommandGroup: () => null, getSubcommand: () => "register", getUser: () => ({ id: "member", username: "Member" }), getString: (name: string) => name === "server" ? "asia" : "Character" },
    deferReply: async () => undefined, editReply: async (payload: unknown) => { replies.push(payload); },
    followUp: async (payload: unknown) => { replies.push(payload); }, reply: async (payload: unknown) => { replies.push(payload); }
  } as unknown as ChatInputCommandInteraction;
  const profile = { memberGroupId: "custom-group", memberGroupProfileId: "different-profile-id", discordGuildId: "discord", albionServer: "asia", albionCharacterId: "character", groupType: "group", lifecycleState: "current", lifecycleRevision: 19 };
  const repository = {
    getMemberAccess: async () => options.kicked ? { blocked: true, cleanupPending: options.cleanupPending ?? false, revokedRoleIds: ["manager"], revision: 8 } : undefined,
    listKickAuthorityRoleIds: async () => ["manager"],
    getKickRecoverySnapshot: async () => ({ expectedMemberAccessRevision: options.kicked ? 8 : null, expectedCharacterKickRevision: options.kicked || options.characterGuarded || options.pastKick ? 9 : null, characterKickRecoveryRequired: options.characterGuarded ?? options.kicked ?? false }),
    getRegisteredCharacter: async () => undefined,
    getCharacterRegistrationLifecycle: async () => { checks.push("lifecycle"); return options.selfRace || recovered ? undefined : { state: options.lifecycle ?? "hold", revision: 7 }; },
    hasOrphanProfilesForCharacter: async () => false,
    listProfilesForCharacter: async () => { checks.push("profiles"); return [profile]; },
    listConfiguredAlbionGuilds: async () => { verified = true; return recovered ? [] : [group]; },
    listConfiguredAlbionAlliances: async () => [], listMemberGroups: async () => [],
    registerCharacterAndAdoptOrphans: async (input: RegisterCharacterInput) => {
      evidence.push(input);
      if (options.recoveryError) throw options.recoveryError;
      recovered = true;
      return { discordGuildId: "discord", discordUserId: "member", albionServer: "asia", albionCharacterId: character.id, characterName: character.name };
    },
    registerCharacter: async () => { throw new CharacterRecoveryRequiredError(); },
    upsertVerifiedCharacter: async () => undefined,
    listDormantReactionRoleSubscriptions: async () => [], listConfiguredRoleIdsForGuild: async () => [], listQualifiedRoleIdsForUser: async () => [], getEffectiveNickname: async () => undefined
  } as unknown as Parameters<typeof handleCharacterCommand>[2];
  const client = { searchCharacters: async () => ({ players: [character], guilds: [] }), getPlayer: async () => { checks.push("player"); return options.wrongPlayer ? { ...character, id: "wrong" } : character; } } as unknown as Parameters<typeof handleCharacterCommand>[1];
  return { replies, evidence, checks, interaction, repository, client, allRoles, member, commands, permissions,
    run: () => handleCharacterCommand(interaction, client, repository),
    text: () => replies.flatMap(reply => messageTexts(reply as never)).join("\n") };
}

test("officer recovery sends verified memberships and pre-verification revisions to one guarded transaction", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.evidence[0].recovery, {
    expectedMemberAccessRevision: null, expectedCharacterKickRevision: null,
    expectedRegistrationRevision: 7, expectedProfileRevisions: { "custom-group": 19 },
    verifiedMemberGroupIds: ["guild-group"], unavailableMemberGroupIds: []
  });
  assert.match(f.text(), /was registered/);
  assert.deepEqual(f.checks, ["lifecycle", "profiles", "player"]);
});

test("officer reconnection waits for kick cleanup and refuses surviving Administrator authority", async () => {
  for (const options of [{ kicked: true, cleanupPending: true }, { kicked: true, administrator: true }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.evidence.length, 0);
    assert.match(f.text(), /remains blocked/);
  }
  const recovered = fixture({ kicked: true }); await recovered.run();
  assert.equal(recovered.evidence[0].recovery?.expectedMemberAccessRevision, 8);
  assert.equal(recovered.evidence[0].recovery?.expectedCharacterKickRevision, 9);
});

test("officer recovery rejects absent targets and departures during verification without writing ownership", async () => {
  for (const options of [{ absent: true }, { leaveDuringVerification: true }]) {
    const f = fixture(options); await f.run();
    assert.equal(f.evidence.length, 0);
    assert.match(f.text(), /must be in this Discord server|left this Discord server/);
  }
});

test("officer recovery refuses mismatched player endpoint evidence without changing registration", async () => {
  const f = fixture({ wrongPlayer: true }); await f.run();
  assert.equal(f.evidence.length, 0);
  assert.match(f.text(), /could not be verified/);
});

test("officer recovery reports stale or unavailable evidence without a success receipt", async () => {
  for (const [recoveryError, expected] of [
    [new MembershipLifecycleConflictError(), /membership changed during verification/],
    [new MembershipRecoveryVerificationUnavailableError(), /could not be verified/]
  ] as const) {
    const f = fixture({ recoveryError }); await f.run();
    assert.match(f.text(), expected);
    assert.doesNotMatch(f.text(), /was registered/);
  }
});

test("self registration cannot recover either saved state or a departure that raced its initial check", async () => {
  for (const options of [{ lifecycle: "hold" as const }, { lifecycle: "abandoned" as const }, { selfRace: true }]) {
    const f = fixture(options);
    await handleRegisterCommand(f.interaction, f.client, f.repository);
    assert.match(f.text(), /character register/);
    assert.equal(f.evidence.length, 0);
  }
});


test("kick recovery snapshots newly configured administrative roles before ordinary roles can be restored", async () => {
  for (const options of [{ kicked: true }, { characterGuarded: true }]) {
    const f = fixture(options);
    f.commands.set("message-command", { id: "message-command", name: "message", type: 1 });
    f.permissions.set("message-command", [{ type: 1, id: "new-command-officer", permission: true }]);
    await f.run();
    assert.deepEqual(new Set(f.evidence[0].recovery?.kickAuthorityRoleIds), new Set(["manager", "new-admin", "new-command-officer"]));
  }
});

test("unavailable current authority snapshots stop both former and replacement owner recovery", async () => {
  for (const guard of [{ kicked: true }, { characterGuarded: true }]) for (const failure of [{ roleFetchFailure: true }, { commandPermissionFailure: true }]) {
    const f = fixture({ ...guard, ...failure }); await f.run();
    assert.equal(f.evidence.length, 0); assert.match(f.text(), /permissions could not be checked/);
  }
});

test("an unblocked replacement owner keeps independently existing native or direct command authority", async () => {
  const f = fixture({ characterGuarded: true, administrator: true });
  f.commands.set("message-command", { id: "message-command", name: "message", type: 1 });
  f.permissions.set("message-command", [{ type: 2, id: "member", permission: true }]);
  await f.run(); assert.equal(f.evidence.length, 1);
  assert.ok(f.evidence[0].recovery?.kickAuthorityRoleIds?.includes("new-admin"));
});

test("ordinary registration and already resolved character guards do not invoke kick authority checks", async () => {
  for (const pastKick of [false, true]) {
    const f = fixture({ pastKick, roleFetchFailure: true, commandPermissionFailure: true });
    await f.run(); assert.equal(f.evidence.length, 1);
    assert.equal(f.evidence[0].recovery?.kickAuthorityRoleIds, undefined);
    assert.ok(!f.checks.includes("roles"));
  }
});

test("blocked users cannot recover with a fresh direct administrative command grant", async () => {
  const f = fixture({ kicked: true });
  f.commands.set("message-command", { id: "message-command", name: "message", type: 1 });
  f.permissions.set("message-command", [{ type: 2, id: "member", permission: true }]);
  await f.run(); assert.equal(f.evidence.length, 0); assert.match(f.text(), /administrative command grants/);
});
