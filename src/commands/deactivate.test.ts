import { assertV2Card, v2Rows } from "../testSupport/messageAssertions.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { handleDeactivateButton, handleDeactivateCommand } from "./deactivate.js";

test("deactivate presents the requested confirmation Container and buttons", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    components?: Array<{ toJSON(): { components?: Array<{ label?: string }> } }>;
  }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    reply: async (reply: typeof replies[number]) => replies.push(reply)
  } as unknown as ChatInputCommandInteraction;

  await handleDeactivateCommand(interaction);

  assertV2Card(replies[0], {
    color: 0xef4444,
    title: "Deactivate Guild Manager",
    description: [
      "Are you sure you want to deactivate Guild Manager?",
      "- Guild Manager data and configuration will be permanently deleted.",
      "- The UTC time channel will be deleted.",
      "- No other existing channels, messages, roles, and permissions will be changed.",
      "- Only `/activate` will remain available."
    ].join("\n")
  });
  assert.deepEqual(
    v2Rows(replies[0])[0].components.map((button: any) => button.label),
    ["Deactivate", "Cancel"]
  );
});

test("confirmed deactivation presents the requested completion Container", async () => {
  const events: string[] = [];
  const updates: Array<{
    embeds?: Array<{ toJSON(): { title?: string; description?: string } }>;
    components?: unknown[];
  }> = [];
  const interaction = {
    customId: "gm-deactivate:confirm:guild-1:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    deferUpdate: async () => undefined,
    editReply: async (update: typeof updates[number]) => updates.push(update)
  } as unknown as ButtonInteraction;
  const repository = {
    purgeGuildImmediately: async () => {
      events.push("purge");
    }
  } as unknown as Parameters<typeof handleDeactivateButton>[1];

  const handled = await handleDeactivateButton(
    interaction,
    repository,
    async () => {
      events.push("commands");
    },
    async () => {
      events.push("external-cleanup");
    }
  );

  assert.equal(handled, true);
  assert.deepEqual(events, ["external-cleanup", "purge", "commands"]);
  assertV2Card(updates[0], {
    color: 0x22c55e,
    title: "Guild Manager Deactivated",
    description: [
      "Guild Manager has been deactivated.",
      "- Guild Manager data and configuration has been permanently deleted.",
      "- The UTC time channel has been deleted.",
      "- No other existing channels, messages, roles, and permissions were changed.",
      "- Use `/activate` to activate Guild Manager again."
    ].join("\n")
  });
  assert.deepEqual(v2Rows(updates[0]), []);
});
