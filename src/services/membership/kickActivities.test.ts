import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createKickActivitiesService } from "./kickActivities.js";
import type { KickActivityCleanup } from "../../db/kickActivitiesRepository.js";
import { runApplicationLifecycleOperation } from "../applications/lifecycleService.js";
import { runTicketLifecycleOperation } from "../tickets/lifecycleService.js";

function fixture(kind: KickActivityCleanup["kind"] = "ticket") {
  const job: KickActivityCleanup = { cleanupId: "1", discordGuildId: "guild", discordUserId: "kicked", kind, targetId: "target", channelId: "channel", messageIds: [] };
  const pending = [job]; const events: unknown[] = [];
  const permissions = { has: () => false };
  const member = { permissions, voice: { channelId: "other-room", disconnect: async () => { events.push("disconnect"); } } };
  const channel = { id: "channel", guild: { id: "guild" }, type: kind === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
    permissionOverwrites: { edit: async (user: string, bits: unknown) => { events.push({ user, bits }); } },
    messages: { fetch: async (_id: string): Promise<unknown> => undefined } };
  const guild = { id: "guild", client: { user: { id: "bot" } }, members: { fetch: async () => member }, channels: { fetch: async (): Promise<unknown> => channel } };
  const repository = { listPending: async () => [...pending], markAttempted: async (...args: unknown[]) => { events.push(["attempt", ...args]); }, complete: async (...args: unknown[]) => { events.push(["complete", ...args]); pending.splice(0, 1); }, hasPendingCleanup: async () => pending.length > 0 };
  const dependencies = { logger: { warn: () => {} }, contentRepository: {}, giveawayRepository: {}, giveawayService: {} };
  return { job, pending, events, channel, guild, member, service: createKickActivitiesService(repository as never, dependencies as never) };
}

test("kick conversation cleanup denies only the target and retires controls while retaining historical content", async () => {
  const f = fixture(); f.job.messageIds = ["control"];
  let edited: unknown;
  f.channel.messages.fetch = async () => ({ author: { id: "bot" }, components: [{ toJSON: () => ({ type: 17, components: [{ type: 10, content: "Historical conversation" }, { type: 1, components: [{ type: 2, custom_id: "reopen", label: "Reopen", style: 1 }] }] }) }], edit: async (payload: unknown) => { edited = payload; } });
  assert.deepEqual(await f.service.reconcileUser(f.guild as never, "kicked"), { warnings: [], pending: false });
  assert.deepEqual(f.events[1], { user: "kicked", bits: { ViewChannel: false, SendMessages: false, ReadMessageHistory: false, AttachFiles: false } });
  assert.match(JSON.stringify(edited), /Historical conversation/); assert.match(JSON.stringify(edited), /"disabled":true/);
  assert.deepEqual(f.events.at(-1), ["complete", "guild", "kicked", "1"]);
});

test("Discord permission failures stay queued and a later retry completes", async () => {
  const f = fixture(); let failing = true;
  f.channel.permissionOverwrites.edit = async () => { if (failing) throw { code: 50013 }; };
  const failed = await f.service.reconcileUser(f.guild as never, "kicked");
  assert.equal(failed.pending, true); assert.equal(failed.warnings.length, 1); assert.equal(f.pending.length, 1);
  failing = false;
  assert.deepEqual(await f.service.reconcileUser(f.guild as never, "kicked"), { warnings: [], pending: false });
});

test("only definitive missing Discord resources finish cleanup; temporary fetch failure remains pending", async () => {
  const f = fixture(); f.guild.channels.fetch = async () => { throw { code: 50013 }; };
  assert.equal((await f.service.reconcileUser(f.guild as never, "kicked")).pending, true);
  f.guild.channels.fetch = async () => { throw { code: 10003 }; };
  assert.equal((await f.service.reconcileUser(f.guild as never, "kicked")).pending, false);
});

test("queue scope mismatch cannot touch another user's channel", async () => {
  const f = fixture(); f.job.discordUserId = "unrelated";
  assert.equal((await f.service.reconcileUser(f.guild as never, "kicked")).pending, true);
  assert.deepEqual(f.events, []);
});

test("temporary voice cleanup removes owner powers and disconnects only the target's old room", async () => {
  const f = fixture("voice"); f.member.voice.channelId = "channel";
  await f.service.reconcileUser(f.guild as never, "kicked");
  const overwrite = f.events[1] as { user: string; bits: Record<string, boolean> };
  assert.equal(overwrite.user, "kicked");
  for (const permission of ["ManageChannels", "MoveMembers", "MuteMembers", "DeafenMembers", "PrioritySpeaker", "SetVoiceChannelStatus", "ManageMessages", "Connect", "ViewChannel"]) assert.equal(overwrite.bits[permission], false);
  assert.ok(f.events.includes("disconnect"));
  const other = fixture("voice"); await other.service.reconcileUser(other.guild as never, "kicked"); assert.ok(!other.events.includes("disconnect"));
});

test("an administrator permission bypass cannot be reported as successful access cleanup", async () => {
  const f = fixture(); f.member.permissions.has = (...args: unknown[]) => args[0] === PermissionFlagsBits.Administrator;
  assert.equal((await f.service.reconcileUser(f.guild as never, "kicked")).pending, true);
});

test("retained kicked conversations reject reopening before permissions even after user reconnection", async () => {
  const accessRevokedAt = new Date();
  const application = await runApplicationLifecycleOperation({ action: "reopen", guildId: "guild", applicationId: "app", applicationRepository: { getOpenApplication: async () => ({ accessRevokedAt }) } } as never);
  assert.equal(application.kind, "error");
  const ticket = await runTicketLifecycleOperation({ action: "reopen", guildId: "guild", ticketId: "ticket", ticketRepository: { getTicket: async () => ({ status: "closed", accessRevokedAt }) } } as never);
  assert.equal(ticket.kind, "error");
});

test("archived party cleanup restores archival on failures and tolerates already absent membership", async () => {
  const f = fixture("content");
  const events: string[] = []; let fail = true;
  const thread = { id: "channel", guild: { id: "guild" }, archived: true, isThread: () => true,
    members: { remove: async (user: string) => { assert.equal(user, "kicked"); throw { code: fail ? 50013 : 10007 }; } },
    setArchived: async (archived: boolean) => { events.push(`archived:${archived}`); thread.archived = archived; } };
  f.guild.channels.fetch = async () => thread;
  const pending = [f.job];
  const service = createKickActivitiesService({ listPending: async () => [...pending], markAttempted: async () => {}, complete: async () => { pending.length = 0; }, hasPendingCleanup: async () => pending.length > 0 } as never,
    { contentRepository: { getContentSnapshot: async () => undefined }, logger: { warn: () => {} } } as never);
  assert.equal((await service.reconcileUser(f.guild as never, "kicked")).pending, true);
  assert.deepEqual(events, ["archived:false", "archived:true"]); assert.equal(thread.archived, true);
  fail = false;
  assert.equal((await service.reconcileUser(f.guild as never, "kicked")).pending, false);
  assert.equal(thread.archived, true);
});
