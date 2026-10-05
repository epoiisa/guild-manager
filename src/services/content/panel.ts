import { randomBytes } from "node:crypto";
import {
  PermissionFlagsBits,
  type Guild,
  type Message,
  type TextChannel,
  type NewsChannel,
  type MessageCreateOptions,
} from "discord.js";
import type { createContentRepository } from "../../db/contentRepository.js";
import type {
  ContentPanelPublication,
  createContentPanelRepository,
} from "../../db/contentPanelRepository.js";
import type { Logger } from "../../logging/logger.js";
import { createKeyedSerialQueue } from "../reactionRoles/keyedSerialQueue.js";
import {
  buildContentPanelMessage,
  parseContentPanelId,
} from "./panelRendering.js";

type Repository = ReturnType<typeof createContentPanelRepository>;
type Channel = TextChannel | NewsChannel;
export type ContentPanelService = ReturnType<typeof createContentPanelService>;
const missing = (error: unknown) =>
  [10008, 10003].includes(Number((error as { code?: unknown })?.code));
export function createContentPanelService(
  content: Pick<
    ReturnType<typeof createContentRepository>,
    "getContentChannel"
  >,
  repository: Repository,
  logger: Logger,
  options: {
    isGuildActive?: (guildId: string) => Promise<boolean> | boolean;
    render?: (guildId: string, channelId: string, generation: string, now: Date) => Promise<{ payload: MessageCreateOptions; hash: string }>;
    parseId?: (id: string) => { generation: string } | undefined;
    shouldMove?: (guild: Guild, channel: Channel, now: Date) => Promise<boolean>;
    runExclusive?: <T>(guildId: string, operation: () => Promise<T>) => Promise<T>;
  } = {},
) {
  const queue = createKeyedSerialQueue();
  const epochs = new Map<string, number>();
  const warnings = new Map<string, string>();
  const scanAnchors = new Map<string, string | null>();
  const retries = new Map<string, { at: number; failures: number }>();
  let stopped = false;
  let runtimeEpoch = 0;
  async function runExclusive<T>(
    guildId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (options.runExclusive) return options.runExclusive(guildId, operation);
    let result!: T;
    await queue.enqueue(guildId, async () => {
      result = await operation();
    });
    return result;
  }
  function invalidateGuild(guildId: string) {
    epochs.set(guildId, (epochs.get(guildId) ?? 0) + 1);
    retries.delete(guildId);
  }
  async function isCurrentPanel(
    guildId: string,
    channelId: string,
    messageId: string,
    generation: string,
  ) {
    if (
      stopped ||
      (options.isGuildActive && !(await options.isGuildActive(guildId)))
    )
      return false;
    const config = await content.getContentChannel(guildId);
    return (
      config?.discordChannelId === channelId &&
      (await repository.listPublications(guildId)).some(
        (p) =>
          p.state === "current" &&
          p.configurationRevision === config.configurationRevision &&
          p.messageId === messageId &&
          p.generation === generation,
      )
    );
  }
  function identity(
    message: Message,
    publication: ContentPanelPublication,
    botId: string,
  ): boolean {
    if (message.author.id !== botId) return false;
    const walk = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      const item = value as {
        custom_id?: string;
        components?: unknown[];
        toJSON?: () => unknown;
      };
      if (item.toJSON) return walk(item.toJSON());
      return (
        (item.custom_id
          ? (options.parseId ?? parseContentPanelId)(item.custom_id)?.generation ===
            publication.generation
          : false) || !!item.components?.some(walk)
      );
    };
    return message.components.some(walk);
  }
  async function render(guildId: string, channelId: string, generation: string, now: Date) {
    if (options.render) return options.render(guildId, channelId, generation, now);
    const entries = await repository.listPanelContent(guildId, channelId, now);
    for (const entry of entries) if (entry.content.state === "active" && !entry.content.startedAt)
      logger.warn("Active content has no actual start", { discordGuildId: guildId, contentId: entry.content.contentId });
    return buildContentPanelMessage(entries, generation, now);
  }
  async function runGuild(guild: Guild, now = new Date()) {
    const epoch = epochs.get(guild.id) ?? 0,
      runtime = runtimeEpoch;
    return runExclusive(guild.id, async () => {
      const live = async () =>
        !stopped &&
        runtime === runtimeEpoch &&
        epoch === (epochs.get(guild.id) ?? 0) &&
        (!options.isGuildActive || (await options.isGuildActive(guild.id)));
      if (!(await live()) || (retries.get(guild.id)?.at ?? 0) > now.getTime())
        return;
      const resolveChannel = async (
        id: string,
      ): Promise<Channel | undefined> => {
        try {
          const channel = await guild.channels.fetch(id);
          return channel && (channel.type === 0 || channel.type === 5)
            ? (channel as Channel)
            : undefined;
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
      };
      const fetchMessage = async (channel: Channel, id: string) => {
        try {
          return await channel.messages.fetch({ message: id, force: true });
        } catch (error) {
          if (missing(error)) return undefined;
          throw error;
        }
      };
      try {
        warnings.delete(guild.id);
        let config = await content.getContentChannel(guild.id);
        let publications = await repository.listPublications(guild.id);
        const botId = guild.client.user!.id;
        for (const old of publications.filter(
          (p) =>
            p.state !== "retired" &&
            (!config ||
              p.configurationRevision !== config.configurationRevision ||
              p.discordChannelId !== config.discordChannelId),
        )) {
          if (!(await live())) return;
          await repository.retirePublication(guild.id, old.generation);
        }
        publications = await repository.listPublications(guild.id);
        const generations = new Set(
          publications.map((p) => `${guild.id}:${p.generation}`),
        );
        for (const key of scanAnchors.keys())
          if (key.startsWith(`${guild.id}:`) && !generations.has(key))
            scanAnchors.delete(key);
        // Recovery advances backwards durably, revisits the newer frontier, and
        // only releases absent attempts after a complete scan and settling window.
        for (const publication of publications.filter(
          (p) => p.state === "pending" || p.state === "retired",
        )) {
          if (!(await live())) return;
          try {
            const channel = await resolveChannel(publication.discordChannelId);
            if (!channel) {
              await repository.removePublication(
                guild.id,
                publication.generation,
              );
              continue;
            }
            let message = publication.messageId
              ? await fetchMessage(channel, publication.messageId)
              : undefined;
            if (!publication.messageId) {
              const permissions = channel.permissionsFor(
                guild.members.me ?? botId,
              );
              if (
                !permissions?.has([
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.ReadMessageHistory,
                ])
              ) {
                throw new Error(
                  "Content panel recovery requires channel history access",
                );
              }
              // A stable newest-message anchor lets each bounded historical page
              // advance without re-reading an ever-growing frontier. On restart or
              // new parent activity, restart the scan rather than trust an unanchored
              // cursor. Sustained traffic may postpone recovery, but quiet history
              // always completes regardless of its size.
              const scanKey = `${guild.id}:${publication.generation}`;
              const newest = await channel.messages.fetch({
                limit: 1,
                cache: false,
              });
              const scanTop = newest.first()?.id;
              let before = publication.scanBeforeMessageId;
              if (
                !scanAnchors.has(scanKey) ||
                scanAnchors.get(scanKey) !== (scanTop ?? null)
              ) {
                scanAnchors.set(scanKey, scanTop ?? null);
                before = null;
                await repository.updateRecoveryCursor(
                  guild.id,
                  publication.generation,
                  null,
                );
              }
              const batch = await channel.messages.fetch({
                limit: 100,
                ...(before ? { before } : {}),
                cache: false,
              });
              message ??= [...batch.values()].find((m) =>
                identity(m, publication, botId),
              );
              if (!message) {
                const oldest = [...batch.values()].sort((a, b) =>
                  BigInt(a.id) < BigInt(b.id) ? -1 : 1,
                )[0];
                if (
                  batch.size === 100 &&
                  oldest &&
                  oldest.createdTimestamp >=
                    publication.createdAt.getTime() - 5000
                ) {
                  warnings.set(
                    guild.id,
                    "Content panel recovery is scanning channel history; automatic recovery will continue.",
                  );
                  await repository.updateRecoveryCursor(
                    guild.id,
                    publication.generation,
                    oldest.id,
                  );
                  continue;
                }
                const frontier = await channel.messages.fetch({
                  limit: 100,
                  cache: false,
                });
                message = [...frontier.values()].find((m) =>
                  identity(m, publication, botId),
                );
                if (!message && frontier.first()?.id !== scanTop) {
                  await repository.updateRecoveryCursor(
                    guild.id,
                    publication.generation,
                    null,
                  );
                  warnings.set(
                    guild.id,
                    "Content panel recovery is checking newly arrived messages; automatic recovery will continue.",
                  );
                  continue;
                }
                if (
                  !message &&
                  publication.state === "pending" &&
                  now.getTime() - publication.createdAt.getTime() < 120000 &&
                  permissions.has(PermissionFlagsBits.SendMessages) &&
                  config?.configurationRevision ===
                    publication.configurationRevision &&
                  (await live())
                ) {
                  const rendered = await render(guild.id, channel.id, publication.generation, now);
                  message = await channel.send({
                    ...rendered.payload,
                    nonce: publication.generation,
                    enforceNonce: true,
                  });
                }
                if (!message) {
                  if (
                    now.getTime() - publication.createdAt.getTime() >= 300000 &&
                    (await live())
                  ) {
                    // Both the historical range and its newer segment were checked.
                    // Release a verified-absent attempt only after the send window settles.
                    // An arbitrarily delayed remote send remains theoretically possible;
                    // its generation can never become canonical after this release.
                    await repository.removePublication(
                      guild.id,
                      publication.generation,
                    );
                    continue;
                  }
                  await repository.updateRecoveryCursor(
                    guild.id,
                    publication.generation,
                    null,
                  );
                  warnings.set(
                    guild.id,
                    "Content panel publication is awaiting recovery; automatic recovery will retry after checking channel history.",
                  );
                  logger.warn("Content panel publication unresolved", {
                    discordGuildId: guild.id,
                    generation: publication.generation,
                  });
                  continue;
                }
              }
            }
            if (!(await live())) return;
            config = await content.getContentChannel(guild.id);
            if (
              message &&
              publication.state === "pending" &&
              config?.configurationRevision ===
                publication.configurationRevision &&
              config.discordChannelId === publication.discordChannelId
            ) {
              if (
                !(await repository.commitPublication(
                  guild.id,
                  publication.generation,
                  message.id,
                ))
              )
                await repository.retirePublication(
                  guild.id,
                  publication.generation,
                  message.id,
                );
            } else {
              if (message && identity(message, publication, botId))
                await message.delete();
              await repository.removePublication(
                guild.id,
                publication.generation,
              );
            }
          } catch (error) {
            warnings.set(
              guild.id,
              "Content panel cleanup or recovery is incomplete. Check bot channel access; automatic recovery will retry.",
            );
            logger.warn("Content panel recovery deferred", {
              discordGuildId: guild.id,
              channelId: publication.discordChannelId,
              generation: publication.generation,
              code: (error as { code?: unknown })?.code,
            });
          }
        }
        if (!(await live())) return;
        config = await content.getContentChannel(guild.id);
        publications = await repository.listPublications(guild.id);
        // Configuration changes immediately invalidate controls; retire old canonical.
        for (const old of publications.filter(
          (p) =>
            p.state === "current" &&
            (!config ||
              p.configurationRevision !== config.configurationRevision ||
              p.discordChannelId !== config.discordChannelId),
        ))
          await repository.retirePublication(guild.id, old.generation);
        if (!config || !(await live())) return;
        const expected = config;
        const fresh = async () => {
          if (!(await live())) return false;
          const current = await content.getContentChannel(guild.id);
          return (
            current?.configurationRevision === expected.configurationRevision &&
            current.discordChannelId === expected.discordChannelId
          );
        };
        const channel = await resolveChannel(config.discordChannelId);
        if (!channel) {
          warnings.set(
            guild.id,
            "The configured content channel is missing or unavailable.",
          );
          return;
        }
        if (!(await fresh())) return;
        const permissions = channel.permissionsFor(guild.members.me ?? botId);
        if (
          !permissions?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages,
          ])
        ) {
          warnings.set(
            guild.id,
            "Content panel requires View Channel, Read Message History, and Send Messages in the configured channel.",
          );
          logger.warn("Content panel permissions unavailable", {
            discordGuildId: guild.id,
            channelId: channel.id,
          });
          return;
        }
        publications = await repository.listPublications(guild.id);
        const current = publications.find((p) => p.state === "current");
        const message = current?.messageId
          ? await fetchMessage(channel, current.messageId)
          : undefined;
        if (message && current && !identity(message, current, botId))
          throw new Error("Saved content panel identity mismatch");
        const newest = (
          await channel.messages.fetch({ limit: 1, cache: false })
        ).first();
        const newer = options.shouldMove ? await options.shouldMove(guild, channel, now) :
          message &&
          newest &&
          BigInt(newest.id) > BigInt(message.id) &&
          !publications.some((p) => identity(newest, p, botId));
        const blocked = publications.some(
          (p) =>
            p.state === "pending" ||
            (p.state === "retired" && p.discordChannelId === channel.id),
        );
        const throttled =
          current?.publishedAt &&
          now.getTime() - current.publishedAt.getTime() < 60000;
        if (message && current && (!newer || blocked || throttled)) {
          const rendered = await render(guild.id, channel.id, current.generation, now);
          if (rendered.hash !== current.renderHash && (await fresh())) {
            await message.edit({
              components: rendered.payload.components,
              allowedMentions: rendered.payload.allowedMentions,
            });
            if (await fresh())
              await repository.markRendered(
                guild.id,
                current.generation,
                rendered.hash,
              );
          }
        } else if (!blocked && (await fresh())) {
          const generation = randomBytes(12).toString("hex");
          const rendered = await render(guild.id, channel.id, generation, now);
          const pending = await repository.beginPublication({
            discordGuildId: guild.id,
            discordChannelId: channel.id,
            configurationRevision: config.configurationRevision,
            generation,
            previousGeneration: current?.generation ?? null,
            renderHash: rendered.hash,
            now,
          });
          if (!pending) return;
          if (!(await fresh())) {
            await repository.removePublication(guild.id, generation);
            return;
          }
          let sent: Message;
          try {
            sent = await channel.send({
              ...rendered.payload,
              nonce: generation,
              enforceNonce: true,
            });
          } catch (error) {
            const status = Number((error as { status?: unknown })?.status);
            if (
              status >= 400 &&
              status < 500 &&
              status !== 408 &&
              status !== 429 &&
              (await live())
            )
              await repository.removePublication(guild.id, generation);
            throw error;
          }
          if (!(await fresh())) {
            try { await sent.delete(); await repository.removePublication(guild.id, generation); }
            catch { await repository.retirePublication(guild.id, generation, sent.id); }
            return;
          }
          if (
            !(await repository.commitPublication(guild.id, generation, sent.id))
          )
            await repository.retirePublication(guild.id, generation, sent.id);
          else if (current?.messageId) {
            try {
              if (message && identity(message, current, botId))
                await message.delete();
              await repository.removePublication(guild.id, current.generation);
            } catch {
              /* The durable retired record is retried next pass. */
            }
          }
        }
        retries.delete(guild.id);
      } catch (error) {
        warnings.set(
          guild.id,
          "The content panel could not be refreshed. Check bot channel permissions; automatic recovery will retry.",
        );
        const failures = Math.min(
          (retries.get(guild.id)?.failures ?? 0) + 1,
          6,
        );
        retries.set(guild.id, {
          failures,
          at: now.getTime() + Math.min(60000 * 2 ** (failures - 1), 900000),
        });
        logger.warn("Content panel reconciliation deferred", {
          discordGuildId: guild.id,
          code: (error as { code?: unknown })?.code,
        });
      }
    });
  }
  return {
    movementReady: (guildId: string, _now: Date) => !stopped && !retries.has(guildId),
    getLastWarning: (guildId: string) => warnings.get(guildId),
    captureFence(guildId: string) {
      const epoch = epochs.get(guildId) ?? 0;
      const runtime = runtimeEpoch;
      return () =>
        !stopped &&
        runtime === runtimeEpoch &&
        epoch === (epochs.get(guildId) ?? 0);
    },
    runGuild,
    runPanels: async (guilds: Iterable<Guild>, now = new Date()) => {
      for (const guild of guilds) await runGuild(guild, now);
    },
    runExclusive,
    isCurrentPanel,
    invalidateGuild,
    stop() {
      stopped = true;
      runtimeEpoch++;
      scanAnchors.clear();
    },
    start() {
      stopped = false;
    },
  };
}
