import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type MessageEditOptions } from "discord.js";
import type { createKickActivitiesRepository, KickActivityCleanup } from "../../db/kickActivitiesRepository.js";
import type { createContentRepository } from "../../db/contentRepository.js";
import type { createGiveawayRepository } from "../../db/giveawayRepository.js";
import type { createGiveawayService } from "../giveaways/service.js";
import type { Logger } from "../../logging/logger.js";
import type { MemberUpdateWarning } from "./discordMemberUpdates.js";
import { refreshAnnouncementMessage, refreshContentMessages } from "../content/messages.js";
import { TEMPORARY_VOICE_OWNER_PERMISSIONS } from "../temporaryVoice.js";
import { createKeyedSerialQueue } from "../reactionRoles/keyedSerialQueue.js";

type Repository = ReturnType<typeof createKickActivitiesRepository>;
export interface KickActivitiesResult { warnings: MemberUpdateWarning[]; pending: boolean; }

export function createKickActivitiesService(repository: Repository, dependencies: {
  contentRepository: ReturnType<typeof createContentRepository>;
  giveawayRepository: ReturnType<typeof createGiveawayRepository>;
  giveawayService: ReturnType<typeof createGiveawayService>;
  logger: Logger;
}) {
  const queue = createKeyedSerialQueue();
  return {
    async reconcileUser(guild: Guild, discordUserId: string): Promise<KickActivitiesResult> {
      const warnings: MemberUpdateWarning[] = [];
      await queue.enqueue(`${guild.id}:${discordUserId}`, async () => {
        for (const job of await repository.listPending(guild.id, discordUserId)) {
          try {
            if (job.discordGuildId !== guild.id || job.discordUserId !== discordUserId) throw new Error("Kick cleanup scope mismatch.");
            await repository.markAttempted(guild.id, discordUserId, job.cleanupId);
            await reconcileJob(guild, job);
            await repository.complete(guild.id, discordUserId, job.cleanupId);
          } catch (error) {
            dependencies.logger.warn("kick activity cleanup remains pending", { guildId: guild.id, discordUserId, kind: job.kind, targetId: job.targetId, error });
            warnings.push({ message: `Could not finish ${job.kind} cleanup for <@${discordUserId}> in <#${job.channelId}>. Cleanup will retry.` });
          }
        }
      });
      return { warnings, pending: await repository.hasPendingCleanup(guild.id, discordUserId) };
    }
  };

  async function reconcileJob(guild: Guild, job: KickActivityCleanup): Promise<void> {
    if (job.kind === "giveaway") {
      const giveaway = await dependencies.giveawayRepository.getById(guild.id, job.targetId);
      if (giveaway) await dependencies.giveawayService.reconcileAfterKick(guild, giveaway, job.discordUserId);
      return;
    }
    const channel = await guild.channels.fetch(job.channelId, { force: true }).catch((error: unknown) => {
      if (hasDiscordCode(error, 10003)) return null;
      throw error;
    });
    if (!channel) {
      if (job.kind === "content") {
        const snapshot = await dependencies.contentRepository.getContentSnapshot(guild.id, job.targetId);
        if (snapshot) await refreshAnnouncementMessage(guild, snapshot, true);
      }
      return;
    }
    if (channel.guild.id !== guild.id) throw new Error("Kick cleanup channel scope mismatch.");
    if (job.kind === "content") {
      if (!channel.isThread()) throw new Error("Party thread is unavailable for cleanup.");
      const snapshot = await dependencies.contentRepository.getContentSnapshot(guild.id, job.targetId);
      const archiveAfter = channel.archived || snapshot?.content.state === "cancelled";
      if (channel.archived) await channel.setArchived(false, "Reconcile Guild Manager kick cleanup.");
      try {
        await channel.members.remove(job.discordUserId).catch((error: unknown) => {
          if (!hasDiscordCode(error, 10007)) throw error;
        });
        if (snapshot) await refreshContentMessages(guild, dependencies.contentRepository, snapshot, undefined, true);
      } finally {
        if (snapshot?.content.state === "cancelled") await channel.setLocked(true, "Party host kicked from Guild Manager.");
        if (archiveAfter) await channel.setArchived(true, "Restore closed party after Guild Manager kick cleanup.");
      }
      return;
    }
    if (job.kind === "voice") {
      if (channel.type !== ChannelType.GuildVoice) throw new Error("Temporary voice channel is unavailable for cleanup.");
      // A member-specific deny removes ownership even when shared roles grant native voice powers.
      await channel.permissionOverwrites.edit(job.discordUserId, {
        ViewChannel: false, Connect: false, SendMessages: false,
        ...Object.fromEntries(TEMPORARY_VOICE_OWNER_PERMISSIONS.map(permission => [newPermissionName(permission), false]))
      }, { type: OverwriteType.Member, reason: "Temporary voice ownership revoked by Guild Manager kick." });
      const member = await fetchMember(guild, job.discordUserId);
      if (member?.voice.channelId === channel.id) await member.voice.disconnect("Guild Manager access revoked.");
      if (member?.permissions.has(PermissionFlagsBits.Administrator)) throw new Error("Administrator permission bypasses temporary voice access revocation.");
      return;
    }
    if (channel.type !== ChannelType.GuildText) throw new Error("Private conversation channel is unavailable for cleanup.");
    await channel.permissionOverwrites.edit(job.discordUserId, {
      ViewChannel: false, SendMessages: false, ReadMessageHistory: false, AttachFiles: false
    }, { type: OverwriteType.Member, reason: "Private conversation access revoked by Guild Manager kick." });
    const member = await fetchMember(guild, job.discordUserId);
    if (member?.permissions.has(PermissionFlagsBits.Administrator)) throw new Error("Administrator permission bypasses private conversation access revocation.");
    for (const messageId of job.messageIds) {
      const message = await channel.messages.fetch({ message: messageId, force: true }).catch((error: unknown) => {
        if (hasDiscordCode(error, 10008)) return undefined;
        throw error;
      });
      if (!message) continue;
      if (message.author.id !== guild.client.user.id) throw new Error("Conversation control is not owned by this bot.");
      const components = message.components.map(component => disableControls(component.toJSON()));
      if (JSON.stringify(components) !== JSON.stringify(message.components.map(component => component.toJSON()))) {
        await message.edit({ components: components as MessageEditOptions["components"] });
      }
    }
  }
}

function newPermissionName(permission: bigint): string {
  const entry = Object.entries(PermissionFlagsBits).find(([, value]) => value === permission);
  if (!entry) throw new Error("Unknown voice permission.");
  return entry[0];
}

function disableControls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(disableControls);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries({ ...record, ...(typeof record.custom_id === "string" ? { disabled: true } : {}) })
    .map(([key, item]) => [key, disableControls(item)]));
}

function hasDiscordCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === code;
}

async function fetchMember(guild: Guild, discordUserId: string) {
  return guild.members.fetch({ user: discordUserId, force: true }).catch((error: unknown) => {
    if (hasDiscordCode(error, 10007) || hasDiscordCode(error, 10013)) return undefined;
    throw error;
  });
}
