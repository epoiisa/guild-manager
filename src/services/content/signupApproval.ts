import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Guild,
  type Message,
  type MessageCreateOptions,
  type ThreadChannel
} from "discord.js";
import type { ContentItem, ContentSignupRequest, createContentRepository } from "../../db/contentRepository.js";

type ContentRepository = ReturnType<typeof createContentRepository>;
type DeliveryKind = "request" | "outcome";
export interface SignupApprovalDeliveryOptions { notifyRequestId?: string; notifyOutcomeRequestId?: string; notifyOutcomeRequestIds?: readonly string[]; }
const operations = new Map<string, Promise<unknown>>();
const silentMentions = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };

export function buildSignupRequestMessage(content: ContentItem, request: ContentSignupRequest, notify = false): MessageCreateOptions {
  return {
    content: `<@${content.hostDiscordUserId}>, <@${request.discordUserId}> has requested **${requestedPlace(request)}**.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`content:approval:accept:${content.contentId}:${request.requestId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`content:approval:decline:${content.contentId}:${request.requestId}`).setLabel("Decline").setStyle(ButtonStyle.Secondary)
    )],
    allowedMentions: { ...silentMentions, users: notify ? [content.hostDiscordUserId] : [] }
  };
}

export function buildSignupOutcomeMessage(request: ContentSignupRequest, notify = false): MessageCreateOptions {
  const place = requestedPlace(request);
  const content = request.status === "accepted"
    ? `<@${request.discordUserId}> accepted for ${request.roleSlotId ? "role " : ""}**${place}**.`
    : request.status === "invalidated"
      ? `<@${request.discordUserId}>, your request for **${place}** was cleared because that role changed. Choose a role again.`
      : `<@${request.discordUserId}> not accepted for **${place}**.`;
  return { content, components: [], allowedMentions: { ...silentMentions, users: notify ? [request.discordUserId] : [] } };
}

/** Serialize presentation only; the repository independently makes domain changes atomic. */
export async function reconcileSignupApprovals(
  guild: Guild,
  repository: ContentRepository,
  contentId: string,
  options: SignupApprovalDeliveryOptions = {}
): Promise<{ complete: boolean }> {
  const key = `${guild.id}:${contentId}`;
  const previous = operations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => reconcile(guild, repository, contentId, options));
  operations.set(key, operation);
  try { return await operation; }
  finally { if (operations.get(key) === operation) operations.delete(key); }
}

async function reconcile(guild: Guild, repository: ContentRepository, contentId: string, options: SignupApprovalDeliveryOptions): Promise<{ complete: boolean }> {
  try {
    await repository.reconcileSignupRequestClosure(guild.id, contentId);
    const snapshot = await repository.getContentSnapshot(guild.id, contentId);
    if (!snapshot) return { complete: true };
    const requests = await repository.listSignupRequests(guild.id, contentId);
    const unfinished = requests.filter((request) => request.status === "pending" || !request.presentationFinishedAt);
    if (!unfinished.length) return { complete: true };
    const channel = await guild.channels.fetch(snapshot.content.threadChannelId);
    if (!channel?.isThread()) return { complete: false };
    const thread: ThreadChannel = channel;
    const party = snapshot.content;
    const knownIds = new Set(requests.flatMap((request) => [request.requestMessageId, request.outcomeMessageId]).filter((id): id is string => !!id));
    let complete = true;
    // Retire replaced requests before publishing their replacement's controls.
    for (const original of [...unfinished.filter((request) => request.status !== "pending"), ...unfinished.filter((request) => request.status === "pending")]) {
      try {
        const request = await repository.getSignupRequest(guild.id, contentId, original.requestId);
        if (!request || request.presentationFinishedAt) continue;
        if (request.status === "pending") {
          const fresh = await repository.getContentSnapshot(guild.id, contentId);
          if (fresh) await publish(thread, repository, fresh.content, request, "request", knownIds, options.notifyRequestId === request.requestId);
          const latest = await repository.getSignupRequest(guild.id, contentId, request.requestId);
          if (latest && latest.status !== "pending") {
            await presentResolved(latest);
          }
        } else {
          await presentResolved(request);
        }
      } catch { complete = false; }
    }
    async function presentResolved(request: ContentSignupRequest): Promise<void> {
      try {
        if (["accepted", "declined", "invalidated"].includes(request.status)) {
          await publish(thread, repository, party, request, "outcome", knownIds,
            options.notifyOutcomeRequestId === request.requestId || Boolean(options.notifyOutcomeRequestIds?.includes(request.requestId)));
        }
      } catch (error) {
        // A saved decision must never leave live-looking controls after a failed send.
        await retireRequest(thread, repository, request, false);
        throw error;
      }
      await retireRequest(thread, repository, request, true);
      await repository.finishSignupRequestPresentation(guild.id, contentId, request.requestId);
    }
    return { complete };
  } catch { return { complete: false }; }
}

async function publish(
  thread: ThreadChannel,
  repository: ContentRepository,
  content: ContentItem,
  request: ContentSignupRequest,
  kind: DeliveryKind,
  knownIds: Set<string>,
  allowNotification: boolean
): Promise<void> {
  const previousId = kind === "request" ? request.requestMessageId : request.outcomeMessageId;
  let message = previousId ? await fetchMessage(thread, previousId) : undefined;
  const payload = kind === "request" ? buildSignupRequestMessage(content, request) : buildSignupOutcomeMessage(request);
  if (message) {
    if (kind === "request") await message.edit({ content: payload.content, components: payload.components, allowedMentions: silentMentions });
    return;
  }
  const nonce = publicationNonce(request.requestId, kind, previousId);
  message = await recoverMessage(thread, request, kind, payload, nonce, knownIds);
  if (!message) {
    // An ambiguous send consumes the notifying attempt. Recovery always stays silent.
    const claimed = await repository.claimSignupRequestNotification(content.discordGuildId, content.contentId, request.requestId, kind);
    const notify = claimed && allowNotification;
    if (kind === "request") {
      const current = await repository.getSignupRequest(content.discordGuildId, content.contentId, request.requestId);
      if (!current || current.status !== "pending") return;
    }
    message = await thread.send({
      ...(kind === "request" ? buildSignupRequestMessage(content, request, notify) : buildSignupOutcomeMessage(request, notify)),
      nonce,
      enforceNonce: true
    });
  }
  knownIds.add(message.id);
  const stored = await repository.setSignupRequestMessage(content.discordGuildId, content.contentId, request.requestId, kind, message.id, previousId);
  if (!stored) throw new Error("The signup request presentation changed during delivery.");
  if (kind === "request") await message.edit({ content: payload.content, components: payload.components, allowedMentions: silentMentions });
}

async function retireRequest(thread: ThreadChannel, repository: ContentRepository, request: ContentSignupRequest, remove: boolean): Promise<void> {
  let message = request.requestMessageId ? await fetchMessage(thread, request.requestMessageId) : undefined;
  // A request send may have succeeded before its canonical ID could be saved.
  if (!message) message = await recoverMessage(thread, request, "request", undefined, undefined, new Set());
  if (!message) return;
  if (request.requestMessageId !== message.id) {
    // Save the recovered locator before stripping the custom IDs used to find it.
    const stored = await repository.setSignupRequestMessage(request.discordGuildId, request.contentId,
      request.requestId, "request", message.id, request.requestMessageId);
    if (!stored) throw new Error("The recovered signup request message changed during cleanup.");
    request.requestMessageId = message.id;
  }
  if (!remove) {
    await message.edit({ components: [], allowedMentions: silentMentions });
    return;
  }
  try { await message.delete(); }
  catch (error) {
    if (isMissingMessage(error)) return;
    await message.edit({ components: [], allowedMentions: silentMentions });
    throw error;
  }
}

async function fetchMessage(thread: ThreadChannel, id: string): Promise<Message | undefined> {
  try {
    const message = await thread.messages.fetch(id);
    return message?.author.id === thread.client.user.id ? message : undefined;
  } catch (error) { if (isMissingMessage(error)) return undefined; throw error; }
}

async function recoverMessage(
  thread: ThreadChannel,
  request: ContentSignupRequest,
  kind: DeliveryKind,
  payload?: MessageCreateOptions,
  nonce?: string,
  knownIds = new Set<string>()
): Promise<Message | undefined> {
  let before: string | undefined;
  let oldestMatchingOutcome: Message | undefined;
  const earliest = (kind === "outcome" ? request.resolvedAt : request.createdAt)?.getTime() ?? request.createdAt.getTime();
  while (true) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) {
      if (message.author.id !== thread.client.user.id || knownIds.has(message.id)) continue;
      if (nonce && String(message.nonce) === nonce) return message;
      if (kind === "request" && JSON.stringify(message.components).includes(`content:approval:accept:${request.contentId}:${request.requestId}`)) return message;
      // Discord may omit nonce in a later history fetch. Date and known canonical IDs
      // distinguish repeated identical outcomes from earlier requests for the same place.
      if (kind === "outcome" && message.createdTimestamp >= earliest && message.content === payload?.content && !message.components.length
        && (!oldestMatchingOutcome || message.createdTimestamp < oldestMatchingOutcome.createdTimestamp
          || (message.createdTimestamp === oldestMatchingOutcome.createdTimestamp && compareMessageIds(message.id, oldestMatchingOutcome.id) < 0))) {
        oldestMatchingOutcome = message;
      }
    }
    if (page.size < 100) return oldestMatchingOutcome;
    const next = page.last()?.id;
    if (!next || next === before) return oldestMatchingOutcome;
    before = next;
  }
}

function compareMessageIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) === BigInt(right) ? 0 : 1;
  return left.localeCompare(right);
}

function requestedPlace(request: ContentSignupRequest): string {
  return request.roleSlotId ? `${request.slotIndex}. ${request.roleLabel}` : "Standby";
}

function publicationNonce(requestId: string, kind: DeliveryKind, previousId: string | null): string {
  return createHash("sha256").update(`${requestId}:${kind}:${previousId ?? "first"}`).digest("hex").slice(0, 24);
}

function isMissingMessage(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 10008;
}
