import { randomInt } from "node:crypto";
import {
  ComponentType,
  MessageFlags,
  type Guild,
  type Message,
  type SendableChannels
} from "discord.js";
import type {
  GiveawayReactionSnapshot,
  GiveawayRecord,
  GiveawayState,
  createGiveawayRepository
} from "../../db/giveawayRepository.js";
import type { Logger } from "../../logging/logger.js";
import { canonicalReactionEmojiKey } from "../reactionRoles/emoji.js";
import {
  buildClosedGiveawayV2Message,
  buildDrawAnnouncement,
  buildOpenGiveawayV2Message,
  buildRedrawAnnouncement
} from "./rendering.js";

type GiveawayRepository = ReturnType<typeof createGiveawayRepository>;

export type GiveawayDrawResult = "drawn" | "already_closed" | "message_missing";
export type GiveawayCancelResult = "cancelled" | "already_closed" | "message_missing" | "message_close_failed";
export interface GiveawayRerollSuccess {
  replacementDiscordUserId: string;
  notificationPublished: boolean;
}
export const GIVEAWAY_ENTRY_EMOJI = "🎁";
export const GIVEAWAY_ENTRY_EMOJI_KEY = `unicode:${GIVEAWAY_ENTRY_EMOJI}`;

export function createGiveawayService(repository: GiveawayRepository, logger: Logger) {
  return {
    async refreshOpenMessage(guild: Guild, giveaway: GiveawayRecord): Promise<void> {
      const message = await fetchGiveawayMessage(guild, giveaway);
      if (!message) return;
      const participantIds = await repository.listEligibleParticipantIds(guild.id, giveaway.giveawayId);
      await message.edit({
        ...withoutPreviousGiveawayReport(message),
        ...buildOpenGiveawayV2Message(
          giveaway,
          participantIds,
          false,
          existingGiveawayImageUrl(message, giveaway)
        ),
        content: null,
        embeds: [],
        flags: MessageFlags.IsComponentsV2
      });
    },

    /** Retryable presentation cleanup after the kick transaction has revoked participation. */
    async reconcileAfterKick(guild: Guild, giveaway: GiveawayRecord, discordUserId: string): Promise<void> {
      const channel = await guild.channels.fetch(giveaway.channelId, { force: true }).catch((error: unknown) => {
        if (isMissingDiscordResource(error, 10003)) return null;
        throw error;
      });
      if (!channel) {
        await repository.markOriginalMessageDeleted(guild.id, giveaway.originalMessageId);
        return;
      }
      if (!channel.isSendable()) throw new Error("Giveaway channel is unavailable for cleanup.");
      const message = await channel.messages.fetch({ message: giveaway.originalMessageId, force: true }).catch((error: unknown) => {
        if (isMissingDiscordResource(error, 10008)) return undefined;
        throw error;
      });
      if (!message) {
        await repository.markOriginalMessageDeleted(guild.id, giveaway.originalMessageId);
        return;
      }
      const participantIds = giveaway.state === "drawn"
        ? await repository.listRecordedParticipantIds(guild.id, giveaway.giveawayId)
        : await repository.listEligibleParticipantIds(guild.id, giveaway.giveawayId);
      const at = giveaway.state === "drawn" ? giveaway.drawnAt : giveaway.cancelledAt;
      if (giveaway.state !== "open" && !at) throw new Error("Closed giveaway has no closure timestamp.");
      const payload = giveaway.state === "open"
        ? buildOpenGiveawayV2Message(giveaway, participantIds, false, existingGiveawayImageUrl(message, giveaway))
        : buildClosedGiveawayV2Message(giveaway, participantIds, { state: giveaway.state, at: at! }, existingGiveawayImageUrl(message, giveaway));
      await message.edit({ ...withoutPreviousGiveawayReport(message), ...payload, content: null, embeds: [], flags: MessageFlags.IsComponentsV2 });
      const entryReaction = message.reactions.cache.find(reaction => canonicalReactionEmojiKey(reaction.emoji) === GIVEAWAY_ENTRY_EMOJI_KEY);
      if (entryReaction) {
        if (giveaway.state === "open") await entryReaction.users.remove(discordUserId);
        else await entryReaction.remove();
      }
      if (giveaway.state !== "open") await repository.markOriginalMessageClosed(guild.id, giveaway.originalMessageId);
    },

    async draw(
      guild: Guild,
      giveaway: GiveawayRecord,
      drawnByDiscordUserId?: string
    ): Promise<GiveawayDrawResult> {
      if (giveaway.state !== "open") return "already_closed";
      const message = await fetchGiveawayMessage(guild, giveaway);
      if (!message) {
        await repository.markOriginalMessageDeleted(guild.id, giveaway.originalMessageId);
        return "message_missing";
      }

      const participantReactions = await collectEligibleReactionSnapshot(
        guild,
        message,
        repository
      );
      const participantIds = participantReactions.map((entry) => entry.discordUserId);
      const winnerIds = selectRandomUnique(participantIds, giveaway.winnerCount);
      const recorded = await repository.recordDraw({
        discordGuildId: guild.id,
        giveawayId: giveaway.giveawayId,
        participantReactions,
        winnerDiscordUserIds: winnerIds,
        drawnByDiscordUserId
      });
      if (!recorded) return "already_closed";

      const fresh = await repository.getById(guild.id, giveaway.giveawayId);
      if (fresh) await publishDraw(guild, fresh, message, repository, logger);
      return "drawn";
    },

    async publishPending(guild: Guild, giveaway: GiveawayRecord): Promise<void> {
      const original = await fetchGiveawayMessage(guild, giveaway);
      if (!original) {
        logger.error("giveaway draw announcement cannot be published because the original message is missing", {
          guildId: guild.id,
          giveawayId: giveaway.giveawayId,
          originalMessageId: giveaway.originalMessageId
        });
        await repository.markOriginalMessageDeleted(guild.id, giveaway.originalMessageId);
        return;
      }
      await publishDraw(guild, giveaway, original, repository, logger);
    },

    async cancel(
      guild: Guild,
      giveaway: GiveawayRecord,
      actorDiscordUserId: string
    ): Promise<GiveawayCancelResult> {
      const cancelled = await repository.cancel(guild.id, giveaway.giveawayId, actorDiscordUserId);
      if (!cancelled) return "already_closed";
      const message = await fetchGiveawayMessage(guild, cancelled);
      if (!message) {
        await repository.markOriginalMessageDeleted(guild.id, cancelled.originalMessageId);
        return "message_missing";
      }
      const participantIds = await repository.listEligibleParticipantIds(guild.id, cancelled.giveawayId);
      return await closeOriginalGiveaway(
        guild,
        cancelled,
        message,
        participantIds,
        repository,
        logger
      ) ? "cancelled" : "message_close_failed";
    },

    async reroll(
      guild: Guild,
      giveaway: GiveawayRecord,
      unavailableDiscordUserId: string,
      actorDiscordUserId: string
    ): Promise<GiveawayRerollSuccess | "" | undefined> {
      const winners = await repository.listWinners(guild.id, giveaway.giveawayId);
      if (!winners.some((winner) => winner.status === "current" && winner.discordUserId === unavailableDiscordUserId)) {
        return undefined;
      }

      const previousWinnerIds = new Set(winners.map((winner) => winner.discordUserId));
      const participantIds = await repository.listEligibleParticipantIds(guild.id, giveaway.giveawayId);
      const candidates: string[] = [];
      for (const participantId of participantIds) {
        if (previousWinnerIds.has(participantId)) continue;
        const member = guild.members.cache.get(participantId)
          ?? await guild.members.fetch(participantId).catch(() => undefined);
        if (member) candidates.push(participantId);
      }
      if (candidates.length === 0) return "";

      const replacementDiscordUserId = candidates[randomInt(candidates.length)];
      const replaced = await repository.replaceWinner({
        discordGuildId: guild.id,
        giveawayId: giveaway.giveawayId,
        unavailableDiscordUserId,
        replacementDiscordUserId,
        actorDiscordUserId
      });
      if (!replaced) return undefined;

      const fresh = await repository.getById(guild.id, giveaway.giveawayId);
      let notificationPublished = false;
      if (fresh) {
        await refreshDrawAnnouncement(guild, fresh, repository).catch((error) => {
          logger.error("giveaway draw announcement refresh failed after reroll", {
            guildId: guild.id,
            giveawayId: fresh.giveawayId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
        notificationPublished = await publishRerollAnnouncement(
          guild,
          fresh,
          replacementDiscordUserId,
          logger
        );
      }
      return { replacementDiscordUserId, notificationPublished };
    }
  };
}

export function selectRandomUnique(values: string[], requestedCount: number): string[] {
  const remaining = [...new Set(values)];
  const selected: string[] = [];
  while (remaining.length > 0 && selected.length < requestedCount) {
    const index = randomInt(remaining.length);
    selected.push(remaining[index]);
    remaining.splice(index, 1);
  }
  return selected;
}

export function giveawayReactionAction(
  emojiKey: string,
  subscribe: boolean,
  isManagedUser: boolean
): "join" | "leave" | "ignore" {
  if (!isGiveawayEntryEmojiKey(emojiKey)) return "ignore";
  if (!subscribe) return "leave";
  return isManagedUser ? "join" : "ignore";
}

export function isGiveawayEntryEmojiKey(emojiKey: string): boolean {
  return emojiKey === GIVEAWAY_ENTRY_EMOJI_KEY;
}

export function shouldRemoveClosedGiveawayReaction(
  state: GiveawayState,
  emojiKey: string,
  subscribe: boolean
): boolean {
  return state !== "open" && subscribe && isGiveawayEntryEmojiKey(emojiKey);
}

async function collectEligibleReactionSnapshot(
  guild: Guild,
  message: Message,
  repository: GiveawayRepository
): Promise<GiveawayReactionSnapshot[]> {
  const emojiKeysByUserId = new Map<string, Set<string>>();
  for (const reaction of message.reactions.cache.values()) {
    const emojiKey = canonicalReactionEmojiKey(reaction.emoji);
    if (!emojiKey || !isGiveawayEntryEmojiKey(emojiKey)) continue;
    let after: string | undefined;
    do {
      const users = await reaction.users.fetch({ limit: 100, after });
      for (const user of users.values()) {
        if (user.bot) continue;
        const keys = emojiKeysByUserId.get(user.id) ?? new Set<string>();
        keys.add(emojiKey);
        emojiKeysByUserId.set(user.id, keys);
      }
      const last = users.last();
      after = users.size === 100 && last ? last.id : undefined;
    } while (after);
  }

  const snapshot: GiveawayReactionSnapshot[] = [];
  for (const [discordUserId, emojiKeys] of emojiKeysByUserId) {
    const member = guild.members.cache.get(discordUserId)
      ?? await guild.members.fetch(discordUserId).catch(() => undefined);
    if (!member || !await repository.isManagedUser(guild.id, discordUserId)) continue;
    snapshot.push({ discordUserId, emojiKeys: [...emojiKeys].sort() });
  }
  return snapshot.sort((left, right) => left.discordUserId.localeCompare(right.discordUserId));
}

async function publishDraw(
  guild: Guild,
  giveaway: GiveawayRecord,
  originalMessage: Message,
  repository: GiveawayRepository,
  logger: Logger
): Promise<void> {
  if (!giveaway.announcementMessageId) {
    const currentWinners = (await repository.listWinners(guild.id, giveaway.giveawayId))
      .filter((winner) => winner.status === "current");
    const winnerIds = currentWinners.map((winner) => winner.discordUserId);
    const announcement = await originalMessage.reply({
      ...buildDrawAnnouncement(giveaway, winnerIds, originalMessage.url),
      nonce: `giveaway-${giveaway.giveawayId}`.slice(0, 25),
      enforceNonce: true
    });
    await repository.setAnnouncementMessage(guild.id, giveaway.giveawayId, announcement.id);
  }

  if (!giveaway.originalMessageClosedAt && !giveaway.originalMessageDeletedAt) {
    const participantIds = await repository.listRecordedParticipantIds(guild.id, giveaway.giveawayId);
    await closeOriginalGiveaway(
      guild,
      giveaway,
      originalMessage,
      participantIds,
      repository,
      logger
    );
  }
}

async function refreshDrawAnnouncement(
  guild: Guild,
  giveaway: GiveawayRecord,
  repository: GiveawayRepository
): Promise<void> {
  if (!giveaway.announcementMessageId) return;
  const channel = await fetchSendableChannel(guild, giveaway.channelId);
  if (!channel) return;
  const message = await channel.messages.fetch(giveaway.announcementMessageId).catch(() => undefined);
  if (!message) return;
  const currentWinners = (await repository.listWinners(guild.id, giveaway.giveawayId))
    .filter((winner) => winner.status === "current");
  const winnerIds = currentWinners.map((winner) => winner.discordUserId);
  await message.edit({
    ...withoutPreviousGiveawayReport(message),
    ...buildDrawAnnouncement(giveaway, winnerIds, originalMessageUrl(giveaway)),
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2
  });
}

async function publishRerollAnnouncement(
  guild: Guild,
  giveaway: GiveawayRecord,
  replacementDiscordUserId: string,
  logger: Logger
): Promise<boolean> {
  const channel = await fetchSendableChannel(guild, giveaway.channelId);
  if (!channel) return false;
  try {
    await channel.send({
      ...buildRedrawAnnouncement(
        giveaway,
        replacementDiscordUserId,
        new Date(),
        originalMessageUrl(giveaway)
      ),
      reply: giveaway.announcementMessageId
        ? { messageReference: giveaway.announcementMessageId, failIfNotExists: false }
        : undefined
    });
    return true;
  } catch (error) {
    logger.error("giveaway reroll notification failed", {
      guildId: guild.id,
      giveawayId: giveaway.giveawayId,
      replacementDiscordUserId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function closeOriginalGiveaway(
  guild: Guild,
  giveaway: GiveawayRecord,
  message: Message,
  participantIds: string[],
  repository: GiveawayRepository,
  logger: Logger
): Promise<boolean> {
  const state = giveaway.state === "drawn" ? "drawn" : "cancelled";
  const at = state === "drawn" ? giveaway.drawnAt : giveaway.cancelledAt;
  if (!at) return false;
  try {
    await message.edit({
      ...withoutPreviousGiveawayReport(message),
      ...buildClosedGiveawayV2Message(
        giveaway,
        participantIds,
        { state, at },
        existingGiveawayImageUrl(message, giveaway)
      ),
      content: null,
      embeds: [],
      flags: MessageFlags.IsComponentsV2
    });
  } catch (error) {
    logger.error("giveaway original message could not be closed", {
      guildId: guild.id,
      giveawayId: giveaway.giveawayId,
      originalMessageId: giveaway.originalMessageId,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }

  const entryReaction = message.reactions.cache.find((reaction) =>
    canonicalReactionEmojiKey(reaction.emoji) === GIVEAWAY_ENTRY_EMOJI_KEY
  );
  if (entryReaction) {
    await entryReaction.remove().catch((error) => {
      logger.warn("giveaway entry reaction could not be cleared after closure", {
        guildId: guild.id,
        giveawayId: giveaway.giveawayId,
        originalMessageId: giveaway.originalMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }
  await repository.markOriginalMessageClosed(guild.id, giveaway.originalMessageId);
  return true;
}

async function fetchGiveawayMessage(guild: Guild, giveaway: GiveawayRecord): Promise<Message | undefined> {
  const channel = await fetchSendableChannel(guild, giveaway.channelId);
  return channel?.messages.fetch(giveaway.originalMessageId).catch(() => undefined);
}

async function fetchSendableChannel(guild: Guild, channelId: string): Promise<SendableChannels | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => undefined);
  if (!channel || !channel.isTextBased() || !("send" in channel) || !("messages" in channel)) {
    return undefined;
  }
  return channel as SendableChannels;
}

function originalMessageUrl(giveaway: GiveawayRecord): string {
  return `https://discord.com/channels/${giveaway.discordGuildId}/${giveaway.channelId}/${giveaway.originalMessageId}`;
}

function existingGiveawayImageUrl(
  message: Message,
  giveaway: Pick<GiveawayRecord, "imageAttachmentName">
): string | undefined {
  if (!giveaway.imageAttachmentName) return undefined;
  const attachmentUrl = message.attachments
    .find((attachment) => attachment.name === giveaway.imageAttachmentName)?.url
    ?? message.attachments.first()?.url;
  const componentUrl = message.components
    .map((component) => retainedMediaUrl(component.toJSON() as RetainedMediaComponent))
    .find((url): url is string => url !== undefined);
  const embedImage = message.embeds[0]?.image;

  return [attachmentUrl, componentUrl, embedImage?.url, embedImage?.proxyURL]
    .map(durableImageUrl)
    .find((url): url is string => url !== undefined);
}

interface RetainedMediaComponent {
  type: number;
  components?: RetainedMediaComponent[];
  items?: Array<{
    media: {
      url?: string;
      proxy_url?: string;
    };
  }>;
}

function retainedMediaUrl(component: RetainedMediaComponent): string | undefined {
  if (component.type === ComponentType.MediaGallery) {
    for (const item of component.items ?? []) {
      const url = [item.media.url, item.media.proxy_url]
        .find((candidate) => candidate && !candidate.startsWith("attachment://"));
      if (url) return url;
    }
  }

  for (const child of component.components ?? []) {
    const url = retainedMediaUrl(child);
    if (url) return url;
  }
  return undefined;
}

function durableImageUrl(candidate: string | undefined): string | undefined {
  if (!candidate || candidate.startsWith("attachment://")) return undefined;
  try {
    const url = new URL(candidate);
    if (
      ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
      && /\/(?:ephemeral-)?attachments\//.test(url.pathname)
    ) {
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    return candidate;
  }
  return candidate;
}

/** Replace generated overflow only; retain the original proof/prize image. */
function withoutPreviousGiveawayReport(message: Message): Pick<import("discord.js").MessageEditOptions, "attachments"> {
  const report = (name: string) => /^giveaway-[a-f0-9]{12}\.md$/.test(name);
  if (!message.attachments?.some(attachment => report(attachment.name))) return {};
  return { attachments: [...message.attachments.values()].filter(attachment => !report(attachment.name)).map(attachment => ({ id: attachment.id })) };
}

function isMissingDiscordResource(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === code;
}
