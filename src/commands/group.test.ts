import { v2Description, v2Rows, v2Title } from "../testSupport/messageAssertions.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { groupCommand, handleGroupCommand } from "./group.js";

test("group command remains hidden and exposes the approved surface", () => {
  const command = groupCommand.toJSON();
  assert.equal(command.name, "group");
  assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options?.map((option) => option.name), ["create", "delete", "edit", "list", "report", "roles"]);
});

test("group delete previews affected memberships instead of blocking on application history", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    components?: Array<{ toJSON(): { components?: Array<{ label?: string }> } }>;
  }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "admin-1" },
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "delete",
      getString: (name: string) => name === "server" ? "europe" : "42"
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    getGroup: async () => ({
      memberGroupId: "42",
      discordGuildId: "guild-1",
      albionServer: "europe",
      groupType: "group",
      groupName: "Friends"
    }),
    previewMemberGroupRemoval: async () => ({
      memberGroup: { memberGroupId: "42", discordGuildId: "guild-1", albionServer: "europe", groupType: "group", groupName: "Friends" },
      displayName: "Friends",
      totalMembershipProfiles: 3,
      ownedMembershipProfiles: 2,
      orphanedMembershipProfiles: 1,
      affectedDiscordUserIds: ["user-1", "user-2"],
      retiredRoleIds: []
    })
  } as unknown as Parameters<typeof handleGroupCommand>[1];

  await handleGroupCommand(interaction, repository, { getSchedule: async () => undefined });

  assert.equal(replies.length, 1);
  const embed = replies[0];
  assert.equal(v2Title(embed), "Delete Group?");
  assert.match(v2Description(embed) ?? "", /3 membership profiles/);
  assert.match(v2Description(embed) ?? "", /2 Discord members/);
  assert.deepEqual(v2Rows(replies[0])[0].components?.map((button: { label?: string; custom_id?: string }) => button.label), ["DELETE", "CANCEL"]);
});
