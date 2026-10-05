import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type Guild, type MessageCreateOptions } from "discord.js";
import type { LogChannelRecord } from "../../db/logChannelRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createLogFeedService, splitLogFeedText } from "./delivery.js";

function fixture() {
  const sent: MessageCreateOptions[] = [], warnings: unknown[] = [];
  let config: LogChannelRecord | undefined = { discordGuildId: "guild-a", discordChannelId: "channel-a", configuredByDiscordUserId: "user", createdAt: new Date(), updatedAt: new Date() };
  const bot = { id: "bot" }, everyone = { id: "guild-a" };
  let botPermissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
  let publicChannel = false;
  const channel = {
    guildId: "guild-a", type: ChannelType.GuildText as number,
    permissionsFor: (target: unknown) => target === bot ? botPermissions : new PermissionsBitField(publicChannel ? [PermissionFlagsBits.ViewChannel] : []),
    send: async (payload: MessageCreateOptions) => { sent.push(payload); }
  };
  const guild = { id: "guild-a", channels: { fetch: async (_id: string) => channel as typeof channel | null }, members: { me: bot, fetchMe: async () => bot }, roles: { everyone } };
  const repository = { get: async (_guildId: string) => config };
  const logger: Logger = { debug() {}, info() {}, error() {}, warn: (message, metadata) => { warnings.push({ message, metadata }); } };
  return {
    guild: guild as unknown as Guild, rawGuild: guild, channel, repository, sent, warnings,
    service: createLogFeedService(repository, logger),
    setConfig: (value: LogChannelRecord | undefined) => { config = value; },
    setPermissions: (value: bigint[]) => { botPermissions = new PermissionsBitField(value); },
    makePublic: () => { publicChannel = true; }
  };
}

test("log feed is optional plain text and suppresses mentions and link previews", async () => {
  const f = fixture();
  assert.equal(await f.service.send(f.guild, ["<@user> joined the server.", "Character joined Officers • group • Europe."]), "sent");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(f.sent[0].content, "<@user> joined the server.\nCharacter joined Officers • group • Europe.");
  assert.equal(f.sent[0].flags, MessageFlags.SuppressEmbeds);
  assert.equal(f.sent[0].embeds, undefined);
  assert.equal(f.sent[0].components, undefined);
  f.setConfig(undefined);
  assert.equal(await f.service.send(f.guild, ["change"]), "disabled");
  assert.equal(await f.service.send(f.guild, []), "disabled");
  assert.equal(f.sent.length, 1);
});

test("grace deadline timestamps remain intact and silent across message boundaries", async () => {
  const f = fixture();
  const deadline = "<t:1893758400:F>";
  const text = `${"x".repeat(1995)}${deadline}. Discord registration recovery deadline: <t:1893672000:F>.`;
  assert.equal(await f.service.send(f.guild, [text]), "sent");
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.map(message => message.content).join(""), text);
  assert.ok(f.sent[1].content?.startsWith(deadline));
  for (const message of f.sent) {
    assert.ok(message.content!.length <= 2000);
    assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
    assert.equal(message.flags, MessageFlags.SuppressEmbeds);
  }
});

test("inspection retains unavailable destinations, reports exact permissions and permits public announcement channels", async () => {
  const f = fixture();
  f.channel.type = ChannelType.GuildAnnouncement;
  f.makePublic();
  assert.deepEqual(await f.service.inspect(f.guild, "channel-a"), { available: true, everyoneVisible: true, missingPermissions: [] });
  f.setPermissions([PermissionFlagsBits.ViewChannel]);
  assert.deepEqual(await f.service.inspect(f.guild, "channel-a"), {
    available: false, reason: "missing_permissions", everyoneVisible: true, missingPermissions: ["Send Messages"]
  });
  assert.equal(await f.service.send(f.guild, ["change"]), "failed");
  assert.ok(await f.repository.get("guild-a"));
  assert.equal(f.sent.length, 0);
  f.setPermissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  assert.equal(await f.service.send(f.guild, ["change without Embed Links"]), "sent");
});

test("deleted, cross-guild and nonordinary channel destinations never send", async () => {
  for (const variant of ["deleted", "other-guild", "thread", "voice"] as const) {
    const f = fixture();
    if (variant === "deleted") f.rawGuild.channels.fetch = async () => null;
    if (variant === "other-guild") f.channel.guildId = "guild-b";
    if (variant === "thread") f.channel.type = ChannelType.PublicThread;
    if (variant === "voice") f.channel.type = ChannelType.GuildVoice;
    assert.equal(await f.service.send(f.guild, ["change"]), "failed", variant);
    assert.equal(f.sent.length, 0);
    assert.ok(await f.repository.get("guild-a"));
  }
});

test("configuration lookup, channel lookup and send failures cannot fail the domain operation or disclose payloads", async () => {
  for (const stage of ["configuration", "lookup", "send"] as const) {
    const f = fixture();
    const fail = async (): Promise<never> => { throw Object.assign(new Error("private application answers and credentials"), { code: 50013, status: 403 }); };
    if (stage === "configuration") f.repository.get = fail;
    if (stage === "lookup") f.rawGuild.channels.fetch = fail;
    if (stage === "send") f.channel.send = fail;
    assert.equal(await f.service.send(f.guild, ["sensitive event body"]), "failed");
    assert.ok(f.warnings.length);
    assert.doesNotMatch(JSON.stringify(f.warnings), /private|credentials|sensitive event body|Error/);
    assert.match(JSON.stringify(f.warnings), /50013/);
  }
});

test("terminal or test sends can use the captured destination without an extant configuration", async () => {
  const f = fixture();
  f.repository.get = async () => { throw new Error("configuration was purged"); };
  const fetched: string[] = [];
  f.rawGuild.channels.fetch = async id => { fetched.push(id); return f.channel; };
  assert.equal(await f.service.send(f.guild, ["Guild Manager was reset for this server."], { channelId: "old-channel" }), "sent");
  assert.deepEqual(fetched, ["old-channel"]);
});

test("combined entries split losslessly into bounded text and continuation messages", async () => {
  const entries = Array.from({ length: 700 }, (_, i) => `<@user> left an application open in <#channel-${i}>.`);
  for (const lines of [["x".repeat(6_000)], entries, ["x".repeat(4_095) + "😀".repeat(8_000)]]) {
    const messages = splitLogFeedText(lines);
    assert.equal(messages.join(""), lines.join("\n"));
    for (const text of messages) {
      assert.ok(text.length > 0 && text.length <= 2_000);
      assert.doesNotMatch(text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    if (lines.join("\n").length <= 2_000) assert.equal(messages.length, 1);
  }
  const f = fixture();
  assert.equal(await f.service.send(f.guild, entries), "sent");
  assert.ok(f.sent.length > 1);
  for (const payload of f.sent) assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("log continuation preserves complete generated mentions at the text boundary", () => {
  for (const mention of ["<@123456789012345678>", "<@&123456789012345678>", "<#123456789012345678>"]) {
    const text = "x".repeat(1_995) + mention + " joined.";
    const messages = splitLogFeedText([text]);
    assert.equal(messages.join(""), text);
    assert.ok(messages[1].startsWith(mention));
  }
});
