import { AlbionApiError, type AlbionClient } from "./client.js";
import type { AlbionServer } from "./servers.js";
import type { AlbionAlliance, AlbionGuild } from "./types.js";

/** Fills missing lookup display metadata without changing membership evidence. */
export async function getGuildLookupDetails(
  albionClient: Pick<AlbionClient, "getGuild" | "getAlliance">,
  server: AlbionServer,
  guildId: string
): Promise<AlbionGuild> {
  const guild = await albionClient.getGuild(server, guildId);
  if (guild.id !== guildId) {
    throw new AlbionApiError("Albion Online guild lookup returned an unexpected Albion Online guild ID.", "invalid_response");
  }

  if (!guild.allianceId?.trim() || (guild.allianceName?.trim() && guild.allianceTag?.trim())) {
    return guild;
  }

  let alliance: AlbionAlliance;
  try {
    alliance = await albionClient.getAlliance(server, guild.allianceId);
  } catch {
    // The shared client logs API failures; optional metadata must not hide valid details.
    return guild;
  }

  if (alliance.id !== guild.allianceId) return guild;

  return {
    ...guild,
    allianceName: guild.allianceName?.trim() ? guild.allianceName : alliance.name,
    allianceTag: guild.allianceTag?.trim() ? guild.allianceTag : alliance.tag
  };
}
