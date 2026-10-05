import type { Guild } from "discord.js";
import type { ContentSnapshot, createContentRepository } from "../../db/contentRepository.js";
import { refreshContentMessages } from "./messages.js";
import { buildStartNotification } from "./rendering.js";

export type StartNotificationResult = "sent" | "already-sent" | "unavailable";

/** Refresh before claiming; a retained claim prevents duplicate pings after an ambiguous send. */
export async function deliverStartNotification(
  guild: Guild,
  repository: ReturnType<typeof createContentRepository>,
  snapshot: ContentSnapshot
): Promise<StartNotificationResult> {
  if (snapshot.content.startNotificationMessageId) return "already-sent";
  if (snapshot.content.startNotificationClaimedAt || snapshot.content.state !== "active") return "unavailable";
  const channel = await guild.channels.fetch(snapshot.content.threadChannelId);
  if (!channel || !("send" in channel)) return "unavailable";
  await refreshContentMessages(guild, repository, snapshot, undefined, true);
  // Refresh may have repaired either linked message. Use the current IDs and
  // refuse an old caller after an intervening Unstart, restart or closure.
  const fresh = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
  if (!fresh || fresh.content.state !== "active" || fresh.content.startRevision !== snapshot.content.startRevision) return "unavailable";
  const payload = buildStartNotification(fresh);
  if (!await repository.claimStartNotification(snapshot.content.discordGuildId, snapshot.content.contentId, fresh.content.startRevision)) {
    const current = await repository.getContentSnapshot(snapshot.content.discordGuildId, snapshot.content.contentId);
    return current && current.content.startRevision === fresh.content.startRevision && current.content.startNotificationMessageId ? "already-sent" : "unavailable";
  }
  const notification = await channel.send(payload);
  const saved = await repository.setStartNotificationMessage(snapshot.content.discordGuildId, snapshot.content.contentId, notification.id, fresh.content.startRevision);
  if (saved === false) {
    // A closure can win during the Discord send. Never attach its old message
    // to a newer lifecycle state or leave operative controls behind.
    await notification.delete().catch(() => undefined);
    return "unavailable";
  }
  return "sent";
}
