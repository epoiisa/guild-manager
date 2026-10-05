import test from "node:test";
import assert from "node:assert/strict";
import { Collection, ContainerBuilder, TextDisplayBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { createEntryPanelService, panelBlockNeedsMovement } from "./service.js";
import { ENTRY_FEATURES, entryPanelId } from "./types.js";

function fixture() {
  let renderHook = () => {};
  let sendHook = () => {};
  let timestamp = Date.now(), sequence = 1000000000000000000n, failSend = false;
  const configs = new Map<string, any>(["content", ...ENTRY_FEATURES].map(feature => [feature, { discordGuildId: "guild", discordChannelId: "shared", configurationRevision: feature }]));
  const rows = new Map<string, any[]>();
  const stores = new Map<string, Collection<string, any>>();
  const sent: string[] = [], deleted: string[] = [];
  const publications = (feature: string) => {
    if (!rows.has(feature)) rows.set(feature, []);
    return {
      listPublications: async () => rows.get(feature)!,
      listPanelContent: async () => [],
      beginPublication: async (input: any) => {
        const row = { ...input, state: "pending", messageId: null, createdAt: new Date(timestamp), publishedAt: null };
        rows.get(feature)!.push(row); return row;
      },
      commitPublication: async (_: string, generation: string, messageId: string) => {
        for (const row of rows.get(feature)!) if (row.state === "current") row.state = "retired";
        const row = rows.get(feature)!.find(p => p.generation === generation)!;
        Object.assign(row, { state: "current", messageId, publishedAt: new Date(timestamp) }); return true;
      },
      retirePublication: async (_: string, generation: string, messageId?: string) => {
        const row = rows.get(feature)!.find(p => p.generation === generation); if (row) Object.assign(row, { state: "retired", ...(messageId ? { messageId } : {}) });
      },
      removePublication: async (_: string, generation: string) => { rows.set(feature, rows.get(feature)!.filter(p => p.generation !== generation)); },
      markRendered: async (_: string, generation: string, hash: string) => { rows.get(feature)!.find(p => p.generation === generation)!.renderHash = hash; },
      updateRecoveryCursor: async () => {}
    };
  };
  const channel = (id: string): any => {
    const messages = stores.get(id) ?? new Collection(); stores.set(id, messages);
    return { id, type: 0, permissionsFor: () => ({ has: () => true }), messages: { fetch: async (options: any) => {
      if (options.message) { const message = messages.get(options.message); if (!message) throw { code: 10008 }; return message; }
      return new Collection([...messages].reverse().filter(([messageId]) => !options.before || BigInt(messageId) < BigInt(options.before)).slice(0, options.limit));
    } }, send: async (payload: any) => {
      if (failSend) throw { status: 403 };
      const messageId = String(++sequence); sent.push(messageId);
      const message = { id: messageId, author: { id: "bot" }, components: payload.components, createdTimestamp: timestamp,
        delete: async () => { deleted.push(messageId); messages.delete(messageId); },
        edit: async (body: any) => { message.components = body.components; } };
      messages.set(messageId, message); sendHook(); return message;
    } };
  };
  const repository: any = {
    getChannel: async (_: string, feature: string) => configs.get(feature), publications,
    prepareChannel: async (guild: string, feature: string, channelId: string, revision: string, generation: string, hash: string) => {
      rows.get(feature)!.push({ discordGuildId: guild, discordChannelId: channelId, configurationRevision: revision, generation, state: "pending", messageId: null, renderHash: hash, createdAt: new Date(timestamp) }); return true;
    },
    commitChannel: async (_: string, feature: string, generation: string, messageId: string) => {
      const row = rows.get(feature)!.find(p => p.generation === generation)!;
      configs.set(feature, { discordGuildId: "guild", discordChannelId: row.discordChannelId, configurationRevision: row.configurationRevision });
      return publications(feature).commitPublication("guild", generation, messageId);
    }
  };
  const guild: any = { id: "guild", members: { me: null }, client: { user: { id: "bot" } }, channels: { fetch: async (id: string) => channel(id) } };
  const service = createEntryPanelService({ repository, content: { getContentChannel: async () => configs.get("content") } as any,
    contentPanels: publications("content") as any, logger: { debug() {}, info() {}, warn() {}, error() {} }, isGuildActive: async () => true, hasRegisteredCharacter: async () => true,
    render: async (feature, _g, _c, generation) => { renderHook(); return ({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(feature)).addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(entryPanelId(feature, generation, "test")).setLabel("Test").setStyle(ButtonStyle.Secondary)))] }); } });
  return { service, repository, configs, rows, stores, sent, deleted, guild, channel,
    setRenderHook(hook: () => void) { renderHook = hook; },
    setSendHook(hook: () => void) { sendHook = hook; },
    setFailSend(v: boolean) { failSend = v; },
    async pass() { await service.runGuild(guild, new Date(timestamp)); timestamp += 60001; },
    human() { const id = String(++sequence); stores.get("shared")!.set(id, { id, author: { id: "human" }, components: [], createdTimestamp: timestamp }); },
    current() { return ["content", ...ENTRY_FEATURES].map(feature => rows.get(feature)!.find(p => p.state === "current")!.messageId); }
  };
}

test("five colocated panels publish in order, move as one block after activity, and then remain quiet", async () => {
  const f = fixture(); await f.pass();
  assert.equal(f.sent.length, 5);
  assert.deepEqual([...f.stores.get("shared")!.keys()], f.current());
  await f.pass(); await f.pass(); assert.equal(f.sent.length, 5);
  f.human(); await f.pass();
  assert.equal(f.sent.length, 10); assert.equal(f.deleted.length, 5);
  assert.deepEqual([...f.stores.get("shared")!.keys()].slice(-5), f.current());
  await f.pass(); await f.pass(); assert.equal(f.sent.length, 10, "peer panels must not trigger one another indefinitely");
});

test("a missing middle panel is repaired and the complete shared block settles without deleting ordinary posts", async () => {
  const f = fixture(); await f.pass(); f.human();
  f.stores.get("shared")!.delete(f.current()[2]);
  await f.pass(); await f.pass();
  assert.deepEqual([...f.stores.get("shared")!.keys()].slice(-5), f.current());
  const count = f.sent.length; await f.pass(); assert.equal(f.sent.length, count);
  assert.equal([...f.stores.get("shared")!.values()].filter(m => m.author.id === "human").length, 1);
});

test("failed channel publication leaves previous config and canonical intact; successful replacement preserves same-channel revision", async () => {
  const f = fixture(); await f.pass(); const original = f.configs.get("accounts"), oldId = f.current()[1];
  f.setFailSend(true);
  assert.equal(await f.service.configureChannel(f.guild, "accounts", f.channel("new")), false);
  assert.deepEqual(f.configs.get("accounts"), original); assert.equal(f.current()[1], oldId);
  f.setFailSend(false);
  assert.equal(await f.service.configureChannel(f.guild, "accounts", f.channel("shared")), true);
  assert.equal(f.configs.get("accounts").configurationRevision, original.configurationRevision);
  assert.ok(f.stores.get("shared")!.has(oldId), "new canonical is saved before old message cleanup");
});

test("configuration/reset exclusion is reentrant and runtime invalidation fences old work", async () => {
  const f = fixture(); const fence = f.service.captureFence("guild");
  assert.equal(await f.service.runExclusive("guild", () => f.service.runExclusive("guild", async () => 3)), 3);
  f.service.invalidateGuild("guild"); assert.equal(fence(), false);
  f.service.stop(); await f.pass(); assert.equal(f.sent.length, 0);
  f.service.start(); await f.pass(); assert.equal(f.sent.length, 5);
});

test("block detection catches ordering, missing panels and human activity", () => {
  assert.equal(panelBlockNeedsMovement(["1", "2"], ["2", "1"]), false);
  assert.equal(panelBlockNeedsMovement(["1", "2"], ["1", "2"]), true);
  assert.equal(panelBlockNeedsMovement(["1", null], ["2", "1"]), true);
  assert.equal(panelBlockNeedsMovement(["1", "2"], [null, "2"]), true);
});

test("healthy siblings stay in place while a missing panel cannot publish", async () => {
  const f = fixture(); await f.pass();
  f.stores.get("shared")!.delete(f.current()[1]); f.setFailSend(true);
  await f.pass(); await f.pass(); await f.pass();
  assert.equal(f.sent.length, 5); assert.equal(f.deleted.length, 0);
  f.setFailSend(false); await f.pass(); await f.pass(); await f.pass();
  assert.deepEqual([...f.stores.get("shared")!.keys()].slice(-5), f.current());
  const count = f.sent.length; await f.pass(); assert.equal(f.sent.length, count);
});

test("explicit channel replacement retires unresolved pending sends and preserves their cleanup record", async () => {
  const f = fixture(); await f.pass();
  f.rows.get("accounts")!.push({ generation: "unknown", state: "pending", discordChannelId: "shared", configurationRevision: "accounts", createdAt: new Date() });
  assert.equal(await f.service.configureChannel(f.guild, "accounts", f.channel("new")), true);
  assert.equal(f.rows.get("accounts")!.find(row => row.generation === "unknown")!.state, "retired");
  assert.equal(f.configs.get("accounts").discordChannelId, "new");
});

test("configuration invalidated during rendering or preparation never sends a new panel", async () => {
  for (const phase of ["render", "prepare"]) {
    const f = fixture(); await f.pass();
    if (phase === "render") f.setRenderHook(() => f.service.invalidateGuild("guild"));
    else {
      const prepare = f.repository.prepareChannel;
      f.repository.prepareChannel = async (...args: any[]) => { const result = await prepare(...args); f.service.invalidateGuild("guild"); return result; };
    }
    assert.equal(await f.service.configureChannel(f.guild, "accounts", f.channel("new")), false);
    assert.equal(f.sent.length, 5); assert.equal(f.configs.get("accounts").discordChannelId, "shared");
  }
});

test("a send resolving after invalidation removes its new message before queued purge can discard cleanup state", async () => {
  for (const configure of [true, false]) {
    const f = fixture();
    if (configure) await f.pass();
    f.setSendHook(() => f.service.invalidateGuild("guild"));
    if (configure) assert.equal(await f.service.configureChannel(f.guild, "accounts", f.channel("new")), false);
    else await f.pass();
    assert.equal(f.deleted.length, 1);
    assert.equal(f.stores.get(configure ? "new" : "shared")!.size, 0);
  }
});
