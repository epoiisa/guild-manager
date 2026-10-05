import assert from "node:assert/strict";
import test from "node:test";
import { OverwriteType, PermissionFlagsBits, type TextChannel } from "discord.js";
import {
  buildTicketConversationPermissionOverwrites,
  setTicketConversationSendPermission
} from "./ticketChannelPermissions.js";

test("open application and ticket conversations allow screenshots for the member and reviewer role", () => {
  assert.deepEqual(
    buildTicketConversationPermissionOverwrites(
      "everyone-role-id",
      "member-id",
      "reviewer-role-id"
    ),
    [
      {
        id: "everyone-role-id",
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: "member-id",
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles
        ]
      },
      {
        id: "reviewer-role-id",
        type: OverwriteType.Role,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles
        ]
      }
    ]
  );
});

test("ticket conversation permissions identify uncached IDs as a member and role", async () => {
  const edits: Array<{
    id: string;
    permissions: { SendMessages: boolean };
    options: { type: OverwriteType };
  }> = [];
  const channel = {
    guild: {
      members: {
        fetch: async () => ({ id: "uncached-member-id" })
      }
    },
    permissionOverwrites: {
      edit: async (
        id: string,
        permissions: { SendMessages: boolean },
        options: { type: OverwriteType }
      ) => {
        edits.push({ id, permissions, options });
      }
    }
  } as unknown as TextChannel;

  await setTicketConversationSendPermission(
    channel,
    "uncached-member-id",
    "reviewer-role-id",
    false
  );

  assert.deepEqual(edits, [
    {
      id: "reviewer-role-id",
      permissions: { SendMessages: false },
      options: { type: OverwriteType.Role }
    },
    {
      id: "uncached-member-id",
      permissions: { SendMessages: false },
      options: { type: OverwriteType.Member }
    }
  ]);
});

test("ticket conversation permissions preserve explicit overwrite types when reopening", async () => {
  const edits: Array<{ allowed: boolean; type: OverwriteType }> = [];
  const channel = {
    guild: {
      members: {
        fetch: async () => ({ id: "member-id" })
      }
    },
    permissionOverwrites: {
      edit: async (
        _id: string,
        permissions: { SendMessages: boolean },
        options: { type: OverwriteType }
      ) => {
        edits.push({ allowed: permissions.SendMessages, type: options.type });
      }
    }
  } as unknown as TextChannel;

  await setTicketConversationSendPermission(channel, "member-id", "role-id", true);

  assert.deepEqual(edits, [
    { allowed: true, type: OverwriteType.Role },
    { allowed: true, type: OverwriteType.Member }
  ]);
});

test("ticket conversation permissions skip a departed member overwrite and still update reviewers", async () => {
  const edits: Array<{ id: string; allowed: boolean; type: OverwriteType }> = [];
  const channel = {
    guild: {
      members: {
        fetch: async () => Promise.reject({ code: 10_007 })
      }
    },
    permissionOverwrites: {
      edit: async (
        id: string,
        permissions: { SendMessages: boolean },
        options: { type: OverwriteType }
      ) => {
        edits.push({ id, allowed: permissions.SendMessages, type: options.type });
      }
    }
  } as unknown as TextChannel;

  await setTicketConversationSendPermission(channel, "departed-member-id", "reviewer-role-id", false);

  assert.deepEqual(edits, [
    { id: "reviewer-role-id", allowed: false, type: OverwriteType.Role }
  ]);
});

test("ticket conversation permissions tolerate departure between member lookup and overwrite edit", async () => {
  const editedIds: string[] = [];
  const channel = {
    guild: {
      members: {
        fetch: async () => ({ id: "departing-member-id" })
      }
    },
    permissionOverwrites: {
      edit: async (id: string) => {
        editedIds.push(id);
        if (id === "departing-member-id") throw { code: 10_009 };
      }
    }
  } as unknown as TextChannel;

  await setTicketConversationSendPermission(channel, "departing-member-id", "reviewer-role-id", false);

  assert.deepEqual(editedIds, ["reviewer-role-id", "departing-member-id"]);
});
