import type { createMembershipRepository } from "../../db/membershipRepository.js";
import type { AlbionClient } from "../albion/client.js";
import type { AlbionServer } from "../albion/servers.js";
import type { AlbionPlayer } from "../albion/types.js";
import { checkPlayerAllianceMembership, createGuildLookupCache } from "./allianceMembership.js";
import { checkPlayerGuildMembership, createGuildMembershipCache } from "./guildMembership.js";
import type { MemberUpdateWarning } from "./discordMemberUpdates.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export interface VerifiedCharacterMemberships {
  qualifiedGroupIds: string[];
  rejectedGroupIds: string[];
  unavailableGroupIds: string[];
  warnings: MemberUpdateWarning[];
}

/** Read-only evidence for officer recovery. Take the lifecycle revision before
 * calling this function and pass it to the atomic recovery operation afterwards.
 * Unknown memberships remain suspended; they are never treated as departures.
 */
export async function verifyConfiguredCharacterMemberships(
  discordGuildId: string,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  server: AlbionServer,
  player: AlbionPlayer
): Promise<VerifiedCharacterMemberships> {
  const [guilds, alliances] = await Promise.all([
    membershipRepository.listConfiguredAlbionGuilds(discordGuildId),
    membershipRepository.listConfiguredAlbionAlliances(discordGuildId)
  ]);
  const result: VerifiedCharacterMemberships = {
    qualifiedGroupIds: [], rejectedGroupIds: [], unavailableGroupIds: [], warnings: []
  };
  const guildCache = createGuildLookupCache();
  const membershipCache = createGuildMembershipCache();
  for (const group of [...guilds, ...alliances].filter(candidate => candidate.albionServer === server)) {
    const check = "albionGuildId" in group
      ? await checkPlayerGuildMembership(albionClient, server, player, group.albionGuildId, membershipCache)
      : await checkPlayerAllianceMembership(albionClient, server, player, group.albionAllianceId, guildCache, membershipCache);
    if (check.kind === "verified") result.qualifiedGroupIds.push(group.memberGroupId);
    else if (check.kind === "not_member") result.rejectedGroupIds.push(group.memberGroupId);
    else {
      result.unavailableGroupIds.push(group.memberGroupId);
      result.warnings.push({ message: `Membership verification is unavailable for ${player.name} in ${group.groupName}; its retained membership remains suspended.` });
    }
  }
  return result;
}
