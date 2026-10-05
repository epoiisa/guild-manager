import {
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { activeGuildCommands } from "../discord/commands.js";
import { assertFeedbackCard, assertV2Message } from "../testSupport/messageAssertions.js";
import {
  balanceCommand,
  buildBalanceEmbeds,
  buildMemberProfileEmbeds,
  buildRolesEmbeds,
  handleBalanceCommand,
  handleMembershipCommand,
  handleRolesCommand,
  membershipCommand,
  rolesCommand
} from "./selfService.js";

test("self-service commands expose the accepted optionless hidden surface", () => {
  const commands = [membershipCommand, balanceCommand, rolesCommand].map((command) => command.toJSON());
  assert.deepEqual(
    commands.map(({ name, description, default_member_permissions, options }) => ({
      name,
      description,
      default_member_permissions,
      options: options ?? []
    })),
    [
      {
        name: "membership",
        description: "Show your Guild Manager membership details.",
        default_member_permissions: "0",
        options: []
      },
      {
        name: "balance",
        description: "Show your account balances.",
        default_member_permissions: "0",
        options: []
      },
      {
        name: "roles",
        description: "Show your membership and reaction roles.",
        default_member_permissions: "0",
        options: []
      }
    ]
  );
  assert.deepEqual(
    ["membership", "balance", "roles"].map((name) =>
      activeGuildCommands.find((command) => command.name === name)?.options ?? []
    ),
    [[], [], []]
  );
});

test("member profiles always render the approved six fields and empty states", () => {
  const embeds = buildMemberProfileEmbeds({
    discordUserId: "user-1",
    discordUsername: "member",
    displayName: "Member",
    characters: [],
    memberships: [],
    positions: [],
    accounts: []
  }).map((embed) => embed.toJSON());

  assert.deepEqual(embeds, [{
    color: 0x3b82f6,
    title: "Member Profile • Member",
    fields: [
      { name: "User", value: "<@user-1> • `member`", inline: false },
      { name: "Registered Characters", value: "None", inline: false },
      { name: "Memberships", value: "None", inline: false },
      { name: "Membership Roles", value: "None", inline: false },
      { name: "Membership Positions", value: "None", inline: false },
      { name: "Account Balances", value: "None", inline: false }
    ]
  }]);
});

test("member profiles use the fixed full report with main, role union, and balances", () => {
  const embed = buildMemberProfileEmbeds({
    discordUserId: "user-1",
    discordUsername: "discord-user",
    displayName: "Server Display",
    characters: [
      { albionServer: "europe", albionCharacterId: "main", characterName: "Zulu", discordRoleIds: ["character-role"] },
      { albionServer: "asia", albionCharacterId: "later", characterName: "Alpha", discordRoleIds: [] }
    ],
    memberships: [
      {
        memberGroupProfileId: "profile-2", memberGroupId: "group-2", albionServer: "asia", albionCharacterId: "later",
        characterName: "Alpha", groupType: "alliance", groupName: "A Group", discordRoleIds: ["later-group-role"]
      },
      {
        memberGroupProfileId: "profile-1", memberGroupId: "group-1", albionServer: "europe", albionCharacterId: "main",
        characterName: "Zulu", groupType: "guild", groupName: "Z Guild", discordRoleIds: ["group-role"]
      }
    ],
    positions: [
      {
        memberGroupPositionAppointmentId: "appointment-2", albionServer: "asia", albionCharacterId: "later",
        characterName: "Alpha", groupType: "alliance", groupName: "A Group", positionName: "Officer", discordRoleId: "later-position-role"
      },
      {
        memberGroupPositionAppointmentId: "appointment-1", albionServer: "europe", albionCharacterId: "main",
        characterName: "Zulu", groupType: "guild", groupName: "Z Guild", positionName: "Leader", discordRoleId: "position-role"
      }
    ],
    accounts: [account("main", "Zulu", "europe", "main", "open", -10n), account("later", "Alpha", "asia", "later", "frozen", 20n)]
  })[0].toJSON();

  assert.equal(embed.title, "Member Profile • Server Display");
  assert.equal(embed.color, 0x3b82f6);
  assert.deepEqual(embed.fields, [
    { name: "User", value: "<@user-1> • `discord-user`", inline: false },
    { name: "Registered Characters", value: "Zulu • Europe • Main • <@&character-role>\nAlpha • Asia", inline: false },
    { name: "Memberships", value: "Z Guild • guild • Zulu • Europe • <@&group-role>\nA Group • alliance • Alpha • Asia • <@&later-group-role>", inline: false },
    { name: "Membership Roles", value: "<@&character-role>\n<@&group-role>\n<@&later-group-role>\n<@&later-position-role>\n<@&position-role>", inline: false },
    { name: "Membership Positions", value: "Z Guild • guild • Zulu • Europe • Leader • <@&position-role>\nA Group • alliance • Alpha • Asia • Officer • <@&later-position-role>", inline: false },
    { name: "Account Balances", value: "Zulu • Europe • -10\nAlpha • Asia • 20 • Frozen", inline: false }
  ]);
});

test("balance and roles use current source-of-truth rows without Discord role drift checks", () => {
  const balance = buildBalanceEmbeds([
    account("closed", "Closed", "europe", "closed-character", "closed", 999n),
    account("main", "Zulu", "asia", "main-character", "open", -10n),
    account("later", "Alpha", "americas", "later-character", "frozen", 20n)
  ])[0].toJSON();
  assert.deepEqual(balance, {
    color: 0x64748b,
    title: "Balance",
    description: "Zulu • Asia • -10\nAlpha • North America • 20 • Frozen",
    footer: { text: "Use `/statement` to view your full account history.", icon_url: undefined }
  });
  assert.deepEqual(buildBalanceEmbeds([])[0].toJSON(), {
    color: 0x64748b,
    title: "Balance",
    description: "No accounts.",
    footer: { text: "Use `/statement` to view your full account history.", icon_url: undefined }
  });

  const roles = buildRolesEmbeds(
    "Member",
    ["role-2", "role-1", "role-2"],
    [
      { reactionRoleConfigId: "config-1", discordRoleId: "role-4", dormant: false },
      { reactionRoleConfigId: "config-2", discordRoleId: "role-3", dormant: true },
      { reactionRoleConfigId: "config-3", discordRoleId: "role-3", dormant: true }
    ]
  )[0].toJSON();
  assert.equal(roles.title, "Roles • @Member");
  assert.deepEqual(roles.fields, [
    { name: "Membership Roles", value: "<@&role-1>\n<@&role-2>", inline: false },
    { name: "Reaction Roles", value: "<@&role-3> • dormant\n<@&role-4>", inline: false }
  ]);
  assert.deepEqual(
    buildRolesEmbeds("Member", [], [])[0].toJSON().fields,
    [
      { name: "Membership Roles", value: "None", inline: false },
      { name: "Reaction Roles", value: "None", inline: false }
    ]
  );
});

test("member profile renderer continues fields and embeds without exceeding Discord limits", () => {
  const characters = Array.from({ length: 300 }, (_, index) => ({
    albionServer: "europe" as const,
    albionCharacterId: `character-${index}`,
    characterName: `${String(index).padStart(3, "0")}-${"Character".repeat(8)}`,
    discordRoleIds: [`role-${index}`]
  }));
  const embeds = buildMemberProfileEmbeds({
    discordUserId: "user-1",
    discordUsername: "overflow-member",
    displayName: "Overflow Member",
    characters,
    memberships: [],
    positions: [],
    accounts: []
  }).map((embed) => embed.toJSON());

  assert.ok(embeds.length > 1);
  assert.ok(embeds.flatMap((embed) => embed.fields ?? []).some((field) => field.name === "Registered Characters (continued)"));
  assert.ok(embeds.every((embed) => (embed.fields?.length ?? 0) <= 25));
  assert.ok(embeds.every((embed) =>
    (embed.title?.length ?? 0) + (embed.fields ?? []).reduce(
      (length, field) => length + field.name.length + field.value.length,
      0
    ) <= 6000
  ));
  assert.ok(embeds.flatMap((embed) => embed.fields ?? []).every((field) => field.value.length <= 1024));
  const rendered = embeds.flatMap((embed) => embed.fields ?? []).map((field) => field.value).join("\n");
  assert.match(rendered, /000-Character/);
  assert.match(rendered, /299-Character/);
});

test("handlers pass only the caller identity to bounded read methods and keep responses ephemeral", async () => {
  const queryCalls: Array<[string, string, string]> = [];
  const replies: Array<{ embeds?: unknown[]; flags?: MessageFlags }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    member: { displayName: "Caller" },
    user: { id: "caller-1", displayName: "Caller", username: "caller" },
    reply: async (payload: { embeds?: unknown[]; flags?: MessageFlags }) => {
      replies.push(payload);
    },
    followUp: async (payload: { embeds?: unknown[]; flags?: MessageFlags }) => {
      replies.push(payload);
    }
  } as unknown as ChatInputCommandInteraction;
  const membershipRepository = {
    listSelfServiceCharacters: read("characters", []),
    listSelfServiceMemberships: read("memberships", []),
    listSelfServicePositions: read("positions", []),
    listSelfServiceReactionRoles: read("reactions", []),
    listMembershipRoleIdsForUser: read("membership roles", [])
  } as unknown as Parameters<typeof handleMembershipCommand>[1];
  const accountRepository = {
    listAccountsForUser: read("accounts", [])
  } as unknown as Parameters<typeof handleBalanceCommand>[1];

  await handleMembershipCommand(interaction, membershipRepository, accountRepository);
  await handleBalanceCommand(interaction, accountRepository);
  await handleRolesCommand(interaction, membershipRepository);

  assert.deepEqual(queryCalls, [
    ["characters", "guild-1", "caller-1"],
    ["memberships", "guild-1", "caller-1"],
    ["positions", "guild-1", "caller-1"],
    ["accounts", "guild-1", "caller-1"],
    ["accounts", "guild-1", "caller-1"],
    ["membership roles", "guild-1", "caller-1"],
    ["reactions", "guild-1", "caller-1"]
  ]);
  assert.equal(replies.length, 3);
  assert.ok(replies.every((reply) => (Number(reply.flags) & MessageFlags.Ephemeral) !== 0));

  function read<T>(name: string, value: T) {
    return async (guildId: string, userId: string): Promise<T> => {
      queryCalls.push([name, guildId, userId]);
      return value;
    };
  }
});

test("all self-service handlers use the shared server-only response before querying", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    flags?: MessageFlags;
  }> = [];
  const interaction = {
    inGuild: () => false,
    reply: async (payload: typeof replies[number]) => {
      replies.push(payload);
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = new Proxy({}, {
    get: () => () => {
      throw new Error("Repository should not be queried outside a server.");
    }
  });

  await handleMembershipCommand(interaction, repository as never, repository as never);
  await handleBalanceCommand(interaction, repository as never);
  await handleRolesCommand(interaction, repository as never);

  assert.equal(replies.length, 3);
  for (const reply of replies) {
    assertFeedbackCard(reply, {
      color: 0xeab308,
      title: "Server Only",
      description: "This command can only be used in a Discord server."
    });
    assert.equal(reply.flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
  }
});

test("membership sends large reports as additional ephemeral responses", async () => {
  const responses: Array<{ embeds?: unknown[]; flags?: MessageFlags }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    member: { displayName: "Overflow Member" },
    user: { id: "caller-1", displayName: "Overflow Member", username: "caller" },
    reply: async (payload: { embeds?: unknown[]; flags?: MessageFlags }) => {
      responses.push(payload);
    },
    followUp: async (payload: { embeds?: unknown[]; flags?: MessageFlags }) => {
      responses.push(payload);
    }
  } as unknown as ChatInputCommandInteraction;
  const characters = Array.from({ length: 700 }, (_, index) => ({
    albionServer: "europe" as const,
    albionCharacterId: `character-${index}`,
    characterName: `${String(index).padStart(3, "0")}-${"Character".repeat(8)}`,
    discordRoleIds: [`role-${index}`]
  }));
  const membershipRepository = {
    listSelfServiceCharacters: async () => characters,
    listSelfServiceMemberships: async () => [],
    listSelfServicePositions: async () => []
  } as unknown as Parameters<typeof handleMembershipCommand>[1];

  await handleMembershipCommand(interaction, membershipRepository, { listAccountsForUser: async () => [] } as never);

  assert.ok(responses.length > 1);
  responses.forEach(assertV2Message);
  assert.ok(responses.every((response) => response.flags === (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral)));
});

function account(
  accountId: string,
  characterName: string,
  albionServer: "americas" | "asia" | "europe",
  albionCharacterId: string,
  status: "open" | "frozen" | "closed",
  balance: bigint
) {
  return {
    accountId,
    discordGuildId: "guild-1",
    discordUserId: "user-1",
    albionServer,
    albionCharacterId,
    characterName,
    status,
    balance,
    createdAt: new Date("2026-07-01T00:00:00.000Z")
  };
}
