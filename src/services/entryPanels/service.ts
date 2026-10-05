import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Guild, Message, MessageCreateOptions, NewsChannel, TextChannel } from "discord.js";
import type { createContentRepository } from "../../db/contentRepository.js";
import type { createContentPanelRepository } from "../../db/contentPanelRepository.js";
import type { createEntryPanelRepository } from "../../db/entryPanelRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createContentPanelService } from "../content/panel.js";
import { createKeyedSerialQueue } from "../reactionRoles/keyedSerialQueue.js";
import { createEntryPanelContext } from "./access.js";
import { ENTRY_FEATURES, parseEntryPanelId, type EntryFeature } from "./types.js";

type Channel = TextChannel | NewsChannel;
type Render = (feature: EntryFeature, guildId: string, channelId: string, generation: string, now: Date) => Promise<MessageCreateOptions>;
export function createEntryPanelService(deps: {
  repository: ReturnType<typeof createEntryPanelRepository>;
  content: ReturnType<typeof createContentRepository>;
  contentPanels: ReturnType<typeof createContentPanelRepository>;
  logger: Logger;
  isGuildActive(guildId: string): Promise<boolean>;
  hasRegisteredCharacter(guildId: string, userId: string): Promise<boolean>;
  render: Render;
}) {
  const queue = createKeyedSerialQueue();
  const held = new AsyncLocalStorage<string>();
  const epochs = new Map<string, number>();
  const plans = new Map<string, Map<string, boolean>>();
  let stopped = false, runtime = 0;
  async function runExclusive<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    if (held.getStore() === guildId) return operation();
    let result!: T;
    await queue.enqueue(guildId, () => held.run(guildId, async () => { result = await operation(); }));
    return result;
  }
  function captureFence(guildId: string) {
    const epoch = epochs.get(guildId) ?? 0, version = runtime;
    return () => !stopped && version === runtime && epoch === (epochs.get(guildId) ?? 0);
  }
  async function configurations(guildId: string) {
    const [content, ...entries] = await Promise.all([deps.content.getContentChannel(guildId), ...ENTRY_FEATURES.map(f => deps.repository.getChannel(guildId, f))]);
    return [{ feature: "content" as const, config: content }, ...ENTRY_FEATURES.map((feature, index) => ({ feature, config: entries[index] }))];
  }
  async function movementPlan(guild: Guild, now = new Date()) {
    const groups = new Map<string, Array<string | null>>();
    const blockedChannels = new Set<string>();
    for (const { feature, config } of await configurations(guild.id)) {
      if (!config) continue;
      const publications = await (feature === "content" ? deps.contentPanels : deps.repository.publications(feature)).listPublications(guild.id);
      const current = publications.find(p => p.state === "current" && p.configurationRevision === config.configurationRevision && p.discordChannelId === config.discordChannelId);
      const core = feature === "content" ? contentCore : services[feature];
      if (!current?.messageId || !current.publishedAt || now.getTime() - current.publishedAt.getTime() < 60000
        || !core.movementReady(guild.id, now)
        || publications.some(p => p.state !== "current" && p.discordChannelId === config.discordChannelId)) blockedChannels.add(config.discordChannelId);
      const expected = groups.get(config.discordChannelId) ?? [];
      expected.push(current?.messageId ?? null);
      groups.set(config.discordChannelId, expected);
    }
    const result = new Map<string, boolean>();
    for (const [id, expected] of groups) {
      if (blockedChannels.has(id)) { result.set(id, false); continue; }
      try {
        const channel = await guild.channels.fetch(id);
        if (!channel || (channel.type !== 0 && channel.type !== 5)) continue;
        // A missing sibling repairs itself first. Healthy panels wait until the
        // whole channel can move together, including recovery and retry throttles.
        const canonicals = await Promise.all(expected.map(message => channel.messages.fetch({ message: message!, force: true }).catch(() => null)));
        if (canonicals.some(message => !message || message.author.id !== guild.client.user!.id)) { result.set(id, false); continue; }
        const top = [...(await channel.messages.fetch({ limit: expected.length, cache: false })).values()].sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
        result.set(id, panelBlockNeedsMovement(expected, top.map(m => m.author.id === guild.client.user!.id ? m.id : null)));
      } catch { /* Each durable service reports and backs off its own unavailable channel. */ }
    }
    return result;
  }
  const shouldMove = async (guild: Guild, channel: Channel, now: Date) => (plans.get(guild.id) ?? await movementPlan(guild, now)).get(channel.id) ?? false;
  const contentCore = createContentPanelService(deps.content, deps.contentPanels, deps.logger, { isGuildActive: deps.isGuildActive, runExclusive, shouldMove });
  const services = Object.fromEntries(ENTRY_FEATURES.map(feature => [feature, createContentPanelService(
    { getContentChannel: async guildId => { const c = await deps.repository.getChannel(guildId, feature); return c ? { ...c, discordGuildId: guildId } : undefined; } },
    { ...deps.repository.publications(feature), listPanelContent: async () => [] }, deps.logger, {
      isGuildActive: deps.isGuildActive, runExclusive, shouldMove,
      parseId: id => { const parsed = parseEntryPanelId(id); return parsed?.feature === feature ? parsed : undefined; },
      render: async (guildId, channelId, generation, now) => render(feature, guildId, channelId, generation, now)
    })])) as Record<EntryFeature, ReturnType<typeof createContentPanelService>>;
  async function render(feature: EntryFeature, guildId: string, channelId: string, generation: string, now: Date) {
    const payload = await deps.render(feature, guildId, channelId, generation, now);
    return { payload, hash: createHash("sha256").update(JSON.stringify(payload.components)).digest("hex") };
  }
  async function runGuild(guild: Guild, now = new Date()) {
    const live = captureFence(guild.id);
    await runExclusive(guild.id, async () => {
      if (!live() || !await deps.isGuildActive(guild.id)) return;
      plans.set(guild.id, await movementPlan(guild, now));
      try {
        for (const service of [contentCore, ...ENTRY_FEATURES.map(f => services[f])]) {
          if (!live()) return;
          await service.runGuild(guild, now);
        }
      } finally { plans.delete(guild.id); }
    });
  }
  const context = createEntryPanelContext({ repository: deps.repository, runExclusive, refresh: runGuild,
    isGuildActive: deps.isGuildActive, hasRegisteredCharacter: deps.hasRegisteredCharacter, captureFence,
    isCurrentPanel: (feature, guildId, channelId, messageId, generation) => services[feature].isCurrentPanel(guildId, channelId, messageId, generation) });
  return {
    context, runGuild, runExclusive, captureFence,
    content: { ...contentCore, runGuild, runPanels: async (guilds: Iterable<Guild>, now = new Date()) => { for (const guild of guilds) await runGuild(guild, now); } },
    async configureChannel(guild: Guild, feature: EntryFeature, channel: Channel) {
      const live = captureFence(guild.id);
      return runExclusive(guild.id, async () => {
        if (!live() || !await deps.isGuildActive(guild.id)) return false;
        const previous = await deps.repository.getChannel(guild.id, feature);
        const generation = randomBytes(12).toString("hex");
        const revision = previous?.discordChannelId === channel.id ? previous.configurationRevision : randomUUID();
        const rendered = await render(feature, guild.id, channel.id, generation, new Date());
        if (!live() || !await deps.isGuildActive(guild.id) || !live()) return false;
        // Explicit reconfiguration must escape an unresolved send in an old,
        // inaccessible channel. Retain that attempt for cleanup without its unique pending slot.
        for (const attempt of await deps.repository.publications(feature).listPublications(guild.id)) {
          if (attempt.state === "pending") await deps.repository.publications(feature).retirePublication(guild.id, attempt.generation);
        }
        if (!live()) return false;
        if (!await deps.repository.prepareChannel(guild.id, feature, channel.id, revision, generation, rendered.hash)) return false;
        if (!live() || !await deps.isGuildActive(guild.id) || !live()) {
          await deps.repository.publications(feature).removePublication(guild.id, generation);
          return false;
        }
        let sentId: string | undefined;
        let sentMessage: Message | undefined;
        try {
          const message = await channel.send({ ...rendered.payload, nonce: generation, enforceNonce: true });
          sentMessage = message;
          sentId = message.id;
          if (!live() || !await deps.isGuildActive(guild.id)) throw new Error("Entry panel configuration expired.");
          if (!await deps.repository.commitChannel(guild.id, feature, generation, sentId, previous?.configurationRevision)) throw new Error("Entry panel configuration changed.");
          return true;
        } catch {
          // A lost database acknowledgement may still represent a committed setting.
          const saved = await deps.repository.publications(feature).listPublications(guild.id);
          if (saved.some(p => p.state === "current" && p.generation === generation)) return true;
          if (sentMessage && !live()) {
            try {
              await sentMessage.delete();
              await deps.repository.publications(feature).removePublication(guild.id, generation);
              return false;
            } catch { /* Keep cleanup state if Discord cannot remove the superseded send. */ }
          }
          await deps.repository.publications(feature).retirePublication(guild.id, generation, sentId);
          return false;
        }
      });
    },
    runPanels: async (guilds: Iterable<Guild>, now = new Date()) => { for (const guild of guilds) await runGuild(guild, now); },
    invalidateGuild(guildId: string) { epochs.set(guildId, (epochs.get(guildId) ?? 0) + 1); contentCore.invalidateGuild(guildId); for (const service of Object.values(services)) service.invalidateGuild(guildId); },
    stop() { stopped = true; runtime++; contentCore.stop(); for (const service of Object.values(services)) service.stop(); },
    start() { stopped = false; contentCore.start(); for (const service of Object.values(services)) service.start(); }
  };
}

export function panelBlockNeedsMovement(expectedOldestFirst: readonly (string | null)[], actualNewestFirst: readonly (string | null)[]) {
  return expectedOldestFirst.some(id => !id) || expectedOldestFirst.length !== actualNewestFirst.length || [...expectedOldestFirst].reverse().some((id, index) => id !== actualNewestFirst[index]);
}
