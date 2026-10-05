import type { ApplicationClass, createApplicationRepository } from "../../db/applicationRepository.js";
import type { AlbionClient } from "../albion/client.js";
import type { AlbionSearchPlayer } from "../albion/types.js";
import { withApplicationOperationLock } from "./applicationOperationLock.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;
export type RetryCharacterSearchResult =
  | { kind: "no_matches"; application: ApplicationClass; attempt: number }
  | { kind: "matches"; application: ApplicationClass; attempt: number; players: AlbionSearchPlayer[] }
  | { kind: "error"; title: string; description: string };

export async function retryApplicationCharacterSearch(input: { guildId: string; channelId?: string; applicationId: string; characterName: string; actor: { userId: string; roleIds: ReadonlySet<string> }; applicationRepository: ApplicationRepository; albionClient: AlbionClient }): Promise<RetryCharacterSearchResult> {
  return withApplicationOperationLock(input.guildId, input.applicationId, () => retryApplicationCharacterSearchLocked(input));
}

async function retryApplicationCharacterSearchLocked(input: { guildId: string; channelId?: string; applicationId: string; characterName: string; actor: { userId: string; roleIds: ReadonlySet<string> }; applicationRepository: ApplicationRepository; albionClient: AlbionClient }): Promise<RetryCharacterSearchResult> {
  const open = await input.applicationRepository.getOpenApplication(input.guildId, input.applicationId);
  const application = open ? await input.applicationRepository.getApplicationClass(input.guildId, open.applicationClassId) : undefined;
  if (!open || !application || open.status !== "open" || open.channelStatus !== "open") return error("Character Search Unavailable", "This application is no longer open and undecided.");
  if (application.archivedAt) return error("Application Target Removed", "This application is retained as history because its target member group was removed.");
  if (input.channelId && open.ticketChannelId !== input.channelId) return error("Wrong Channel", "That control can only be used in the matching application ticket.");
  if (input.actor.userId !== open.applicantDiscordUserId && !input.actor.roleIds.has(application.reviewerRoleId)) return error("Character Search Not Allowed", "You cannot submit this character search.");
  let players: AlbionSearchPlayer[];
  try {
    players = (await input.albionClient.searchCharacters(application.albionServer, input.characterName)).players.slice(0, 24);
  } catch {
    return error(
      "Character Search Unavailable",
      "Albion Online character search is temporarily unavailable. Try again."
    );
  }
  const tracked = await input.applicationRepository.beginApplicationCharacterSearch(input.guildId, input.applicationId, input.characterName);
  if (!tracked) return error("Character Search Unavailable", "The application changed before this search was submitted.");
  return players.length ? { kind: "matches", application, attempt: tracked.characterSearchAttemptCount, players } : { kind: "no_matches", application, attempt: tracked.characterSearchAttemptCount };
}
function error(title: string, description: string): RetryCharacterSearchResult { return { kind: "error", title, description }; }
