import assert from "node:assert/strict";
import test from "node:test";
import type { MemberGroupRemovalResult } from "../../db/membershipRepository.js";
import { recordLogChange, type LogChange } from "./events.js";
import { formatLogChanges } from "./formatting.js";
import { createLogFeedRuntime } from "./runtime.js";

const character = { discordGuildId: "guild", discordUserId: "member", albionServer: "asia" as const, albionCharacterId: "character", characterName: "melony69" };
const profile = { ...character, memberGroupProfileId: "profile", memberGroupId: "group", groupName: "Friends", groupType: "group" as const };
const registration: LogChange = { kind: "registration", action: "registered", character };
const joined: LogChange = { kind: "profile", action: "joined", profile };
const addedRole: LogChange = { kind: "role", action: "add", discordUserId: "member", roleId: "friends" };
const actor = { actorDiscordUserId: "officer" };

function fixture() {
  const sent: Array<{ lines: readonly string[]; options?: { channelId?: string } }> = [];
  const guild: any = { id: "guild" };
  const repository: any = { get: async () => ({ discordGuildId: "guild", discordChannelId: "old-channel" }) };
  const delivery: any = { send: async (_guild: unknown, lines: readonly string[], options?: { channelId?: string }) => {
    sent.push({ lines, options });
    return "sent";
  } };
  const runtime = createLogFeedRuntime(repository, delivery, { warn() {} } as any);
  const interaction: any = {
    guild, guildId: guild.id, user: { id: "officer" },
    isRepliable: () => true, isChatInputCommand: () => true,
    commandName: "member", options: { getSubcommand: () => "add", getUser: () => ({ id: "member" }) }
  };
  return { runtime, sent, guild, interaction };
}

test("officer membership command leaves attribute role-only changes to the invoking officer", async () => {
  for (const [commandName, subcommand] of [
    ["character", "register"], ["character", "unregister"], ["character", "switch"],
    ["member", "add"], ["member", "remove"], ["application", "accept"], ["application", "verify"]
  ]) {
    const f = fixture();
    f.interaction.commandName = commandName;
    f.interaction.options.getSubcommand = () => subcommand;
    await f.runtime.interaction(f.interaction, async () => { recordLogChange("guild", addedRole); });
    assert.deepEqual(f.sent.map(entry => entry.lines), [["<@officer> updated roles for <@member>. <@&friends> added."]], `${commandName} ${subcommand}`);
  }
});

test("officer selectors and group-removal confirmations retain the current actor", async () => {
  for (const customId of [
    "cs:select:officer:nonce", "albion-character:character-register:member:asia",
    "member-group-delete:group:officer:123:confirm", "member-group-remove:guild:officer:123:confirm"
  ]) {
    const f = fixture();
    f.interaction.isChatInputCommand = () => false;
    f.interaction.customId = customId;
    await f.runtime.interaction(f.interaction, async () => { recordLogChange("guild", joined); recordLogChange("guild", addedRole); });
    assert.deepEqual(f.sent.map(entry => entry.lines), [["<@officer> added melony69 to Friends • group • Asia. <@&friends> added."]], customId);
  }
});

test("application acceptance waiting for membership stays silent and later verification names the completing reviewer", async () => {
  const f = fixture();
  f.interaction.isChatInputCommand = () => false;
  f.interaction.customId = "app:accept:application";
  f.interaction.user.id = "first-reviewer";
  await f.runtime.interaction(f.interaction, async () => undefined);
  assert.equal(f.sent.length, 0);
  f.interaction.customId = "app:verify:application";
  f.interaction.user.id = "completing-reviewer";
  await f.runtime.interaction(f.interaction, async () => {
    recordLogChange("guild", registration);
    recordLogChange("guild", joined);
  });
  assert.deepEqual(f.sent.map(entry => entry.lines), [[
    "<@completing-reviewer> registered melony69 to <@member> • Asia. <@completing-reviewer> added melony69 to Friends • group • Asia."
  ]]);
});

test("self-service commands and their character selector retain the actorless wording", async () => {
  for (const commandName of ["register", "unregister", "selector"]) {
    const f = fixture();
    f.interaction.commandName = commandName;
    if (commandName === "selector") {
      f.interaction.isChatInputCommand = () => false;
      f.interaction.customId = "albion-character:register:member:asia";
    }
    const change: LogChange = { ...registration, action: commandName === "unregister" ? "unregistered" : "registered" };
    await f.runtime.interaction(f.interaction, async () => { recordLogChange("guild", change); });
    assert.deepEqual(f.sent.map(entry => entry.lines), [[commandName === "unregister"
      ? "melony69 unregistered from <@member> • Asia."
      : "melony69 registered to <@member> • Asia."]], commandName);
  }
});

test("officer registration combines loss, role removals, joins and role additions without duplicate outcomes", () => {
  const unregistered: LogChange = { ...registration, action: "unregistered" };
  const orphaned: LogChange = { kind: "profile", action: "orphaned", profile: { ...profile, memberGroupProfileId: "old-profile", groupName: "Old Friends" } };
  const removedRole: LogChange = { kind: "role", action: "remove", discordUserId: "member", roleId: "old-friends" };
  assert.deepEqual(formatLogChanges([unregistered, unregistered, orphaned, orphaned, removedRole, removedRole, registration, joined, joined, addedRole, addedRole], actor), [
    "<@officer> unregistered melony69 from <@member> • Asia. <@officer> registered melony69 to <@member> • Asia. melony69 orphaned in Old Friends • group • Asia. <@&old-friends> removed. <@officer> added melony69 to Friends • group • Asia. <@&friends> added."
  ]);
});

test("explicit membership removals name the officer even for ownerless profiles", () => {
  for (const action of ["left", "removed"] as const) {
    for (const discordUserId of ["member", undefined]) {
      assert.deepEqual(formatLogChanges([{ kind: "profile", action, profile: { ...profile, discordUserId } }], actor), [
        "<@officer> removed melony69 from Friends • group • Asia."
      ]);
    }
  }
});

test("switch and recovery retain their factual consequences with actor attribution", () => {
  assert.deepEqual(formatLogChanges([{ kind: "switch", from: character, to: { ...character, characterName: "**New**\nCharacter" } }, addedRole], actor), [
    "<@officer> switched melony69 to \\*\\*New\\*\\* Character for <@member> • Asia. <@&friends> added."
  ]);
  const restored: LogChange = { kind: "membershipLifecycle", action: "restored", characterName: character.characterName, albionServer: "asia", discordUserId: "member" };
  assert.deepEqual(formatLogChanges([restored, restored], actor), ["<@officer> restored membership for melony69 • Asia for <@member>."]);
  assert.deepEqual(formatLogChanges([restored]), ["melony69 • Asia membership restored for <@member>."]);
});

test("kick uses the officer as actor and the selected member as the target", async () => {
  const f = fixture();
  f.interaction.commandName = "kick";
  await f.runtime.interaction(f.interaction, async () => {
    recordLogChange("guild", { kind: "memberBlocked", discordUserId: "member" });
    recordLogChange("guild", { ...registration, action: "unregistered" });
    recordLogChange("guild", { kind: "profile", action: "removed", profile });
    recordLogChange("guild", { ...addedRole, action: "remove" });
  });
  assert.deepEqual(f.sent.map(entry => entry.lines), [[
    "<@officer> removed <@member> from Guild Manager. 1 character unregistered and 1 profile removed. Access blocked until officer reconnection. <@&friends> removed."
  ]]);
});

test("a committed kick remains auditable when no registrations or roles existed", () => {
  assert.deepEqual(formatLogChanges([{ kind: "memberBlocked", discordUserId: "member" }], { kind: "kick", actorDiscordUserId: "officer", discordUserId: "member" }),
    ["<@officer> removed <@member> from Guild Manager. 0 characters unregistered and 0 profiles removed. Access blocked until officer reconnection."]);
});

test("whole-group removals attribute the aggregate and retain unique member counts without role inventories", () => {
  for (const groupType of ["group", "guild", "alliance"] as const) {
    const result: MemberGroupRemovalResult = {
      memberGroup: { memberGroupId: "group", discordGuildId: "guild", albionServer: "asia", groupType, groupName: "Friends" },
      displayName: "Friends", totalMembershipProfiles: 3, ownedMembershipProfiles: 2, orphanedMembershipProfiles: 1,
      affectedDiscordUserIds: ["member", "member", "other-member"], retiredRoleIds: ["friends"],
      archivedApplicationClassCount: 0, deletedApplicationClassCount: 0, archivedApplicationClassIds: [], deletedApplicationClassIds: [],
      archivedApplicationIds: [], archivedApplicationClasses: [], deletedApplicationClasses: [], archivedApplications: []
    };
    assert.deepEqual(formatLogChanges([{ kind: "groupRemoved", result }, { ...addedRole, action: "remove" }], actor), [
      `<@officer> ${groupType === "group" ? "deleted" : "removed"} Friends • ${groupType} • Asia. 3 profiles removed and 2 members updated.`
    ]);
  }
});

test("officer no-ops stay silent and committed changes retain attribution after a later failure", async () => {
  const f = fixture();
  await f.runtime.interaction(f.interaction, async () => undefined);
  await assert.rejects(f.runtime.interaction(f.interaction, async () => { throw new Error("before mutation"); }), /before mutation/);
  assert.equal(f.sent.length, 0);
  const failure = new Error("private downstream failure");
  await assert.rejects(f.runtime.interaction(f.interaction, async () => {
    recordLogChange("guild", joined);
    recordLogChange("guild", addedRole);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(f.sent.map(entry => entry.lines), [[
    "<@officer> added melony69 to Friends • group • Asia. <@&friends> added.",
    "Some membership changes could not be completed."
  ]]);
});

test("manual update attribution preserves actual counts while scheduled updates retain their wording", async () => {
  for (const manual of [true, false]) {
    const f = fixture();
    f.interaction.commandName = "update";
    const operation = async () => {
      recordLogChange("guild", joined);
      recordLogChange("guild", addedRole);
      recordLogChange("guild", { kind: "nickname", action: "set", discordUserId: "member", nickname: "melony69" });
      recordLogChange("guild", { kind: "reconciliation", outcomes: [], warningCount: 1 });
    };
    if (manual) await f.runtime.interaction(f.interaction, operation);
    else await f.runtime.run(f.guild, operation, { kind: "reconciliation" });
    assert.deepEqual(f.sent.map(entry => entry.lines), [[manual
      ? "<@officer> ran a membership update: 1 profile changed for 1 member. 1 role added, 0 removed. 1 nickname changed. 1 operation could not be completed."
      : "Membership update changed 1 profile for 1 member. 1 role added, 0 removed. 1 nickname changed. 1 operation could not be completed."]]);
  }
});

test("successful reset and deactivation name the invoking officer at the previous destination", async () => {
  for (const kind of ["reset", "deactivated"] as const) {
    const f = fixture();
    const result = await f.runtime.terminal(f.guild, kind, async () => 42, f.interaction);
    assert.equal(result, 42);
    assert.deepEqual(f.sent, [{ lines: [`<@officer> ${kind === "reset" ? "reset" : "deactivated"} Guild Manager for this server.`], options: { channelId: "old-channel" } }]);
  }
});
