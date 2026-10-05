import type { AlbionClient } from "../albion/client.js";
import type { AlbionServer } from "../albion/servers.js";
import type { AlbionGuild, AlbionPlayer } from "../albion/types.js";
import { resolvePlayerGuildIdentity, type GuildMembershipCache } from "./guildMembership.js";

export type AllianceMembershipCheck =
  | { kind: "verified"; source: "player" }
  | { kind: "verified"; source: "guild"; guildName: string }
  | { kind: "not_member" }
  | { kind: "unavailable"; error: unknown };

export type GuildLookupCache = Map<string, Promise<Pick<AlbionGuild, "id" | "name" | "allianceId">>>;

export function createGuildLookupCache(): GuildLookupCache {
  return new Map();
}

/**
 * Confirms alliance membership using Albion's player record first, then the
 * central exact-ID guild-identity fallback. IDs are the only authority; names
 * and tags are display data and must not influence this decision.
 */
export async function checkPlayerAllianceMembership(
  albionClient: AlbionClient,
  server: AlbionServer,
  player: AlbionPlayer,
  targetAllianceId: string,
  guildLookupCache?: GuildLookupCache,
  guildMembershipCache?: GuildMembershipCache
): Promise<AllianceMembershipCheck> {
  if (player.allianceId === targetAllianceId) return { kind: "verified", source: "player" };

  const identity = await resolvePlayerGuildIdentity(albionClient, server, player, guildMembershipCache);
  if (identity.kind === "unavailable") return identity;
  if (!identity.guildId) return { kind: "not_member" };

  try {
    const cacheKey = `${server}:${identity.guildId}`;
    const guild = guildLookupCache
      ? await getCachedGuild(albionClient, server, identity.guildId, cacheKey, guildLookupCache)
      : await albionClient.getGuild(server, identity.guildId);
    if (guild.id !== identity.guildId) {
      return { kind: "unavailable", error: new Error("Guild lookup returned an unexpected guild ID.") };
    }
    return guild.allianceId === targetAllianceId
      ? { kind: "verified", source: "guild", guildName: guild.name }
      : { kind: "not_member" };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

function getCachedGuild(
  albionClient: AlbionClient,
  server: AlbionServer,
  guildId: string,
  cacheKey: string,
  cache: GuildLookupCache
): Promise<Pick<AlbionGuild, "id" | "name" | "allianceId">> {
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const lookup = albionClient.getGuild(server, guildId);
  cache.set(cacheKey, lookup);
  return lookup;
}
