import assert from "node:assert/strict";
import test from "node:test";
import { MessageFlags } from "discord.js";
import { createMemberActionGuard } from "../runtime/memberActionGuard.js";
import { messageText } from "../testSupport/messageAssertions.js";
import { createInteractionRouter } from "./interactionRouter.js";
import { buildTemplateModalId } from "../services/content/rendering.js";

for (const kind of ["command", "autocomplete", "button", "select", "modal"]) {
  test(`blocked ${kind} cannot reach handlers despite Administrator or Integration permissions`, async () => {
    const replies: unknown[] = [], choices: unknown[] = [], errors: unknown[] = [];
    const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async (guild, user) => {
      assert.deepEqual([guild, user], ["guild", "blocked"]); return true;
    } });
    const forbidden = () => assert.fail("blocked actors must be stopped before business or lifecycle routing");
    const router = createInteractionRouter({
      actionGuard: guard,
      lifecycleRepository: { isGuildActive: forbidden },
      entryPanelInteractions: [{ handle: forbidden }],
      logFeedRuntime: { interaction: forbidden },
      logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) }
    } as never);
    await router.handleInteraction({
      type: kind === "autocomplete" ? 4 : kind === "modal" ? 5 : kind === "command" ? 2 : 3,
      createdTimestamp: Date.now(), guildId: "guild", user: { id: "blocked" },
      commandName: "tasks", customId: "content-panel:g:scheduled",
      memberPermissions: { has: () => true }, member: { roles: { cache: new Map([["manager", {}]]) } },
      options: { getSubcommandGroup: () => null, getSubcommand: () => null },
      isAutocomplete: () => kind === "autocomplete", isChatInputCommand: () => kind === "command",
      isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal",
      isRepliable: () => kind !== "autocomplete", responded: false, deferred: false, replied: false,
      reply: async (payload: unknown) => { replies.push(payload); },
      respond: async (payload: unknown) => { choices.push(payload); }
    } as never);
    assert.deepEqual(errors, []);
    if (kind === "autocomplete") {
      assert.deepEqual(choices, [[]]); assert.deepEqual(replies, []);
    } else {
      assert.equal(replies.length, 1);
      assert.match(messageText(replies[0]), /access has been revoked/);
      assert.equal((replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
    }
  });
}

test("a blocked officer cannot use kick and the exclusive wait acknowledges before admission", async () => {
  const calls: string[] = [];
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => { calls.push("access"); return true; } });
  const router = createInteractionRouter({ actionGuard: guard,
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected error") },
    lifecycleRepository: { isGuildActive: () => assert.fail("blocked kick must not route") }
  } as never);
  const interaction = {
    type: 2, createdTimestamp: Date.now(), guildId: "guild", user: { id: "officer" }, commandName: "kick",
    options: { getSubcommandGroup: () => null, getSubcommand: () => null },
    isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => true,
    deferred: false, replied: false, ephemeral: true,
    deferReply: async () => { calls.push("defer"); interaction.deferred = true; },
    editReply: async () => { calls.push("denied"); }
  };
  await router.handleInteraction(interaction as never);
  assert.deepEqual(calls, ["defer", "access", "denied"]);
});

test("an inactive guild kick finishes its prior acknowledgement without a second reply", async () => {
  const replies: unknown[] = [];
  const router = createInteractionRouter({
    actionGuard: createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false }),
    lifecycleRepository: { isGuildActive: async () => false },
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected routing error") }
  } as never);
  const interaction = {
    type: 2, createdTimestamp: Date.now(), guildId: "guild", user: { id: "officer" }, commandName: "kick",
    options: { getSubcommandGroup: () => null, getSubcommand: () => null },
    isAutocomplete: () => false, isChatInputCommand: () => true, isRepliable: () => true, inGuild: () => true,
    isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    deferred: false, replied: false, ephemeral: true,
    deferReply: async () => { interaction.deferred = true; },
    reply: async () => assert.fail("already acknowledged"),
    editReply: async (payload: unknown) => { replies.push(payload); }
  };
  await router.handleInteraction(interaction as never);
  assert.equal(messageText(replies[0]), "Guild Manager is not active on this server.");
});

test("controls arriving during kick receive retry feedback instead of queuing an expiring mutation", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const guard = createMemberActionGuard({ getMemberAccess: async () => undefined, isMemberBlocked: async () => false });
  const kick = guard.runSystem("guild", async () => { entered(); await finish; }, true);
  await ready;
  const replies: unknown[] = [];
  const router = createInteractionRouter({ actionGuard: guard,
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected error") },
    lifecycleRepository: { isGuildActive: () => assert.fail("busy control must not route") }
  } as never);
  await router.handleInteraction({
    type: 3, createdTimestamp: Date.now(), guildId: "guild", user: { id: "user" }, customId: "content-panel:g:scheduled",
    isAutocomplete: () => false, isChatInputCommand: () => false, isRepliable: () => true,
    deferred: false, replied: false, reply: async (payload: unknown) => { replies.push(payload); }
  } as never);
  assert.match(messageText(replies[0]), /Try again shortly/);
  release(); await kick;
});

test("reconnection does not reactivate pre-kick officer controls or private drafts", async () => {
  const lastKick = new Date(Date.now() - 1000);
  for (const [customId, ephemeral] of [
    ["gm-reset:reset:guild:officer", false], ["gm-deactivate:confirm:guild:officer", false],
    ["member-group-delete:group:officer:expiry:confirm", false], ["class-remove:token:confirm", false],
    ["albion-character:character-register:officer:europe:target", false], ["cs:officer:target", false],
    ["some-private-draft:token", true]
  ] as const) {
    const replies: unknown[] = [];
    const router = createInteractionRouter({
      actionGuard: createMemberActionGuard({ isMemberBlocked: async () => false, getMemberAccess: async () => ({ lastKickedAt: lastKick }) }),
      lifecycleRepository: { isGuildActive: () => assert.fail("stale authority must not reach routing") },
      logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected stale-control error") }
    } as never);
    await router.handleInteraction({
      type: 3, createdTimestamp: Date.now(), guildId: "guild", user: { id: "officer" }, customId,
      message: { createdTimestamp: lastKick.getTime() - 1, flags: { has: () => ephemeral } },
      isAutocomplete: () => false, isChatInputCommand: () => false, isModalSubmit: () => false, isRepliable: () => true,
      deferred: false, replied: false, reply: async (payload: unknown) => { replies.push(payload); }
    } as never);
    assert.match(messageText(replies[0]), /issued before your access was revoked/);
  }
});

test("an old shared public panel still routes through fresh feature authorization after reconnection", async () => {
  let routed = false;
  const router = createInteractionRouter({
    actionGuard: createMemberActionGuard({ isMemberBlocked: async () => false,
      getMemberAccess: async () => ({ lastKickedAt: new Date() }) }),
    logFeedRuntime: { interaction: async () => { routed = true; } },
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected shared-panel error") }
  } as never);
  await router.handleInteraction({
    type: 3, createdTimestamp: Date.now(), guildId: "guild", user: { id: "member" }, customId: "entry-panel:accounts:1:balance",
    message: { createdTimestamp: 1, flags: { has: () => false } },
    isAutocomplete: () => false, isChatInputCommand: () => false, isModalSubmit: () => false, isRepliable: () => true
  } as never);
  assert.equal(routed, true);
});

test("actor-bound controls with unavailable issuance time fail closed after a kick", async () => {
  const replies: unknown[] = [];
  const router = createInteractionRouter({
    actionGuard: createMemberActionGuard({ isMemberBlocked: async () => false,
      getMemberAccess: async () => ({ lastKickedAt: new Date() }) }),
    lifecycleRepository: { isGuildActive: () => assert.fail("unknown issuance must not reach routing") },
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected stale-control error") }
  } as never);
  await router.handleInteraction({
    type: 3, createdTimestamp: Date.now(), guildId: "guild", user: { id: "officer" }, customId: "gm-reset:reset:guild:officer",
    message: { flags: { has: () => false } },
    isAutocomplete: () => false, isChatInputCommand: () => false, isModalSubmit: () => false, isRepliable: () => true,
    deferred: false, replied: false, reply: async (payload: unknown) => { replies.push(payload); }
  } as never);
  assert.match(messageText(replies[0]), /issued before your access was revoked/);
});

test("modal envelopes reject pre-kick forms and unwrap newly authorized post-recovery forms", async () => {
  let lastKickedAt: Date | null = null;
  const forms: Array<{ custom_id: string }> = [], replies: unknown[] = [], routed: string[] = [];
  const router = createInteractionRouter({
    actionGuard: createMemberActionGuard({ isMemberBlocked: async () => false,
      getMemberAccess: async () => ({ lastKickedAt }) }),
    lifecycleRepository: { isGuildActive: async () => true },
    logFeedRuntime: { interaction: async (interaction: { isModalSubmit(): boolean; customId: string }, route: () => Promise<void>) => {
      if (interaction.isModalSubmit()) routed.push(interaction.customId); else await route();
    } },
    logger: { debug() {}, info() {}, warn() {}, error: () => assert.fail("unexpected modal routing error") }
  } as never);
  const base = {
    guildId: "guild", user: { id: "officer" }, inGuild: () => true,
    isAutocomplete: () => false, isStringSelectMenu: () => false, isButton: () => false,
    isRepliable: () => true, deferred: false, replied: false,
    reply: async (payload: unknown) => { replies.push(payload); }
  };
  const open = (createdTimestamp: number) => router.handleInteraction({ ...base,
    type: 2, createdTimestamp, commandName: "template", isChatInputCommand: () => true, isModalSubmit: () => false,
    options: { getSubcommandGroup: () => null, getSubcommand: () => "create" },
    showModal: async (payload: { custom_id: string }) => { forms.push(payload); }
  } as never);
  const submit = (customId: string) => router.handleInteraction({ ...base,
    type: 5, createdTimestamp: Date.now(), customId, isChatInputCommand: () => false, isModalSubmit: () => true
  } as never);
  await open(Date.now() - 1000);
  assert.match(forms[0].custom_id, /^gm-modal:/);
  lastKickedAt = new Date(Date.now() - 500);
  await submit(forms[0].custom_id);
  assert.deepEqual(routed, []);
  assert.match(messageText(replies[0]), /form is no longer current/);
  await open(Date.now());
  await submit(forms[1].custom_id);
  assert.deepEqual(routed, [buildTemplateModalId("create")]);
  await submit(buildTemplateModalId("create"));
  assert.equal(routed.length, 1, "raw custom IDs cannot bypass modal issuance validation");
  router.stop();
});
