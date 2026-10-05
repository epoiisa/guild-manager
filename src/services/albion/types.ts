export interface AlbionSearchResult {
  guilds: AlbionSearchGuild[];
  players: AlbionSearchPlayer[];
}

export interface AlbionSearchGuild {
  id: string;
  name: string;
  allianceId?: string;
  allianceName?: string;
  allianceTag?: string;
}

export interface AlbionSearchPlayer {
  id: string;
  name: string;
  guildId?: string;
  guildName?: string;
  allianceId?: string;
  allianceName?: string;
  allianceTag?: string;
}

export interface AlbionGuild {
  id: string;
  name: string;
  founderName?: string;
  founded?: string;
  allianceId?: string;
  allianceName?: string;
  allianceTag?: string;
  memberCount?: number;
}

export interface AlbionGuildMember extends AlbionPlayer {
  pvpFame?: number;
  pveFame?: number;
  gatheringFame?: number;
  refiningFame?: number;
  totalFame?: number;
}

export interface AlbionAlliance {
  id: string;
  name: string;
  tag?: string;
  guilds: {
    id: string;
    name: string;
  }[];
}

export interface AlbionPlayer {
  id: string;
  name: string;
  guildId?: string;
  guildName?: string;
  allianceId?: string;
  allianceName?: string;
  allianceTag?: string;
  pvpFame?: number;
  pveFame?: number;
  gatheringFame?: number;
  craftingFame?: number;
}
