import assert from "node:assert/strict";
import test from "node:test";
import { Collection } from "discord.js";
import { createGiveawayService } from "./service.js";
import type { GiveawayRecord } from "../../db/giveawayRepository.js";

function fixture() {
  const events: unknown[] = [];
  const giveaway: GiveawayRecord = { giveawayId: "giveaway", discordGuildId: "guild", channelId: "channel", originalMessageId: "message", creatorDiscordUserId: "kicked", title: "Prize", description: "", drawAt: new Date(), winnerCount: 1, state: "cancelled", cancelledAt: new Date(), createdAt: new Date() };
  const reaction = { emoji: { name: "🎁", id: null }, remove: async () => { events.push("clear-reaction"); }, users: { remove: async (user: string) => { events.push(["remove-user", user]); } } };
  const message = { components: [], embeds: [], attachments: new Collection(), reactions: { cache: new Collection([["entry", reaction]]) }, edit: async (payload: unknown) => { events.push(payload); } };
  const channel = { isSendable: () => true, messages: { fetch: async (): Promise<unknown> => message } };
  const guild = { id: "guild", channels: { fetch: async (): Promise<unknown> => channel } };
  const repository = { listEligibleParticipantIds: async () => ["other"], listRecordedParticipantIds: async () => ["historical"], markOriginalMessageClosed: async (...args: unknown[]) => { events.push(["closed", ...args]); }, markOriginalMessageDeleted: async (...args: unknown[]) => { events.push(["missing", ...args]); } };
  return { events, giveaway, reaction, message, channel, guild, service: createGiveawayService(repository as never, {} as never) };
}

test("kick cancellation retries reaction failure without reporting original message closed prematurely", async () => {
  const f = fixture(); f.reaction.remove = async () => { throw { code: 50013 }; };
  await assert.rejects(f.service.reconcileAfterKick(f.guild as never, f.giveaway, "kicked"));
  assert.ok(!JSON.stringify(f.events).includes('"closed"'));
  f.reaction.remove = async () => { f.events.push("clear-reaction"); };
  await f.service.reconcileAfterKick(f.guild as never, f.giveaway, "kicked");
  assert.deepEqual(f.events.at(-1), ["closed", "guild", "message"]);
  assert.match(JSON.stringify(f.events), /Cancelled/);
});

test("kick cleanup of another host's open giveaway removes only the kicked reaction", async () => {
  const f = fixture(); f.giveaway.state = "open";
  await f.service.reconcileAfterKick(f.guild as never, f.giveaway, "kicked");
  assert.deepEqual(f.events.at(-1), ["remove-user", "kicked"]);
  assert.ok(!f.events.includes("clear-reaction"));
});

test("giveaway cleanup only treats definitive missing message as deletion", async () => {
  const f = fixture(); f.channel.messages.fetch = async () => { throw { code: 50013 }; };
  await assert.rejects(f.service.reconcileAfterKick(f.guild as never, f.giveaway, "kicked")); assert.deepEqual(f.events, []);
  f.channel.messages.fetch = async () => { throw { code: 10008 }; };
  await f.service.reconcileAfterKick(f.guild as never, f.giveaway, "kicked");
  assert.deepEqual(f.events, [["missing", "guild", "message"]]);
});
