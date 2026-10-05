import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { activeGuildCommands } from "../discord/commands.js";
import { messageRows, messageText } from "../testSupport/messageAssertions.js";
import { handleResetButton, handleResetCommand, resetCommand } from "./reset.js";

const administratorPermissions = {
  has: (permission: bigint) => permission === PermissionFlagsBits.Administrator
};

test("reset command remains hidden and has no options", () => {
  const command = resetCommand.toJSON();
  assert.equal(command.name, "reset");
  assert.equal(command.description, "Delete this Discord server's Guild Manager data.");
  assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options ?? [], []);
});

test("reset remains on the 50-command active surface", () => {
  assert.equal(activeGuildCommands.length, 50);
  assert.equal(activeGuildCommands.some((command) => command.name === "reset"), true);
});

test("reset command requires a server administrator", async () => {
  const replies: Array<{ content?: string }> = [];
  const interaction = {
    inGuild: () => true,
    memberPermissions: { has: () => false },
    reply: async (reply: { content?: string }) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;

  await handleResetCommand(interaction);

  assert.equal(
    messageText(replies[0]),
    "Only a server administrator can reset this Discord server's Guild Manager data."
  );
});

test("reset command presents exact RESET and CANCEL buttons", async () => {
  const replies: Array<{
    content?: string;
    components?: Array<{ toJSON(): { components?: Array<{ label?: string; custom_id?: string }> } }>;
  }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    memberPermissions: administratorPermissions,
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    }
  } as unknown as ChatInputCommandInteraction;

  await handleResetCommand(interaction);

  assert.equal(
    messageText(replies[0]),
    "Reset Guild Manager for this Discord server? This permanently deletes only this Discord server's Guild Manager data and configuration. Cancellation changes nothing."
  );
  const buttons = messageRows(replies[0])[0].components ?? [];
  assert.deepEqual(buttons.map((button: { label?: string; custom_id?: string }) => button.label), ["RESET", "CANCEL"]);
  assert.deepEqual(
    buttons.map((button: { label?: string; custom_id?: string }) => button.custom_id),
    ["gm-reset:reset:guild-1:user-1", "gm-reset:cancel:guild-1:user-1"]
  );
});

test("reset confirmation purges only the invoking guild and runs reset follow-up", async () => {
  const events: string[] = [];
  const interaction = {
    customId: "gm-reset:reset:guild-1:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    memberPermissions: administratorPermissions,
    deferUpdate: async () => {
      events.push("defer");
    },
    editReply: async (reply: { content?: string }) => {
      events.push(messageText(reply));
    }
  } as unknown as ButtonInteraction;
  const repository = {
    purgeGuildData: async (discordGuildId: string) => {
      events.push(`purge:${discordGuildId}`);
    }
  } as unknown as Parameters<typeof handleResetButton>[1];

  const handled = await handleResetButton(interaction, repository, async () => {
    events.push("follow-up");
  });

  assert.equal(handled, true);
  assert.deepEqual(events, [
    "defer",
    "purge:guild-1",
    "follow-up",
    "This Discord server's Guild Manager data was reset. Guild Manager is ready to configure again."
  ]);
});

test("reset cancellation leaves the database untouched", async () => {
  let purged = false;
  const updates: Array<{ content?: string; components?: unknown[] }> = [];
  const interaction = {
    customId: "gm-reset:cancel:guild-1:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    memberPermissions: administratorPermissions,
    update: async (update: { content?: string; components?: unknown[] }) => {
      updates.push(update);
    }
  } as unknown as ButtonInteraction;
  const repository = {
    purgeGuildData: async () => {
      purged = true;
    }
  } as unknown as Parameters<typeof handleResetButton>[1];

  const handled = await handleResetButton(interaction, repository, async () => undefined);

  assert.equal(handled, true);
  assert.equal(purged, false);
  assert.equal(updates.length, 1);
  assert.equal(messageText(updates[0]), "Reset cancelled. Nothing was changed.");
  assert.deepEqual(messageRows(updates[0]), []);
});

test("reset buttons reject users other than the initiating administrator", async () => {
  let purged = false;
  const replies: Array<{ content?: string }> = [];
  const interaction = {
    customId: "gm-reset:reset:guild-1:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-2" },
    memberPermissions: administratorPermissions,
    reply: async (reply: { content?: string }) => {
      replies.push(reply);
    }
  } as unknown as ButtonInteraction;
  const repository = {
    purgeGuildData: async () => {
      purged = true;
    }
  } as unknown as Parameters<typeof handleResetButton>[1];

  const handled = await handleResetButton(interaction, repository, async () => undefined);

  assert.equal(handled, true);
  assert.equal(purged, false);
  assert.equal(messageText(replies[0]), "Only the administrator who started the reset can use these buttons.");
});

test("reset confirmation still requires Administrator permission", async () => {
  let purged = false;
  const replies: Array<{ content?: string }> = [];
  const interaction = {
    customId: "gm-reset:reset:guild-1:user-1",
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "user-1" },
    memberPermissions: { has: () => false },
    reply: async (reply: { content?: string }) => {
      replies.push(reply);
    }
  } as unknown as ButtonInteraction;
  const repository = {
    purgeGuildData: async () => {
      purged = true;
    }
  } as unknown as Parameters<typeof handleResetButton>[1];

  const handled = await handleResetButton(interaction, repository, async () => undefined);

  assert.equal(handled, true);
  assert.equal(purged, false);
  assert.equal(
    messageText(replies[0]),
    "Only a server administrator can reset this Discord server's Guild Manager data."
  );
});

for (const cancel of [false, true]) {
  for (const failure of [undefined, "receipt", "cleanup"] as const) {
    test(`reset ${cancel ? "cancellation" : "completion"} safely handles ${failure ?? "successful delivery"}`, async () => {
      const calls: string[] = [];
      const updates: unknown[] = [];
      let purges = 0;
      const interaction = {
        customId: `gm-reset:${cancel ? "cancel" : "reset"}:guild-1:user-1`,
        inGuild: () => true, guildId: "guild-1", user: { id: "user-1" },
        memberPermissions: administratorPermissions, deferred: false, replied: false, ephemeral: null,
        message: { flags: { has: (bit: number) => bit === MessageFlags.IsComponentsV2 || bit === MessageFlags.Ephemeral } },
        deferUpdate: async () => { interaction.deferred = true; calls.push("defer"); },
        update: async (payload: unknown) => { calls.push("update"); updates.push(payload); },
        editReply: async (payload: unknown) => { calls.push("edit"); updates.push(payload); },
        followUp: async (payload: unknown) => {
          calls.push("receipt");
          assert.equal((payload as { flags: number }).flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
          assert.match(messageText(payload), cancel ? /Reset cancelled/ : /data was reset/);
          if (failure === "receipt") throw new Error("uncertain send");
        },
        deleteReply: async () => { calls.push("delete"); if (failure === "cleanup") throw new Error("cleanup failed"); }
      };
      await handleResetButton(interaction as never, { purgeGuildData: async () => { purges++; calls.push("purge"); } } as never, async () => undefined);
      assert.equal(purges, cancel ? 0 : 1);
      assert.deepEqual(calls, [...(cancel ? ["update"] : ["defer", "purge", "edit"]), "receipt", ...(failure === "receipt" ? [] : ["delete"])]);
      assert.equal((updates[0] as { flags: number }).flags, MessageFlags.IsComponentsV2);
      assert.deepEqual(messageRows(updates[0]), []);
      assert.match(messageText(updates[0]), cancel ? /Reset cancelled/ : /data was reset/);
    });
  }
}
