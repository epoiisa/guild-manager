import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { activationGuildCommands, activeGuildCommands } from "./commands.js";
import { createInteractionRouter } from "./interactionRouter.js";

test("character purge is absent from both command registries", () => {
  assert.equal([...activationGuildCommands, ...activeGuildCommands].some(command => command.name === "purge"), false);
});

for (const autocomplete of [false, true]) {
  test(`a stale purge ${autocomplete ? "autocomplete" : "command"} cannot access character records`, async () => {
    const errors: unknown[] = [];
    const warnings: string[] = [];
    const forbidden = new Proxy({}, { get: () => assert.fail("retired purge must not read or mutate character records") });
    const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
      logger: { debug() {}, info() {}, warn: (message: string) => warnings.push(message), error: (...args: unknown[]) => errors.push(args) },
      lifecycleRepository: { isGuildActive: async () => true },
      membershipRepository: forbidden
    } as never);
    const interaction = {
      type: autocomplete ? 4 : 2, createdTimestamp: Date.now(), guildId: "guild", guild: { id: "guild" },
      commandName: "purge", user: { id: "officer" },
      deferred: false, replied: false, responded: false,
      inGuild: () => true, inCachedGuild: () => true, isChatInputCommand: () => !autocomplete, isAutocomplete: () => autocomplete,
      isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isRepliable: () => !autocomplete,
      options: { getSubcommandGroup: () => null, getSubcommand: () => null },
      reply: async () => assert.fail("retired purge must not produce a command response"),
      deferReply: async () => assert.fail("retired purge must not begin a mutation"),
      respond: async () => assert.fail("retired purge must not offer character choices")
    };
    await router.handleInteraction(interaction as never);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, autocomplete ? [] : ["unknown command received"]);
  });
}
