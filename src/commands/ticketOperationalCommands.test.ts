import { ChannelType, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { handleTicketAutocomplete, handleTicketButton, handleTicketCommand, handleTicketModalSubmit, handleTicketsCommand, ticketCommand, ticketsCommand } from "./ticket.js";

test("ticket operational command leaves are separated from administrative leaves, descriptions, permissions, and optional target shape", () => {
  const json = ticketCommand.toJSON();
  assert.equal(json.default_member_permissions, "0");
  assert.deepEqual(json.options?.map((option) => option.name), ["close", "reopen", "delete"]);
  assert.deepEqual(ticketsCommand.toJSON().options?.map((option) => option.name), ["list", "show", "create", "button", "messages", "disable", "remove"]);
  const expected = new Map([["close", "Close an open general ticket."], ["reopen", "Reopen a closed general ticket."], ["delete", "Permanently delete a closed general ticket channel."]]);
  for (const [name, description] of expected) {
    const leaf = json.options?.find((option) => option.name === name) as { description?: string; options?: Array<{ type?: number; name?: string; description?: string; required?: boolean; autocomplete?: boolean }> } | undefined;
    assert.equal(leaf?.description, description);
    assert.deepEqual(leaf?.options?.map((option) => ({ type: option.type, name: option.name, description: option.description, required: option.required, autocomplete: option.autocomplete })), [{ type: 3, name: "ticket", description: "Ticket target; omit in its ticket channel.", required: false, autocomplete: true }]);
  }
});

test("ticket class reports are handled by the plural configuration command", async () => {
  const events: string[] = [];
  const replies: unknown[] = [];
  const ticketClass = { ticketClassId: "class", discordGuildId: "guild", name: "Support", ticketCategoryId: "category", reviewerRoleId: "reviewer", enabled: true };
  const repository = {
    listTicketClasses: async () => { events.push("list"); return [ticketClass]; },
    getTicketClass: async () => { events.push("show"); return ticketClass; }
  };
  const interaction = (subcommand: "list" | "show") => ({
    guildId: "guild",
    guild: { channels: { cache: new Map([["category", { name: "Tickets" }]]) } },
    inGuild: () => true,
    options: { getSubcommandGroup: () => null, getSubcommand: () => subcommand, getString: () => "class" },
    reply: async (payload: unknown) => { replies.push(payload); },
    deferReply: async () => { events.push("defer"); },
    editReply: async (payload: unknown) => { replies.push(payload); }
  });

  await handleTicketsCommand(interaction("list") as never, repository as never);
  await handleTicketsCommand(interaction("show") as never, repository as never);

  assert.deepEqual(events, ["defer", "list", "defer", "show"]);
  assert.deepEqual(replies.map(title), ["Tickets", "Support"]);
});

test("close resolves current-channel and explicit targets, defers first, edits canonical controls, persists, and reports exactly", async () => {
  const current = ticketHarness({ action: "close" });
  await handleTicketCommand(current.command as never, current.repository as never);
  assert.deepEqual(current.events, ["defer", "permission:false", "permission:false", "close", "send:Ticket Closed", "persist", "edit:control"]);
  assert.equal(title(current.replies.at(-1)), "<#channel> was closed.");
  assert.equal(description(current.replies.at(-1)), "<#channel> was closed.");

  const explicit = ticketHarness({ action: "close", commandChannelId: "outside", supplied: "ticket" });
  await handleTicketCommand(explicit.command as never, explicit.repository as never);
  assert.equal(title(explicit.replies.at(-1)), "<#channel> was closed.");
  assert.ok(explicit.events.indexOf("defer") < explicit.events.indexOf("close"));
});

test("a missing canonical ticket message is replaced with a complete non-notifying V2 closed control card", async () => {
  const h = ticketHarness({ action: "close", missingControl: true });
  await handleTicketCommand(h.command as never, h.repository as never);
  assert.deepEqual(h.sent.map(title), ["Ticket Closed"]);
  assert.equal(h.sent[0].flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(h.sent[0].allowedMentions, { parse: [], repliedUser: false });
  const card = h.sent[0].components[0].toJSON();
  assert.deepEqual(card.components.at(-1).components.map((button: any) => button.label), ["Reopen", "Delete"]);
});

test("target required, mismatch, not found, and fetched unavailable errors are exact and deferred", async () => {
  const scenarios = [
    { commandChannelId: "outside", expected: "Run this command in a ticket channel or choose a ticket." },
    { commandChannelId: "channel", supplied: "missing", expected: "Choose an active ticket." },
    { commandChannelId: "outside", supplied: "missing", expected: "Choose an active ticket." },
    { fetch: "missing" as const, expected: "The retained ticket channel is no longer available." }
  ];
  for (const scenario of scenarios) {
    const h = ticketHarness({ action: "close", ...scenario });
    await handleTicketCommand(h.command as never, h.repository as never);
    assert.equal(h.events[0], "defer");
    assert.equal(title(h.replies.at(-1)), scenario.expected);
  }
});

test("close and reopen enforce opener/reviewer access, state, and idempotent repair", async () => {
  const scenarios = [
    { action: "close" as const, user: "opener", roles: [], expected: "<#channel> was closed." },
    { action: "close" as const, user: "reviewer", roles: ["reviewer"], expected: "<#channel> was closed." },
    { action: "close" as const, user: "administrator", roles: ["administrator"], expected: "Only the ticket opener or a configured reviewer can use this control." },
    { action: "reopen" as const, status: "closed" as const, user: "opener", roles: [], expected: "<#channel> was reopened." },
    { action: "close" as const, status: "closed" as const, user: "opener", roles: [], expected: "<#channel> was already closed. Its conversation permissions and controls were repaired." }
  ];
  for (const scenario of scenarios) {
    const h = ticketHarness(scenario);
    await handleTicketCommand(h.command as never, h.repository as never);
    assert.equal(title(h.replies.at(-1)), scenario.expected);
  }
});

test("operational autocomplete hides unauthorized or wrong-state targets, caps choices, and preserves configuration autocomplete", async () => {
  const targets = Array.from({ length: 30 }, (_, index) => ({ ticketId: `t${index}`, ticketName: `Ticket ${index}`, openerDiscordUserId: index === 0 ? "opener" : "other", ticketChannelId: `c${index}`, status: index === 1 ? "closed" as const : "open" as const, reviewerRoleId: "reviewer" }));
  const choices: unknown[][] = [];
  await handleTicketAutocomplete(autocomplete("close", "opener", [], targets, choices) as never, { listOperationalTicketTargets: async () => targets } as never);
  assert.equal(choices[0].length, 1);
  const reviewer: unknown[][] = [];
  await handleTicketAutocomplete(autocomplete("reopen", "reviewer", ["reviewer"], targets, reviewer) as never, { listOperationalTicketTargets: async () => targets } as never);
  assert.equal(reviewer[0].length, 1);
  const config: unknown[][] = [];
  await handleTicketAutocomplete(autocomplete("show", "reviewer", ["reviewer"], targets, config, "tickets") as never, { listTicketClasses: async () => [{ ticketClassId: "class", name: "Support", enabled: true }] } as never);
  assert.deepEqual(config[0], [{ name: "Enabled • Support", value: "class" }]);
});

test("delete command enforces reviewer-and-closed gates and deletes before marking", async () => {
  const h = ticketHarness({ action: "delete", status: "closed", commandChannelId: "outside", supplied: "ticket", roles: ["reviewer"] });
  await handleTicketCommand(h.command as never, h.repository as never);
  assert.equal(title(h.replies.at(-1)), "support-opener was deleted; the retained ticket record was not deleted.");
  assert.deepEqual(h.deleteEvents, ["delete", "mark", "reload"]);

  const denied = ticketHarness({ action: "delete", status: "closed", commandChannelId: "outside", supplied: "ticket", roles: [] });
  await handleTicketCommand(denied.command as never, denied.repository as never);
  assert.equal(title(denied.replies.at(-1)), "Only members with <@&reviewer> can perform this action.");

  const open = ticketHarness({ action: "delete", status: "open", commandChannelId: "outside", supplied: "ticket", roles: ["reviewer"] });
  await handleTicketCommand(open.command as never, open.repository as never);
  assert.equal(title(open.replies.at(-1)), "This ticket must be closed before it can be deleted.");

  const failed = ticketHarness({ action: "delete", status: "closed", commandChannelId: "outside", supplied: "ticket", roles: ["reviewer"], deleteError: new Error("no") });
  await assert.rejects(() => handleTicketCommand(failed.command as never, failed.repository as never), /no/);
  assert.deepEqual(failed.deleteEvents, ["delete"]);
});

test("ticket creation points to the registered tickets button command", async () => {
  const replies: any[] = [];
  const interaction: any = {
    guildId: "guild",
    user: { id: "creator" },
    inGuild: () => true,
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "create",
      getChannel: () => ({ id: "category", type: ChannelType.GuildCategory }),
      getRole: () => ({ id: "reviewer" }),
      getString: () => "Support"
    },
    reply: async (payload: unknown) => replies.push(payload),
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => replies.push(payload)
  };
  const repository: any = {
    createTicketClass: async () => ({ name: "Support" })
  };

  await handleTicketsCommand(interaction, repository);

  assert.equal(title(replies[0]), "Ticket class Support was created; add an entry button with `/tickets button add`.");
  assert.equal(description(replies[0]), "Ticket class Support was created; add an entry button with `/tickets button add`.");
});

test("ticket configuration acknowledges before list lookup", async () => {
  const events: string[] = [];
  const interaction: any = {
    guildId: "guild", inGuild: () => true,
    options: { getSubcommandGroup: () => null, getSubcommand: () => "list" },
    deferReply: async () => events.push("defer"),
    editReply: async () => undefined
  };
  await handleTicketsCommand(interaction, { listTicketClasses: async () => { events.push("lookup"); return []; } } as never);
  assert.deepEqual(events, ["defer", "lookup"]);
});

test("ticket message modal opener responds once when its class is unavailable", async () => {
  const replies: unknown[] = [];
  let modalOpened = false;
  const interaction: any = {
    guildId: "guild", inGuild: () => true,
    options: { getSubcommandGroup: () => "messages", getSubcommand: () => "set", getString: (name: string) => name === "ticket" ? "missing" : "initial" },
    reply: async (payload: unknown) => replies.push(payload),
    showModal: async () => { modalOpened = true; }
  };
  await handleTicketsCommand(interaction, { getTicketClass: async () => undefined } as never);
  assert.equal(replies.length, 1);
  assert.equal(title(replies[0]), "Choose a configured ticket class.");
  assert.equal(modalOpened, false);
});

test("ticket message modal submit acknowledges before persistence", async () => {
  const events: string[] = [];
  const interaction: any = {
    customId: "ticket:message:class:initial",
    guildId: "guild",
    inGuild: () => true,
    fields: { getTextInputValue: () => "Welcome" },
    deferReply: async (payload: any) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push("defer"); },
    editReply: async () => { events.push("edit"); }
  };
  const repository = { setTicketMessage: async () => { events.push("persist"); } };

  assert.equal(await handleTicketModalSubmit(interaction, repository as never), true);
  assert.deepEqual(events, ["defer", "persist", "edit"]);
});

test("ticket entry button acknowledges before class lookup", async () => {
  const events: string[] = [];
  const interaction: any = {
    customId: "ticket:open:missing",
    guildId: "guild",
    inCachedGuild: () => true,
    deferReply: async (payload: any) => { assert.equal(payload.flags, MessageFlags.Ephemeral); events.push("defer"); },
    editReply: async () => { events.push("edit"); }
  };
  const repository = { getTicketClass: async () => { events.push("lookup"); return undefined; } };

  assert.equal(await handleTicketButton(interaction, repository as never), true);
  assert.deepEqual(events, ["defer", "lookup", "edit"]);
});

function ticketHarness(input: any = {}) {
  const events: string[] = []; const replies: unknown[] = []; const deleteEvents: string[] = []; const sent: any[] = [];
  const ticket: any = { ticketId: "ticket", ticketClassId: "class", discordGuildId: "guild", openerDiscordUserId: "opener", ticketChannelId: "channel", status: input.status ?? "open", controlMessageId: "control" };
  const ticketClass: any = { ticketClassId: "class", name: "Support", reviewerRoleId: "reviewer", enabled: true, closedMessage: "Closed copy" };
  const control = { id: "control", author: { id: "bot" }, components: [{ type: 17, components: [{ type: 10, content: "# Ticket" }, { type: 1, components: [{ type: 2, custom_id: "ticket:close:ticket", label: "Close" }] }] }], embeds: [], edit: async () => events.push("edit:control") };
  const channel: any = { id: "channel", name: "support-opener", type: ChannelType.GuildText, client: { user: { id: "bot" } }, guild: { id: "guild", members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async (_: string, p: any) => events.push(`permission:${p.SendMessages}`) }, messages: { fetch: async () => input.missingControl ? undefined : control }, send: async (p: any) => { sent.push(p); events.push(`send:${title(p)}`); return { id: "new" }; }, delete: async () => { deleteEvents.push("delete"); if (input.deleteError) throw input.deleteError; } };
  const guild: any = { id: "guild", channels: { cache: new Map(input.fetch ? [] : [["channel", channel]]), fetch: async () => input.fetch === "missing" ? undefined : channel }, members: channel.guild.members };
  const targets = [{ ticketId: "ticket", ticketName: "Support", openerDiscordUserId: "opener", ticketChannelId: "channel", status: ticket.status, reviewerRoleId: "reviewer" }];
  const repository: any = { listOperationalTicketTargets: async () => targets, getTicket: async () => deleteEvents.includes("mark") ? (deleteEvents.push("reload"), { ...ticket, status: "deleted" }) : ticket, getTicketClass: async () => ticketClass, markTicketClosed: async () => { events.push("close"); ticket.status = "closed"; return ticket; }, markTicketReopened: async () => { events.push("reopen"); ticket.status = "open"; return ticket; }, setTicketControlMessageId: async () => { events.push("persist"); return ticket; }, claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expectedMessageId: string | undefined, candidateMessageId: string) => { if (ticket.controlMessageId !== expectedMessageId) return false; ticket.controlMessageId = candidateMessageId; events.push("persist"); return true; }, markTicketDeleted: async () => { deleteEvents.push("mark"); return undefined; } };
  const command: any = { guildId: "guild", guild, channelId: input.commandChannelId ?? "channel", user: { id: input.user ?? "opener" }, member: { roles: { cache: new Map((input.roles ?? []).map((r: string) => [r, {}])) } }, inGuild: () => true, inCachedGuild: () => true, options: { getSubcommandGroup: () => null, getSubcommand: () => input.action ?? "close", getString: () => input.supplied ?? null }, deferReply: async (p: any) => { assert.equal(p.flags, MessageFlags.Ephemeral); events.push("defer"); }, editReply: async (p: any) => { replies.push(p); return {}; }, reply: async (p: any) => replies.push(p) };
  return { command, repository, channel, guild, events, replies, deleteEvents, sent };
}
function autocomplete(subcommand: string, user: string, roles: string[], targets: any[], responses: unknown[][], commandName = "ticket") { return { commandName, guildId: "guild", user: { id: user }, guild: { channels: { cache: new Map(targets.map(t => [t.ticketChannelId, { name: t.ticketChannelId }])) }, members: { cache: new Map([[user, { roles: { cache: new Map(roles.map(r => [r, {}])) } }]]) } }, client: { users: { cache: new Map() } }, options: { getFocused: () => ({ name: "ticket", value: "" }), getSubcommand: () => subcommand }, respond: async (c: unknown[]) => responses.push(c) }; }
function title(payload: any) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  if (payload?.embeds?.[0]?.data?.title) return payload.embeds[0].data.title;
  const container = payload?.components?.[0]?.toJSON?.();
  const heading = container?.components?.find((component: any) => typeof component.content === "string")?.content;
  return typeof heading === "string" && heading.startsWith("# ") ? heading.slice(2) : undefined;
}
function description(payload: any) {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  if (payload?.embeds?.[0]?.data?.description) return payload.embeds[0].data.description;
  const container = payload?.components?.[0]?.toJSON?.();
  return container?.components?.find((component: any, index: number) => index > 0 && typeof component.content === "string" && !component.content.startsWith("**"))?.content;
}
