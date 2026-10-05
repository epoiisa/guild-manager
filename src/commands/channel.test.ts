import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_SYSTEMS, channelCommand, handleChannelCommand, type ChannelSystem } from "./channel.js";

const features = { log: "log", account: "accounts", regear: "regears", specialisation: "specialisation", giveaway: "giveaways" } as const;

function fixture(system: ChannelSystem | null = "content", action = "set") {
  let live = true, admin = true, usable = true, configured = true, warning: string | undefined;
  let interruptAt: "member" | "channel" | "queue" | undefined;
  const events: string[] = [], responses: any[] = [];
  const saved = new Map<string, string>();
  const channel = {
    id: "selected-channel",
    type: system === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
    permissionsFor: () => ({ has: () => usable })
  };
  const interaction: any = {
    guildId: "guild", user: { id: "admin", bot: false }, deferred: false, replied: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => action,
      getString: () => system,
      getChannel: () => ({ id: "selected-channel" })
    },
    guild: {
      id: "guild", client: { user: { id: "bot" } },
      members: {
        me: { id: "bot" },
        fetch: async () => {
          events.push("member");
          if (interruptAt === "member") live = false;
          return { user: { bot: false }, permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.Administrator && admin } };
        }
      },
      channels: { fetch: async () => { events.push("fetch-channel"); if (interruptAt === "channel") live = false; return channel; } }
    },
    deferReply: async ({ flags }: { flags: number }) => {
      assert.equal(flags, MessageFlags.Ephemeral);
      events.push("defer"); interaction.deferred = true;
    },
    editReply: async (payload: any) => { events.push("reply"); responses.push(payload); interaction.replied = true; },
    followUp: async (payload: any) => { events.push("follow-up"); responses.push(payload); }
  };
  const dependencies: any = {
    logChannelRepository: {
      get: async () => { events.push("read:log"); return saved.has("log") ? { discordGuildId: "guild", discordChannelId: saved.get("log") } : undefined; },
      set: async (_guild: string, channelId: string) => { events.push("set:log"); saved.set("log", channelId); },
      clear: async () => { events.push("clear:log"); saved.delete("log"); }
    },
    logFeedService: {
      inspect: async () => { events.push("fetch-channel"); if (interruptAt === "channel") live = false; return { available: usable && channel.type === ChannelType.GuildText, missingPermissions: [], everyoneVisible: false }; },
      send: async () => { events.push("publish:log"); return configured ? "sent" : "failed"; }
    },
    contentRepository: {
      getContentChannel: async () => { events.push("read:content"); return saved.has("content") ? { discordChannelId: saved.get("content") } : undefined; },
      setContentChannel: async (guild: string, channelId: string) => { assert.equal(guild, "guild"); events.push("set:content"); saved.set("content", channelId); },
      clearContentChannel: async (guild: string) => { assert.equal(guild, "guild"); events.push("clear:content"); saved.delete("content"); }
    },
    entryPanelService: {
      captureFence: () => () => live,
      runExclusive: async (_guild: string, task: () => Promise<any>) => { events.push("queue"); if (interruptAt === "queue") live = false; return task(); },
      runGuild: async () => { events.push("refresh-panels"); },
      configureChannel: async (guild: { id: string }, feature: string, selected: { id: string }) => {
        assert.equal(guild.id, "guild"); events.push(`publish:${feature}`);
        if (configured) saved.set(feature, selected.id);
        return configured;
      },
      content: { getLastWarning: () => warning },
      context: { repository: {
        getChannel: async (guild: string, feature: string) => { assert.equal(guild, "guild"); events.push(`read:${feature}`); return saved.has(feature) ? { discordChannelId: saved.get(feature) } : undefined; },
        clearChannel: async (guild: string, feature: string) => { assert.equal(guild, "guild"); events.push(`clear:${feature}`); saved.delete(feature); }
      } }
    },
    temporaryVoiceService: {
      getConfig: async () => { events.push("read:voice"); return saved.has("voice") ? { baseChannelId: saved.get("voice") } : undefined; },
      configureBaseChannel: async (guild: { id: string }, selected: { id: string }) => { assert.equal(guild.id, "guild"); events.push("set:voice"); saved.set("voice", selected.id); },
      clearConfig: async (guild: string) => { assert.equal(guild, "guild"); events.push("clear:voice"); return saved.delete("voice"); },
      getMissingBotPermissions: () => usable ? [] : ["Manage Channels"]
    }
  };
  return {
    interaction, dependencies, channel, events, responses, saved,
    deny: () => { admin = false; }, blockChannel: () => { usable = false; }, failPublication: () => { configured = false; },
    interrupt: (at: typeof interruptAt) => { interruptAt = at; }, warn: (text: string) => { warning = text; },
    run: () => handleChannelCommand(interaction, dependencies)
  };
}

test("channel command exposes exactly the approved systems and required inputs, hidden by default", () => {
  const command = channelCommand.toJSON();
  assert.equal(command.name, "channel");
  assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options?.map(option => option.name), ["set", "clear", "show"]);
  for (const leaf of command.options as any[]) {
    assert.deepEqual(leaf.options.map((option: any) => [option.name, option.required]), leaf.name === "set"
      ? [["system", true], ["channel", true]] : [["system", leaf.name === "clear"]]);
    assert.deepEqual(leaf.options[0].choices.map((choice: any) => choice.value), CHANNEL_SYSTEMS);
    if (leaf.name === "set") assert.deepEqual(leaf.options[1].channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice]);
  }
});

test("every channel system and report requires live Administrator permission before reading or changing settings", async () => {
  for (const system of [...CHANNEL_SYSTEMS, null]) {
    for (const action of system ? ["set", "clear", "show"] : ["show"]) {
      const f = fixture(system, action); f.deny(); await f.run();
      assert.deepEqual(f.events, ["defer", "member", "reply"]);
      assert.match(JSON.stringify(f.responses), /Administrator Required/);
      assert.deepEqual(f.responses[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    }
  }
});

test("channel set acknowledges before member and channel fetches, and uses the correct system's configuration service", async () => {
  for (const system of CHANNEL_SYSTEMS) {
    const f = fixture(system); await f.run();
    const key = system === "content" || system === "voice" ? system : features[system];
    assert.deepEqual(f.events.slice(0, 3), ["defer", "member", "fetch-channel"]);
    assert.equal(f.saved.get(key), "selected-channel");
    assert.equal(f.saved.size, 1);
    assert.ok(f.events.includes(system === "content" || system === "voice" ? `set:${system}` : `publish:${key}`));
    assert.equal(f.events.includes("refresh-panels"), system !== "voice" && system !== "log");
    if (system !== "voice" && system !== "log") assert.ok(f.events.indexOf("refresh-panels") < f.events.indexOf("reply"));
  }
});

test("channel set rejects cross-system channel types and missing bot permissions without changing configuration", async () => {
  for (const system of CHANNEL_SYSTEMS) {
    for (const failure of ["type", "permissions"] as const) {
      const f = fixture(system);
      if (failure === "type") f.channel.type = system === "voice" ? ChannelType.GuildText : ChannelType.GuildVoice;
      else f.blockChannel();
      await f.run();
      assert.equal(f.saved.size, 0);
      assert.equal(f.events.includes("queue"), false);
      assert.match(JSON.stringify(f.responses), /Invalid Voice Channel|Voice Permissions Missing|Channel Unavailable/);
    }
  }
});

test("feature channel changes delegate publication failure without changing the old setting or claiming success", async () => {
  for (const system of ["account", "regear", "specialisation", "giveaway"] as const) {
    const f = fixture(system); f.saved.set(features[system], "old-channel"); f.failPublication(); await f.run();
    assert.equal(f.saved.get(features[system]), "old-channel");
    assert.equal(f.events.includes("refresh-panels"), false);
    assert.match(JSON.stringify(f.responses), /Channel Unavailable/);
  }
});

test("channel show includes all seven systems and unconfigured settings, or only the requested system", async () => {
  const all = fixture(null, "show");
  all.saved.set("content", "content-channel"); all.saved.set("regears", "regear-channel"); all.saved.set("voice", "voice-channel");
  await all.run();
  const report = JSON.stringify(all.responses);
  assert.match(report, /Content: <#content-channel>/);
  assert.match(report, /Accounts: Not configured/);
  assert.match(report, /Re-gears: <#regear-channel>/);
  assert.match(report, /Weapon Specialisation: Not configured/);
  assert.match(report, /Giveaways: Not configured/);
  assert.match(report, /Temporary Voice: <#voice-channel>/);
  assert.deepEqual(all.events.filter(event => event.startsWith("read:")), ["read:content", "read:accounts", "read:regears", "read:specialisation", "read:giveaways", "read:voice", "read:log"]);
  for (const system of CHANNEL_SYSTEMS) {
    const f = fixture(system, "show"); await f.run();
    assert.equal(f.events.filter(event => event.startsWith("read:")).length, 1);
    assert.match(JSON.stringify(f.responses), /No .* channel is configured/);
  }
});

test("channel clear changes only the selected system and retains shared panel reconciliation or normal voice cleanup", async () => {
  for (const system of CHANNEL_SYSTEMS) {
    const f = fixture(system, "clear");
    for (const key of ["content", "accounts", "regears", "specialisation", "giveaways", "voice", "log"]) f.saved.set(key, "original-channel");
    await f.run();
    const key = system === "content" || system === "voice" ? system : features[system];
    assert.equal(f.saved.has(key), false);
    assert.equal(f.saved.size, 6);
    assert.equal(f.events.includes("refresh-panels"), system !== "voice" && system !== "log");
    if (system === "voice") assert.match(JSON.stringify(f.responses), /existing temporary channels will be removed when empty/);
  }
});

test("resets during permission checks, target lookup, or queued mutations cannot recreate a channel setting", async () => {
  for (const system of CHANNEL_SYSTEMS) {
    for (const stage of ["member", "channel", "queue"] as const) {
      const f = fixture(system); f.interrupt(stage); await f.run();
      assert.equal(f.saved.size, 0);
      assert.match(JSON.stringify(f.responses), /Start Again/);
    }
    const clearing = fixture(system, "clear"); clearing.saved.set(system, "original"); clearing.interrupt("queue"); await clearing.run();
    assert.equal(clearing.saved.size, 1);
    assert.match(JSON.stringify(clearing.responses), /Start Again/);
  }
});

test("content channel changes preserve the maintenance warning after the saved setting's private response", async () => {
  for (const action of ["set", "clear"]) {
    const f = fixture("content", action); f.warn("Automatic recovery will retry."); await f.run();
    assert.equal(f.responses.length, 2);
    assert.match(JSON.stringify(f.responses[1]), /Content Panel Maintenance.*Automatic recovery will retry/);
    assert.ok(f.events.indexOf("reply") < f.events.indexOf("follow-up"));
    assert.equal(f.responses[1].flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  }
});
