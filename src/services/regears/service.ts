import type { Guild, Message, SendableChannels } from "discord.js";
import type { AlbionServer } from "../albion/servers.js";
import type { RegearClaim, createRegearRepository } from "../../db/regearRepository.js";
import type { Logger } from "../../logging/logger.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import {
  buildAcceptedRegearOutcome,
  buildRegearContentAnnouncement,
  buildEvidenceDeletedNotification,
  buildPendingRegearReviewEdit,
  inspectPendingRegearEvidence
} from "./rendering.js";

type RegearRepository = ReturnType<typeof createRegearRepository>;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

export interface RegearRegistrationObservation {
  hasPendingClaims: boolean;
  warnings?: MemberUpdateWarning[];
}

export interface RegearCharacterObserver {
  observeCharacterRegistration(
    guild: Guild,
    albionServer: AlbionServer,
    albionCharacterId: string
  ): Promise<RegearRegistrationObservation>;
}

type PendingReviewFetch =
  | { state: "valid"; message: Message }
  | { state: "missing" }
  | { state: "indeterminate"; error: unknown };

export function createRegearService(repository: RegearRepository, logger: Logger) {
  let interval: NodeJS.Timeout | undefined;

  async function fetchPendingReviewMessage(guild: Guild, claim: RegearClaim): Promise<PendingReviewFetch> {
    let channel;
    try {
      channel = await guild.channels.fetch(claim.reviewChannelId);
    } catch (error) {
      return isDefinitelyMissing(error) ? { state: "missing" } : { state: "indeterminate", error };
    }
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return { state: "missing" };
    let message: Message;
    try {
      message = await channel.messages.fetch(claim.reviewMessageId);
    } catch (error) {
      return isDefinitelyMissing(error) ? { state: "missing" } : { state: "indeterminate", error };
    }
    return inspectPendingRegearEvidence(message) ? { state: "valid", message } : { state: "missing" };
  }

  async function notifyEvidenceDeleted(guild: Guild, claim: RegearClaim): Promise<void> {
    const channel = await fetchSendableChannel(guild, claim.reviewChannelId);
    if (!channel) {
      logger.warn("re-gear evidence deletion notification channel unavailable", {
        guildId: guild.id,
        regearClaimId: claim.regearClaimId,
        channelId: claim.reviewChannelId
      });
      return;
    }
    await channel.send(buildEvidenceDeletedNotification(claim));
  }

  async function removeMissingEvidence(guild: Guild, claim: RegearClaim): Promise<void> {
    const removed = await repository.removePendingClaim(guild.id, claim.regearClaimId);
    if (!removed) return;
    await notifyEvidenceDeleted(guild, removed).catch((error) => {
      logger.warn("re-gear evidence deletion notification failed", {
        guildId: guild.id,
        regearClaimId: removed.regearClaimId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async function reconcilePendingClaim(guild: Guild, claim: RegearClaim): Promise<Message | undefined> {
    const current = await repository.getClaim(guild.id, claim.regearClaimId);
    if (!current || current.status !== "pending") return undefined;
    const fetched = await fetchPendingReviewMessage(guild, current);
    if (fetched.state === "indeterminate") {
      logger.warn("re-gear Pending evidence inspection deferred", {
        guildId: guild.id,
        regearClaimId: current.regearClaimId,
        messageId: current.reviewMessageId,
        error: fetched.error instanceof Error ? fetched.error.message : String(fetched.error)
      });
      return undefined;
    }
    if (fetched.state === "missing") {
      await removeMissingEvidence(guild, current);
      return undefined;
    }
    const evidence = inspectPendingRegearEvidence(fetched.message);
    if (!evidence) {
      await removeMissingEvidence(guild, current);
      return undefined;
    }
    const reviewerRoleIds = await repository.listReviewerRoleIds(guild.id);
    await fetched.message.edit(buildPendingRegearReviewEdit(current, evidence, false, reviewerRoleIds)).catch((error) => {
      logger.warn("re-gear Pending review refresh failed", {
        guildId: guild.id,
        regearClaimId: current.regearClaimId,
        messageId: current.reviewMessageId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return fetched.message;
  }

  async function handleMessageDeleted(guild: Guild, messageId: string): Promise<void> {
    const removed = await repository.removePendingByReviewMessage(guild.id, messageId);
    if (removed) await notifyEvidenceDeleted(guild, removed);
    await Promise.all([
      repository.clearAcceptedOutcomeByMessage(guild.id, messageId),
      repository.clearAnnouncementByMessage(guild.id, messageId)
    ]);
  }

  async function repairAcceptedOutcome(guild: Guild, input: RegearClaim): Promise<Message | undefined> {
    const claim = await repository.getClaim(guild.id, input.regearClaimId);
    if (!claim || claim.status !== "accepted") return undefined;
    if (claim.outcomeChannelId && claim.outcomeMessageId) {
      const existingChannel = await guild.channels.fetch(claim.outcomeChannelId).catch(() => undefined);
      if (!existingChannel?.isTextBased() || !("messages" in existingChannel)) return undefined;
      try {
        return await existingChannel.messages.fetch(claim.outcomeMessageId);
      } catch (error) {
        if (!isDefinitelyMissing(error)) return undefined;
      }
    }
    const channel = await fetchSendableChannel(guild, claim.outcomeChannelId ?? claim.reviewChannelId);
    if (!channel) return undefined;
    const outcome = await channel.send(buildAcceptedRegearOutcome(claim));
    try {
      await repository.setAcceptedOutcome(guild.id, claim.regearClaimId, channel.id, outcome.id);
    } catch (error) {
      await outcome.delete().catch(() => undefined);
      throw error;
    }
    const reviewChannel = await guild.channels.fetch(claim.reviewChannelId).catch(() => undefined);
    if (reviewChannel?.isTextBased() && "messages" in reviewChannel) {
      const review = await reviewChannel.messages.fetch(claim.reviewMessageId).catch(() => undefined);
      await review?.delete().catch(() => undefined);
    }
    return outcome;
  }

  async function reconcileGuild(guild: Guild): Promise<void> {
    for (const content of await repository.listContents(guild.id)) {
      if (!content.announcementMessageId) continue;
      const channel = await guild.channels.fetch(content.channelId).catch(() => undefined);
      if (!channel?.isTextBased() || !("messages" in channel)) continue;
      const message = await channel.messages.fetch(content.announcementMessageId).catch(() => undefined);
      if (!message) continue;
      try {
        await message.edit(buildRegearContentAnnouncement(content));
        await repository.clearAnnouncementByMessage(guild.id, content.announcementMessageId);
      } catch (error) {
        logger.warn("historical re-gear entry cleanup failed", { guildId: guild.id, messageId: content.announcementMessageId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const claim of await repository.listPendingClaims(guild.id)) {
      await reconcilePendingClaim(guild, claim);
    }
  }

  return {
    startScheduler(getGuilds: () => Iterable<Guild>): void {
      if (interval) return;
      const run = () => {
        for (const guild of getGuilds()) {
          void reconcileGuild(guild).catch((error) => logger.error("re-gear reconciliation failed", {
            guildId: guild.id,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      };
      run();
      interval = setInterval(run, RECONCILIATION_INTERVAL_MS);
    },
    stopScheduler(): void {
      if (interval) clearInterval(interval);
      interval = undefined;
    },
    reconcileGuild,
    reconcilePendingClaim,
    fetchPendingReviewMessage,
    removeMissingEvidence,
    repairAcceptedOutcome,
    handleMessageDeleted,
    async observeCharacterRegistration(
      guild: Guild,
      albionServer: RegearClaim["albionServer"],
      albionCharacterId: string
    ): Promise<RegearRegistrationObservation> {
      const claims = await repository.listPendingClaimsForCharacter(guild.id, albionServer, albionCharacterId);
      for (const claim of claims) await reconcilePendingClaim(guild, claim);
      return { hasPendingClaims: claims.length > 0 };
    }
  };
}

function isDefinitelyMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const status = "status" in error ? Number((error as { status?: unknown }).status) : undefined;
  return code === "10003" || code === "10008" || status === 404;
}

async function fetchSendableChannel(guild: Guild, channelId: string): Promise<SendableChannels | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => undefined);
  return channel?.isSendable() ? channel : undefined;
}
