import type { ButtonInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { messageDescription, messageRows, messageSummary } from "../testSupport/messageAssertions.js";
import { handleMemberGroupRemovalButton } from "./memberGroupRemoval.js";

test("confirmed member-group removal binds the actor, removes the group, and reports actual counts", async () => {
  const calls: unknown[] = [];
  const edits: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }>; components?: unknown[] }> = [];
  const interaction = {
    customId: `member-group-remove:42:admin-1:${(Date.now() + 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    guild: {},
    user: { id: "admin-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;
  const repository = {
    removeMemberGroup: async (input: unknown) => {
      calls.push(input);
      return {
        memberGroup: { memberGroupId: "42", discordGuildId: "guild-1", albionServer: "europe", groupType: "alliance", groupName: "Alliance" },
        displayName: "Alliance [TAG]",
        albionEntityId: "alliance-id",
        albionAllianceTag: "TAG",
        totalMembershipProfiles: 4,
        ownedMembershipProfiles: 3,
        orphanedMembershipProfiles: 1,
        affectedDiscordUserIds: [],
        retiredRoleIds: ["role-1"],
        archivedApplicationClassCount: 1,
        deletedApplicationClassCount: 0,
        archivedApplicationClassIds: ["class-1"],
        deletedApplicationClassIds: [],
        archivedApplicationIds: ["application-1"],
        archivedApplicationClasses: [],
        deletedApplicationClasses: [],
        archivedApplications: []
      };
    }
  } as unknown as Parameters<typeof handleMemberGroupRemovalButton>[1];

  const handled = await handleMemberGroupRemovalButton(interaction, repository, async () => []);

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ discordGuildId: "guild-1", memberGroupId: "42", archivedByDiscordUserId: "admin-1" }]);
  assert.equal(messageSummary(edits[0]), "Alliance Removed");
  assert.match(messageDescription(edits[0]) ?? "", /4 membership profiles/);
  assert.deepEqual(messageRows(edits[0]), []);
});

test("confirmed custom-group deletion uses delete outcome semantics", async () => {
  const edits: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }>; components?: unknown[] }> = [];
  const interaction = {
    customId: `member-group-delete:42:admin-1:${(Date.now() + 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    guild: {},
    user: { id: "admin-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;
  const repository = {
    removeMemberGroup: async () => ({
      memberGroup: { memberGroupId: "42", discordGuildId: "guild-1", albionServer: "europe", groupType: "group", groupName: "Friends" },
      displayName: "Friends",
      totalMembershipProfiles: 2,
      ownedMembershipProfiles: 1,
      orphanedMembershipProfiles: 1,
      affectedDiscordUserIds: [],
      retiredRoleIds: [],
      archivedApplicationClassCount: 0,
      deletedApplicationClassCount: 0,
      archivedApplicationClassIds: [],
      deletedApplicationClassIds: [],
      archivedApplicationIds: [],
      archivedApplicationClasses: [],
      deletedApplicationClasses: [],
      archivedApplications: []
    })
  } as unknown as Parameters<typeof handleMemberGroupRemovalButton>[1];

  await handleMemberGroupRemovalButton(interaction, repository, async () => []);

  const embed = edits[0];
  assert.equal(messageSummary(embed), "Group Deleted");
  assert.match(messageDescription(embed) ?? "", /Friends • Europe was deleted/);
  assert.match(messageDescription(embed) ?? "", /2 membership profiles.*were removed/);
});

test("cancelled custom-group deletion uses deletion semantics", async () => {
  const edits: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }>; components?: unknown[] }> = [];
  const interaction = {
    customId: `member-group-delete:42:admin-1:${(Date.now() + 60_000).toString(36)}:cancel`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "admin-1" },
    update: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;

  await handleMemberGroupRemovalButton(interaction, {} as Parameters<typeof handleMemberGroupRemovalButton>[1]);

  assert.equal(messageSummary(edits[0]), "Deletion Cancelled");
  assert.equal(messageDescription(edits[0]), "Deletion cancelled. Nothing was changed.");
});

test("expired custom-group deletion uses deletion semantics", async () => {
  const edits: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }>; components?: unknown[] }> = [];
  const interaction = {
    customId: `member-group-delete:42:admin-1:${(Date.now() - 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "admin-1" },
    update: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;

  await handleMemberGroupRemovalButton(interaction, {} as Parameters<typeof handleMemberGroupRemovalButton>[1]);

  assert.equal(messageSummary(edits[0]), "Deletion Confirmation Expired");
  assert.equal(messageDescription(edits[0]), "Deletion confirmation expired; run the delete command again.");
});

test("member-group removal confirmation rejects another user", async () => {
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string } }> }> = [];
  const interaction = {
    customId: `member-group-remove:42:admin-1:${(Date.now() + 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "admin-2" },
    reply: async (payload: typeof replies[number]) => { replies.push(payload); }
  } as unknown as ButtonInteraction;

  const handled = await handleMemberGroupRemovalButton(interaction, {} as Parameters<typeof handleMemberGroupRemovalButton>[1]);

  assert.equal(handled, true);
  assert.equal(messageSummary(replies[0]), "Only the person who started this removal can use these buttons.");
});

test("member-group removal uses singular success copy", async () => {
  const edits: Array<{ embeds?: Array<{ toJSON(): { description?: string } }> }> = [];
  const member = { id: "user-1", guild: { id: "guild-1" }, roles: { cache: { has: () => false }, add: async () => undefined, remove: async () => undefined } };
  const interaction = {
    customId: `member-group-remove:42:admin-1:${(Date.now() + 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    guild: { id: "guild-1", channels: { fetch: async () => undefined }, members: { fetch: async () => member } },
    user: { id: "admin-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;
  const repository = {
    removeMemberGroup: async () => removalResult(["user-1"]),
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => [],
    listQualifiedRoleIdsForUser: async () => []
  } as unknown as Parameters<typeof handleMemberGroupRemovalButton>[1];

  await handleMemberGroupRemovalButton(interaction, repository, async () => []);

  const description = messageDescription(edits[0]) ?? "";
  assert.equal(
    description,
    "Alliance [TAG] • Europe was removed. **1 membership profile** was removed. **1 Discord member** was reconciled. Other memberships and character registrations were retained."
  );
});

test("member-group removal reports partial reconciliation and cleanup failures after the database succeeds", async () => {
  const edits: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const interaction = {
    customId: `member-group-remove:42:admin-1:${(Date.now() + 60_000).toString(36)}:confirm`,
    inCachedGuild: () => true,
    guildId: "guild-1",
    guild: { id: "guild-1", channels: { fetch: async () => undefined }, members: { fetch: async () => undefined } },
    user: { id: "admin-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: typeof edits[number]) => { edits.push(payload); }
  } as unknown as ButtonInteraction;
  const repository = {
    removeMemberGroup: async () => removalResult(["user-1"]),
    listDormantReactionRoleSubscriptions: async () => undefined
  } as unknown as Parameters<typeof handleMemberGroupRemovalButton>[1];

  await handleMemberGroupRemovalButton(interaction, repository, async () => { throw new Error("cleanup failed"); });

  const embed = edits[0];
  assert.equal(messageSummary(embed), "Alliance Removed; Entitlement Reconciliation Incomplete");
  assert.match(messageDescription(embed) ?? "", /0 of 1 Discord members/);
  assert.doesNotMatch(messageDescription(embed) ?? "", /1 Discord member\*\* was reconciled/);
  assert.match(messageDescription(embed) ?? "", /Application presentation cleanup reported \*\*1 warning\*\*/);
});

function removalResult(affectedDiscordUserIds: string[]) {
  return {
    memberGroup: { memberGroupId: "42", discordGuildId: "guild-1", albionServer: "europe", groupType: "alliance", groupName: "Alliance" },
    displayName: "Alliance [TAG]",
    totalMembershipProfiles: 1,
    ownedMembershipProfiles: 1,
    orphanedMembershipProfiles: 0,
    affectedDiscordUserIds,
    retiredRoleIds: ["role-1"],
    archivedApplicationClassCount: 0,
    deletedApplicationClassCount: 0,
    archivedApplicationClassIds: [],
    deletedApplicationClassIds: [],
    archivedApplicationIds: [],
    archivedApplicationClasses: [],
    deletedApplicationClasses: [],
    archivedApplications: []
  };
}
