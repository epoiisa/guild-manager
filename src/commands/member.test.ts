import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { MemberGroup, MemberGroupProfile, ProfileInput } from "../db/membershipRepository.js";
import { assertFeedbackCard, messageDescription, messageSummary, messageTexts } from "../testSupport/messageAssertions.js";
import { handleMemberAutocomplete, handleMemberCommand, memberCommand } from "./member.js";

test("member lookup descriptions describe the approved full-profile leaves", () => {
  const lookup = memberCommand.toJSON().options?.find((option) => option.name === "lookup");
  const leaves = lookup && "options" in lookup ? lookup.options : [];
  assert.deepEqual(leaves?.map((leaf) => ({ name: leaf.name, description: leaf.description })), [
    { name: "user", description: "Look up a Discord user's full member profile." },
    { name: "character", description: "Look up the registered owner's full member profile." }
  ]);
});

test("member lookup character accepts only a current registration and returns the unified profile", async () => {
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string; fields?: unknown[] } }> }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    guild: { members: { fetch: async () => ({ displayName: "Server Name" }) } },
    client: { users: { fetch: async () => ({ id: "user-1", username: "user", displayName: "User" }) } },
    options: {
      getSubcommandGroup: () => "lookup",
      getSubcommand: () => "character",
      getString: () => "europe:character-1"
    },
    deferReply: async () => undefined,
    editReply: async (payload: typeof replies[number]) => { replies.push(payload); },
    followUp: async () => undefined
  } as unknown as ChatInputCommandInteraction;
  const membership = {
    getRegisteredCharacter: async () => ({ discordUserId: "user-1", albionServer: "europe", albionCharacterId: "character-1", characterName: "Main" }),
    listSelfServiceCharacters: async () => [], listSelfServiceMemberships: async () => [], listSelfServicePositions: async () => []
  } as unknown as Parameters<typeof handleMemberCommand>[1];
  const accounts = { listAccountsForUser: async () => [] } as unknown as Parameters<typeof handleMemberCommand>[2];

  await handleMemberCommand(interaction, membership, accounts);

  const embed = replies[0];
  assert.equal(messageSummary(embed), "Member Profile • Server Name");
  assert.equal(messageTexts(embed).filter(text => text.startsWith("**")).length, 6);
});

test("member lookup character rejects stale autocomplete values with the approved invalid-input response", async () => {
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const interaction = {
    inGuild: () => true, guildId: "guild-1",
    options: { getSubcommandGroup: () => "lookup", getSubcommand: () => "character", getString: () => "europe:stale" },
    deferReply: async () => undefined,
    editReply: async (payload: typeof replies[number]) => { replies.push(payload); }
  } as unknown as ChatInputCommandInteraction;
  await handleMemberCommand(interaction, { getRegisteredCharacter: async () => undefined } as never, {} as never);
  assertFeedbackCard(replies[0], {
    color: 0xeab308,
    title: "Member Not Found",
    description: "Choose a currently registered character from autocomplete."
  }, true);
});

test("member lookup character acknowledges before registration and Discord user fetches", async () => {
  const events: string[] = [];
  let resolveRegistered: ((value: unknown) => void) | undefined;
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    guild: { members: { fetch: async () => ({ displayName: "Server Name" }) } },
    client: { users: { fetch: async () => { events.push("user-fetch"); return { id: "user-1", username: "user", displayName: "User" }; } } },
    options: { getSubcommandGroup: () => "lookup", getSubcommand: () => "character", getString: () => "europe:character-1" },
    deferReply: async () => { events.push("defer"); },
    editReply: async () => { events.push("edit"); },
    followUp: async () => undefined
  } as unknown as ChatInputCommandInteraction;
  const membership = {
    getRegisteredCharacter: async () => {
      events.push("registration");
      return await new Promise((resolve) => { resolveRegistered = resolve; });
    },
    listSelfServiceCharacters: async () => [], listSelfServiceMemberships: async () => [], listSelfServicePositions: async () => []
  } as unknown as Parameters<typeof handleMemberCommand>[1];
  const pending = handleMemberCommand(interaction, membership, { listAccountsForUser: async () => [] } as never);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["defer", "registration"]);
  resolveRegistered?.({ discordUserId: "user-1", albionServer: "europe", albionCharacterId: "character-1", characterName: "Main" });
  await pending;
  assert.deepEqual(events, ["defer", "registration", "user-fetch", "edit"]);
});

test("member lookup character autocomplete excludes unregistered stored characters", async () => {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction = {
    commandName: "member", guildId: "guild-1",
    options: { getFocused: () => ({ name: "character", value: "" }), getSubcommandGroup: () => "lookup", getSubcommand: () => "character" },
    respond: async (choices: Array<{ name: string; value: string }>) => { responses.push(choices); }
  } as unknown as AutocompleteInteraction;
  await handleMemberAutocomplete(interaction, {
    listRegisteredCharacters: async () => [{ albionServer: "europe", albionCharacterId: "registered", characterName: "Registered", discordUserId: "user-1" }],
    listKnownCharactersForGuild: async () => { throw new Error("Stored characters must not be queried."); }
  } as never);
  assert.deepEqual(responses, [[{ name: "Registered • Europe", value: "europe:registered" }]]);
});

test("member add immediately reconciles configured roles for the addressed user", async () => {
  const addedRoles: string[] = [];
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: () => false },
      add: async (roleId: string) => {
        addedRoles.push(roleId);
      },
      remove: async () => undefined
    }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => undefined },
    members: { fetch: async () => member }
  };
  const interaction = {
    inGuild: () => true,
    guild,
    guildId: "guild-1",
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "add",
      getString: (name: string) => name === "character" ? "europe:character-1" : "group-1"
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getRegisteredCharacter: async () => ({
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example"
    }),
    getGroup: async () => ({
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      albionServer: "europe",
      groupType: "group",
      groupName: "Friends"
    }),
    addRegisteredProfile: async () => ({
      memberGroupProfileId: "profile-1",
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1"
    }),
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => ["group-role-1", "group-role-2"],
    listQualifiedRoleIdsForUser: async () => ["group-role-1", "group-role-2"]
  } as unknown as Parameters<typeof handleMemberCommand>[1];

  await handleMemberCommand(interaction, repository, {} as never);

  assert.deepEqual(addedRoles, ["group-role-1", "group-role-2"]);
  const embed = replies[0];
  assert.equal(messageSummary(embed), "Example • <@user-1> was added to Friends • Europe.");
  assert.equal(messageDescription(embed), "Example • <@user-1> was added to Friends • Europe.");
});

test("member add reports immediate role reconciliation warnings", async () => {
  const replies: Array<{ embeds?: Array<{ toJSON(): { description?: string } }> }> = [];
  const interaction = {
    inGuild: () => true,
    guild: {
      id: "guild-1",
      channels: { fetch: async () => undefined },
      members: {
        fetch: async () => {
          throw new Error("Missing permissions");
        }
      }
    },
    guildId: "guild-1",
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "add",
      getString: (name: string) => name === "character" ? "europe:character-1" : "group-1"
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getRegisteredCharacter: async () => ({
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example"
    }),
    getGroup: async () => ({
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      albionServer: "europe",
      groupType: "group",
      groupName: "Friends"
    }),
    addRegisteredProfile: async () => ({
      memberGroupProfileId: "profile-1",
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1"
    }),
    listDormantReactionRoleSubscriptions: async () => []
  } as unknown as Parameters<typeof handleMemberCommand>[1];

  await handleMemberCommand(interaction, repository, {} as never);

  assert.equal(
    messageDescription(replies[0]),
    "Example • <@user-1> was added to Friends • Europe.\n\nRole update failed for <@user-1>: Missing permissions"
  );
});

test("member remove character autocomplete includes orphaned profiles in the selected group", async () => {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction = {
    commandName: "member",
    guildId: "guild-1",
    options: {
      getFocused: () => ({ name: "character", value: "a" }),
      getSubcommandGroup: () => null,
      getSubcommand: () => "remove",
      getString: (name: string) => name === "group" ? "group-1" : null
    },
    respond: async (choices: Array<{ name: string; value: string }>) => {
      responses.push(choices);
    }
  } as unknown as AutocompleteInteraction;
  const repository = {
    listProfilesForGroups: async () => [
      {
        memberGroupProfileId: "profile-1",
        memberGroupId: "group-1",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        albionServer: "europe",
        albionCharacterId: "character-1",
        groupName: "Friends",
        groupType: "group",
        characterName: "Alicia"
      },
      {
        memberGroupProfileId: "profile-2",
        memberGroupId: "group-1",
        discordGuildId: "guild-1",
        albionServer: "europe",
        albionCharacterId: "character-2",
        groupName: "Friends",
        groupType: "group",
        characterName: "Bryn"
      },
      {
        memberGroupProfileId: "profile-3",
        memberGroupId: "group-1",
        discordGuildId: "guild-1",
        albionServer: "europe",
        albionCharacterId: "character-3",
        groupName: "Friends",
        groupType: "group",
        characterName: "Arden"
      }
    ]
  } as unknown as Parameters<typeof handleMemberAutocomplete>[1];

  assert.equal(await handleMemberAutocomplete(interaction, repository), true);
  assert.deepEqual(responses, [[
    { name: "Alicia • Europe", value: "europe:character-1" },
    { name: "Arden • Europe", value: "europe:character-3" }
  ]]);
});

test("member remove group autocomplete includes orphaned custom-group profiles and excludes automatic groups", async () => {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction = {
    commandName: "member",
    guildId: "guild-1",
    options: {
      getFocused: () => ({ name: "group", value: "fri" }),
      getSubcommandGroup: () => null,
      getSubcommand: () => "remove",
      getString: (name: string) => name === "character" ? "europe:character-1" : null
    },
    respond: async (choices: Array<{ name: string; value: string }>) => {
      responses.push(choices);
    }
  } as unknown as AutocompleteInteraction;
  const repository = {
    listProfilesForCharacter: async () => [
      {
        memberGroupProfileId: "profile-1",
        memberGroupId: "group-1",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        albionServer: "europe",
        albionCharacterId: "character-1",
        groupName: "Friends",
        groupType: "group",
        characterName: "Alicia"
      },
      {
        memberGroupProfileId: "profile-2",
        memberGroupId: "group-2",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        albionServer: "europe",
        albionCharacterId: "character-1",
        groupName: "Raiders",
        groupType: "group",
        characterName: "Alicia"
      },
      {
        memberGroupProfileId: "profile-3",
        memberGroupId: "group-3",
        discordGuildId: "guild-1",
        albionServer: "europe",
        albionCharacterId: "character-1",
        groupName: "Friday Orphans",
        groupType: "group",
        characterName: "Alicia"
      },
      {
        memberGroupProfileId: "profile-4",
        memberGroupId: "guild-1",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        albionServer: "europe",
        albionCharacterId: "character-1",
        groupName: "Friendly Guild",
        groupType: "guild",
        characterName: "Alicia"
      }
    ]
  } as unknown as Parameters<typeof handleMemberAutocomplete>[1];

  assert.equal(await handleMemberAutocomplete(interaction, repository), true);
  assert.deepEqual(responses, [[
    { name: "Friends • Europe", value: "group-1" },
    { name: "Friday Orphans • Europe", value: "group-3" }
  ]]);
});

test("member remove without a selected group deduplicates profiled characters and retains server identity", async () => {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction = {
    commandName: "member", guildId: "guild-1",
    options: {
      getFocused: () => ({ name: "character", value: "" }),
      getSubcommandGroup: () => null, getSubcommand: () => "remove", getString: () => null
    },
    respond: async (choices: Array<{ name: string; value: string }>) => { responses.push(choices); }
  } as unknown as AutocompleteInteraction;
  await handleMemberAutocomplete(interaction, {
    listGroups: async () => [{ memberGroupId: "group-1" }, { memberGroupId: "group-2" }],
    listProfilesForGroups: async (guild: string, groups: string[]) => {
      assert.equal(guild, "guild-1");
      assert.deepEqual(groups, ["group-1", "group-2"]);
      return [
        { ...removalProfile },
        { ...removalProfile, memberGroupId: "group-2", discordUserId: undefined },
        { ...removalProfile, albionServer: "asia", discordUserId: undefined },
        { ...removalProfile, albionCharacterId: "automatic", groupType: "alliance" }
      ];
    }
  } as never);
  assert.deepEqual(responses, [[
    { name: "Example • Europe", value: "europe:character-1" },
    { name: "Example • Asia", value: "asia:character-1" }
  ]]);
});

const removalProfile: MemberGroupProfile = {
  memberGroupProfileId: "profile-1", memberGroupId: "group-1", discordGuildId: "guild-1",
  discordUserId: "user-1", albionServer: "europe", albionCharacterId: "character-1",
  characterName: "Example", groupType: "group", groupName: "Friends"
};

function createMemberRemovalFixture(profile: MemberGroupProfile | undefined) {
  const events: string[] = [];
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const roles = new Set(["friends-role", "position-role", "shared-role", "alliance-role", "registration-role", "reaction-role", "unmanaged-role"]);
  const member = {
    id: "user-1", guild: { id: "guild-1" },
    roles: {
      cache: { has: (roleId: string) => roles.has(roleId) },
      add: async (roleId: string) => { roles.add(roleId); },
      remove: async (roleId: string) => { roles.delete(roleId); }
    }
  };
  const interaction = {
    inGuild: () => true, guildId: "guild-1",
    guild: { members: { fetch: async (request: string | { user: string }) => { events.push(`roles:${typeof request === "string" ? request : request.user}`); return member; } } },
    options: {
      getSubcommandGroup: () => null, getSubcommand: () => "remove",
      getString: (name: string) => name === "character" ? "europe:character-1" : "group-1"
    },
    deferReply: async (payload: { flags: number }) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push("defer"); },
    reply: async (payload: typeof replies[number]) => { replies.push(payload); },
    editReply: async (payload: typeof replies[number]) => { events.push("reply"); replies.push(payload); }
  };
  const repository = {
    getGroup: async (guild: string, group: string, server: string): Promise<MemberGroup | undefined> => {
      events.push("group");
      assert.deepEqual([guild, group, server], ["guild-1", "group-1", "europe"]);
      return { memberGroupId: group, discordGuildId: guild, albionServer: "europe", groupType: "group", groupName: "Friends" };
    },
    removeCustomGroupProfile: async (input: ProfileInput) => {
      events.push("delete");
      assert.deepEqual(input, { memberGroupId: "group-1", discordGuildId: "guild-1", albionServer: "europe", albionCharacterId: "character-1" });
      return profile;
    },
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => ["friends-role", "position-role", "shared-role", "alliance-role", "registration-role", "reaction-role"],
    listQualifiedRoleIdsForUser: async () => {
      assert.ok(events.includes("delete"), "Entitlements must be evaluated after membership removal.");
      return ["shared-role", "alliance-role", "registration-role", "reaction-role"];
    }
  };
  return {
    events, replies, roles, member, interaction, repository,
    run: () => handleMemberCommand(interaction as unknown as ChatInputCommandInteraction, repository as never, {} as never)
  };
}

test("member remove deletes the selected profile before reconciling remaining entitlements", async () => {
  const fixture = createMemberRemovalFixture(removalProfile);
  await fixture.run();
  assert.deepEqual(fixture.events.filter(event => !event.startsWith("roles:")), ["defer", "group", "delete", "reply"]);
  assert.ok(fixture.events.indexOf("roles:user-1") > fixture.events.indexOf("delete"));
  assert.deepEqual([...fixture.roles], ["shared-role", "alliance-role", "registration-role", "reaction-role", "unmanaged-role"]);
  assert.equal(messageSummary(fixture.replies[0]), "Example • <@user-1> was removed from Friends • Europe.");
  assert.equal(messageDescription(fixture.replies[0]), "Example • <@user-1> was removed from Friends • Europe.");
});

test("member remove deletes an orphaned profile without requiring a registration or Discord owner", async () => {
  const fixture = createMemberRemovalFixture({ ...removalProfile, discordUserId: undefined });
  await fixture.run();
  assert.deepEqual(fixture.events, ["defer", "group", "delete", "reply"]);
  assert.equal(messageDescription(fixture.replies[0]), "Example was removed from Friends • Europe.");
});

test("member remove reports a stale profile without changing Discord roles", async () => {
  const fixture = createMemberRemovalFixture(undefined);
  await fixture.run();
  assert.deepEqual(fixture.events, ["defer", "group", "delete", "reply"]);
  assert.equal(messageSummary(fixture.replies[0]), "The selected character has no profile in Friends • Europe.");
});

test("member remove rejects missing or out-of-scope groups before deleting a profile", async () => {
  const fixture = createMemberRemovalFixture(removalProfile);
  fixture.repository.getGroup = async () => undefined;
  await fixture.run();
  assert.deepEqual(fixture.events, ["defer", "reply"]);
  assert.equal(messageSummary(fixture.replies[0]), "Group Not Found: Choose a group on the character's Albion Online server.");
});

test("member remove reports role cleanup failure after successful profile deletion", async () => {
  const fixture = createMemberRemovalFixture(removalProfile);
  fixture.member.roles.remove = async () => { throw new Error("Missing permissions"); };
  await fixture.run();
  assert.equal(fixture.events.filter((event) => event === "delete").length, 1);
  assert.equal(messageSummary(fixture.replies[0]), "Member Removed");
  assert.match(messageDescription(fixture.replies[0]) ?? "", /was removed from Friends • Europe\..*\n\nRole update failed/);
});
