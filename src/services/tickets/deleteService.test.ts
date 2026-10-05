import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { deleteTicketChannel } from "./deleteService.js";
import { runTicketLifecycleOperation } from "./lifecycleService.js";

test("ticket deletion service is reviewer-only, deletes Discord before marking, and reloads listener races", async () => {
  const h = fixture();
  assert.equal((await deleteTicketChannel({ ...h.input, actor: { userId: "admin", roleIds: new Set(["administrator"]) } })).kind, "error");
  assert.deepEqual(h.events, []);
  assert.deepEqual(await deleteTicketChannel(h.input), { kind: "deleted", channelName: "ticket" });
  assert.deepEqual(h.events, ["delete", "mark", "reload"]);
});
function fixture() { const events: string[] = []; const ticket = { ticketId: "t", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "closed" }; const channel = { id: "c", name: "ticket", type: ChannelType.GuildText, delete: async () => { events.push("delete"); } }; const repository = { getTicket: async () => events.includes("mark") ? (events.push("reload"), { ...ticket, status: "deleted" }) : ticket, getTicketClass: async () => ({ reviewerRoleId: "reviewer" }), markTicketDeleted: async () => { events.push("mark"); return undefined; } }; return { events, input: { guild: { channels: { cache: new Map([["c", channel]]), fetch: async () => channel } } as never, guildId: "g", ticketId: "t", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, ticketRepository: repository as never, channel: channel as never } }; }

test("ticket deletion racing reopen serializes channel deletion before the locked lifecycle recheck", async () => {
  const state = { ticketId: "race", ticketClassId: "class", discordGuildId: "g", openerDiscordUserId: "opener", ticketChannelId: "c", status: "closed" as "open" | "closed" | "deleted", controlMessageId: "closed-control" };
  const events: string[] = [];
  let deletionStarted!: () => void;
  let releaseDeletion!: () => void;
  const started = new Promise<void>((resolve) => { deletionStarted = resolve; });
  const holdDeletion = new Promise<void>((resolve) => { releaseDeletion = resolve; });
  const channel = {
    id: "c",
    name: "ticket",
    type: ChannelType.GuildText,
    guild: { members: { fetch: async () => ({}) } },
    permissionOverwrites: { edit: async (_id: string, permissions: { SendMessages: boolean }) => { events.push(`permission:${permissions.SendMessages}`); } },
    delete: async () => { events.push("delete:start"); deletionStarted(); await holdDeletion; events.push("delete:done"); }
  };
  const repository = {
    getTicket: async () => ({ ...state }),
    getTicketClass: async () => ({ reviewerRoleId: "reviewer" }),
    markTicketDeleted: async () => { state.status = "deleted"; events.push("status:deleted"); return { ...state }; },
    markTicketReopened: async () => { state.status = "open"; events.push("status:open"); return { ...state }; },
    claimTicketControlMessageId: async () => { events.push("claim"); return true; }
  };
  const guild = { channels: { cache: new Map([["c", channel]]), fetch: async () => channel } } as never;
  const deleting = deleteTicketChannel({ guild, guildId: "g", ticketId: "race", actor: { userId: "reviewer", roleIds: new Set(["reviewer"]) }, ticketRepository: repository as never, channel: channel as never });
  await started;
  const reopening = runTicketLifecycleOperation({
    action: "reopen",
    guild,
    guildId: "g",
    ticketId: "race",
    actor: { userId: "opener", roleIds: new Set<string>() },
    ticketRepository: repository as never,
    channel: channel as never,
    presentation: { renderClosed: async () => { events.push("render:closed"); return "closed-replacement"; }, renderOpen: async () => { events.push("render:open"); return "open-control"; }, retireCandidate: async (id: string) => { events.push(`retire:${id}`); } }
  });
  releaseDeletion();
  const [deletedResult, reopenedResult] = await Promise.all([deleting, reopening]);

  assert.deepEqual(deletedResult, { kind: "deleted", channelName: "ticket" });
  assert.deepEqual(reopenedResult, { kind: "error", title: "Ticket Not Found", description: "Choose an active ticket." });
  assert.equal(state.status, "deleted");
  assert.equal(state.controlMessageId, "closed-control");
  assert.deepEqual(events, ["delete:start", "delete:done", "status:deleted"]);
});
