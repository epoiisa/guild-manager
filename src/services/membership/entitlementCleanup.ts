import type { Guild } from "discord.js";
import type { createMembershipEvidenceCleanupRepository } from "../../db/membershipEntitlementCleanup.js";
import type { Logger } from "../../logging/logger.js";

/** Durable, idempotent evidence deletion; deliberately sends no notifications. */
export function createMembershipEntitlementCleanupService(
  repository: ReturnType<typeof createMembershipEvidenceCleanupRepository>,
  logger: Logger
) {
  const running = new Set<string>();
  return {
    async reconcileGuild(guild: Guild): Promise<void> {
      if (running.has(guild.id)) return;
      running.add(guild.id);
      try {
        for (const job of await repository.listPending(guild.id)) {
          if (job.discordGuildId !== guild.id) continue;
          try {
            await repository.markAttempted(guild.id, job.cleanupId);
            const channel = await guild.channels.fetch(job.channelId);
            if (channel) {
              if (!channel.isTextBased() || !("messages" in channel)) throw new Error("Evidence channel cannot be inspected.");
              // Deleting the canonical message retires its attachments and all
              // controls together. Expired rows already reject stale controls.
              await channel.messages.delete(job.messageId);
            }
            await repository.complete(guild.id, job.cleanupId);
          } catch (error) {
            if (isDefinitelyMissing(error)) {
              await repository.complete(guild.id, job.cleanupId);
            } else {
              logger.warn("expired membership evidence cleanup deferred", {
                guildId: guild.id, channelId: job.channelId, messageId: job.messageId
              });
            }
          }
        }
      } finally {
        running.delete(guild.id);
      }
    }
  };
}

function isDefinitelyMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  return code === "10003" || code === "10008";
}
