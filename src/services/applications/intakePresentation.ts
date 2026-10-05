import { createHash } from "node:crypto";
import { AttachmentBuilder, ComponentType, MessageFlags, type Message, type MessageCreateOptions, type TextChannel } from "discord.js";
import { OperationalMessageLayoutError, v2Message } from "../../discord/operationalMessages.js";
import type { ApplicationClass, ApplicationReviewPublication, OpenApplication, createApplicationRepository } from "../../db/applicationRepository.js";
import type { MemberGroup } from "../../db/membershipRepository.js";
import { asComponentsV2Edit } from "../../discord/componentsV2.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";
import { buildApplicationAnswerMessages, buildApplicationIntakeCard, buildApplicationInstructionsMessage, hasValidApplicationSelection, isApplicationControlFooter, type ApplicationIntakeCardOptions } from "./rendering.js";

type Repository = ReturnType<typeof createApplicationRepository>;

/** The lifecycle and intake routes share this one canonical, mention-suppressed card. */
export async function refreshApplicationIntakeCard(
  channel: TextChannel,
  repository: Repository,
  application: ApplicationClass,
  supplied: OpenApplication,
  group?: MemberGroup,
  options: ApplicationIntakeCardOptions = {},
): Promise<void> {
  await withApplicationOperationLock(supplied.discordGuildId, supplied.applicationId, async () => {
    let current = await repository.getOpenApplication(supplied.discordGuildId, supplied.applicationId);
    if (!current || current.status !== "open" || current.channelStatus !== "open") return;
    // A newer search or selection must never receive stale candidates or status text.
    if (current.characterSearchAttemptCount !== supplied.characterSearchAttemptCount
      || current.selectedAlbionCharacterId !== supplied.selectedAlbionCharacterId
      || current.characterResolutionState !== supplied.characterResolutionState) return;
    let stored = await fetchOwnMessage(channel, current.applicationControlMessageId);
    if (current.legacyReviewPublication) {
      current = await repository.ensureApplicationReviewPublication(current.discordGuildId, current.applicationId) ?? current;
      if (current.reviewPublication) {
        if (stored && !current.reviewPublication.legacyHistoryPayload) {
          const { content, embeds, components, flags } = withoutApplicationControls(stored);
          const snapshot = JSON.parse(JSON.stringify({ content, embeds, components, flags })) as ApplicationReviewPublication["legacyHistoryPayload"];
          await savePublication(repository, current, { ...current.reviewPublication, legacyHistoryPayload: snapshot });
        }
        if (current.reviewPublication.legacyHistoryPayload && !await fetchOwnMessage(channel, current.reviewPublication.legacyHistoryMessageId)) {
          const snapshot = buildApplicationHistoryMessage(current.reviewPublication.legacyHistoryPayload as MessageCreateOptions);
          const history = await findOrSend(channel, current.applicationId, "legacy", snapshot, new Set(stored ? [stored.id] : []));
          await savePublication(repository, current, { ...current.reviewPublication, legacyHistoryMessageId: history.id });
        }
      }
    }
    const selected = hasValidApplicationSelection(current);
    if (selected && !current.legacyReviewPublication && !current.reviewPublication && options.publishReview !== false) {
      current = await repository.ensureApplicationReviewPublication(current.discordGuildId, current.applicationId) ?? current;
    }
    const payload = buildApplicationIntakeCard(application, current, group, { ...options, openingApplicantId: undefined });
    const publication = current.reviewPublication;
    const hasPriorSupplementaryMessages = !!publication && (!!publication.initialMessageId || publication.answerMessageIds.length > 0 || !!publication.notificationMessageId);
    if (publication && !current.legacyReviewPublication && (selected || publication.reviewCardMessageId || publication.replacedSelectionMessageId || hasPriorSupplementaryMessages)) {
      // Previously published review cards adopt the new arrangement silently.
      if (!publication.reviewCardMessageId && !publication.replacedSelectionMessageId && hasPriorSupplementaryMessages && stored) {
        await savePublication(repository, current, { ...publication, reviewCardMessageId: stored.id, notificationClaimed: true });
      }
      stored = await restoreReviewCard(channel, repository, application, current, group, payload, selected && options.publishReview !== false);
      if (!stored) return;
    } else {
      if (stored) await stored.edit(asComponentsV2Edit(payload));
      else {
        const replacement = await findOrSend(channel, current.applicationId, "first", payload);
        const claimed = await repository.claimApplicationFirstMessageId(current.discordGuildId, current.applicationId, current.applicationControlMessageId, replacement.id);
        if (!claimed) {
          await retireIntakeMessageControls(replacement);
          return;
        }
        stored = replacement;
        current.applicationControlMessageId = replacement.id;
      }
    }
    if (current.characterResolutionMessageId && current.characterResolutionMessageId !== stored.id
      && current.characterResolutionMessageId !== current.reviewPublication?.replacedSelectionMessageId) {
      const old = await fetchOwnMessage(channel, current.characterResolutionMessageId);
      if (old) await retireIntakeMessageControls(old);
    }
    if (current.characterResolutionMessageId !== stored.id) {
      const linked = await repository.claimApplicationFirstMessageId(current.discordGuildId, current.applicationId, stored.id, stored.id);
      if (!linked) return;
      current.characterResolutionMessageId = stored.id;
    }
    if (current.reviewPublication && !current.legacyReviewPublication && (selected || current.reviewPublication.reviewCardMessageId)) {
      await publishReviewMessages(channel, repository, current);
    }
  });
}

async function restoreReviewCard(
  channel: TextChannel,
  repository: Repository,
  application: ApplicationClass,
  current: OpenApplication,
  group: MemberGroup | undefined,
  payload: MessageCreateOptions,
  allowNotification: boolean,
): Promise<Message | undefined> {
  let publication = current.reviewPublication!;
  let review = await fetchOwnMessage(channel, publication.reviewCardMessageId);
  if (!review) {
    // Persist the source before publication. The old selection remains usable if
    // the send fails, and can be deleted safely after any restart or lost reply.
    if (!publication.reviewCardMessageId && !publication.replacedSelectionMessageId && current.applicationControlMessageId) {
      await savePublication(repository, current, { ...publication, replacedSelectionMessageId: current.applicationControlMessageId });
      publication = current.reviewPublication!;
    }
    const excluded = new Set([publication.replacedSelectionMessageId, current.applicationControlMessageId].filter((id): id is string => !!id));
    review = await findPublishedMessage(channel, payload, excluded, publicationNonce(current.applicationId, "review-card"), true);
    if (review) await review.edit(asComponentsV2Edit(payload));
    if (!review) {
      const notify = allowNotification && !publication.notificationClaimed && !publication.reviewCardMessageId;
      if (!publication.notificationClaimed) {
        await savePublication(repository, current, { ...publication, notificationClaimed: true });
        publication = current.reviewPublication!;
      }
      const openingPayload = notify
        ? buildApplicationIntakeCard({ ...application, reviewerRoleId: publication.reviewerRoleId }, current, group)
        : payload;
      review = await channel.send({ ...openingPayload,
        allowedMentions: notify ? { parse: [], repliedUser: false, users: [current.applicantDiscordUserId], roles: [publication.reviewerRoleId] } : { parse: [], repliedUser: false },
        nonce: publicationNonce(current.applicationId, "review-card"), enforceNonce: true,
      });
    }
    await savePublication(repository, current, { ...current.reviewPublication!, reviewCardMessageId: review.id, notificationClaimed: true });
  } else await review.edit(asComponentsV2Edit(payload));
  const claimed = await repository.claimApplicationFirstMessageId(current.discordGuildId, current.applicationId, current.applicationControlMessageId, review.id);
  if (!claimed) {
    await retireIntakeMessageControls(review);
    throw new Error("The application review card could not become canonical; retry the current application control.");
  }
  current.applicationControlMessageId = review.id;
  // Retire any old separate character-resolution card as well as the selection.
  if (current.characterResolutionMessageId && current.characterResolutionMessageId !== review.id
    && current.characterResolutionMessageId !== current.reviewPublication?.replacedSelectionMessageId) {
    const oldCharacterCard = await fetchOwnMessage(channel, current.characterResolutionMessageId);
    if (oldCharacterCard) await retireIntakeMessageControls(oldCharacterCard);
  }
  current.characterResolutionMessageId = review.id;
  const sourceId = current.reviewPublication?.replacedSelectionMessageId;
  if (sourceId && sourceId !== review.id) {
    await deleteReplacedMessage(channel, sourceId);
    await savePublication(repository, current, { ...current.reviewPublication!, replacedSelectionMessageId: undefined });
  }
  return review;
}

async function deleteReplacedMessage(channel: TextChannel, messageId: string): Promise<void> {
  const message = await fetchOwnMessage(channel, messageId);
  if (!message) return;
  try { await message.delete(); }
  catch (error) {
    if ((error as { code?: number }).code === 10008) return;
    await retireIntakeMessageControls(message).catch(() => undefined);
    throw error;
  }
}

async function publishReviewMessages(channel: TextChannel, repository: Repository, current: OpenApplication): Promise<void> {
  let publication = current.reviewPublication!;
  const save = async (next: ApplicationReviewPublication) => {
    await savePublication(repository, current, next);
    publication = next;
  };
  if (publication.initialMessage) {
    const payload = buildApplicationInstructionsMessage(publication.initialMessage);
    const excluded = new Set([publication.notificationMessageId, ...publication.answerMessageIds].filter((id): id is string => !!id));
    // Compare the previous bare-Text-Display shape only for recovery; never send it.
    let message = await fetchOwnMessage(channel, publication.initialMessageId)
      ?? await findPublishedMessage(channel, payload, excluded, publicationNonce(current.applicationId, "instructions"))
      ?? await findPublishedMessage(channel, { flags: MessageFlags.IsComponentsV2, components: [{ type: ComponentType.TextDisplay, content: publication.initialMessage }] }, excluded, publicationNonce(current.applicationId, "instructions"));
    if (message) {
      // Old standalone instructions convert in place, keeping their exact text
      // and chronological position while the snapshot remains authoritative.
      if (fingerprint(message) !== fingerprint(payload)) await message.edit(asComponentsV2Edit(payload));
    } else message = await channel.send({ ...payload, nonce: publicationNonce(current.applicationId, "instructions"), enforceNonce: true });
    if (message.id !== publication.initialMessageId) await save({ ...publication, initialMessageId: message.id });
  }
  for (const [index, payload] of buildApplicationAnswerMessages(current.modalAnswers).entries()) {
    const message = await fetchOwnMessage(channel, publication.answerMessageIds[index])
      ?? await findOrSend(channel, current.applicationId, `answers-${index}`, payload, new Set(publication.answerMessageIds.filter((_, candidate) => candidate !== index)));
    if (message.id !== publication.answerMessageIds[index]) {
      const ids = [...publication.answerMessageIds]; ids[index] = message.id;
      await save({ ...publication, answerMessageIds: ids });
    }
  }
  // Only the explicitly recorded old bot notice is obsolete. Never infer its ID
  // from text, which might also be the administrator's exact instructions.
  if (publication.notificationMessageId) {
    await deleteReplacedMessage(channel, publication.notificationMessageId);
    await save({ ...publication, notificationMessageId: undefined });
  }
}

async function savePublication(repository: Repository, current: OpenApplication, next: ApplicationReviewPublication): Promise<void> {
  const expected = current.reviewPublication!;
  if (!await repository.updateApplicationReviewPublication(current.discordGuildId, current.applicationId, expected, next)) {
    throw new Error("The application review publication changed concurrently; retry the current application control.");
  }
  current.reviewPublication = next;
}

export async function retireIntakeMessageControls(message: Message): Promise<void> {
  const payload = withoutApplicationControls(message);
  await message.edit(payload.flags === MessageFlags.IsComponentsV2 ? asComponentsV2Edit(payload, true) : { components: [], embeds: payload.embeds, allowedMentions: { parse: [], repliedUser: false } });
}

/** A recovered history copy is a new message, so it must use the current format.
 * Known legacy application cards contain text and fields. Preserve an unusual
 * older layout in full as an explicit archive instead of silently dropping it.
 * Existing historical messages are still retired in place without rewriting.
 */
export function buildApplicationHistoryMessage(snapshot: MessageCreateOptions): MessageCreateOptions {
  const allowedMentions = { parse: [] as never[], repliedUser: false };
  if (Number(snapshot.flags) & MessageFlags.IsComponentsV2) {
    const components = JSON.parse(JSON.stringify(snapshot.components ?? []));
    if (components.length === 1 && components[0].type === ComponentType.Container && typeof components[0].accent_color === "number") {
      return { ...snapshot, allowedMentions };
    }
  } else {
    try { return v2Message({ text: snapshot.content, cards: snapshot.embeds, allowedMentions }); }
    catch (error) { if (!(error instanceof OperationalMessageLayoutError)) throw error; }
  }
  return v2Message({ text: "# Application History\n\nThe complete original application message is attached.",
    files: [new AttachmentBuilder(Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"), { name: "application-history.json" })], allowedMentions });
}

/** Preserve message history while retiring controls and their footer guidance. */
export function withoutApplicationControls(message: Message): MessageCreateOptions {
  const strip = (value: unknown): unknown => {
    const json = (value as { toJSON?: () => unknown })?.toJSON?.() ?? value;
    if (!json || typeof json !== "object") return json;
    const component = json as Record<string, unknown>;
    if (!Array.isArray(component.components)) return component;
    const children = component.components.filter((child) => (child as { type?: number }).type !== ComponentType.ActionRow).map(strip);
    const footer = children.at(-1) as { type?: number; content?: string } | undefined;
    if (component.type === ComponentType.Container && children.length > 1
      && footer?.type === ComponentType.TextDisplay && isApplicationControlFooter(footer.content)) children.pop();
    return { ...component, components: children };
  };
  if (message.components?.some((component) => component.type === ComponentType.Container || component.type === ComponentType.TextDisplay)) {
    return { flags: MessageFlags.IsComponentsV2, components: message.components.filter((component) => component.type !== ComponentType.ActionRow).map(strip) as MessageCreateOptions["components"], allowedMentions: { parse: [], repliedUser: false } };
  }
  const embeds = message.embeds?.map((embed) => {
    const json = embed.toJSON();
    return isApplicationControlFooter(json.footer?.text) ? { ...json, footer: undefined } : json;
  });
  return { content: message.content || undefined, embeds, components: [], allowedMentions: { parse: [], repliedUser: false } };
}

async function fetchOwnMessage(channel: TextChannel, id?: string): Promise<Message | undefined> {
  if (!id) return undefined;
  try {
    const message = await channel.messages.fetch(id);
    return message.author.id === channel.client.user.id ? message : undefined;
  } catch (error) {
    // Permission/network failures are not proof that a message is missing.
    if ((error as { code?: number }).code === 10008) return undefined;
    throw error;
  }
}

export function publicationNonce(applicationId: string, key: string): string {
  return createHash("sha256").update(`application:${applicationId}:${key}`).digest("hex").slice(0, 24);
}

async function findOrSend(channel: TextChannel, applicationId: string, key: string, payload: MessageCreateOptions, excluded = new Set<string>()): Promise<Message> {
  return await findPublishedMessage(channel, payload, excluded, publicationNonce(applicationId, key)) ?? channel.send({ ...payload, nonce: publicationNonce(applicationId, key), enforceNonce: true });
}

function fingerprint(payload: { content?: unknown; embeds?: unknown; components?: unknown }): string {
  // Serialization normalises Discord's read-side component builders and omits
  // component IDs, which Discord may assign automatically on publication.
  return JSON.stringify({ content: payload.content || undefined, embeds: payload.embeds ?? [], components: payload.components ?? [] }, (key, value) => {
    if (key === "id" || (key === "type" && value === "rich") || ((key === "spoiler" || key === "disabled") && value === false)) return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((property) => [property, value[property]]));
    }
    return value;
  });
}

async function findPublishedMessage(channel: TextChannel, payload: MessageCreateOptions, excluded = new Set<string>(), nonce?: string, recoverNonce = false): Promise<Message | undefined> {
  const expected = fingerprint(payload);
  let before: string | undefined;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) {
      if (!excluded.has(message.id) && (!message.nonce || !nonce || String(message.nonce) === nonce) && message.author.id === channel.client.user.id && ((recoverNonce && !!nonce && String(message.nonce) === nonce) || fingerprint({ content: message.content, embeds: message.embeds, components: message.components }) === expected)) return message;
    }
    if (page.size < 100) return undefined;
    const next = page.last()?.id;
    if (!next || next === before) return undefined;
    before = next;
  }
}
