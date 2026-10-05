import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createReactionEventCoordinator } from "./reactionEventCoordinator.js";
import { createKeyedSerialQueue } from "../services/reactionRoles/keyedSerialQueue.js";
import { reactionRoleConfigChangeKey } from "../services/reactionRoles/subscriptions.js";
import { createMemberActionGuard } from "../runtime/memberActionGuard.js";

test("blocked reactions cannot enter giveaways or restore subscriptions, including partial events", async () => {
  const errors: unknown[] = [];
  const forbidden = () => assert.fail("blocked reactions must not enter domain handling");
  const coordinator = createReactionEventCoordinator({
    actionGuard: createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => true }),
    logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
    lifecycleRepository: { isGuildActive: forbidden }
  } as never);
  for (const emoji of ["🎁", "✅"]) for (const subscribe of [true, false]) {
    coordinator.handleReactionChange({
      partial: true, fetch: forbidden, emoji: { id: null, name: emoji },
      message: { guildId: "guild", id: "message", guild: { id: "guild" } }
    } as never, { id: "blocked", bot: false, partial: true, fetch: forbidden } as never, subscribe);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
  coordinator.stop();
});

test("reaction coordinator gives an open giveaway precedence over a mapped reaction role", async () => {
  const calls: string[] = [];
  const coordinator = createReactionEventCoordinator({ actionGuard: createUnblockedMemberActionGuard(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    lifecycleRepository: { isGuildActive: async () => true },
    membershipRepository: {},
    reactionRoleRepository: {
      getPlacementByReaction: async () => {
        calls.push("placement");
        return { reactionRoleConfigId: "role-config" };
      }
    },
    giveawayRepository: {
      getByMessage: async () => {
        calls.push("giveaway");
        return { giveawayId: "giveaway-1", state: "open" };
      },
      isManagedUser: async () => true,
      addReaction: async () => { calls.push("join"); }
    },
    giveawayService: { refreshOpenMessage: async () => undefined }
  } as never);
  coordinator.handleReactionChange({
    partial: false,
    emoji: { id: null, name: "🎁" },
    message: { guildId: "guild-1", id: "message-1", guild: { id: "guild-1" } },
    users: { remove: async () => undefined }
  } as never, { id: "user-1", bot: false, partial: false } as never, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();
  assert.deepEqual(calls, ["placement", "giveaway", "join"]);
});

test("reaction processing waits for the injected matching configuration queue", async () => {
  const configurationQueue = createKeyedSerialQueue();
  let releaseConfiguration!: () => void;
  const configurationBlocked = new Promise<void>((resolve) => { releaseConfiguration = resolve; });
  const calls: string[] = [];
  void configurationQueue.enqueue(
    reactionRoleConfigChangeKey("guild-1", "role-config"),
    async () => configurationBlocked
  );
  const coordinator = createReactionEventCoordinator({ actionGuard: createUnblockedMemberActionGuard(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    lifecycleRepository: { isGuildActive: async () => true },
    membershipRepository: {},
    reactionRoleRepository: {
      getPlacementByReaction: async () => ({ reactionRoleConfigId: "role-config" }),
      isManagedUser: async () => true,
      subscribe: async () => { calls.push("subscribed"); }
    },
    giveawayRepository: { getByMessage: async () => undefined },
    giveawayService: { refreshOpenMessage: async () => undefined },
    reactionRoleConfigQueue: configurationQueue
  } as never);
  coordinator.handleReactionChange({
    partial: false,
    emoji: { id: null, name: "✅" },
    message: { guildId: "guild-1", id: "message-1", guild: { id: "guild-1" } },
    users: { remove: async () => undefined }
  } as never, { id: "user-1", bot: false, partial: false } as never, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  releaseConfiguration();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();
  assert.deepEqual(calls, ["subscribed"]);
});

test("reaction coordinator fetches partials and suppresses its own dormant-reaction removal", async () => {
  const calls: string[] = [];
  const coordinator = createReactionEventCoordinator({ actionGuard: createUnblockedMemberActionGuard(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    lifecycleRepository: { isGuildActive: async () => true }, membershipRepository: {},
    reactionRoleRepository: {
      getPlacementByReaction: async () => ({ reactionRoleConfigId: "role-config" }),
      isManagedUser: async () => false,
      unsubscribe: async () => { calls.push("unsubscribe"); }
    },
    giveawayRepository: { getByMessage: async () => undefined },
    giveawayService: { refreshOpenMessage: async () => undefined },
    reactionRoleConfigQueue: createKeyedSerialQueue()
  } as never);
  const resolvedReaction = {
    partial: false, emoji: { id: null, name: "✅" },
    message: { guildId: "guild-1", id: "message-1", guild: { id: "guild-1" } },
    users: { remove: async () => { calls.push("remove"); } }
  };
  coordinator.handleReactionChange({ ...resolvedReaction, partial: true, fetch: async () => { calls.push("reaction-fetch"); return resolvedReaction; } } as never,
    { id: "user-1", bot: false, partial: true, fetch: async () => { calls.push("user-fetch"); return { id: "user-1", bot: false, partial: false }; } } as never, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.handleReactionChange(resolvedReaction as never, { id: "user-1", bot: false, partial: false } as never, false);
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();
  assert.deepEqual(calls, ["reaction-fetch", "user-fetch", "remove"]);
});

test("stop cancels a pending remove-all giveaway render", async () => {
  let renders = 0;
  const coordinator = createReactionEventCoordinator({ actionGuard: createUnblockedMemberActionGuard(),
    logger: { debug() {}, info() {}, warn() {}, error() {} }, lifecycleRepository: {}, membershipRepository: {}, reactionRoleRepository: {},
    giveawayRepository: {
      removeReactionsForMessage: async () => undefined,
      getOpenByMessage: async () => ({ giveawayId: "giveaway-1", state: "open" })
    },
    giveawayService: { refreshOpenMessage: async () => { renders += 1; } }, reactionRoleConfigQueue: createKeyedSerialQueue()
  } as never);
  coordinator.handleRemoveAll({ guildId: "guild-1", id: "message-1", guild: { id: "guild-1" } } as never);
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.equal(renders, 0);
});
