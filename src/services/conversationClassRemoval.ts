import { ChannelType, type Guild } from "discord.js";
import type { ConversationClassRemovalRepository, ConversationClassSnapshot } from "../db/conversationClassRemovalRepository.js";
import { withApplicationOperationLock } from "./applications/applicationOperationLock.js";
import { withTicketOperationLock } from "./tickets/ticketOperationLock.js";
import { removeEntryButtonComponents } from "../discord/entryButtons.js";

export function isMissingDiscordResource(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Called with the class lock held. Discord deletion precedes record deletion. */
export async function removeConversationClass(input: {
  guild: Guild;
  actorId: string;
  snapshot: ConversationClassSnapshot;
  repository: ConversationClassRemovalRepository;
  cleanupActiveRole?: (userId: string, roleId: string) => Promise<void>;
}): Promise<{ removed: boolean; deletedChannels: number; failures: number; entryWarning: boolean }> {
  const { guild, snapshot, repository } = input;
  await repository.disable(guild.id, snapshot.classId);
  let deletedChannels = 0;
  let failures = 0;
  const withRecordLock = repository.kind === "application" ? withApplicationOperationLock : withTicketOperationLock;
  for (const record of snapshot.conversations) {
    if (record.status === "deleted") continue;
    try {
      await withRecordLock(guild.id, record.id, async () => {
        if (record.channelId) {
          const channel = await guild.channels.fetch(record.channelId).catch((error: unknown) => {
            if (isMissingDiscordResource(error, 10003)) return null;
            throw error;
          });
          if (channel) {
            if (channel.type !== ChannelType.GuildText || channel.guild.id !== guild.id || channel.id !== record.channelId) {
              throw new Error("The stored conversation channel does not match this server's text channel.");
            }
            const deleted = await channel.delete(`Guild Manager ${repository.kind} class removed`).then(() => true).catch((error: unknown) => {
              if (!isMissingDiscordResource(error, 10003)) throw error;
              return false;
            });
            if (deleted) deletedChannels += 1;
          }
        }
        await repository.markDeleted(guild.id, record.id, input.actorId);
      });
    } catch { failures += 1; }
  }
  // Include already-deleted records so a retry can finish failed role cleanup.
  if (snapshot.activeRoleId && input.cleanupActiveRole) {
    for (const userId of new Set(snapshot.conversations.map((record) => record.userId))) {
      try { await input.cleanupActiveRole(userId, snapshot.activeRoleId); }
      catch { failures += 1; }
    }
  }
  if (failures) return { removed: false, deletedChannels, failures, entryWarning: false };
  // Keep source placement metadata until entry cleanup succeeds or is reported.
  let entryWarning = false;
  try { await removeEntryButton(guild, repository.kind, snapshot); }
  catch { entryWarning = true; }
  const removed = await repository.remove(guild.id, snapshot.classId);
  return { removed, deletedChannels, failures, entryWarning };
}

async function removeEntryButton(guild: Guild, kind: "application" | "ticket", snapshot: ConversationClassSnapshot): Promise<void> {
  if (!snapshot.sourceChannelId || !snapshot.sourceMessageId) return;
  try {
    const channel = await guild.channels.fetch(snapshot.sourceChannelId);
    if (!channel) return;
    if (!channel.isTextBased() || !("messages" in channel)) throw new Error("Entry message channel unavailable.");
    const message = await channel.messages.fetch(snapshot.sourceMessageId);
    if (message.author.id !== guild.client.user.id) throw new Error("Entry message is not bot-authored.");
    const customId = `${kind === "application" ? "app" : "ticket"}:open:${snapshot.classId}`;
    const components = removeEntryButtonComponents(message.components, customId);
    await message.edit({ components, allowedMentions: { parse: [], repliedUser: false } });
  } catch (error) {
    if (!isMissingDiscordResource(error, 10003) && !isMissingDiscordResource(error, 10008)) throw error;
  }
}
