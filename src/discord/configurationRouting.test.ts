import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { channelCommand } from "../commands/channel.js";
import { managerCommand } from "../commands/manager.js";
import { activationGuildCommands, activeGuildCommands } from "./commands.js";
import { createInteractionRouter } from "./interactionRouter.js";

test("shared configuration is registered once and retired configuration surfaces are absent", () => {
  for (const builder of [channelCommand, managerCommand]) {
    const command = builder.toJSON();
    assert.deepEqual(activeGuildCommands.filter(item => item.name === command.name), [command]);
    assert.equal(activationGuildCommands.some(item => item.name === command.name), false);
  }
  assert.ok(activeGuildCommands.every(command => command.default_member_permissions === "0"));
  assert.ok(activeGuildCommands.every(command => !["configuration", "content", "reviewer", "voice"].includes(command.name)));
  for (const name of ["account", "regear", "specialisation", "giveaway"]) {
    const command = activeGuildCommands.find(item => item.name === name)!;
    assert.ok(command.options?.every(option => !["channel", "manager", "host"].includes(option.name)));
  }
  assert.deepEqual(activeGuildCommands.find(command => command.name === "utc")?.options?.map(option => option.name), ["add", "remove"]);
});

for (const commandName of ["channel", "manager"]) {
  for (const mode of ["inactive", "member", "administrator"] as const) {
    test(`${commandName} routing enforces activation and Administrator access before configuration reads (${mode})`, async () => {
      const replies: unknown[] = [];
      const reads: string[] = [];
      const errors: unknown[] = [];
      const read = async (guildId: string) => { assert.equal(guildId, "guild"); reads.push(guildId); return undefined; };
      const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
        logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
        lifecycleRepository: { isGuildActive: async () => mode !== "inactive" },
        contentRepository: { getContentChannel: read },
        temporaryVoiceService: { getConfig: read },
        reviewerRepository: { listBindings: async (guildId: string) => { await read(guildId); return []; } },
        entryPanelService: { captureFence: () => () => true, context: { repository: {
          getChannel: read,
          listRoles: async (guildId: string) => { await read(guildId); return []; }
        } } }
      } as never);
      const interaction = {
        type: 2, createdTimestamp: Date.now(), guildId: "guild", commandName,
        user: { id: "caller", bot: false },
        guild: { id: "guild", members: { fetch: async () => ({ user: { bot: false }, permissions: { has: () => mode === "administrator" } }) } },
        deferred: false, replied: false,
        inGuild: () => true, isChatInputCommand: () => true, isAutocomplete: () => false,
        isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => true,
        options: { getSubcommandGroup: () => null, getSubcommand: () => commandName === "channel" ? "show" : "list", getString: () => null },
        deferReply: async () => { interaction.deferred = true; },
        reply: async (payload: unknown) => { replies.push(payload); },
        editReply: async (payload: unknown) => { replies.push(payload); }
      };
      await router.handleInteraction(interaction as never);
      assert.deepEqual(errors, []);
      assert.equal(reads.length, mode === "administrator" ? commandName === "channel" ? 6 : 3 : 0);
      assert.equal(replies.length, 1);
      assert.match(JSON.stringify(replies), mode === "inactive" ? /Inactive|not active/ : mode === "member" ? /Discord Administrator/ : commandName === "channel" ? /System Channels/ : /Manager Roles/);
    });
  }
}
