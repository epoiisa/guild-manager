import type { AlbionClient } from "../albion/client.js";
import type { AlbionServer } from "../albion/servers.js";
import type { AlbionPlayer } from "../albion/types.js";
import type {
  RegisteredCharacter,
  RegisteredProfileInput,
  createMembershipRepository
} from "../../db/membershipRepository.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export interface RegisterVerifiedCharacterInput {
  discordGuildId: string;
  discordUserId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
}

export interface MembershipIdentityService {
  verifyCharacter(server: AlbionServer, albionCharacterId: string): Promise<AlbionPlayer>;
  registerVerifiedCharacter(input: RegisterVerifiedCharacterInput): Promise<RegisteredCharacter>;
  addRegisteredProfile(input: RegisteredProfileInput): Promise<void>;
}

export function createMembershipIdentityService(
  repository: MembershipRepository,
  albionClient: AlbionClient
): MembershipIdentityService {
  return {
    verifyCharacter: async (server, albionCharacterId) => {
      const player = await albionClient.getPlayer(server, albionCharacterId);
      await repository.upsertVerifiedCharacter(server, player);
      return player;
    },
    registerVerifiedCharacter: async (input) => {
      const player = await albionClient.getPlayer(input.albionServer, input.albionCharacterId);
      return repository.registerCharacter({
        discordGuildId: input.discordGuildId,
        discordUserId: input.discordUserId,
        albionServer: input.albionServer,
        player
      });
    },
    addRegisteredProfile: async (input) => {
      const profile = await repository.addRegisteredProfile(input);
      if (!profile) {
        throw new Error("Cannot create active member group profile without a registered Discord user and verified Albion Online character.");
      }
    }
  };
}
