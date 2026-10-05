import { createUnblockedMemberActionGuard, passThroughModalSessions } from "../testSupport/memberActionGuard.js";
import { MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { messageDescription, messageSummary, messageText } from "../testSupport/messageAssertions.js";
import { createInteractionRouter, interactionFailureResponse, isDefinitivePresentationFailure } from "./interactionRouter.js";
import { OperationalMessageLayoutError } from "./operationalMessages.js";

test("interaction router retains the inactive autocomplete acknowledgement", async () => {
  const responses: unknown[][] = [];
  const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
    lifecycleRepository: { isGuildActive: async () => false },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  } as never);
  await router.handleInteraction({
    user: { id: "actor" }, createdTimestamp: Date.now(),
    isAutocomplete: () => true,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
    isRepliable: () => false,
    inGuild: () => true,
    guildId: "guild-1",
    respond: async (choices: unknown[]) => { responses.push(choices); }
  } as never);
  assert.deepEqual(responses, [[]]);
});

test("interaction failure response retains giveaway wording in a failure Container", () => {
  const response = interactionFailureResponse({
    isChatInputCommand: () => true,
    commandName: "giveaway",
    options: { getSubcommandGroup: () => null }
  } as never);
  assert.equal(messageSummary(response), "Giveaway Command Failed: Guild Manager could not complete that command.");
  assert.equal(messageDescription(response), "Giveaway Command Failed: Guild Manager could not complete that command.");
});

test("router emits one terminal event and chooses the correct failure acknowledgement", async () => {
  for (const state of [
    { deferred: false, replied: false, ephemeral: null, expected: "reply" },
    { deferred: true, replied: false, ephemeral: true, expected: "editReply" },
    { deferred: true, replied: false, ephemeral: null, expected: "followUp" }
  ]) {
    const calls: string[] = [];
    const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
      lifecycleRepository: { isGuildActive: async () => { throw new Error("database unavailable"); } },
      logger: {
        debug() {}, warn() {},
        info: (message: string, context?: Record<string, unknown>) => logs.push({ message, context }),
        error: (message: string, context?: Record<string, unknown>) => logs.push({ message, context })
      }
    } as never);
    await router.handleInteraction({
      user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "guild-1", commandName: "ping",
      deferred: state.deferred, replied: state.replied, ephemeral: state.ephemeral,
      isChatInputCommand: () => true, isAutocomplete: () => false, isStringSelectMenu: () => false,
      isButton: () => false, isModalSubmit: () => false, isRepliable: () => true, inGuild: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => null }, type: 2,
      reply: async () => { calls.push("reply"); }, editReply: async () => { calls.push("editReply"); }, followUp: async () => { calls.push("followUp"); }
    } as never);
    assert.deepEqual(calls, [state.expected]);
    assert.equal(logs.filter((entry) => entry.message === "interaction failed").length, 1);
    assert.equal(logs.filter((entry) => entry.message === "chat input command handled").length, 1);
    assert.equal(logs.find((entry) => entry.message === "chat input command handled")?.context?.outcome, "unhandled_error");
  }
});

test("router falls back to one empty autocomplete response after an error", async () => {
  const calls: unknown[][] = [];
  const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
    lifecycleRepository: { isGuildActive: async () => { throw new Error("database unavailable"); } },
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  } as never);
  await router.handleInteraction({
    user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "guild-1", responded: false,
    isChatInputCommand: () => false, isAutocomplete: () => true, isStringSelectMenu: () => false,
    isButton: () => false, isModalSubmit: () => false, isRepliable: () => false, inGuild: () => true,
    respond: async (choices: unknown[]) => { calls.push(choices); }, type: 4
  } as never);
  assert.deepEqual(calls, [[]]);
});

test("router retains inactive string-select and direct-message modal/chat-input gates", async () => {
  const replies: string[] = [];
  const inactiveRouter = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
    lifecycleRepository: { isGuildActive: async () => false }, logger: { debug() {}, info() {}, warn() {}, error() {} }
  } as never);
  await inactiveRouter.handleInteraction({
    user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "guild-1", isAutocomplete: () => false, isStringSelectMenu: () => true,
    isChatInputCommand: () => false, isButton: () => false, isModalSubmit: () => false, inGuild: () => true,
    isRepliable: () => true, reply: async (response: { content: string }) => { replies.push(messageText(response)); }, type: 3
  } as never);
  for (const modal of [true, false]) {
    await inactiveRouter.handleInteraction({
      user: { id: "actor" }, createdTimestamp: Date.now(), guildId: null, commandName: "ping", isAutocomplete: () => false, isStringSelectMenu: () => false,
      isChatInputCommand: () => !modal, isButton: () => false, isModalSubmit: () => modal, inGuild: () => false,
      isRepliable: () => true, options: { getSubcommandGroup: () => null, getSubcommand: () => null },
      customId: "test-modal",
      reply: async (response: { content: string }) => { replies.push(messageText(response)); }, type: 5
    } as never);
  }
  assert.deepEqual(replies, [
    "Guild Manager is not active on this server.",
    "Guild Manager commands can only be used from a Discord server.",
    "Guild Manager commands can only be used from a Discord server."
  ]);
});

test("new panel component families require activation and route before older handlers", async () => {
  for (const active of [true, false]) for (const kind of ["button", "select", "modal"]) {
    const calls: string[] = [];
    const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
      lifecycleRepository: { isGuildActive: async () => active },
      contentPanelInteractions: { handleButton: async () => calls.push("button"), handleSelect: async () => calls.push("select"), handleModal: async () => calls.push("modal") },
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    } as never);
    await router.handleInteraction({
      user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "g", customId: kind === "button" ? "content-panel:g:scheduled" : "content-host:d:form:1",
      isAutocomplete: () => false, isChatInputCommand: () => false, isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isModalSubmit: () => kind === "modal",
      isRepliable: () => true, inGuild: () => true, reply: async () => calls.push("inactive")
    } as never);
    assert.deepEqual(calls, [active ? kind : "inactive"]);
  }
});

test("Content modal error responses complete a private deferReply with suppressed one-line feedback", async () => {
  const replies: Array<Record<string, unknown>> = [];
  const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
    lifecycleRepository: { isGuildActive: async () => { throw new Error("unavailable"); } },
    logger: { error() {}, warn() {}, info() {}, debug() {} }
  } as never);
  await router.handleInteraction({
    user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "g", customId: "content-host:d:form:1", type: 5,
    deferred: true, replied: false, ephemeral: true,
    isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => true,
    isAutocomplete: () => false, isChatInputCommand: () => false, inGuild: () => true, isRepliable: () => true,
    editReply: async (value: Record<string, unknown>) => replies.push(value)
  } as never);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, MessageFlags.SuppressEmbeds);
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal((replies[0].components as unknown[]).length, 0);
  assert.equal(replies[0].content, "Guild Manager could not complete that command.");
  assert.deepEqual(replies[0].embeds, []);
});

test("all feature control families, including giveaway role selectors and upload modals, reach their controllers", async () => {
  for (const family of ["entry-panel:giveaways:g:host", "account-entry:d:recipient", "regear-entry:d:content", "weapon-entry:d:tree", "giveaway-panel:d:role", "giveaway-panel:d:form:1"]) {
    for (const active of [true, false]) {
      const replies: any[] = []; let handled = 0;
      const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(), lifecycleRepository: { isGuildActive: async () => active },
        entryPanelInteractions: [{ handle: async () => { handled++; return true; } }],
        logger: { debug() {}, info() {}, warn() {}, error() {} } } as never);
      const modal = family.includes(":form:");
      await router.handleInteraction({ user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "guild", customId: family,
        isButton: () => family.startsWith("entry-panel:"), isAnySelectMenu: () => !modal, isStringSelectMenu: () => false,
        isModalSubmit: () => modal, isAutocomplete: () => false, isChatInputCommand: () => false, isRepliable: () => true, inGuild: () => true,
        reply: async (payload: any) => replies.push(payload) } as never);
      assert.equal(handled, active ? 1 : 0, family);
      if (!active) assert.match(JSON.stringify(replies[0]), /Start Again: This control is no longer current/);
    }
  }
});

test("emergency text is limited to a definitive presentation failure", async () => {
  assert.equal(isDefinitivePresentationFailure(new OperationalMessageLayoutError("Invalid layout")), true);
  assert.equal(isDefinitivePresentationFailure({ code: 50035 }), true);
  for (const error of [new Error("timeout"), { code: 50013 }, { code: 10062 }, { status: 500 }]) {
    assert.equal(isDefinitivePresentationFailure(error), false);
  }
  for (const deferred of [false, true]) for (const code of [50035, 50013, undefined]) {
    const replies: Array<{ method: string; payload: any }> = [];
    let businessCalls = 0;
    const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(), modalSessions: passThroughModalSessions(),
      lifecycleRepository: { isGuildActive: async () => { businessCalls++; throw new Error("database unavailable"); } },
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    } as never);
    const send = async (method: string, payload: any) => {
      replies.push({ method, payload });
      if (replies.length === 1) throw code ? { code } : new Error("timeout");
    };
    await router.handleInteraction({
      user: { id: "actor" }, createdTimestamp: Date.now(), guildId: "guild", commandName: "ping", deferred, replied: false, ephemeral: deferred ? true : null,
      isChatInputCommand: () => true, isAutocomplete: () => false, isStringSelectMenu: () => false,
      isButton: () => false, isModalSubmit: () => false, isRepliable: () => true, inGuild: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => null }, type: 2,
      reply: (p: any) => send("reply", p), editReply: (p: any) => send("edit", p), followUp: (p: any) => send("followUp", p)
    } as never);
    assert.equal(businessCalls, 1, "never repeat the business action");
    assert.equal(replies.length, code === 50035 ? 2 : 1);
    assert.equal(messageText(replies[0].payload), "Guild Manager could not complete that command.");
    if (code === 50035) {
      assert.equal(replies[1].method, deferred ? "followUp" : "reply", "never downgrade a V2 message by editing it");
      assert.deepEqual(replies[1].payload, { content: "Guild Manager could not complete that command.", flags: 64, allowedMentions: { parse: [], repliedUser: false } });
    }
  }
});
