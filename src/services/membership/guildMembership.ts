import type { AlbionClient } from "../albion/client.js";
import type { AlbionServer } from "../albion/servers.js";
import type { AlbionGuildMember, AlbionPlayer } from "../albion/types.js";

export type PlayerGuildIdentity =
  | { kind: "verified"; guildId?: string; source: "player" | "search" }
  | { kind: "unavailable"; error: unknown };

export type GuildMembershipCheck =
  | { kind: "verified"; source: "player" | "search" | "roster" }
  | { kind: "not_member" }
  | { kind: "unavailable"; error: unknown };

export interface GuildMembershipCache {
  identities: Map<string, Promise<PlayerGuildIdentity>>;
  rosters: Map<string, Promise<AlbionGuildMember[]>>;
}

export function createGuildMembershipCache(): GuildMembershipCache {
  return { identities: new Map(), rosters: new Map() };
}

/**
 * Resolves a player's reported guild with an exact-ID character-search fallback.
 * A search result with the same name but a different ID is never used.
 */
export async function resolvePlayerGuildIdentity(
  albionClient: AlbionClient,
  server: AlbionServer,
  player: AlbionPlayer,
  cache?: GuildMembershipCache
): Promise<PlayerGuildIdentity> {
  if (player.guildId) return { kind: "verified", guildId: player.guildId, source: "player" };

  return lookupPlayerGuildByExactSearch(albionClient, server, player, cache);
}

/** Performs the character-search fallback even when player detail has a guild. */
export async function lookupPlayerGuildByExactSearch(
  albionClient: AlbionClient,
  server: AlbionServer,
  player: AlbionPlayer,
  cache?: GuildMembershipCache
): Promise<PlayerGuildIdentity> {

  const key = `${server}:${player.id}`;
  const cached = cache?.identities.get(key);
  if (cached) return cached;

  const lookup = (async (): Promise<PlayerGuildIdentity> => {
    try {
      const search = await albionClient.searchCharacters(server, player.name);
      const exact = search.players.find((candidate) => candidate.id === player.id);
      if (!exact) {
        return { kind: "unavailable", error: new Error("Character search did not return the expected character ID.") };
      }
      return { kind: "verified", guildId: exact.guildId, source: "search" };
    } catch (error) {
      return { kind: "unavailable", error };
    }
  })();
  cache?.identities.set(key, lookup);
  return lookup;
}

/**
 * Confirms configured Albion Online guild membership. Player detail is the fast
 * path; an incomplete detail record is checked against an exact-ID search and,
 * finally, the configured guild roster. A clean roster absence is definitive;
 * incomplete or failed evidence remains unavailable so callers retain profiles.
 */
export async function checkPlayerGuildMembership(
  albionClient: AlbionClient,
  server: AlbionServer,
  player: AlbionPlayer,
  targetGuildId: string,
  cache?: GuildMembershipCache
): Promise<GuildMembershipCheck> {
  if (player.guildId === targetGuildId) return { kind: "verified", source: "player" };

  const [identity, roster] = await Promise.all([
    lookupPlayerGuildByExactSearch(albionClient, server, player, cache),
    Promise.resolve().then(() => getGuildRoster(albionClient, server, targetGuildId, cache))
      .then((members) => ({ kind: "verified" as const, members }))
      .catch((error): { kind: "unavailable"; error: unknown } => ({ kind: "unavailable", error }))
  ]);
  if (identity.kind === "verified" && identity.guildId === targetGuildId) {
    return { kind: "verified", source: "search" };
  }
  if (roster.kind === "verified" && roster.members.some((member) => member.id === player.id)) {
    return { kind: "verified", source: "roster" };
  }
  if (identity.kind === "verified" && roster.kind === "verified") return { kind: "not_member" };
  return {
    kind: "unavailable",
    error: identity.kind === "unavailable"
      ? identity.error
      : roster.kind === "unavailable"
        ? roster.error
        : new Error("Guild membership evidence was unavailable.")
  };
}

function getGuildRoster(
  albionClient: AlbionClient,
  server: AlbionServer,
  guildId: string,
  cache?: GuildMembershipCache
): Promise<AlbionGuildMember[]> {
  const key = `${server}:${guildId}`;
  const cached = cache?.rosters.get(key);
  if (cached) return cached;
  const roster = albionClient.getGuildMembers(server, guildId);
  cache?.rosters.set(key, roster);
  return roster;
}
