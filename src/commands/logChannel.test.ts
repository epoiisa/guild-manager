import { ChannelType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type MessageCreateOptions } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { LogChannelRecord, LogChannelRepository } from "../db/logChannelRepository.js";
import { createLogFeedService } from "../services/logFeed/delivery.js";
import { LOG_DELIVERY_WARNING } from "../services/logFeed/runtime.js";
import { handleChannelCommand } from "./channel.js";

function fixture(action: "set" | "clear" | "show" = "set") {
  const events: string[] = [], responses: unknown[] = [];
  const messages: Array<{ channelId: string; payload: MessageCreateOptions }> = [];
  let admin = true, live = true;
  const bot = { id: "bot" }, everyone = { id: "guild-a" };
  const configured = new Map<string, LogChannelRecord>();
  const repository: LogChannelRepository = {
    async get(guildId) { assert.equal(guildId, "guild-a"); events.push("read"); return configured.get(guildId); },
    async set(guildId, channelId, userId) {
      assert.equal(guildId, "guild-a"); assert.equal(userId, "operator");
      events.push(`save:${channelId}`); configure(channelId);
    },
    async clear(guildId) { assert.equal(guildId, "guild-a"); events.push("clear"); configured.delete(guildId); }
  };
  function configure(channelId: string) {
    configured.set("guild-a", { discordGuildId: "guild-a", discordChannelId: channelId, configuredByDiscordUserId: "operator", createdAt: new Date(), updatedAt: new Date() });
  }
  function channel(id: string) {
    return {
      id, guildId: "guild-a", type: ChannelType.GuildText as number,
      public: false,
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]),
      permissionsFor(target: unknown) {
        return target === bot ? this.permissions : new PermissionsBitField(this.public ? [PermissionFlagsBits.ViewChannel] : []);
      },
      async send(payload: MessageCreateOptions) {
        events.push(`send:${id}`);
        messages.push({ channelId: id, payload });
      }
    };
  }
  const selected = channel("new-channel"), old = channel("old-channel");
  const channels = new Map([[selected.id, selected], [old.id, old]]);
  const interaction: any = {
    guildId: "guild-a", user: { id: "operator", bot: false }, deferred: false, replied: false,
    inGuild: () => true,
    options: { getSubcommand: () => action, getString: () => "log", getChannel: () => ({ id: selected.id }) },
    guild: {
      id: "guild-a", roles: { everyone }, members: {
        me: bot,
        fetch: async () => { events.push("administrator"); return { user: { bot: false }, permissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []) }; }
      },
      channels: { fetch: async (id: string, options: unknown) => {
        assert.deepEqual(options, { force: true }); events.push(`inspect:${id}`); return channels.get(id) ?? null;
      } }
    },
    deferReply: async (options: { flags: number }) => {
      assert.equal(options.flags, MessageFlags.Ephemeral); events.push("defer"); interaction.deferred = true;
    },
    editReply: async (payload: unknown) => { responses.push(payload); events.push("reply"); interaction.replied = true; },
    followUp: async (payload: unknown) => { responses.push(payload); events.push("follow-up"); }
  };
  const service = createLogFeedService(repository, { debug() {}, info() {}, warn() {}, error() {} });
  const dependencies: any = {
    logChannelRepository: repository, logFeedService: service,
    entryPanelService: {
      captureFence: () => () => live,
      runExclusive: async (guildId: string, task: () => Promise<unknown>) => { assert.equal(guildId, "guild-a"); return task(); },
      context: { repository: {} }
    }
  };
  return {
    events, responses, messages, channels, selected, old, configured, configure,
    deny: () => { admin = false; }, invalidate: () => { live = false; },
    run: () => handleChannelCommand(interaction, dependencies),
    copy: () => JSON.stringify(responses),
    effects: () => events.filter(event => /^(send:|save:|clear$)/.test(event))
  };
}

test("log configuration uses the shared live Administrator gate before settings or delivery", async () => {
  for (const action of ["set", "clear", "show"] as const) {
    const f = fixture(action); f.configure("old-channel"); f.deny(); await f.run();
    assert.deepEqual(f.events, ["defer", "administrator", "reply"]);
    assert.equal(f.configured.get("guild-a")!.discordChannelId, "old-channel");
    assert.match(f.copy(), /Administrator Required/);
  }
});

test("new log channel is validated and tested before saving and private confirmation", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.events, ["defer", "administrator", "inspect:new-channel", "read", "inspect:new-channel", "send:new-channel", "save:new-channel", "reply"]);
  assert.equal(f.configured.get("guild-a")!.discordChannelId, "new-channel");
  assert.match(JSON.stringify(f.messages[0].payload), /Audit logging enabled here/);
  assert.deepEqual(f.messages[0].payload.allowedMentions, { parse: [], repliedUser: false });
  assert.match(f.copy(), /Guild Manager will post member and membership audit entries in/);
});

test("invalid log destination type, tenant, or permissions preserves the previous destination", async () => {
  for (const invalid of ["type", "tenant", "permissions"] as const) {
    const f = fixture(); f.configure("old-channel");
    if (invalid === "type") f.selected.type = ChannelType.GuildVoice;
    if (invalid === "tenant") f.selected.guildId = "guild-b";
    if (invalid === "permissions") f.selected.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    await f.run();
    assert.deepEqual(f.effects(), []);
    assert.equal(f.configured.get("guild-a")!.discordChannelId, "old-channel");
    assert.match(f.copy(), /Channel Unavailable/);
  }
});

test("moving a log enables the new destination before saving, then tells the old destination", async () => {
  const f = fixture(); f.configure("old-channel"); await f.run();
  assert.deepEqual(f.effects(), ["send:new-channel", "save:new-channel", "send:old-channel"]);
  assert.deepEqual(f.messages.map(message => [message.channelId, message.payload.content]), [
    ["new-channel", "Audit logging enabled here."], ["old-channel", "Audit logging moved to <#new-channel>."]
  ]);
  assert.equal(f.configured.get("guild-a")!.discordChannelId, "new-channel");
});

test("move failure in the old destination does not undo the new setting and gives a private warning", async () => {
  const f = fixture(); f.configure("old-channel");
  f.old.send = async () => { f.events.push("send:old-channel"); throw new Error("unavailable"); };
  await f.run();
  assert.deepEqual(f.effects(), ["send:new-channel", "save:new-channel", "send:old-channel"]);
  assert.equal(f.configured.get("guild-a")!.discordChannelId, "new-channel");
  assert.match(f.copy(), /Guild Manager will post member and membership audit entries in/);
  assert.ok(f.copy().includes(LOG_DELIVERY_WARNING));
});

test("failed enable test keeps the old setting and does not publish a moved entry", async () => {
  const f = fixture(); f.configure("old-channel");
  f.selected.send = async () => { f.events.push("send:new-channel"); throw new Error("send failed"); };
  await f.run();
  assert.deepEqual(f.effects(), ["send:new-channel"]);
  assert.equal(f.configured.get("guild-a")!.discordChannelId, "old-channel");
  assert.match(f.copy(), /setting was not changed/);
});

test("setting the same available channel does not emit a duplicate enable event", async () => {
  const f = fixture(); f.configure("new-channel"); await f.run();
  assert.deepEqual(f.effects(), []);
  assert.match(f.copy(), /Guild Manager will post member and membership audit entries in/);
});

test("clear removes configuration even when the old destination is unreachable", async () => {
  const f = fixture("clear"); f.configure("old-channel"); f.channels.delete("old-channel"); await f.run();
  assert.deepEqual(f.effects(), ["clear"]);
  assert.equal(f.configured.has("guild-a"), false);
  assert.match(f.copy(), /Audit Feed Disabled/);
  assert.ok(f.copy().includes(LOG_DELIVERY_WARNING));
  assert.ok(f.events.indexOf("clear") < f.events.indexOf("inspect:old-channel"));
});

test("an everyone-visible announcement channel is allowed with an exposure warning and suppressed mentions", async () => {
  const f = fixture(); f.selected.public = true; f.selected.type = ChannelType.GuildAnnouncement; await f.run();
  assert.equal(f.configured.get("guild-a")!.discordChannelId, "new-channel");
  assert.match(f.copy(), /Warning: @everyone can view this channel/);
  assert.deepEqual(f.messages[0].payload.allowedMentions, { parse: [], repliedUser: false });
  const response = JSON.parse(f.copy())[0];
  assert.deepEqual(response.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
});

test("show retains the configured destination while reporting deleted or permission-denied availability", async () => {
  for (const unavailable of ["deleted", "permissions"] as const) {
    const f = fixture("show"); f.configure("old-channel");
    if (unavailable === "deleted") f.channels.delete("old-channel");
    else f.old.permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    await f.run();
    assert.equal(f.configured.get("guild-a")!.discordChannelId, "old-channel");
    assert.match(f.copy(), /<#old-channel> • Unavailable/);
    assert.deepEqual(f.effects(), []);
    if (unavailable === "permissions") assert.match(f.copy(), /Missing: Send Messages/);
  }
});

test("reset invalidation while enable is pending prevents the completed send from saving a setting", async () => {
  const f = fixture();
  let started!: () => void, release!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.selected.send = async payload => {
    f.events.push("send:new-channel"); started(); await pending; f.messages.push({ channelId: "new-channel", payload });
  };
  const operation = f.run();
  await sending;
  f.invalidate();
  release();
  await operation;
  assert.deepEqual(f.effects(), ["send:new-channel"]);
  assert.equal(f.configured.has("guild-a"), false);
  assert.match(f.copy(), /Start Again/);
});
