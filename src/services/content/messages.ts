import { createHash } from "node:crypto";
import {
  AttachmentBuilder,
  ComponentType,
  MessageFlags,
  type APIUnfurledMediaItem,
  type Guild,
  type Message,
  type ThreadChannel,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import type { ContentSnapshot, createContentRepository } from "../../db/contentRepository.js";
import {
  buildContentAnnouncementV2Message,
  buildContentControlV2Message,
  buildContentDetailsV2Message
} from "./rendering.js";
import { findNestedComponentCustomIds } from "../../discord/componentsV2.js";

import { reconcileSignupApprovals } from "./signupApproval.js";

type ContentRepository = ReturnType<typeof createContentRepository>;
const refreshOperations = new Map<string, Promise<void>>();

export async function refreshContentMessages(
  guild: Guild,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  replacementGraphicUrl?: string,
  requireAvailable: boolean | "controls" = false
): Promise<void> {
  const key = `${snapshot.content.discordGuildId}:${snapshot.content.contentId}`;
  const previous = refreshOperations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    // A queued older caller must render the current roster, never its old snapshot.
    const current = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    if (!current) return;
    const graphicUrl = current.content.graphicAttachmentName === snapshot.content.graphicAttachmentName
      ? replacementGraphicUrl : undefined;
    // A versioned render may clear durable retry state only after successful lookups.
    const strict = Boolean(requireAvailable) || Boolean(current.content.renderRevision);
    await refreshAnnouncementMessage(guild, current, strict);
    await refreshThreadMessages(guild, repository, current, graphicUrl, strict);
    if (current.content.approvalRequired) {
      const approval = await reconcileSignupApprovals(guild, repository, current.content.contentId);
      if (!approval.complete) throw new Error("Signup request messages could not be fully refreshed.");
    }
    await repository.markRendered(current.content.discordGuildId, current.content.contentId, current.content.renderRevision);
  });
  refreshOperations.set(key, operation);
  try { await operation; }
  finally { if (refreshOperations.get(key) === operation) refreshOperations.delete(key); }
}

export async function refreshAnnouncementMessage(
  guild: Guild,
  snapshot: ContentSnapshot,
  requireAvailable: boolean
): Promise<void> {
  if (!snapshot.content.announcementMessageId) return;
  const channel = await guild.channels.fetch(snapshot.content.sourceChannelId).catch((error: unknown) => {
    if (requireAvailable && !isDiscordMissing(error, 10003)) throw error;
    return null;
  });
  if (!channel || !("messages" in channel)) return;
  const message = await channel.messages.fetch({ message: snapshot.content.announcementMessageId, force: true }).catch((error: unknown) => {
    if (requireAvailable && !isDiscordMissing(error, 10008)) throw error;
    return null;
  });
  if (!message || message.author.id !== guild.client.user.id) return;
  const payload = buildContentAnnouncementV2Message(snapshot.content);
  if (matchesPresentation(message, payload)) return;
  await message.edit(asV2Edit(payload));
}

function matchesPresentation(message: Message, payload: MessageCreateOptions): boolean {
  return Boolean(message.flags?.has(MessageFlags.IsComponentsV2))
    && presentationFingerprint(message, message.attachments) === presentationFingerprint(payload, message.attachments);
}

function presentationFingerprint(
  message: { content?: unknown; embeds?: unknown; components?: unknown },
  attachments?: Message["attachments"]
): string {
  // Compare authored content, ignoring Discord's generated IDs, default values,
  // and media metadata. An attachment URL or its refreshed signature still
  // refers to the same graphic; explicit replacement uploads are handled below.
  return JSON.stringify({ content: message.content || undefined, embeds: message.embeds ?? [], components: message.components ?? [] }, (key, value) => {
    if (key === "id" || ((key === "spoiler" || key === "disabled") && value === false)
      || (key === "description" && (value === null || value === ""))) return undefined;
    if ((key === "media" || key === "file") && value && typeof value === "object") {
      const attachmentId = value.attachment_id || value.id;
      const attachment = attachments?.find(item =>
        (attachmentId !== undefined && attachmentId === item.id)
        || value.url === item.url || value.url === item.proxyURL || value.url === `attachment://${item.name}`);
      return { url: attachment ? `attachment://${attachment.name}` : value.url };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((property) => [property, value[property]]));
    }
    return value;
  });
}

function inspectContentGraphic(message: Message | undefined, filename: string | null | undefined): { id?: string; url: string } | undefined {
  if (!message || !filename) return undefined;
  // Discord can keep a V2 upload solely in its gallery metadata, leaving the
  // ordinary attachment list empty. Only adopt this card's single-image gallery.
  const galleries = message.components.flatMap(component => {
    const data = "toJSON" in component ? component.toJSON() : component;
    return data.type === ComponentType.Container
      ? data.components.filter(child => child.type === ComponentType.MediaGallery)
      : data.type === ComponentType.MediaGallery ? [data] : [];
  });
  if (galleries.length === 1 && galleries[0].items.length === 1) {
    const media = galleries[0].items[0].media as APIUnfurledMediaItem;
    // A gallery's generic media ID is not an uploaded attachment ID. Discord
    // may return an externally resolved image with only that ID and its URL.
    const id = media.attachment_id?.trim();
    if (media.url?.trim()
      && !media.url.startsWith("attachment://")
      && (!media.content_type || media.content_type.toLocaleLowerCase().startsWith("image/"))) {
      const attachment = id ? message.attachments.get(id) : message.attachments.find(item => item.name === filename);
      return { id: id ?? attachment?.id, url: attachment?.url ?? media.url };
    }
  }
  // Retain compatibility with older cards whose image is an ordinary attachment.
  const attachment = message.attachments.find(item => item.name === filename);
  return attachment ? { id: attachment.id, url: attachment.url } : undefined;
}

async function refreshThreadMessages(
  guild: Guild,
  repository: ContentRepository,
  snapshot: ContentSnapshot,
  replacementGraphicUrl: string | undefined,
  requireAvailable: boolean
): Promise<void> {
  const channel = await guild.channels.fetch(snapshot.content.threadChannelId).catch((error: unknown) => {
    if (requireAvailable) throw error;
    return null;
  });
  if (!channel?.isThread() || !("messages" in channel) || !("send" in channel)) {
    if (requireAvailable) throw new Error("Content thread is unavailable.");
    return;
  }

  const { content } = snapshot;
  let details = await fetchMessage(channel, content.detailsMessageId);
  const detailsNonce = publicationNonce(content.contentId, "details", content.detailsMessageId);
  if (!details && content.state !== "archived") {
    details = await recoverMessage(channel, snapshot, "details", detailsNonce);
  }
  const existingGraphic = inspectContentGraphic(details, content.graphicAttachmentName);
  // A deleted attachment cannot be reconstructed from its filename. Never emit a
  // dangling attachment:// reference during repair; the host can upload it again.
  const detailsPayload = buildContentDetailsV2Message(content, replacementGraphicUrl ? undefined : existingGraphic?.url ?? null);
  const files = replacementGraphicUrl && content.graphicAttachmentName
    ? [new AttachmentBuilder(replacementGraphicUrl, { name: content.graphicAttachmentName })]
    : undefined;
  let detailsCreated = false;
  if (!details && content.state !== "archived") {
    details = await channel.send({ ...detailsPayload, files: [...detailsPayload.files ?? [], ...files ?? []], nonce: detailsNonce, enforceNonce: true });
    detailsCreated = true;
  }
  if (details) {
    // Save before editing so a failed edit or unpin can be retried in place.
    if (details.id !== content.detailsMessageId) {
      await repository.setDetailsMessage(content.discordGuildId, content.contentId, details.id);
    }
    if (!detailsCreated && (files || !matchesPresentation(details, detailsPayload))) {
      const retainedIds = new Set([...details.attachments?.values() ?? []]
        .filter(item => !/^party-[a-f0-9]{12}\.md$/.test(item.name)).map(item => item.id));
      if (existingGraphic?.id) retainedIds.add(existingGraphic.id);
      // Report uploads also populate Discord's attachments field. Explicitly
      // retain the image even when it is absent from the ordinary attachment list.
      await details.edit({ ...asV2Edit(detailsPayload, files, Boolean(files)),
        ...(!files ? { attachments: [...retainedIds].map(id => ({ id })) } : {}) });
    }
    if (details.pinned) await details.unpin("Move the party roles pin to the roles message");
  }

  let roles = await fetchMessage(channel, content.controlMessageId);
  const rolesPayload = buildContentControlV2Message(snapshot);
  const rolesNonce = publicationNonce(content.contentId, "roles", content.controlMessageId);
  if (!roles && content.state !== "archived") {
    roles = await recoverMessage(channel, snapshot, "roles", rolesNonce);
    if (!roles) roles = await channel.send({ ...rolesPayload, nonce: rolesNonce, enforceNonce: true });
  }
  if (roles) {
    if (roles.id !== content.controlMessageId) {
      await repository.setControlMessage(content.discordGuildId, content.contentId, roles.id);
    }
    if (!matchesPresentation(roles, rolesPayload)) {
      const retained = [...roles.attachments?.values() ?? []]
        .filter(item => !/^party-[a-f0-9]{12}\.md$/.test(item.name)).map(item => ({ id: item.id }));
      await roles.edit({ ...asV2Edit(rolesPayload), attachments: retained });
    }
    if (!roles.pinned && content.state !== "archived") await roles.pin("Pin Guild Manager content signup roles and controls");
  }
}

async function fetchMessage(thread: ThreadChannel, id: string | null | undefined): Promise<Message | undefined> {
  if (!id) return undefined;
  try {
    const message = await thread.messages.fetch({ message: id, force: true });
    return message?.author.id === thread.client.user.id ? message : undefined;
  } catch (error) {
    if (isDiscordMissing(error, 10008)) return undefined;
    throw error;
  }
}

async function recoverMessage(
  thread: ThreadChannel, snapshot: ContentSnapshot, kind: "details" | "roles", nonce: string
): Promise<Message | undefined> {
  // A successful send may outlive a failed ID save. Recover only this party's
  // bot-authored card, including after Discord stops returning the send nonce.
  let before: string | undefined;
  const { content } = snapshot;
  while (true) {
    const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of page.values()) {
      if (message.author.id !== thread.client.user.id
        || message.id === content.detailsMessageId || message.id === content.controlMessageId) continue;
      if (String(message.nonce) === nonce) return message;
      const ids = findNestedComponentCustomIds(message.components);
      if (kind === "details" && ids.has(`content:edit:${content.contentId}`)) return message;
      const texts = message.components.flatMap((component) => {
        const data = component.toJSON();
        return data.type === ComponentType.Container
          ? data.components.flatMap((child) => child.type === ComponentType.TextDisplay ? [child.content] : [])
          : [];
      });
      const hasApproval = texts.some((text) => /^\*\*Host approval\*\* (Required|Not required)$/.test(text));
      if (kind === "roles" ? texts[0] === "# Roles" && hasApproval
        : !hasApproval && texts.some((text) => /^\*\*Host\*\* <@\d+>$/.test(text))) return message;
    }
    if (page.size < 100) return undefined;
    const next = page.last()?.id;
    if (!next || next === before) return undefined;
    before = next;
  }
}

function publicationNonce(contentId: string, kind: "details" | "roles", previousId?: string | null): string {
  return createHash("sha256").update(`${contentId}:${kind}:${previousId ?? "first"}`).digest("hex").slice(0, 24);
}

function asV2Edit(message: MessageCreateOptions, files?: AttachmentBuilder[], replaceAttachments = false): MessageEditOptions {
  return {
    ...message,
    content: null,
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    ...(files ? { files: [...message.files ?? [], ...files] } : {}),
    ...(replaceAttachments ? { attachments: [] } : {})
  };
}

function isDiscordMissing(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
