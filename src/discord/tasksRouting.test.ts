import { createUnblockedMemberActionGuard } from "../testSupport/memberActionGuard.js";
import { ComponentType, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { tasksCommand } from "../commands/tasks.js";
import type { TasksSnapshot } from "../db/tasksRepository.js";
import { messageText } from "../testSupport/messageAssertions.js";
import { activationGuildCommands, activeGuildCommands } from "./commands.js";
import { createInteractionRouter } from "./interactionRouter.js";

test("tasks is registered once for active guilds and absent from activation-only commands", () => {
  assert.deepEqual(activeGuildCommands.filter((command) => command.name === "tasks"), [tasksCommand.toJSON()]);
  assert.equal(activationGuildCommands.some((command) => command.name === "tasks"), false);
});

test("tasks routing preserves the server-only and active-guild guards before report reads", async () => {
  const replies: Array<{ content: string; flags: number }> = [];
  const errors: unknown[] = [];
  let lifecycleReads = 0;
  const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
    logger: logger(errors),
    lifecycleRepository: { isGuildActive: async () => { lifecycleReads += 1; return false; } },
    tasksRepository: { getSnapshot: async () => assert.fail("guarded report must not query tasks") },
    regearRepository: { listEffectiveAdminServers: async () => assert.fail("guarded report must not resolve access") },
    reviewerRepository: { effectiveRoleIds: async () => assert.fail("guarded report must not resolve reviewers") }
  } as never);
  const reply = async (response: { content: string; flags: number }) => { replies.push(response); };
  await router.handleInteraction(tasksInteraction({ reply }));
  await router.handleInteraction(tasksInteraction({ reply, guildId: null, guild: null, inGuild: () => false }));
  assert.deepEqual(replies.map(messageText), [
    "Guild Manager is not active on this server.",
    "Guild Manager commands can only be used from a Discord server."
  ]);
  assert.ok(replies.every(reply => reply.flags === (MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds)));
  assert.equal(lifecycleReads, 1);
  assert.deepEqual(errors, []);
});

test("active tasks routing returns identical serverwide V2 queues independent of caller roles or Administrator status", async () => {
  const errors: unknown[] = [];
  const acknowledgements: unknown[] = [];
  const edits: any[] = [];
  const reads: unknown[][] = [];
  const openedAt = new Date("2026-09-01T00:00:00Z");
  const snapshot: TasksSnapshot = {
    discordGuildId: "guild-1",
    applications: [{ applicationId: "application-1", name: "Membership", applicantDiscordUserId: "caller-1", ticketChannelId: "application-channel", status: "accepted", characterResolutionState: "selected", createdAt: openedAt }],
    tickets: [{ ticketId: "ticket-1", name: "Support", openerDiscordUserId: "another-user", ticketChannelId: "ticket-channel", createdAt: openedAt }],
    regearContents: [{ regearContentId: "content-1", name: "Open intake", albionServer: "asia", contentDate: "2026-09-01", createdAt: openedAt }],
    regears: [{ regearClaimId: "claim-1", characterName: "Character", contentName: "Closed intake", contentDate: "2026-08-31", albionServer: "europe", requestedValue: 100n, submittedAt: openedAt }],
    specialisations: [{ specialisationRequestId: "proof-1", characterName: "Character", targetDisplayName: "Sword", level: 100, submittedByDiscordUserId: "another-user", albionServer: "americas", createdAt: openedAt }]
  };
  const forbiddenAccess = new Proxy({}, { get: () => assert.fail("tasks must not inspect domain authorization or Discord resources") });
  const router = createInteractionRouter({ actionGuard: createUnblockedMemberActionGuard(),
    logger: logger(errors),
    lifecycleRepository: { isGuildActive: async (guildId: string) => { assert.equal(guildId, "guild-1"); return true; } },
    regearRepository: forbiddenAccess,
    reviewerRepository: forbiddenAccess,
    tasksRepository: { getSnapshot: async (...args: unknown[]) => { reads.push(args); return snapshot; } }
  } as never);
  for (const [id, roles, administrator] of [
    ["caller-1", [], false],
    ["caller-2", ["reviewer-role"], false],
    ["caller-3", [], true]
  ] as const) {
    await router.handleInteraction(tasksInteraction({
      user: { id },
      guild: { id: "guild-1", roles: forbiddenAccess, channels: forbiddenAccess, members: forbiddenAccess },
      member: { roles: { cache: new Map(roles.map((role) => [role, {}])) } },
      memberPermissions: { has: () => administrator },
      deferReply: async (response: unknown) => { acknowledgements.push(response); },
      editReply: async (response: unknown) => { edits.push(response); }
    }));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(reads, [["guild-1"], ["guild-1"], ["guild-1"]]);
  assert.deepEqual(acknowledgements, Array.from({ length: 3 }, () => ({ flags: MessageFlags.Ephemeral })));
  assert.equal(edits.length, 3);
  const normalized = edits.map((edit) => JSON.parse(JSON.stringify(edit)));
  assert.deepEqual(normalized[1], normalized[0]);
  assert.deepEqual(normalized[2], normalized[0]);
  const response = normalized[0];
  assert.equal(response.flags, MessageFlags.IsComponentsV2);
  assert.equal(response.embeds, undefined);
  assert.equal(response.content, undefined);
  assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(response.components.length, 1);
  const container = response.components[0];
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x3b82f6);
  const text = container.components.map((component: { content?: string }) => component.content ?? "").join("\n");
  for (const heading of ["Applications", "General Tickets", "Open Re-Geared Content", "Pending Re-Gear Requests", "Pending Weapon Specialisation Requests"]) {
    assert.ok(text.includes(`### ${heading} (1)`), heading);
  }
  assert.ok(text.includes(" • Accepted\n"));
  assert.ok(text.includes(" • Open • 1 September 2026"));
  assert.ok(text.includes("No current owner"));
  assert.ok(text.includes("<@caller-1>"));
  assert.ok(text.includes("<@another-user>"));
});

function logger(errors: unknown[]) {
  return { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => { errors.push(args); } };
}

function tasksInteraction(overrides: Record<string, unknown> = {}) {
  return {
    createdTimestamp: Date.now(), guildId: "guild-1", commandName: "tasks", user: { id: "caller-1" },
    guild: { id: "guild-1", roles: { cache: new Map(), fetch: async () => assert.fail("no configured role needs fetching") } },
    member: { roles: { cache: new Map([["caller-role", {}]]) } }, memberPermissions: { has: () => false },
    deferred: false, replied: false, ephemeral: null, type: 2,
    inGuild: () => true, isChatInputCommand: () => true, isAutocomplete: () => false,
    isStringSelectMenu: () => false, isButton: () => false, isModalSubmit: () => false, isRepliable: () => true,
    options: { getSubcommandGroup: () => null, getSubcommand: () => null },
    reply: async () => assert.fail("active tasks should defer"),
    deferReply: async () => assert.fail("guarded tasks should not defer"),
    editReply: async () => assert.fail("guarded tasks should not edit"),
    followUp: async () => assert.fail("small reports should not need follow-ups"),
    ...overrides
  } as never;
}
