import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { activeGuildCommands } from "../discord/commands.js";
import { assertFeedbackCard, assertV2Fields, messageDescription, messageSummary } from "../testSupport/messageAssertions.js";
import {
  handlePositionAutocomplete,
  handlePositionCommand,
  positionCommand
} from "./position.js";

test("position command exposes the approved surface alongside the self-service roles command", () => {
  const json = positionCommand.toJSON();
  assert.equal(json.name, "position");
  assert.equal(json.description, "Manage group-scoped positions.");
  assert.equal(json.default_member_permissions, "0");

  const leaves = (json.options ?? []).map((subcommand) => ({
    signature: `/position ${subcommand.name}`,
    description: subcommand.description,
    options: "options" in subcommand
      ? (subcommand.options ?? []).map((option) => ({
        name: option.name,
        description: option.description,
        required: "required" in option ? option.required === true : false,
        autocomplete: "autocomplete" in option ? option.autocomplete === true : false
      }))
      : []
  }));

  assert.deepEqual(leaves, [
    {
      signature: "/position create",
      description: "Create a group-scoped position.",
      options: [
        { name: "group", description: "Configured member group.", required: true, autocomplete: true },
        { name: "name", description: "Position name.", required: true, autocomplete: false },
        { name: "role", description: "Discord role.", required: true, autocomplete: false }
      ]
    },
    {
      signature: "/position delete",
      description: "Delete a group-scoped position.",
      options: [
        { name: "group", description: "Configured member group.", required: true, autocomplete: true },
        { name: "position", description: "Configured position.", required: true, autocomplete: true }
      ]
    },
    {
      signature: "/position appoint",
      description: "Appoint a character to a group-scoped position.",
      options: [
        { name: "group", description: "Configured member group.", required: true, autocomplete: true },
        { name: "position", description: "Configured position.", required: true, autocomplete: true },
        { name: "character", description: "Member group profile.", required: true, autocomplete: true }
      ]
    },
    {
      signature: "/position dismiss",
      description: "Dismiss a character from a group-scoped position.",
      options: [
        { name: "group", description: "Configured member group.", required: true, autocomplete: true },
        { name: "position", description: "Configured position.", required: true, autocomplete: true },
        { name: "character", description: "Appointed member group profile.", required: true, autocomplete: true }
      ]
    },
    {
      signature: "/position list",
      description: "List group-scoped positions.",
      options: [
        { name: "group", description: "Configured member group.", required: false, autocomplete: true }
      ]
    }
  ]);

  assert.equal(activeGuildCommands.some((command) => command.name === "position"), true);
  assert.equal(activeGuildCommands.some((command) => command.name === "roles"), true);
});

test("position autocomplete ignores the removed roles command and resolves positions", async () => {
  const removedAlias = {
    commandName: "roles"
  } as AutocompleteInteraction;
  assert.equal(await handlePositionAutocomplete(removedAlias, {} as never), false);

  const responses: Array<Array<{ name: string; value: string }>> = [];
  const interaction = {
    commandName: "position",
    guild: null,
    guildId: "guild-1",
    options: {
      getFocused: () => ({ name: "position", value: "lea" }),
      getString: (name: string) => name === "group" ? "group-1" : null
    },
    respond: async (choices: Array<{ name: string; value: string }>) => {
      responses.push(choices);
    }
  } as unknown as AutocompleteInteraction;
  const repository = {
    listGroupPositions: async () => [{
      memberGroupPositionId: "position-1",
      memberGroupId: "group-1",
      name: "Leader",
      discordRoleId: "role-1"
    }]
  } as unknown as Parameters<typeof handlePositionAutocomplete>[1];

  assert.equal(await handlePositionAutocomplete(interaction, repository), true);
  assert.deepEqual(responses, [[{ name: "Leader • @role-1", value: "position-1" }]]);
});

test("position list and dismissal responses use position and appointment terminology", async () => {
  const listReplies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const listInteraction = {
    inGuild: () => true,
    guildId: "guild-1",
    options: {
      getSubcommand: () => "list",
      getString: () => null
    },
    reply: async (reply: typeof listReplies[number]) => {
      listReplies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const listRepository = {
    listGroupPositions: async () => [],
    listGroupPositionAppointments: async () => []
  } as unknown as Parameters<typeof handlePositionCommand>[1];

  await handlePositionCommand(listInteraction, listRepository);
  assertFeedbackCard(listReplies[0], {
    color: 0x64748b,
    title: "Positions",
    description: "No positions are configured."
  });

  const dismissReplies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const dismissInteraction = {
    inGuild: () => true,
    guildId: "guild-1",
    options: {
      getSubcommand: () => "dismiss",
      getString: (name: string) => ({
        group: "group-1",
        position: "position-1",
        character: "profile-1"
      })[name]
    },
    reply: async (reply: typeof dismissReplies[number]) => {
      dismissReplies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const dismissRepository = {
    listMemberGroups: async () => [{
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      groupType: "group",
      groupName: "Leadership",
      albionServer: "europe"
    }],
    getGroupPosition: async () => ({
      memberGroupPositionId: "position-1"
    }),
    dismissGroupPosition: async () => undefined
  } as unknown as Parameters<typeof handlePositionCommand>[1];

  await handlePositionCommand(dismissInteraction, dismissRepository);
  assert.equal(messageSummary(dismissReplies[0]), "Appointment Not Found: Choose an appointed character from autocomplete.");
  assert.equal(messageDescription(dismissReplies[0]), "Appointment Not Found: Choose an appointed character from autocomplete.");
});

test("appoint reports the position, appointment, and Discord role distinctly", async () => {
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; fields?: Array<{ name: string; value: string }> } }> }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    options: {
      getSubcommand: () => "appoint",
      getString: (name: string) => ({
        group: "group-1",
        position: "position-1",
        character: "profile-1"
      })[name]
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    listMemberGroups: async () => [{
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      groupType: "group",
      groupName: "Leadership",
      albionServer: "europe"
    }],
    getGroupPosition: async () => ({
      memberGroupPositionId: "position-1"
    }),
    appointGroupPosition: async () => ({
      memberGroupPositionAppointmentId: "appointment-1",
      memberGroupPositionId: "position-1",
      memberGroupProfileId: "profile-1",
      discordGuildId: "guild-1",
      memberGroupId: "group-1",
      name: "Leader",
      discordRoleId: "role-1",
      albionServer: "europe",
      groupType: "group",
      groupName: "Leadership",
      albionCharacterId: "character-1",
      characterName: "Orphan"
    })
  } as unknown as Parameters<typeof handlePositionCommand>[1];

  await handlePositionCommand(interaction, repository);

  const embed = replies[0];
  assert.equal(messageSummary(embed), "Appointment Created");
  assertV2Fields(embed, [
    { name: "Group", value: "Leadership • Europe", inline: false },
    { name: "Position", value: "Leader • <@&role-1>", inline: false },
    { name: "Appointment", value: "Orphan • orphaned", inline: false },
    { name: "Warnings", value: "Orphan is orphaned, so no Discord role was applied.", inline: false }
  ]);
});
