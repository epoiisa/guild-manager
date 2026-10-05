import type { AlbionClient } from "./client.js";
import type { AlbionServer } from "./servers.js";
import type { AlbionPlayer } from "./types.js";

export interface CharacterResolution {
  status: "resolved" | "not_found" | "ambiguous";
  player?: AlbionPlayer;
  matches?: string[];
}

export async function resolveAlbionCharacter(
  albionClient: AlbionClient,
  server: AlbionServer,
  characterName: string
): Promise<CharacterResolution> {
  const query = characterName.trim();
  if (!query) {
    return { status: "not_found" };
  }

  const search = await albionClient.searchCharacters(server, query);
  const exactMatches = search.players.filter((player) => player.name.toLocaleLowerCase() === query.toLocaleLowerCase());

  if (exactMatches.length !== 1) {
    return {
      status: exactMatches.length === 0 ? "not_found" : "ambiguous",
      matches: exactMatches.map((player) => player.name)
    };
  }

  return {
    status: "resolved",
    player: await albionClient.getPlayer(server, exactMatches[0].id)
  };
}
