import type { Guild } from "discord.js";
import { recordLogChange } from "../logFeed/events.js";
import type {
  ConfiguredAlbionAlliance,
  ConfiguredAlbionGuild,
  MemberGroup,
  MemberGroupProfile,
  createMembershipRepository
} from "../../db/membershipRepository.js";
import type { AlbionClient } from "../albion/client.js";
import { getAlbionServerLabel } from "../albion/servers.js";
import type { AlbionServer } from "../albion/servers.js";
import type { AlbionGuild, AlbionGuildMember, AlbionPlayer } from "../albion/types.js";
import {
  checkPlayerAllianceMembership,
  createGuildLookupCache,
  type GuildLookupCache
} from "./allianceMembership.js";
import {
  checkPlayerGuildMembership,
  createGuildMembershipCache,
  type GuildMembershipCache
} from "./guildMembership.js";
import {
  planEffectiveNicknameUpdate,
  planConfiguredRoleChangesForGuild,
  reconcileConfiguredRoles,
  reconcileConfiguredRolesForGuild,
  reconcileEffectiveNickname,
  type MemberUpdateWarning,
  type NicknameUpdateOutcome,
  type RoleUpdateOutcome
} from "./discordMemberUpdates.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export interface MembershipReconciliationScope {
  server?: AlbionServer;
  memberGroupId?: string;
}

export interface ProfileReconciliationOutcome {
  kind: "profile";
  action: "add" | "remove" | "record" | "reassign" | "depart" | "prune" | "waiting" | "restore" | "expire";
  characterName: string;
  discordUserId?: string;
  previousDiscordUserId?: string | null;
  groupName: string;
  albionServerLabel: string;
  departureExpiresAt?: Date;
  registrationExpiresAt?: Date;
}

export type MembershipReconciliationOutcome =
  | ProfileReconciliationOutcome
  | RoleUpdateOutcome
  | NicknameUpdateOutcome;

export interface MembershipReconciliationWarning extends MemberUpdateWarning {
  checkFailure?: { reason: string; scope: string; subject: string };
}

export interface MembershipReconciliationResult {
  selectedGroups: number;
  registeredCharactersChecked: number;
  managedRosterCharacters: number;
  profilesApplied: number;
  profilesOrphaned: number;
  usersReconciled: number;
  outcomes: MembershipReconciliationOutcome[];
  warnings: MembershipReconciliationWarning[];
}

export async function reconcileMembershipForGuild(
  guild: Guild,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  scope: MembershipReconciliationScope = {}
): Promise<MembershipReconciliationResult> {
  try {
    const result = await planMembershipForGuild(guild, albionClient, membershipRepository, scope, true);
    recordLogChange(guild.id, { kind: "reconciliation", outcomes: result.outcomes, warningCount: result.warnings.length });
    return result;
  } catch (error) {
    recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
    throw error;
  }
}

export async function auditMembershipForGuild(
  guild: Guild,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  scope: MembershipReconciliationScope = {}
): Promise<MembershipReconciliationResult> {
  return planMembershipForGuild(guild, albionClient, membershipRepository, scope, false);
}

export async function reconcileRegisteredCharacterMembership(
  guild: Guild,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  discordUserId: string,
  player: AlbionPlayer,
  server: AlbionServer
): Promise<MemberUpdateWarning[]> {
  const result = createResult();
  const selected = await getSelectedGroups(membershipRepository, guild.id, { server });
  const affectedDiscordUserIds = new Set<string>([discordUserId]);

  await reconcileRegisteredPlayer(
    guild.id,
    albionClient,
    membershipRepository,
    selected,
    server,
    player,
    discordUserId,
    affectedDiscordUserIds,
    result,
    true,
    createGuildLookupCache(),
    createGuildMembershipCache()
  );

  for (const affectedDiscordUserId of affectedDiscordUserIds) {
    result.warnings.push(...await reconcileConfiguredRoles(guild, membershipRepository, affectedDiscordUserId));
  }

  if (result.warnings.length) recordLogChange(guild.id, { kind: "incomplete", area: "membership" });
  return result.warnings;
}

async function planMembershipForGuild(
  guild: Guild,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  scope: MembershipReconciliationScope,
  apply: boolean
): Promise<MembershipReconciliationResult> {
  const result = createResult();
  const selected = await getSelectedGroups(membershipRepository, guild.id, scope);
  result.selectedGroups = selected.all.length;

  const affectedDiscordUserIds = new Set<string>();
  const guildMembershipCache = createGuildMembershipCache();
  const managedRosterPlayers = new Map<string, AlbionPlayer | null>();
  for (const userId of await collectInitialRoleSubjects(membershipRepository, guild.id, scope.server, selected.all)) {
    affectedDiscordUserIds.add(userId);
  }

  for (const configured of selected.guilds.filter((guildGroup) => guildGroup.managed)) {
    await reconcileManagedGuildRoster(guild.id, albionClient, membershipRepository, configured, affectedDiscordUserIds, result, apply, guildMembershipCache, managedRosterPlayers);
  }

  const registeredCharacterGroups = {
    guilds: selected.guilds.filter((guildGroup) => !guildGroup.managed),
    alliances: selected.alliances
  };
  if (registeredCharacterGroups.guilds.length > 0 || registeredCharacterGroups.alliances.length > 0) {
    await reconcileRegisteredCharacters(
      guild.id,
      albionClient,
      membershipRepository,
      registeredCharacterGroups,
      affectedDiscordUserIds,
      result,
      apply,
      createGuildLookupCache(),
      guildMembershipCache,
      managedRosterPlayers
    );
    await reconcileRetainedProfiles(guild.id, albionClient, membershipRepository, registeredCharacterGroups,
      affectedDiscordUserIds, result, apply, createGuildLookupCache(), guildMembershipCache);
  }

  for (const discordUserId of affectedDiscordUserIds) {
    if (apply) {
      const nicknameResult = await reconcileEffectiveNickname(
        guild,
        membershipRepository,
        discordUserId
      );
      result.outcomes.push(...nicknameResult.outcomes);
      result.warnings.push(...nicknameResult.warnings);
    } else {
      const nicknameResult = await planEffectiveNicknameUpdate(
        guild,
        membershipRepository,
        discordUserId
      );
      result.outcomes.push(...nicknameResult.outcomes);
      result.warnings.push(...nicknameResult.warnings);
    }
  }

  if (apply) {
    const roleResult = await reconcileConfiguredRolesForGuild(guild, membershipRepository);
    result.outcomes.push(...roleResult.outcomes);
    result.warnings.push(...roleResult.warnings);
    result.usersReconciled = roleResult.plans.length;
  } else {
    const roleResult = await planConfiguredRoleChangesForGuild(guild, membershipRepository);
    result.outcomes.push(...rolePlansToOutcomes(roleResult.plans));
    result.warnings.push(...roleResult.warnings);
    result.usersReconciled = roleResult.plans.length;
  }

  return result;
}

async function getSelectedGroups(
  membershipRepository: MembershipRepository,
  discordGuildId: string,
  scope: MembershipReconciliationScope
): Promise<{
  all: MemberGroup[];
  guilds: ConfiguredAlbionGuild[];
  alliances: ConfiguredAlbionAlliance[];
}> {
  const [allGroups, configuredGuilds, configuredAlliances] = await Promise.all([
    membershipRepository.listMemberGroups(discordGuildId, scope.server),
    membershipRepository.listConfiguredAlbionGuilds(discordGuildId),
    membershipRepository.listConfiguredAlbionAlliances(discordGuildId)
  ]);
  const allowedGroupIds = new Set(
    allGroups
      .filter((group) => !scope.memberGroupId || group.memberGroupId === scope.memberGroupId)
      .map((group) => group.memberGroupId)
  );

  return {
    all: allGroups.filter((group) => allowedGroupIds.has(group.memberGroupId)),
    guilds: configuredGuilds.filter((group) => allowedGroupIds.has(group.memberGroupId)),
    alliances: configuredAlliances.filter((group) => allowedGroupIds.has(group.memberGroupId))
  };
}

async function collectInitialRoleSubjects(
  membershipRepository: MembershipRepository,
  discordGuildId: string,
  server: AlbionServer | undefined,
  selectedGroups: MemberGroup[]
): Promise<string[]> {
  const [registeredUserIds, profiledUserIds] = await Promise.all([
    membershipRepository.listRegisteredUserIdsForGuild(discordGuildId, server),
    membershipRepository.listActiveProfileUserIdsForGroups(discordGuildId, selectedGroups.map((group) => group.memberGroupId))
  ]);
  return [...new Set([...registeredUserIds, ...profiledUserIds])];
}

async function reconcileManagedGuildRoster(
  discordGuildId: string,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  configured: ConfiguredAlbionGuild,
  affectedDiscordUserIds: Set<string>,
  result: MembershipReconciliationResult,
  apply: boolean,
  guildMembershipCache: GuildMembershipCache,
  managedRosterPlayers: Map<string, AlbionPlayer | null>
): Promise<void> {
  let guild: AlbionGuild;
  let roster: AlbionGuildMember[];
  const existingProfiles = await membershipRepository.listProfilesForGroups(discordGuildId, [configured.memberGroupId]);

  try {
    [guild, roster] = await Promise.all([
      albionClient.getGuild(configured.albionServer, configured.albionGuildId),
      albionClient.getGuildMembers(configured.albionServer, configured.albionGuildId)
    ]);
    if (guild.id !== configured.albionGuildId) throw new Error("Guild lookup returned an unexpected guild ID.");
  } catch (error) {
    result.warnings.push(checkWarning(`Roster check failed for ${configured.albionGuildName}: ${formatError(error)}`,
      error, configured.albionServer, [configured.groupName], "roster"));
    return;
  }

  result.managedRosterCharacters += roster.length;
  guildMembershipCache.rosters.set(`${configured.albionServer}:${configured.albionGuildId}`, Promise.resolve(roster));
  const rosterCharacterIds = new Set<string>();
  const existingProfileByCharacterId = profileByCharacterId(existingProfiles);

  for (const member of roster) {
    rosterCharacterIds.add(member.id);
    const player = rosterMemberToPlayer(member, guild);
    const verifiedGuildPlayer = { ...player, guildId: guild.id, guildName: guild.name,
      allianceId: guild.allianceId, allianceName: guild.allianceName, allianceTag: guild.allianceTag };
    const key = `${configured.albionServer}:${member.id}`;
    const previous = managedRosterPlayers.get(key);
    // Only an exact, consistent guild identity can seed a later positive check.
    if ((member.guildId && member.guildId !== guild.id) || (previous && previous.guildId !== guild.id)) {
      managedRosterPlayers.set(key, null);
    } else if (!managedRosterPlayers.has(key)) {
      managedRosterPlayers.set(key, verifiedGuildPlayer);
    }
    if (apply) {
      await membershipRepository.upsertVerifiedCharacter(configured.albionServer, player);
    }

    const registered = await membershipRepository.getRegisteredCharacter(discordGuildId, configured.albionServer, member.id);
    const existingProfile = existingProfileByCharacterId.get(member.id);
    if (existingProfile?.lifecycleState === "departed") {
      const restored = await restoreVerifiedMembership(membershipRepository, existingProfile, apply, result);
      if (restored?.discordUserId) affectedDiscordUserIds.add(restored.discordUserId);
      continue;
    }
    if (existingProfile?.registrationState === "hold") {
      result.outcomes.push(lifecycleOutcome("waiting", existingProfile, configured));
    }
    if (registered) {
      affectedDiscordUserIds.add(registered.discordUserId);
      if ((!existingProfile || existingProfile.discordUserId !== registered.discordUserId)
        && !existingProfile?.registrationState) {
        const outcome = existingProfile
          ? profileOutcome(
            "reassign",
            player.name,
            configured,
            registered.discordUserId,
            existingProfile.discordUserId
          )
          : profileOutcome("add", player.name, configured, registered.discordUserId);
        if (apply) {
          const profile = await membershipRepository.addRegisteredProfile({
            memberGroupId: configured.memberGroupId,
            discordGuildId,
            discordUserId: registered.discordUserId,
            albionServer: configured.albionServer,
            albionCharacterId: member.id
          });
          if (profile) {
            result.profilesApplied += 1;
            result.outcomes.push(outcome);
          }
        } else {
          result.profilesApplied += 1;
          result.outcomes.push(outcome);
        }
      }
      continue;
    }

    if (!existingProfile) {
      const outcome = profileOutcome("record", player.name, configured);
      if (apply) {
        const recorded = await membershipRepository.addOrphanProfile({
          memberGroupId: configured.memberGroupId,
          discordGuildId,
          albionServer: configured.albionServer,
          albionCharacterId: member.id
        });
        if (recorded.discordUserId || recorded.entitlementPreserved !== false) continue;
      }
      result.profilesApplied += 1;
      result.outcomes.push(outcome);
    }
  }

  for (const profile of existingProfiles.filter((candidate) => !rosterCharacterIds.has(candidate.albionCharacterId))) {
    let check;
    try {
      const player = await albionClient.getPlayer(configured.albionServer, profile.albionCharacterId);
      if (player.id !== profile.albionCharacterId) throw new Error("Character lookup returned an unexpected character ID.");
      check = await checkPlayerGuildMembership(albionClient, configured.albionServer, player,
        configured.albionGuildId, guildMembershipCache);
    } catch (error) {
      check = { kind: "unavailable" as const, error };
    }
    if (check.kind === "unavailable") {
      result.warnings.push(checkWarning(`Guild membership check failed for ${profile.characterName ?? profile.albionCharacterId} in ${configured.groupName}: ${formatError(check.error)}`,
        check.error, configured.albionServer, [configured.groupName], profile.characterName ?? profile.albionCharacterId));
      continue;
    }
    if (check.kind === "verified") {
      if (profile.registrationState === "hold" && profile.lifecycleState !== "departed") {
        result.outcomes.push(lifecycleOutcome("waiting", profile, configured));
      }
      if (profile.lifecycleState === "departed") {
        const restored = await restoreVerifiedMembership(membershipRepository, profile, apply, result);
        if (restored?.discordUserId) affectedDiscordUserIds.add(restored.discordUserId);
      }
      continue;
    }
    await reportMembershipDeparture(membershipRepository, profile, configured, affectedDiscordUserIds, result, apply);
  }
}

async function reconcileRegisteredCharacters(
  discordGuildId: string,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  selected: {
    guilds: ConfiguredAlbionGuild[];
    alliances: ConfiguredAlbionAlliance[];
  },
  affectedDiscordUserIds: Set<string>,
  result: MembershipReconciliationResult,
  apply: boolean,
  guildLookupCache: GuildLookupCache,
  guildMembershipCache: GuildMembershipCache,
  managedRosterPlayers: Map<string, AlbionPlayer | null>
): Promise<void> {
  const selectedServers = new Set<AlbionServer>([
    ...selected.guilds.map((group) => group.albionServer),
    ...selected.alliances.map((group) => group.albionServer)
  ]);
  const characters = await membershipRepository.listRegisteredCharacters(discordGuildId);
  const selectedGroupIds = new Set([...selected.guilds, ...selected.alliances].map(group => group.memberGroupId));

  for (const server of selectedServers) {
    for (const character of characters.filter((candidate) => candidate.albionServer === server)) {
      const profileSnapshot = await membershipRepository.listProfilesForCharacter(discordGuildId, server, character.albionCharacterId);
      const rosterPlayer = managedRosterPlayers.get(`${server}:${character.albionCharacterId}`);
      const allianceEvidenceComplete = selected.alliances.every(group => group.albionServer !== server)
        || rosterPlayer?.allianceId !== undefined;
      const positiveGroups = rosterPlayer && allianceEvidenceComplete ? {
        guilds: selected.guilds.filter(group => group.albionServer === server && group.albionGuildId === rosterPlayer.guildId),
        alliances: selected.alliances.filter(group => group.albionServer === server && group.albionAllianceId === rosterPlayer.allianceId)
      } : undefined;
      // An earlier roster may establish a new membership, but cannot decide a
      // departure against a profile snapshot taken later in this run.
      if (rosterPlayer && positiveGroups
        && (positiveGroups.guilds.length > 0 || positiveGroups.alliances.length > 0)
        && !profileSnapshot.some(profile => selectedGroupIds.has(profile.memberGroupId))) {
        await reconcileRegisteredPlayer(discordGuildId, albionClient, membershipRepository,
          positiveGroups, server, rosterPlayer, character.discordUserId, affectedDiscordUserIds,
          result, apply, guildLookupCache, guildMembershipCache, profileSnapshot, false);
        continue;
      }
      let player: AlbionPlayer;
      try {
        player = await albionClient.getPlayer(server, character.albionCharacterId);
        if (player.id !== character.albionCharacterId) throw new Error("Character lookup returned an unexpected character ID.");
      } catch (error) {
        result.warnings.push(checkWarning(`Character check failed for ${character.characterName}: ${formatError(error)}`,
          error, server, [...selected.guilds, ...selected.alliances].filter(group => group.albionServer === server).map(group => group.groupName), character.characterName));
        continue;
      }

      await reconcileRegisteredPlayer(
        discordGuildId,
        albionClient,
        membershipRepository,
        selected,
        server,
        player,
        character.discordUserId,
        affectedDiscordUserIds,
        result,
        apply,
        guildLookupCache,
        guildMembershipCache,
        profileSnapshot,
        true
      );
    }
  }
}

async function reconcileRegisteredPlayer(
  discordGuildId: string,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  selected: {
    guilds: ConfiguredAlbionGuild[];
    alliances: ConfiguredAlbionAlliance[];
  },
  server: AlbionServer,
  player: AlbionPlayer,
  discordUserId: string,
  affectedDiscordUserIds: Set<string>,
  result: MembershipReconciliationResult,
  apply: boolean,
  guildLookupCache: GuildLookupCache,
  guildMembershipCache: GuildMembershipCache,
  profileSnapshot?: MemberGroupProfile[],
  processDepartures = false
): Promise<void> {
  if (apply) {
    await membershipRepository.upsertVerifiedCharacter(server, player);
  }
  result.registeredCharactersChecked += 1;
  affectedDiscordUserIds.add(discordUserId);

  const selectedAutoGroups = [
    ...selected.guilds.filter((group) => group.albionServer === server),
    ...selected.alliances.filter((group) => group.albionServer === server)
  ];
  const existingProfiles = profileSnapshot ?? await membershipRepository.listProfilesForCharacter(discordGuildId, server, player.id);
  const existingProfileByGroupId = profileByGroupId(existingProfiles);
  const qualifications = await Promise.all(selectedAutoGroups.map(async (group) => ({
    group,
    result: await playerQualifiesForGroup(albionClient, server, player, group, guildLookupCache, guildMembershipCache)
  })));
  const qualifiedGroupIds = new Set(qualifications
    .filter((qualification) => qualification.result.kind === "qualified")
    .map((qualification) => qualification.group.memberGroupId));
  const unavailableGroupIds = new Set(qualifications
    .filter((qualification) => qualification.result.kind === "unavailable")
    .map((qualification) => qualification.group.memberGroupId));
  for (const qualification of qualifications) {
    if (qualification.result.kind === "unavailable") {
      result.warnings.push(checkWarning(`${qualification.group.groupType === "guild" ? "Guild" : "Alliance"} membership check failed for ${player.name} in ${qualification.group.groupName}: ${formatError(qualification.result.error)}`,
        qualification.result.error, server, [qualification.group.groupName], player.name));
    }
  }

  for (const group of selectedAutoGroups) {
    const existingProfile = existingProfileByGroupId.get(group.memberGroupId);
    const qualifies = qualifiedGroupIds.has(group.memberGroupId);

    if (qualifies) {
      if (existingProfile?.lifecycleState === "departed") {
        const restored = await restoreVerifiedMembership(membershipRepository, existingProfile, apply, result);
        if (restored?.discordUserId) affectedDiscordUserIds.add(restored.discordUserId);
        continue;
      }
      if (existingProfile?.registrationState) continue;
      if (!existingProfile || existingProfile.discordUserId !== discordUserId) {
        const outcome = existingProfile
          ? profileOutcome(
            "reassign",
            player.name,
            group,
            discordUserId,
            existingProfile.discordUserId
          )
          : profileOutcome("add", player.name, group, discordUserId);
        if (apply) {
          const profile = await membershipRepository.addRegisteredProfile({
            memberGroupId: group.memberGroupId,
            discordGuildId,
            discordUserId,
            albionServer: server,
            albionCharacterId: player.id
          });
          if (profile) {
            result.profilesApplied += 1;
            result.outcomes.push(outcome);
          }
        } else {
          result.profilesApplied += 1;
          result.outcomes.push(outcome);
        }
      }
      continue;
    }

    // A failed fallback lookup cannot establish that an existing profile is stale.
    if (unavailableGroupIds.has(group.memberGroupId)) continue;

    if (existingProfile) {
      await reportMembershipDeparture(membershipRepository, existingProfile, group, affectedDiscordUserIds, result, apply, processDepartures);
    }
  }
}

/** Orphans are still checked even after their registration has been removed.
 * Otherwise a Discord departure could permanently hide a later in-game loss.
 */
async function reconcileRetainedProfiles(
  discordGuildId: string,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository,
  selected: { guilds: ConfiguredAlbionGuild[]; alliances: ConfiguredAlbionAlliance[] },
  affectedDiscordUserIds: Set<string>,
  result: MembershipReconciliationResult,
  apply: boolean,
  guildLookupCache: GuildLookupCache,
  guildMembershipCache: GuildMembershipCache
): Promise<void> {
  const groups = [...selected.guilds, ...selected.alliances];
  const profiles = await membershipRepository.listProfilesForGroups(discordGuildId, groups.map(group => group.memberGroupId));
  const registrations = await membershipRepository.listRegisteredCharacters(discordGuildId);
  const registeredIds = new Set(registrations.map(character => `${character.albionServer}:${character.albionCharacterId}`));
  // All retained profile revisions were captured above, before this phase's evidence.
  const players = new Map<string, Promise<AlbionPlayer>>();
  for (const profile of profiles) {
    if (profile.discordUserId || registeredIds.has(`${profile.albionServer}:${profile.albionCharacterId}`)) continue;
    const group = groups.find(candidate => candidate.memberGroupId === profile.memberGroupId);
    if (!group) continue;
    let qualification;
    try {
      const key = `${profile.albionServer}:${profile.albionCharacterId}`;
      let lookup = players.get(key);
      if (!lookup) { lookup = albionClient.getPlayer(profile.albionServer, profile.albionCharacterId); players.set(key, lookup); }
      const player = await lookup;
      if (player.id !== profile.albionCharacterId) throw new Error("Character lookup returned an unexpected character ID.");
      qualification = await playerQualifiesForGroup(albionClient, profile.albionServer, player, group,
        guildLookupCache, guildMembershipCache);
    } catch (error) {
      qualification = { kind: "unavailable" as const, error };
    }
    if (qualification.kind === "unavailable") {
      result.warnings.push(checkWarning(`Membership check failed for ${profile.characterName ?? profile.albionCharacterId} in ${group.groupName}: ${formatError(qualification.error)}`,
        qualification.error, profile.albionServer, [group.groupName], profile.characterName ?? profile.albionCharacterId));
      continue;
    }
    if (qualification.kind === "qualified") {
      if (profile.lifecycleState === "departed") await restoreVerifiedMembership(membershipRepository, profile, apply, result);
      else if (profile.registrationState === "hold") result.outcomes.push(lifecycleOutcome("waiting", profile, group));
      continue;
    }
    await reportMembershipDeparture(membershipRepository, profile, group, affectedDiscordUserIds, result, apply);
  }
}

async function reportMembershipDeparture(
  repository: MembershipRepository,
  profile: MemberGroupProfile,
  group: ConfiguredAlbionGuild | ConfiguredAlbionAlliance,
  affectedDiscordUserIds: Set<string>,
  result: MembershipReconciliationResult,
  apply: boolean,
  processDepartures = true
): Promise<void> {
  if (profile.lifecycleState === "departed") {
    const now = new Date();
    const due = processDepartures && profile.departureExpiresAt && profile.departureExpiresAt.getTime() <= now.getTime();
    if (!due) {
      result.outcomes.push(lifecycleOutcome("waiting", profile, group));
      return;
    }
    // This path is reached only after definitive non-membership evidence.
    // Unavailable checks and positive returns never forfeit retained records.
    if (apply) {
      if (profile.lifecycleRevision === undefined
        || !await repository.expireMembershipDeparture(profile, profile.lifecycleRevision, now)) return;
      recordLogChange(profile.discordGuildId, { kind: "profile", action: "removed", profile });
    }
    const owner = profile.discordUserId ?? profile.previousDiscordUserId;
    if (owner) affectedDiscordUserIds.add(owner);
    result.profilesOrphaned += 1;
    result.outcomes.push(lifecycleOutcome("expire", profile, group));
    return;
  }
  const owner = profile.discordUserId ?? profile.previousDiscordUserId;
  if (owner) affectedDiscordUserIds.add(owner);
  const changed = apply ? await repository.markMembershipDeparted(profile) : profile;
  if (!changed) return;
  const action = changed.entitlementPreserved === false ? "prune" : "depart";
  const outcome = lifecycleOutcome(action, { ...profile,
    departureExpiresAt: apply ? changed.departureExpiresAt : undefined }, group);
  if (apply) recordLogChange(profile.discordGuildId, {
    kind: "profile", action: action === "prune" ? "removed" : "left", profile,
    ...(action === "depart" && changed.departureExpiresAt ? {
      startedDepartureGrace: {
        expiresAt: changed.departureExpiresAt,
        registrationExpiresAt: changed.registrationExpiresAt
      }
    } : {})
  });
  result.profilesOrphaned += 1;
  result.outcomes.push(outcome);
}

function lifecycleOutcome(
  action: ProfileReconciliationOutcome["action"],
  profile: MemberGroupProfile,
  group?: ConfiguredAlbionGuild | ConfiguredAlbionAlliance
): ProfileReconciliationOutcome {
  return {
    kind: "profile", action, characterName: profile.characterName ?? profile.albionCharacterId,
    discordUserId: profile.discordUserId, previousDiscordUserId: profile.previousDiscordUserId,
    groupName: group ? ("albionGuildName" in group ? group.albionGuildName : group.albionAllianceName) : profile.groupName ?? "Membership group",
    albionServerLabel: getAlbionServerLabel(profile.albionServer),
    ...(profile.departureExpiresAt ? { departureExpiresAt: profile.departureExpiresAt } : {}),
    ...(profile.registrationExpiresAt ? { registrationExpiresAt: profile.registrationExpiresAt } : {})
  };
}

async function restoreVerifiedMembership(
  membershipRepository: MembershipRepository,
  profile: MemberGroupProfile,
  apply: boolean,
  report: MembershipReconciliationResult
): Promise<MemberGroupProfile | undefined> {
  const outcome = lifecycleOutcome("restore", profile);
  if (!apply) {
    report.outcomes.push(outcome);
    return profile;
  }
  if (profile.lifecycleRevision === undefined) return undefined;
  const restored = await membershipRepository.restoreDepartedMembership(profile, profile.lifecycleRevision);
  if (!restored) return undefined;
  report.outcomes.push(outcome);
  recordLogChange(profile.discordGuildId, { kind: "profile", action: "joined", profile: restored });
  return restored;
}

async function playerQualifiesForGroup(
  albionClient: AlbionClient,
  server: AlbionServer,
  player: AlbionPlayer,
  group: ConfiguredAlbionGuild | ConfiguredAlbionAlliance,
  guildLookupCache: GuildLookupCache,
  guildMembershipCache: GuildMembershipCache
): Promise<{ kind: "qualified" | "not_qualified" } | { kind: "unavailable"; error: unknown }> {
  if ("albionGuildId" in group) {
    const membership = await checkPlayerGuildMembership(
      albionClient,
      server,
      player,
      group.albionGuildId,
      guildMembershipCache
    );
    if (membership.kind === "unavailable") return membership;
    return { kind: membership.kind === "verified" ? "qualified" : "not_qualified" };
  }

  const membership = await checkPlayerAllianceMembership(
    albionClient,
    server,
    player,
    group.albionAllianceId,
    guildLookupCache,
    guildMembershipCache
  );
  if (membership.kind === "unavailable") return membership;
  return { kind: membership.kind === "verified" ? "qualified" : "not_qualified" };
}

function rosterMemberToPlayer(member: AlbionGuildMember, guild: AlbionGuild): AlbionPlayer {
  return {
    id: member.id,
    name: member.name,
    guildId: member.guildId ?? guild.id,
    guildName: member.guildName ?? guild.name,
    allianceId: member.allianceId ?? guild.allianceId,
    allianceName: member.allianceName ?? guild.allianceName,
    allianceTag: member.allianceTag ?? guild.allianceTag
  };
}

function profileByCharacterId(profiles: MemberGroupProfile[]): Map<string, MemberGroupProfile> {
  return new Map(profiles.map((profile) => [profile.albionCharacterId, profile]));
}

function profileByGroupId(profiles: MemberGroupProfile[]): Map<string, MemberGroupProfile> {
  return new Map(profiles.map((profile) => [profile.memberGroupId, profile]));
}

function profileOutcome(
  action: ProfileReconciliationOutcome["action"],
  characterName: string,
  group: ConfiguredAlbionGuild | ConfiguredAlbionAlliance,
  discordUserId?: string,
  previousDiscordUserId?: string | null
): ProfileReconciliationOutcome {
  return {
    kind: "profile",
    action,
    characterName,
    discordUserId,
    previousDiscordUserId,
    groupName: "albionGuildName" in group
      ? group.albionGuildName
      : group.albionAllianceName,
    albionServerLabel: getAlbionServerLabel(group.albionServer)
  };
}

function rolePlansToOutcomes(
  plans: Array<{
    discordUserId: string;
    addRoleIds: string[];
    removeRoleIds: string[];
  }>
): RoleUpdateOutcome[] {
  return plans.flatMap((plan) => [
    ...plan.addRoleIds.map((roleId): RoleUpdateOutcome => ({
      kind: "role",
      action: "add",
      discordUserId: plan.discordUserId,
      roleId
    })),
    ...plan.removeRoleIds.map((roleId): RoleUpdateOutcome => ({
      kind: "role",
      action: "remove",
      discordUserId: plan.discordUserId,
      roleId
    }))
  ]);
}

function createResult(): MembershipReconciliationResult {
  return {
    selectedGroups: 0,
    registeredCharactersChecked: 0,
    managedRosterCharacters: 0,
    profilesApplied: 0,
    profilesOrphaned: 0,
    usersReconciled: 0,
    outcomes: [],
    warnings: []
  };
}

function checkWarning(message: string, error: unknown, server: AlbionServer, groups: string[], subject: string): MembershipReconciliationWarning {
  const reason = error && typeof error === "object" && "kind" in error && error.kind === "rate_limited"
    ? "Albion Online API rate limit (HTTP 429)" : formatError(error);
  return { message, checkFailure: { reason,
    scope: `${getAlbionServerLabel(server)} • ${[...new Set(groups)].join(" / ")}`, subject } };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
