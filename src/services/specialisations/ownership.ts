import type { Guild } from "discord.js";
import type { SpecialisationRepository } from "../../db/specialisationRepository.js";
import type { ReviewerRepository } from "../../db/reviewerRepository.js";
import type { AlbionServer } from "../albion/servers.js";
import type { MemberUpdateWarning } from "../membership/discordMemberUpdates.js";
import { createKeyedSerialQueue } from "../reactionRoles/keyedSerialQueue.js";
import { buildPendingSpecialisationCardEdit, inspectPendingSpecialisationProof } from "./rendering.js";

const presentationQueue = createKeyedSerialQueue();

/** The bot's single-runtime lock makes this fence shared by review and recovery presentation. */
export async function withSpecialisationPresentation<T>(guildId: string, requestId: string, operation: () => Promise<T>): Promise<T> {
  let result!: T;
  await presentationQueue.enqueue(`${guildId}:${requestId}`, async () => { result = await operation(); });
  return result;
}

export async function refreshPendingSpecialisationOwnership(
  guild: Guild,
  repository: SpecialisationRepository,
  reviewers: ReviewerRepository,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<MemberUpdateWarning[]> {
  const warnings: MemberUpdateWarning[] = [];
  try {
    const [requests, roleIds] = await Promise.all([
      repository.listRequests(guild.id, { state: "pending", albionServer, albionCharacterId }),
      reviewers.effectiveRoleIds(guild.id, "specialisation")
    ]);
    for (const request of requests) {
      try {
        await withSpecialisationPresentation(guild.id, request.specialisationRequestId, async () => {
          const current = await repository.getRequest(guild.id, request.specialisationRequestId);
          if (!current || current.state !== "pending" || !current.reviewMessageId || current.reviewMessageDeletedAt) return;
          const channel = await guild.channels.fetch(current.reviewChannelId);
          if (!channel?.isTextBased() || !("messages" in channel)) throw new Error("Review channel unavailable.");
          const message = await channel.messages.fetch(current.reviewMessageId);
          const proof = inspectPendingSpecialisationProof(message);
          if (!proof) throw new Error("Review proof unavailable.");
          await message.edit(buildPendingSpecialisationCardEdit(current, proof, roleIds));
        });
      } catch {
        warnings.push({ message: "A Pending weapon specialisation review card could not be refreshed. The registration change remains complete." });
      }
    }
  } catch {
    warnings.push({ message: "Pending weapon specialisation review cards could not be refreshed. The registration change remains complete." });
  }
  return warnings;
}
