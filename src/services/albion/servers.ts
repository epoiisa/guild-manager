export const ALBION_SERVER_VALUES = ["americas", "asia", "europe"] as const;

export type AlbionServer = typeof ALBION_SERVER_VALUES[number];

export const ALBION_SERVER_LABELS: Record<AlbionServer, string> = {
  americas: "North America",
  asia: "Asia",
  europe: "Europe"
};

const ALBION_GAME_INFO_BASE_URLS: Record<AlbionServer, string> = {
  americas: "https://gameinfo.albiononline.com/api/gameinfo",
  asia: "https://gameinfo-sgp.albiononline.com/api/gameinfo",
  europe: "https://gameinfo-ams.albiononline.com/api/gameinfo"
};

export function getAlbionGameInfoBaseUrl(server: AlbionServer): string {
  return ALBION_GAME_INFO_BASE_URLS[server];
}

export function getAlbionServerLabel(server: AlbionServer): string {
  return ALBION_SERVER_LABELS[server];
}

export function isAlbionServer(value: string): value is AlbionServer {
  return (ALBION_SERVER_VALUES as readonly string[]).includes(value);
}
