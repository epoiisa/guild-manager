import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { runTicketLifecycleOperation } from "./lifecycleService.js";

test("ticket lifecycle service authorizes opener or reviewer, performs CAS transitions, and repairs idempotently", async () => {
  const h = fixture();
  const denied = await runTicketLifecycleOperation({ ...h.input, actor: { userId: "admin", roleIds: new Set(["administrator"]) } });
  assert.deepEqual(denied, { kind: "error", title: "Ticket Access Required", description: "Only the ticket opener or a configured reviewer can use this control." });
  assert.equal((await runTicketLifecycleOperation(h.input)).kind, "closed");
  assert.deepEqual(h.events, ["permission:false", "permission:false", "close", "closed-presentation", "claim"]);
  const repaired = await runTicketLifecycleOperation(h.input);
  assert.deepEqual(repaired, { kind: "closed", repaired: true });
  assert.equal(h.events.filter((event) => event === "close").length, 1);
  const reopened = await runTicketLifecycleOperation({ ...h.input, action: "reopen" });
  assert.deepEqual(reopened, { kind: "reopened", repaired: false });
  assert.ok(h.events.includes("permission:true"));
});

function fixture() {
  const events: string[] = []; const ticket = { ticketId: "t", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "open" as "open" | "closed" };
  const channel = { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async (_id: string, permissions: { SendMessages: boolean }) => { events.push(`permission:${permissions.SendMessages}`); } } };
  const repository = { getTicket: async () => ticket, getTicketClass: async () => ({ reviewerRoleId: "reviewer" }), markTicketClosed: async () => { events.push("close"); ticket.status = "closed"; return undefined; }, markTicketReopened: async () => { events.push("reopen"); ticket.status = "open"; return ticket; }, claimTicketControlMessageId: async () => { events.push("claim"); return true; } };
  return { events, input: { action: "close" as const, guild: { channels: { cache: new Map([["c", channel]]), fetch: async () => channel } } as never, guildId: "g", ticketId: "t", actor: { userId: "opener", roleIds: new Set<string>() }, ticketRepository: repository as never, channel: channel as never, presentation: { renderClosed: async () => { events.push("closed-presentation"); return "closed-control"; }, retireCandidate: async () => { events.push("retire"); }, renderOpen: async () => { events.push("open-presentation"); return "open-control"; } } } };
}

test("concurrent ticket closes claim one canonical control and retire the losing candidate", async () => {
  const state = { ticketId: "t", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "open" as "open" | "closed", controlMessageId: undefined as string | undefined };
  const candidates: string[] = []; const retired: string[] = []; let rendered = 0;
  const repository = { getTicket: async () => ({ ...state }), getTicketClass: async () => ({ reviewerRoleId: "reviewer" }), markTicketClosed: async () => { if (state.status !== "open") return undefined; state.status = "closed"; return { ...state }; }, claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expected: string | undefined, candidate: string) => { if (state.controlMessageId !== expected) return false; state.controlMessageId = candidate; return true; } };
  const presentation = { renderClosed: async () => { const candidate = `candidate-${++rendered}`; candidates.push(candidate); return candidate; }, retireCandidate: async (id: string) => { retired.push(id); }, renderOpen: async () => undefined };
  const input = { action: "close" as const, guild: { channels: { cache: new Map(), fetch: async () => undefined } } as never, guildId: "g", ticketId: "t", actor: { userId: "opener", roleIds: new Set<string>() }, ticketRepository: repository as never, channel: { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async () => undefined } } as never, presentation };
  await Promise.all([runTicketLifecycleOperation(input), runTicketLifecycleOperation(input)]);
  assert.equal(candidates.length, 2); assert.equal(retired.length, 1); assert.equal(state.controlMessageId, candidates.find((candidate) => candidate !== retired[0]));
});

test("concurrent legacy ticket-button closes do not retire their shared winning control", async () => {
  const state = { ticketId: "t", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "open" as "open" | "closed", controlMessageId: undefined as string | undefined };
  const retired: string[] = []; let rendered = 0;
  const repository = { getTicket: async () => ({ ...state }), getTicketClass: async () => ({ reviewerRoleId: "reviewer" }), markTicketClosed: async () => { if (state.status !== "open") return undefined; state.status = "closed"; return { ...state }; }, claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expected: string | undefined, candidate: string) => { if (state.controlMessageId !== expected) return false; state.controlMessageId = candidate; return true; } };
  const presentation = { renderClosed: async () => { rendered += 1; return "legacy-control"; }, retireCandidate: async (id: string) => { retired.push(id); }, renderOpen: async () => undefined };
  const input = { action: "close" as const, guild: { channels: { cache: new Map(), fetch: async () => undefined } } as never, guildId: "g", ticketId: "t", actor: { userId: "opener", roleIds: new Set<string>() }, channel: { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async () => undefined } } as never, ticketRepository: repository as never, presentation };
  await Promise.all([runTicketLifecycleOperation(input), runTicketLifecycleOperation(input)]);
  assert.equal(state.controlMessageId, "legacy-control");
  assert.deepEqual(retired, []);
});

test("concurrent ticket reopens claim one canonical control and retire the losing candidate", async () => {
  const state = { ticketId: "t", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "closed" as "open" | "closed", controlMessageId: "closed-control" as string | undefined };
  const candidates: string[] = []; const retired: string[] = []; let rendered = 0;
  const repository = { getTicket: async () => ({ ...state }), getTicketClass: async () => ({ reviewerRoleId: "reviewer" }), markTicketReopened: async () => { if (state.status !== "closed") return undefined; state.status = "open"; return { ...state }; }, claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expected: string | undefined, candidate: string) => { if (state.controlMessageId !== expected) return false; state.controlMessageId = candidate; return true; } };
  const presentation = { renderClosed: async () => undefined, retireCandidate: async (id: string) => { retired.push(id); }, renderOpen: async () => { const candidate = `candidate-${++rendered}`; candidates.push(candidate); return candidate; } };
  const input = { action: "reopen" as const, guild: { channels: { cache: new Map(), fetch: async () => undefined } } as never, guildId: "g", ticketId: "t", actor: { userId: "opener", roleIds: new Set<string>() }, ticketRepository: repository as never, channel: { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async () => undefined } } as never, presentation };
  await Promise.all([runTicketLifecycleOperation(input), runTicketLifecycleOperation(input)]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(new Set(retired), new Set(["closed-control", candidates.find((candidate) => candidate !== state.controlMessageId)!]));
  assert.ok(candidates.includes(state.controlMessageId!));
});

test("a close racing a reopen serializes status, permissions, canonical control, and retirement", async () => {
  const state = { ticketId: "race", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "open" as "open" | "closed" | "deleted", controlMessageId: "opening-control" as string | undefined };
  const events: string[] = [];
  const retired: string[] = [];
  const cards = new Map<string, "open" | "closed">([["opening-control", "open"]]);
  let closePresentationStarted!: () => void;
  let releaseClosePresentation!: () => void;
  const closeStarted = new Promise<void>((resolve) => { closePresentationStarted = resolve; });
  const holdClose = new Promise<void>((resolve) => { releaseClosePresentation = resolve; });
  const repository = {
    getTicket: async () => ({ ...state }),
    getTicketClass: async () => ({ reviewerRoleId: "reviewer" }),
    markTicketClosed: async () => { if (state.status !== "open") return undefined; state.status = "closed"; events.push("status:closed"); return { ...state }; },
    markTicketReopened: async () => { if (state.status !== "closed") return undefined; state.status = "open"; events.push("status:open"); return { ...state }; },
    claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expected: string | undefined, candidate: string) => { if (state.controlMessageId !== expected) return false; state.controlMessageId = candidate; events.push(`control:${candidate}`); return true; }
  };
  const presentation = {
    renderClosed: async () => { events.push("render:closed"); closePresentationStarted(); await holdClose; cards.set("closed-control", "closed"); return "closed-control"; },
    renderOpen: async () => { events.push("render:open"); cards.set("open-control", "open"); return "open-control"; },
    retireCandidate: async (id: string) => { retired.push(id); events.push(`retire:${id}`); }
  };
  const channel = { id: "c", type: ChannelType.GuildText, guild: { members: { fetch: async () => ({}) } }, permissionOverwrites: { edit: async (_id: string, permissions: { SendMessages: boolean }) => { events.push(`permission:${permissions.SendMessages}`); } } } as never;
  const base = { guild: { channels: { cache: new Map(), fetch: async () => undefined } } as never, guildId: "g", ticketId: "race", actor: { userId: "opener", roleIds: new Set<string>() }, ticketRepository: repository as never, channel, presentation };

  const closing = runTicketLifecycleOperation({ ...base, action: "close" });
  await closeStarted;
  const reopening = runTicketLifecycleOperation({ ...base, action: "reopen" });
  releaseClosePresentation();
  const [closedResult, reopenedResult] = await Promise.all([closing, reopening]);

  assert.deepEqual(closedResult, { kind: "closed", repaired: false });
  assert.deepEqual(reopenedResult, { kind: "reopened", repaired: false });
  assert.equal(state.status, "open");
  assert.equal(state.controlMessageId, "open-control");
  assert.equal(cards.get(state.controlMessageId), "open");
  assert.deepEqual(events.filter((event) => event.startsWith("permission:")), ["permission:false", "permission:false", "permission:true", "permission:true"]);
  assert.deepEqual(retired, ["opening-control", "closed-control"]);
  assert.ok(events.indexOf("control:closed-control") < events.indexOf("status:open"));
});
