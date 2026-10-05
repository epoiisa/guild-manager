import { listQualifiedRoleIdsForUser } from "./roleEntitlements.js";
import type { PostgresPool } from "./postgres.js";
import type { AlbionPlayer } from "../services/albion/types.js";
import type { AlbionServer } from "../services/albion/servers.js";
import { isLogCaptureActive, recordLogChange, type LogChange } from "../services/logFeed/events.js";
import { createMembershipLifecycleRepository, lockMembershipLifecycleTenant, assertRegistrationLifecycleAllowed, prepareOfficerRecovery, mapLifecycleProfile, MembershipLifecycleConflictError, type OfficerRecoveryEvidence } from "./membershipLifecycleRepository.js";
export type { RegistrationLifecycle } from "./membershipLifecycleRepository.js";
export { CharacterRecoveryRequiredError, MembershipLifecycleConflictError, MembershipRecoveryVerificationUnavailableError } from "./membershipLifecycleRepository.js";
import { createCharacterStatusRepository } from "./characterStatusRepository.js";
import { expireCharacterEntitlements, lockCharacterEntitlements } from "./membershipEntitlementCleanup.js";
import { createMemberAccessRepository, assertMemberAccessAllowed, lockMemberAccess, KickCleanupPendingError } from "./memberAccessRepository.js";
import { revokeKickActivities } from "./kickActivitiesRepository.js";
import { createKickRolesRepository } from "./kickRolesRepository.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type MemberGroupType = "group" | "guild" | "alliance";

export interface RegisteredCharacter {
  discordGuildId: string;
  discordUserId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
}

export interface CharacterRecord {
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  guildName?: string;
  allianceName?: string;
}

export interface MemberGroup {
  memberGroupId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  groupType: MemberGroupType;
  groupName: string;
}

export interface ConfiguredAlbionGuild extends MemberGroup {
  albionGuildId: string;
  albionGuildName: string;
  managed: boolean;
}

export interface ConfiguredAlbionAlliance extends MemberGroup {
  albionAllianceId: string;
  albionAllianceName: string;
  albionAllianceTag?: string;
}

export interface CharacterRoleConfig {
  characterRoleConfigId: string;
  discordGuildId: string;
  albionServer?: AlbionServer;
  discordRoleId: string;
}

export interface MemberGroupRoleConfig {
  memberGroupRoleConfigId: string;
  memberGroupId: string;
  discordRoleId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  groupType: MemberGroupType;
  groupName: string;
}

export interface MemberGroupProfile {
  lifecycleState?: "current" | "manual" | "unregistered" | "departed";
  entitlementPreserved?: boolean;
  previousDiscordUserId?: string;
  departureDetectedAt?: Date;
  /** End of the minimum buffer; cleanup waits for an update and verified absence. */
  departureExpiresAt?: Date;
  lifecycleRevision?: number;
  lifecycleWarning?: boolean;
  registrationState?: "hold" | "abandoned";
  registrationSource?: "discord_departure" | "purge";
  registrationExpiresAt?: Date;
  memberGroupProfileId: string;
  memberGroupId: string;
  discordGuildId: string;
  discordUserId?: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  groupName?: string;
  groupType?: MemberGroupType;
  characterName?: string;
}

export interface GroupPosition {
  memberGroupPositionId: string;
  discordGuildId: string;
  memberGroupId: string;
  name: string;
  discordRoleId: string;
  albionServer: AlbionServer;
  groupType: MemberGroupType;
  groupName: string;
}

export interface GroupPositionAppointment {
  memberGroupPositionAppointmentId: string;
  memberGroupPositionId: string;
  memberGroupProfileId: string;
  discordGuildId: string;
  name: string;
  discordRoleId: string;
  memberGroupId: string;
  albionServer: AlbionServer;
  groupType: MemberGroupType;
  groupName: string;
  discordUserId?: string;
  albionCharacterId: string;
  characterName: string;
}

export interface DormantReactionRoleSubscription {
  reactionRoleConfigId: string;
  channelId?: string;
  messageId?: string;
  emojiKey?: string;
  emojiDisplayValue?: string;
}

export interface SelfServiceCharacter {
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  discordRoleIds: string[];
}

export interface SelfServiceMembership {
  memberGroupProfileId: string;
  memberGroupId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  groupType: MemberGroupType;
  groupName: string;
  discordRoleIds: string[];
}

export interface SelfServicePosition {
  memberGroupPositionAppointmentId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  groupType: MemberGroupType;
  groupName: string;
  positionName: string;
  discordRoleId: string;
}

export interface SelfServiceReactionRole {
  reactionRoleConfigId: string;
  discordRoleId: string;
  dormant: boolean;
}

export interface CreateGroupInput {
  discordGuildId: string;
  albionServer: AlbionServer;
  groupName: string;
}

export const MAX_REGISTERED_CHARACTERS_PER_USER = 25;

export class CharacterRegistrationLimitError extends Error {
  constructor(public readonly limit = MAX_REGISTERED_CHARACTERS_PER_USER) {
    super(`A Discord user can have at most ${limit} registered characters in one Discord server.`);
    this.name = "CharacterRegistrationLimitError";
  }
}

/** The durable one-owner-per-character index rejected a competing registration. */
export class CharacterAlreadyRegisteredError extends Error {
  constructor() {
    super("This Albion Online character is already registered to another Discord user in this server.");
    this.name = "CharacterAlreadyRegisteredError";
  }
}

const CHARACTER_OWNER_UNIQUE_INDEX = "discord_user_characters_one_owner_per_guild_character";

export interface ConfigureAlbionGuildInput {
  discordGuildId: string;
  albionServer: AlbionServer;
  albionGuildId: string;
  albionGuildName: string;
  managed: boolean;
}

export interface ConfigureAlbionAllianceInput {
  discordGuildId: string;
  albionServer: AlbionServer;
  albionAllianceId: string;
  albionAllianceName: string;
  albionAllianceTag?: string;
}

export interface RegisterCharacterInput {
  recovery?: OfficerRecoveryEvidence;
  discordGuildId: string;
  discordUserId: string;
  albionServer: AlbionServer;
  player: AlbionPlayer;
}

export interface ProfileInput {
  memberGroupId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
}

export interface CreateGroupPositionInput {
  discordGuildId: string;
  memberGroupId: string;
  name: string;
  discordRoleId: string;
}

export interface RegisteredCharacterRef {
  discordGuildId: string;
  discordUserId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
}

export interface RegisteredProfileInput extends ProfileInput {
  discordUserId: string;
}

export interface CompleteApplicationAcceptanceInput extends RegisterCharacterInput {
  applicationId: string;
  reviewerDiscordUserId: string;
  expectedApplicationStatus: "open" | "awaiting_ingame_membership";
  memberGroupId?: string;
}

export interface SwitchRegisteredCharacterInput {
  discordGuildId: string;
  discordUserId: string;
  fromAlbionServer: AlbionServer;
  fromAlbionCharacterId: string;
  toAlbionServer: AlbionServer;
  player: AlbionPlayer;
}

export interface SwitchRegisteredCharacterResult {
  from?: RegisteredCharacter;
  to?: RegisteredCharacter;
  existing?: RegisteredCharacter;
  switchedProfiles: number;
  mergedOrphanProfiles: number;
}

export interface OrphanedProfileResult {
  orphanedProfiles: number;
  affectedDiscordUserIds: string[];
}

export interface MemberGroupRemovalPreview {
  memberGroup: MemberGroup;
  displayName: string;
  albionEntityId?: string;
  albionAllianceTag?: string;
  totalMembershipProfiles: number;
  ownedMembershipProfiles: number;
  orphanedMembershipProfiles: number;
  affectedDiscordUserIds: string[];
  retiredRoleIds: string[];
}

export interface RemoveMemberGroupInput {
  discordGuildId: string;
  memberGroupId: string;
  archivedByDiscordUserId: string;
}

export interface ArchivedApplicationClassTarget {
  applicationClassId: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
}

export interface ArchivedApplicationTarget {
  applicationId: string;
  applicationClassId: string;
  applicantDiscordUserId: string;
  ticketChannelId?: string;
  reviewerRoleId: string;
  activeRoleId?: string;
  channelStatus: "open" | "closed" | "deleted";
  channelClosedByRemoval: boolean;
}

export interface MemberGroupRemovalResult extends MemberGroupRemovalPreview {
  archivedApplicationClassCount: number;
  deletedApplicationClassCount: number;
  archivedApplicationClassIds: string[];
  deletedApplicationClassIds: string[];
  archivedApplicationIds: string[];
  archivedApplicationClasses: ArchivedApplicationClassTarget[];
  deletedApplicationClasses: ArchivedApplicationClassTarget[];
  archivedApplications: ArchivedApplicationTarget[];
}

export function createMembershipRepository(pool: PostgresPool) {
  return {
    ...createMembershipLifecycleRepository(pool),
    ...createCharacterStatusRepository(pool),
    ...createMemberAccessRepository(pool),
    listKickAuthorityRoleIds: createKickRolesRepository(pool).listAuthorityRoleIds,
    upsertVerifiedCharacter: (server: AlbionServer, player: AlbionPlayer) =>
      upsertVerifiedCharacter(pool, server, player),
    registerCharacter: (input: RegisterCharacterInput) => registerCharacter(pool, input),
    registerCharacterAndAdoptOrphans: (input: RegisterCharacterInput) => registerCharacterAndAdoptOrphans(pool, input),
    completeApplicationAcceptance: (input: CompleteApplicationAcceptanceInput) => completeApplicationAcceptance(pool, input),
    switchRegisteredCharacter: (input: SwitchRegisteredCharacterInput) => switchRegisteredCharacter(pool, input),
    listRegisteredCharacters: (discordGuildId: string, discordUserId?: string) =>
      listRegisteredCharacters(pool, discordGuildId, discordUserId),
    listKnownCharactersForGuild: (discordGuildId: string) => listKnownCharactersForGuild(pool, discordGuildId),
    listRegisteredCharactersByName: (discordGuildId: string, characterName: string, discordUserId?: string) =>
      listRegisteredCharactersByName(pool, discordGuildId, characterName, discordUserId),
    getRegisteredCharacterForUser: (
      discordGuildId: string,
      discordUserId: string,
      albionServer: AlbionServer,
      albionCharacterId: string
    ) => getRegisteredCharacterForUser(pool, discordGuildId, discordUserId, albionServer, albionCharacterId),
    hasOrphanProfilesForCharacter: (
      discordGuildId: string,
      albionServer: AlbionServer,
      albionCharacterId: string
    ) => hasOrphanProfilesForCharacter(pool, discordGuildId, albionServer, albionCharacterId),
    unregisterCharacter: (input: RegisteredCharacterRef) => unregisterCharacter(pool, input),
    kickUser: (discordGuildId: string, discordUserId: string, revokedRoleIds: readonly string[] = [], actorDiscordUserId?: string) =>
      kickUser(pool, discordGuildId, discordUserId, revokedRoleIds, actorDiscordUserId),
    getCharacterRecord: (albionServer: AlbionServer, albionCharacterId: string) =>
      getCharacterRecord(pool, albionServer, albionCharacterId),
    setMainCharacter: (input: RegisteredCharacterRef) => setMainCharacter(pool, input),
    getEffectiveNickname: (discordGuildId: string, discordUserId: string) =>
      getEffectiveNickname(pool, discordGuildId, discordUserId),
    setCustomNickname: (discordGuildId: string, discordUserId: string, nickname: string) =>
      setCustomNickname(pool, discordGuildId, discordUserId, nickname),
    resetCustomNickname: (discordGuildId: string, discordUserId: string) =>
      resetCustomNickname(pool, discordGuildId, discordUserId),
    createGroup: (input: CreateGroupInput) => createGroup(pool, input),
    renameGroup: (discordGuildId: string, memberGroupId: string, groupName: string) =>
      renameGroup(pool, discordGuildId, memberGroupId, groupName),
    previewMemberGroupRemoval: (discordGuildId: string, memberGroupId: string) =>
      previewMemberGroupRemoval(pool, discordGuildId, memberGroupId),
    removeMemberGroup: (input: RemoveMemberGroupInput) => removeMemberGroup(pool, input),
    listGroups: (discordGuildId: string) => listGroups(pool, discordGuildId),
    getGroup: (discordGuildId: string, memberGroupId: string, albionServer?: AlbionServer) =>
      getMemberGroupById(pool, discordGuildId, memberGroupId, "group", albionServer),
    configureAlbionGuild: (input: ConfigureAlbionGuildInput) => configureAlbionGuild(pool, input),
    updateConfiguredAlbionGuild: (discordGuildId: string, memberGroupId: string, managed: boolean) =>
      updateConfiguredAlbionGuild(pool, discordGuildId, memberGroupId, managed),
    listConfiguredAlbionGuilds: (discordGuildId: string) => listConfiguredAlbionGuilds(pool, discordGuildId),
    getConfiguredAlbionGuild: (discordGuildId: string, memberGroupId: string, albionServer?: AlbionServer) =>
      getConfiguredAlbionGuild(pool, discordGuildId, memberGroupId, albionServer),
    getDefaultAlbionGuild: (discordGuildId: string) => getDefaultAlbionGuild(pool, discordGuildId),
    setDefaultAlbionGuild: (discordGuildId: string, memberGroupId: string, albionServer: AlbionServer) =>
      setDefaultAlbionGuild(pool, discordGuildId, memberGroupId, albionServer),
    clearDefaultAlbionGuild: (discordGuildId: string) => clearDefaultAlbionGuild(pool, discordGuildId),
    configureAlbionAlliance: (input: ConfigureAlbionAllianceInput) => configureAlbionAlliance(pool, input),
    listConfiguredAlbionAlliances: (discordGuildId: string) => listConfiguredAlbionAlliances(pool, discordGuildId),
    getConfiguredAlbionAlliance: (discordGuildId: string, memberGroupId: string, albionServer?: AlbionServer) =>
      getConfiguredAlbionAlliance(pool, discordGuildId, memberGroupId, albionServer),
    listMemberGroups: (discordGuildId: string, albionServer?: AlbionServer) =>
      listMemberGroups(pool, discordGuildId, albionServer),
    getActiveMemberGroupForUser: (discordGuildId: string, memberGroupId: string, discordUserId: string) =>
      getActiveMemberGroupForUser(pool, discordGuildId, memberGroupId, discordUserId),
    addRegisteredProfile: (input: RegisteredProfileInput) => mutateProfileAtomically(pool, input, (client, pending) => addRegisteredProfile(client, input, pending)),
    addOrphanProfile: (input: ProfileInput) => mutateProfileAtomically(pool, input, (client, pending) => addOrphanProfile(client, input, pending)),
    removeCustomGroupProfile: (input: ProfileInput) => removeCustomGroupProfile(pool, input),
    orphanRegisteredProfile: (input: RegisteredProfileInput) => orphanRegisteredProfile(pool, input),
    orphanProfilesNotInCharacterIds: (
      discordGuildId: string,
      memberGroupId: string,
      albionServer: AlbionServer,
      albionCharacterIds: string[]
    ) => orphanProfilesNotInCharacterIds(pool, discordGuildId, memberGroupId, albionServer, albionCharacterIds),
    orphanAutoProfilesForCharacter: (
      discordGuildId: string,
      albionServer: AlbionServer,
      albionCharacterId: string,
      selectedMemberGroupIds: string[],
      qualifiedMemberGroupIds: string[]
    ) => orphanAutoProfilesForCharacter(
      pool,
      discordGuildId,
      albionServer,
      albionCharacterId,
      selectedMemberGroupIds,
      qualifiedMemberGroupIds
    ),
    listProfilesForCharacter: (discordGuildId: string, albionServer: AlbionServer, albionCharacterId: string) =>
      listProfilesForCharacter(pool, discordGuildId, albionServer, albionCharacterId),
    listProfilesForGroups: (discordGuildId: string, memberGroupIds: string[]) =>
      listProfilesForGroups(pool, discordGuildId, memberGroupIds),
    listProfilesForGroupReport: (discordGuildId: string, memberGroupId: string) =>
      listProfilesForGroupReport(pool, discordGuildId, memberGroupId),
    createGroupPosition: (input: CreateGroupPositionInput) => createGroupPosition(pool, input),
    deleteGroupPosition: (discordGuildId: string, memberGroupPositionId: string) =>
      deleteGroupPosition(pool, discordGuildId, memberGroupPositionId),
    getGroupPosition: (discordGuildId: string, memberGroupPositionId: string, memberGroupId?: string) =>
      getGroupPosition(pool, discordGuildId, memberGroupPositionId, memberGroupId),
    listGroupPositions: (discordGuildId: string, memberGroupId?: string) =>
      listGroupPositions(pool, discordGuildId, memberGroupId),
    appointGroupPosition: (discordGuildId: string, memberGroupPositionId: string, memberGroupProfileId: string) =>
      appointGroupPosition(pool, discordGuildId, memberGroupPositionId, memberGroupProfileId),
    dismissGroupPosition: (discordGuildId: string, memberGroupPositionId: string, memberGroupProfileId: string) =>
      dismissGroupPosition(pool, discordGuildId, memberGroupPositionId, memberGroupProfileId),
    listGroupPositionAppointments: (discordGuildId: string, memberGroupId?: string, memberGroupPositionId?: string) =>
      listGroupPositionAppointments(pool, discordGuildId, memberGroupId, memberGroupPositionId),
    listRegisteredUserIdsForGuild: (discordGuildId: string, albionServer?: AlbionServer) =>
      listRegisteredUserIdsForGuild(pool, discordGuildId, albionServer),
    listActiveProfileUserIdsForGroups: (discordGuildId: string, memberGroupIds: string[]) =>
      listActiveProfileUserIdsForGroups(pool, discordGuildId, memberGroupIds),
    addCharacterRoleConfig: (
      discordGuildId: string,
      albionServer: AlbionServer | undefined,
      discordRoleId: string,
    ) => addCharacterRoleConfig(pool, discordGuildId, albionServer, discordRoleId),
    removeCharacterRoleConfig: (discordGuildId: string, albionServer: AlbionServer | undefined, discordRoleId: string) =>
      removeCharacterRoleConfig(pool, discordGuildId, albionServer, discordRoleId),
    listCharacterRoleConfigs: (discordGuildId: string) => listCharacterRoleConfigs(pool, discordGuildId),
    addMemberGroupRoleConfig: (memberGroupId: string, discordRoleId: string) =>
      addMemberGroupRoleConfig(pool, memberGroupId, discordRoleId),
    removeMemberGroupRoleConfig: (discordGuildId: string, memberGroupId: string, discordRoleId?: string) =>
      removeMemberGroupRoleConfig(pool, discordGuildId, memberGroupId, discordRoleId),
    listMemberGroupRoleConfigs: (discordGuildId: string, groupType?: MemberGroupType) =>
      listMemberGroupRoleConfigs(pool, discordGuildId, groupType),
    getRegisteredCharacter: (
      discordGuildId: string,
      albionServer: AlbionServer,
      albionCharacterId: string
    ) => getRegisteredCharacter(pool, discordGuildId, albionServer, albionCharacterId),
    listConfiguredRoleIdsForGuild: (discordGuildId: string) => listConfiguredRoleIdsForGuild(pool, discordGuildId),
    listMembershipRoleIdsForUser: (discordGuildId: string, discordUserId: string) =>
      listMembershipRoleIdsForUser(pool, discordGuildId, discordUserId),
    listQualifiedRoleIdsForUser: (discordGuildId: string, discordUserId: string) =>
      listQualifiedRoleIdsForUser(pool, discordGuildId, discordUserId),
    listDormantReactionRoleSubscriptions: (
      discordGuildId: string,
      discordUserId: string
    ) => listDormantReactionRoleSubscriptions(pool, discordGuildId, discordUserId),
    listSelfServiceCharacters: (discordGuildId: string, discordUserId: string) =>
      listSelfServiceCharacters(pool, discordGuildId, discordUserId),
    listSelfServiceMemberships: (discordGuildId: string, discordUserId: string) =>
      listSelfServiceMemberships(pool, discordGuildId, discordUserId),
    listSelfServicePositions: (discordGuildId: string, discordUserId: string) =>
      listSelfServicePositions(pool, discordGuildId, discordUserId),
    listSelfServiceReactionRoles: (discordGuildId: string, discordUserId: string) =>
      listSelfServiceReactionRoles(pool, discordGuildId, discordUserId),
    isReactionRoleConfigured: async (discordGuildId: string, discordRoleId: string) =>
      (await pool.query(`select 1 from reaction_role_configs where discord_guild_id = $1 and discord_role_id = $2`, [discordGuildId, discordRoleId])).rowCount !== 0
  };
}

async function upsertVerifiedCharacter(
  pool: Queryable,
  server: AlbionServer,
  player: AlbionPlayer
): Promise<void> {
  await pool.query(
    `
    insert into albion_characters (
      albion_server,
      albion_character_id,
      character_name,
      guild_id,
      guild_name,
      alliance_id,
      alliance_name,
      alliance_tag,
      verified_at,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    on conflict (albion_server, albion_character_id) do update set
      character_name = excluded.character_name,
      guild_id = excluded.guild_id,
      guild_name = excluded.guild_name,
      alliance_id = excluded.alliance_id,
      alliance_name = excluded.alliance_name,
      alliance_tag = excluded.alliance_tag,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at
    `,
    [
      server,
      player.id,
      player.name,
      player.guildId ?? null,
      player.guildName ?? null,
      player.allianceId ?? null,
      player.allianceName ?? null,
      player.allianceTag ?? null
    ]
  );
}

async function registerCharacter(
  pool: PostgresPool,
  input: RegisterCharacterInput
): Promise<RegisteredCharacter> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await lockMemberAccess(client, input.discordGuildId, input.discordUserId);
    await assertMemberAccessAllowed(client, input.discordGuildId, input.discordUserId);
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    await assertRegistrationLifecycleAllowed(client, { discordGuildId: input.discordGuildId, albionServer: input.albionServer, albionCharacterId: input.player.id });
    await assertCharacterRegistrationCapacity(client, input);
    await upsertVerifiedCharacter(client, input.albionServer, input.player);
    const result = await client.query<RegisteredCharacterRow & { log_inserted?: boolean }>(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id,
        updated_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (discord_guild_id, discord_user_id, albion_server, albion_character_id) do update set
        updated_at = excluded.updated_at
      returning discord_guild_id, discord_user_id, albion_server, albion_character_id
        ${isLogCaptureActive(input.discordGuildId) ? ", (xmax = 0) as log_inserted" : ""}
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.player.id]
    );
    await client.query("commit");
    const character = mapRegisteredCharacter(result.rows[0], input.player.name);
    if (result.rows[0].log_inserted) recordLogChange(input.discordGuildId, { kind: "registration", action: "registered", character });
    return character;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isCharacterOwnerUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && "constraint" in error
    && error.code === "23505"
    && error.constraint === CHARACTER_OWNER_UNIQUE_INDEX;
}

async function registerCharacterAndAdoptOrphans(
  pool: PostgresPool,
  input: RegisterCharacterInput
): Promise<RegisteredCharacter> {
  const client = await pool.connect();
  const changes: LogChange[] = [];

  try {
    await client.query("begin");
    await lockMemberAccess(client, input.discordGuildId, input.discordUserId, true);
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    await prepareKickRecovery(client, input);
    await prepareOfficerRecovery(client, { discordGuildId: input.discordGuildId, albionServer: input.albionServer, albionCharacterId: input.player.id }, input.recovery);
    await assertCharacterRegistrationCapacity(client, input);
    await upsertVerifiedCharacter(client, input.albionServer, input.player);
    const result = await client.query<RegisteredCharacterRow & { log_inserted?: boolean }>(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id,
        updated_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (discord_guild_id, discord_user_id, albion_server, albion_character_id) do update set
        updated_at = excluded.updated_at
      returning discord_guild_id, discord_user_id, albion_server, albion_character_id
        ${isLogCaptureActive(input.discordGuildId) ? ", (xmax = 0) as log_inserted" : ""}
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.player.id]
    );
    await adoptOrphanProfiles(client, input, changes);
    // Persist positive verification in the recovery transaction; later Discord
    // presentation failures must not strand an otherwise recovered character.
    for (const memberGroupId of [...new Set(input.recovery?.verifiedMemberGroupIds ?? [])]) {
      const target = await client.query(`select 1 from member_groups where discord_guild_id = $1 and albion_server = $2 and member_group_id = $3 and group_type in ('guild', 'alliance') for key share`, [input.discordGuildId, input.albionServer, memberGroupId]);
      if (target.rowCount !== 1) throw new MembershipLifecycleConflictError();
      await addRegisteredProfile(client, { memberGroupId, discordGuildId: input.discordGuildId, discordUserId: input.discordUserId, albionServer: input.albionServer, albionCharacterId: input.player.id }, changes);
    }
    await client.query("commit");
    const character = mapRegisteredCharacter(result.rows[0], input.player.name);
    if (result.rows[0].log_inserted) recordLogChange(input.discordGuildId, { kind: "registration", action: "registered", character });
    for (const change of changes) recordLogChange(input.discordGuildId, change);
    return character;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (isCharacterOwnerUniqueViolation(error)) throw new CharacterAlreadyRegisteredError();
    throw error;
  } finally {
    client.release();
  }
}

/** The officer command supplies snapshots taken before any external verification. */
async function prepareKickRecovery(client: Queryable, input: RegisterCharacterInput): Promise<void> {
  const ref = { discordGuildId: input.discordGuildId, albionServer: input.albionServer, albionCharacterId: input.player.id };
  await lockCharacterEntitlements(client, ref);
  const access = (await client.query(`select * from guild_member_access
    where discord_guild_id = $1 and discord_user_id = $2 for update`, [input.discordGuildId, input.discordUserId])).rows[0];
  const kick = (await client.query(`select k.*, a.cleanup_pending as source_cleanup_pending, a.revoked_role_ids as source_revoked_role_ids
    from character_kick_recovery k left join guild_member_access a
      on a.discord_guild_id = k.discord_guild_id and a.discord_user_id = k.disconnected_discord_user_id
    where k.discord_guild_id = $1 and k.albion_server = $2 and k.albion_character_id = $3 for update of k`,
  [input.discordGuildId, input.albionServer, input.player.id])).rows[0];
  if ((access ? Number(access.revision) : null) !== (input.recovery?.expectedMemberAccessRevision ?? null)
    || (kick ? Number(kick.revision) : null) !== (input.recovery?.expectedCharacterKickRevision ?? null)) {
    throw new MembershipLifecycleConflictError();
  }
  if (access?.cleanup_pending || (kick?.recovery_required && kick.source_cleanup_pending)) throw new KickCleanupPendingError();
  // Clear under the transaction before the registration guard runs. Any failed
  // ownership/membership verification rolls the unblock and the registration back.
  if (access?.blocked) await client.query(`update guild_member_access set blocked = false,
    revision = nextval('membership_lifecycle_revision_seq'), updated_at = now()
    where discord_guild_id = $1 and discord_user_id = $2`, [input.discordGuildId, input.discordUserId]);
  if (access?.blocked || kick?.recovery_required) {
    // Authority may have changed while disconnected. Include live configured
    // authority and the officer's fresh Discord snapshot, as well as the source
    // member's suppression when a replacement user recovers the character.
    const authorityRoleIds = [...new Set([
      ...await createKickRolesRepository(client).listAuthorityRoleIds(input.discordGuildId),
      ...(input.recovery?.kickAuthorityRoleIds ?? []),
      ...(kick?.recovery_required ? kick.source_revoked_role_ids ?? [] : [])
    ])];
    if (authorityRoleIds.length) await client.query(`insert into guild_member_access
      (discord_guild_id, discord_user_id, blocked, cleanup_pending, revoked_role_ids)
      values ($1, $2, false, false, $3)
      on conflict (discord_guild_id, discord_user_id) do update set
        revoked_role_ids = array(select distinct role_id from unnest(guild_member_access.revoked_role_ids || excluded.revoked_role_ids) role_id order by role_id),
        revision = nextval('membership_lifecycle_revision_seq'), updated_at = now()`,
    [input.discordGuildId, input.discordUserId, authorityRoleIds]);
  }
  if (kick?.recovery_required) await client.query(`update character_kick_recovery set recovery_required = false,
    revision = nextval('membership_lifecycle_revision_seq'), updated_at = now()
    where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3`,
  [input.discordGuildId, input.albionServer, input.player.id]);
}

/**
 * Commits the application decision with the required registration and optional
 * membership-profile write. Albion and Discord work must already be complete.
 */
async function completeApplicationAcceptance(
  pool: PostgresPool,
  input: CompleteApplicationAcceptanceInput
): Promise<RegisteredCharacter | undefined> {
  const client = await pool.connect();
  const changes: LogChange[] = [];

  try {
    await client.query("begin");
    await lockMemberAccess(client, input.discordGuildId, input.discordUserId);
    await assertMemberAccessAllowed(client, input.discordGuildId, input.discordUserId);
    // Server reset takes the tenant lock before application/group rows too.
    await lockMembershipLifecycleTenant(client, input.discordGuildId);
    if (!await lockOperationalApplicationAcceptanceTarget(client, input)) {
      await client.query("commit");
      return undefined;
    }
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    await assertRegistrationLifecycleAllowed(client, { discordGuildId: input.discordGuildId, albionServer: input.albionServer, albionCharacterId: input.player.id });
    await assertCharacterRegistrationCapacity(client, input);
    await upsertVerifiedCharacter(client, input.albionServer, input.player);
    const result = await client.query<RegisteredCharacterRow & { log_inserted?: boolean }>(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id,
        updated_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (discord_guild_id, discord_user_id, albion_server, albion_character_id) do update set
        updated_at = excluded.updated_at
      returning discord_guild_id, discord_user_id, albion_server, albion_character_id
        ${isLogCaptureActive(input.discordGuildId) ? ", (xmax = 0) as log_inserted" : ""}
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.player.id]
    );
    await adoptOrphanProfiles(client, input, changes);
    if (input.memberGroupId) {
      await addRegisteredProfile(client, {
        memberGroupId: input.memberGroupId,
        discordGuildId: input.discordGuildId,
        discordUserId: input.discordUserId,
        albionServer: input.albionServer,
        albionCharacterId: input.player.id
      }, changes);
    }
    const accepted = await client.query(
      `
      update open_applications
      set status = 'accepted',
        reviewer_discord_user_id = $3,
        accepted_at = coalesce(accepted_at, now()),
        updated_at = now()
      where discord_guild_id = $1
        and application_id = $2
        and status = $4
        and channel_status = 'open'
      `,
      [input.discordGuildId, input.applicationId, input.reviewerDiscordUserId, input.expectedApplicationStatus]
    );
    if ((accepted.rowCount ?? 0) !== 1) {
      await client.query("rollback");
      return undefined;
    }
    await client.query("commit");
    const character = mapRegisteredCharacter(result.rows[0], input.player.name);
    if (result.rows[0].log_inserted) recordLogChange(input.discordGuildId, { kind: "registration", action: "registered", character });
    for (const change of changes) recordLogChange(input.discordGuildId, change);
    return character;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (isCharacterOwnerUniqueViolation(error)) throw new CharacterAlreadyRegisteredError();
    throw error;
  } finally {
    client.release();
  }
}

async function lockOperationalApplicationAcceptanceTarget(
  client: Queryable,
  input: CompleteApplicationAcceptanceInput
): Promise<boolean> {
  if (input.memberGroupId) {
    const memberGroup = await client.query(
      `
      select 1
      from member_groups
      where discord_guild_id = $1
        and member_group_id = $2
        and albion_server = $3
      for update
      `,
      [input.discordGuildId, input.memberGroupId, input.albionServer]
    );
    if ((memberGroup.rowCount ?? 0) !== 1) return false;
  }

  const application = await client.query(
    `
    select 1
    from open_applications open_application
    join application_classes application_class
      on application_class.discord_guild_id = open_application.discord_guild_id
      and application_class.application_class_id = open_application.application_class_id
    where open_application.discord_guild_id = $1
      and open_application.application_id = $2
      and open_application.status = $3
      and open_application.channel_status = 'open'
      and application_class.archived_at is null
      and application_class.albion_server = $5
      and (
        (
          $4::bigint is null
          and application_class.outcome_type = 'register_character'
          and application_class.member_group_id is null
        )
        or (
          $4::bigint is not null
          and application_class.outcome_type = 'member_group'
          and application_class.member_group_id = $4
        )
      )
    for update of application_class, open_application
    `,
    [
      input.discordGuildId,
      input.applicationId,
      input.expectedApplicationStatus,
      input.memberGroupId ?? null,
      input.albionServer
    ]
  );
  return (application.rowCount ?? 0) === 1;
}

async function assertCharacterRegistrationCapacity(
  client: Queryable,
  input: RegisterCharacterInput
): Promise<void> {
  await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
  const capacity = await client.query<{ already_registered: boolean; registration_count: string }>(
    `
    select
      exists (
        select 1
        from discord_user_characters
        where discord_guild_id = $1
          and discord_user_id = $2
          and albion_server = $3
          and albion_character_id = $4
      ) as already_registered,
      (
        select count(*)::text
        from discord_user_characters
        where discord_guild_id = $1
          and discord_user_id = $2
      ) as registration_count
    `,
    [input.discordGuildId, input.discordUserId, input.albionServer, input.player.id]
  );
  const row = capacity.rows[0];
  if (!row?.already_registered && Number.parseInt(row?.registration_count ?? "0", 10) >= MAX_REGISTERED_CHARACTERS_PER_USER) {
    throw new CharacterRegistrationLimitError();
  }
}

async function lockCharacterRegistrationHierarchy(
  client: Queryable,
  discordGuildId: string,
  discordUserId: string
): Promise<void> {
  await lockMembershipLifecycleTenant(client, discordGuildId);
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`character-registration:${discordGuildId}:${discordUserId}`]
  );
}

async function switchRegisteredCharacter(
  pool: PostgresPool,
  input: SwitchRegisteredCharacterInput
): Promise<SwitchRegisteredCharacterResult> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await lockMemberAccess(client, input.discordGuildId, input.discordUserId);
    await assertMemberAccessAllowed(client, input.discordGuildId, input.discordUserId);
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    for (const ref of [
      { discordGuildId: input.discordGuildId, albionServer: input.fromAlbionServer, albionCharacterId: input.fromAlbionCharacterId },
      { discordGuildId: input.discordGuildId, albionServer: input.toAlbionServer, albionCharacterId: input.player.id }
    ].sort((a, b) => `${a.albionServer}:${a.albionCharacterId}`.localeCompare(`${b.albionServer}:${b.albionCharacterId}`))) {
      await assertRegistrationLifecycleAllowed(client, ref);
    }
    await upsertVerifiedCharacter(client, input.toAlbionServer, input.player);

    const from = await getRegisteredCharacterForUser(
      client,
      input.discordGuildId,
      input.discordUserId,
      input.fromAlbionServer,
      input.fromAlbionCharacterId
    );
    if (!from) {
      await client.query("rollback");
      return { switchedProfiles: 0, mergedOrphanProfiles: 0 };
    }

    if (input.fromAlbionServer === input.toAlbionServer && input.fromAlbionCharacterId === input.player.id) {
      await client.query("rollback");
      return {
        from,
        to: from,
        switchedProfiles: 0,
        mergedOrphanProfiles: 0
      };
    }

    const existing = await getRegisteredCharacter(client, input.discordGuildId, input.toAlbionServer, input.player.id);
    if (existing) {
      await client.query("rollback");
      return {
        from,
        existing,
        switchedProfiles: 0,
        mergedOrphanProfiles: 0
      };
    }

    const switchedProfileCount = await countProfilesForCharacter(
      client,
      input.discordGuildId,
      input.fromAlbionServer,
      input.fromAlbionCharacterId
    );

    const mergedOrphanProfiles = await client.query(
      `
      delete from member_group_profiles target
      using member_group_profiles source
      where source.discord_guild_id = $1
        and source.discord_user_id = $2
        and source.albion_server = $3
        and source.albion_character_id = $4
        and target.discord_guild_id = source.discord_guild_id
        and target.member_group_id = source.member_group_id
        and target.discord_user_id is null
        and target.albion_server = $5
        and target.albion_character_id = $6
      `,
      [
        input.discordGuildId,
        input.discordUserId,
        input.fromAlbionServer,
        input.fromAlbionCharacterId,
        input.toAlbionServer,
        input.player.id
      ]
    );

    const result = await client.query<RegisteredCharacterRow>(
      `
      update discord_user_characters
      set albion_server = $5,
        albion_character_id = $6,
        updated_at = now()
      where discord_guild_id = $1
        and discord_user_id = $2
        and albion_server = $3
        and albion_character_id = $4
      returning discord_guild_id, discord_user_id, albion_server, albion_character_id
      `,
      [
        input.discordGuildId,
        input.discordUserId,
        input.fromAlbionServer,
        input.fromAlbionCharacterId,
        input.toAlbionServer,
        input.player.id
      ]
    );

    await client.query("commit");
    recordLogChange(input.discordGuildId, { kind: "switch", from, to: mapRegisteredCharacter(result.rows[0], input.player.name) });
    return {
      from,
      to: mapRegisteredCharacter(result.rows[0], input.player.name),
      switchedProfiles: switchedProfileCount,
      mergedOrphanProfiles: mergedOrphanProfiles.rowCount ?? 0
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function listRegisteredCharacters(
  pool: Queryable,
  discordGuildId: string,
  discordUserId?: string
): Promise<RegisteredCharacter[]> {
  const result = await pool.query<RegisteredCharacterRow & { character_name: string }>(
    `
    select
      duc.discord_guild_id,
      duc.discord_user_id,
      duc.albion_server,
      duc.albion_character_id,
      ac.character_name
    from discord_user_characters duc
    join albion_characters ac
      on ac.albion_server = duc.albion_server
      and ac.albion_character_id = duc.albion_character_id
    where duc.discord_guild_id = $1
      and ($2::text is null or duc.discord_user_id = $2)
    order by duc.registration_order asc
    `,
    [discordGuildId, discordUserId ?? null]
  );
  return result.rows.map((row) => mapRegisteredCharacter(row, row.character_name));
}

async function listRegisteredCharactersByName(
  pool: Queryable,
  discordGuildId: string,
  characterName: string,
  discordUserId?: string
): Promise<RegisteredCharacter[]> {
  const result = await pool.query<RegisteredCharacterRow & { character_name: string }>(
    `
    select
      duc.discord_guild_id,
      duc.discord_user_id,
      duc.albion_server,
      duc.albion_character_id,
      ac.character_name
    from discord_user_characters duc
    join albion_characters ac
      on ac.albion_server = duc.albion_server
      and ac.albion_character_id = duc.albion_character_id
    where duc.discord_guild_id = $1
      and lower(ac.character_name) = lower($2)
      and ($3::text is null or duc.discord_user_id = $3)
    order by ac.character_name asc, duc.albion_server asc, duc.albion_character_id asc
    `,
    [discordGuildId, characterName.trim(), discordUserId ?? null]
  );
  return result.rows.map((row) => mapRegisteredCharacter(row, row.character_name));
}

async function listKnownCharactersForGuild(pool: Queryable, discordGuildId: string): Promise<CharacterRecord[]> {
  const result = await pool.query<CharacterRecordRow>(
    `
    select distinct ac.albion_server, ac.albion_character_id, ac.character_name, ac.guild_name, ac.alliance_name
    from albion_characters ac
    where exists (
      select 1
      from discord_user_characters duc
      where duc.discord_guild_id = $1
        and duc.albion_server = ac.albion_server
        and duc.albion_character_id = ac.albion_character_id
    )
    or exists (
      select 1
      from member_group_profiles mgp
      where mgp.discord_guild_id = $1
        and mgp.albion_server = ac.albion_server
        and mgp.albion_character_id = ac.albion_character_id
    )
    or exists (select 1 from member_registration_lifecycle local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from character_kick_recovery local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from character_registration_history local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from character_accounts local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from regear_claims local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from specialisation_requests local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    or exists (select 1 from character_specialisations local_state where local_state.discord_guild_id = $1
      and local_state.albion_server = ac.albion_server and local_state.albion_character_id = ac.albion_character_id)
    order by ac.character_name asc, ac.albion_server asc, ac.albion_character_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapCharacterRecord);
}

async function getRegisteredCharacterForUser(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<RegisteredCharacter | undefined> {
  const characters = await listRegisteredCharacters(pool, discordGuildId, discordUserId);
  return characters.find((character) =>
    character.albionServer === albionServer && character.albionCharacterId === albionCharacterId
  );
}

async function hasOrphanProfilesForCharacter(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    select 1
    from member_group_profiles
    where discord_guild_id = $1
      and discord_user_id is null
      and albion_server = $2
      and albion_character_id = $3
    limit 1
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function getRegisteredCharacter(
  pool: Queryable,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<RegisteredCharacter | undefined> {
  const result = await pool.query<RegisteredCharacterRow & { character_name: string }>(
    `
    select
      duc.discord_guild_id,
      duc.discord_user_id,
      duc.albion_server,
      duc.albion_character_id,
      ac.character_name
    from discord_user_characters duc
    join albion_characters ac
      on ac.albion_server = duc.albion_server
      and ac.albion_character_id = duc.albion_character_id
    where duc.discord_guild_id = $1
      and duc.albion_server = $2
      and duc.albion_character_id = $3
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );

  const row = result.rows[0];
  return row ? mapRegisteredCharacter(row, row.character_name) : undefined;
}

async function countProfilesForCharacter(
  pool: Queryable,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<number> {
  const result = await pool.query<{ profile_count: string }>(
    `
    select count(*)::text as profile_count
    from member_group_profiles
    where discord_guild_id = $1
      and albion_server = $2
      and albion_character_id = $3
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return Number.parseInt(result.rows[0]?.profile_count ?? "0", 10);
}

async function getCharacterRecord(
  pool: Queryable,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<CharacterRecord | undefined> {
  const result = await pool.query<CharacterRecordRow>(
    `
    select albion_server, albion_character_id, character_name, guild_name, alliance_name
    from albion_characters
    where albion_server = $1
      and albion_character_id = $2
    `,
    [albionServer, albionCharacterId]
  );
  const row = result.rows[0];
  return row ? mapCharacterRecord(row) : undefined;
}

async function unregisterCharacter(pool: PostgresPool, input: RegisteredCharacterRef): Promise<RegisteredCharacter | undefined> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    await lockCharacterEntitlements(client, input);
    const affectedProfiles = isLogCaptureActive(input.discordGuildId)
      ? await lockRegistrationProfiles(client, "discord_guild_id = $1 and discord_user_id = $2 and albion_server = $3 and albion_character_id = $4", [input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]) : [];
    const existing = await getRegisteredCharacterForUser(client, input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId);
    if (!existing) {
      await client.query("rollback");
      return undefined;
    }
    await client.query(`update member_group_profiles set lifecycle_state = case when lifecycle_state = 'departed' then lifecycle_state else 'manual' end, previous_discord_user_id = discord_user_id where discord_guild_id = $1 and discord_user_id = $2 and albion_server = $3 and albion_character_id = $4`, [input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]);
    const deleted = await client.query(
      `
      delete from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
        and albion_server = $3
        and albion_character_id = $4
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]
    );
    await client.query("commit");
    if ((deleted.rowCount ?? 0) > 0) {
      recordLogChange(input.discordGuildId, { kind: "registration", action: "unregistered", character: existing });
      for (const profile of affectedProfiles) recordLogChange(input.discordGuildId, { kind: "profile", action: "orphaned", profile });
    }
    return existing;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function kickUser(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string,
  revokedRoleIds: readonly string[],
  actorDiscordUserId?: string
): Promise<RegisteredCharacter[]> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await lockMemberAccess(client, discordGuildId, discordUserId, true);
    await lockCharacterRegistrationHierarchy(client, discordGuildId, discordUserId);
    const cleanupRoleIds = [...new Set([...await listConfiguredRoleIdsForGuild(client, discordGuildId), ...revokedRoleIds])];
    await client.query(`insert into guild_member_access
      (discord_guild_id, discord_user_id, revoked_role_ids, cleanup_role_ids, last_kicked_at) values ($1, $2, $3, $4, now())
      on conflict (discord_guild_id, discord_user_id) do update set blocked = true, cleanup_pending = true, last_kicked_at = now(),
        revoked_role_ids = array(select distinct role_id from unnest(guild_member_access.revoked_role_ids || excluded.revoked_role_ids) role_id order by role_id),
        cleanup_role_ids = array(select distinct role_id from unnest(guild_member_access.cleanup_role_ids || excluded.cleanup_role_ids) role_id order by role_id),
        revision = nextval('membership_lifecycle_revision_seq'), updated_at = now()`, [discordGuildId, discordUserId, revokedRoleIds, cleanupRoleIds]);
    const registered = await listRegisteredCharacters(client, discordGuildId, discordUserId);
    // Current ownership wins; otherwise only this user's latest ownership or
    // reliable ownerless state is revoked. Earlier owners cannot affect a successor.
    const candidates = await client.query<RegisteredCharacterRow & { character_name: string }>(`
      with candidates as (
        select albion_server, albion_character_id from discord_user_characters where discord_guild_id = $1 and discord_user_id = $2
        union select albion_server, albion_character_id from member_group_profiles where discord_guild_id = $1 and previous_discord_user_id = $2 and discord_user_id is null
        union select albion_server, albion_character_id from member_registration_lifecycle where discord_guild_id = $1 and previous_discord_user_id = $2 and state <> 'purged'
        union select albion_server, albion_character_id from character_registration_history where discord_guild_id = $1 and discord_user_id = $2
        union select albion_server, albion_character_id from character_kick_recovery where discord_guild_id = $1 and disconnected_discord_user_id = $2 and recovery_required
      )
      select $1::text as discord_guild_id, $2::text as discord_user_id, c.albion_server, c.albion_character_id, c.character_name
      from candidates candidate join albion_characters c using (albion_server, albion_character_id)
      left join discord_user_characters current_owner on current_owner.discord_guild_id = $1
        and current_owner.albion_server = candidate.albion_server and current_owner.albion_character_id = candidate.albion_character_id
      left join lateral (select h.discord_user_id from character_registration_history h where h.discord_guild_id = $1
        and h.albion_server = candidate.albion_server and h.albion_character_id = candidate.albion_character_id
        order by h.registered_at desc limit 1) last_owner on true
      where (current_owner.discord_user_id = $2 or (current_owner.discord_user_id is null
        and (last_owner.discord_user_id = $2 or last_owner.discord_user_id is null)))
        and not exists (select 1 from member_registration_lifecycle lifecycle
          where lifecycle.discord_guild_id = $1 and lifecycle.albion_server = candidate.albion_server
            and lifecycle.albion_character_id = candidate.albion_character_id and lifecycle.state = 'purged')
      order by c.albion_server, c.albion_character_id`, [discordGuildId, discordUserId]);
    const characters = candidates.rows.map(row => mapRegisteredCharacter(row, row.character_name));
    for (const ref of characters) await lockCharacterEntitlements(client, ref);
    const affectedProfiles = isLogCaptureActive(discordGuildId)
      ? await lockRegistrationProfiles(client, "discord_guild_id = $1 and discord_user_id = $2", [discordGuildId, discordUserId]) : [];
    for (const ref of characters) {
      const values = [discordGuildId, ref.albionServer, ref.albionCharacterId];
      await client.query(`insert into character_kick_recovery
        (discord_guild_id, albion_server, albion_character_id, disconnected_discord_user_id) values ($1, $2, $3, $4)
        on conflict (discord_guild_id, albion_server, albion_character_id) do update set recovery_required = true,
          disconnected_discord_user_id = excluded.disconnected_discord_user_id,
          revision = nextval('membership_lifecycle_revision_seq'), updated_at = now()`, [...values, discordUserId]);
      await client.query(`delete from member_group_profiles where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3`, values);
      await client.query(`delete from member_registration_lifecycle where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3`, values);
    }
    const deleted = await client.query(
      `
      delete from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
      `,
      [discordGuildId, discordUserId]
    );
    await client.query("delete from reaction_role_subscriptions where discord_guild_id = $1 and discord_user_id = $2", [discordGuildId, discordUserId]);
    await client.query("delete from discord_user_custom_nicknames where discord_guild_id = $1 and discord_user_id = $2", [discordGuildId, discordUserId]);
    await revokeKickActivities(client, discordGuildId, discordUserId, actorDiscordUserId);
    await client.query("commit");
    recordLogChange(discordGuildId, { kind: "memberBlocked", discordUserId });
    if ((deleted.rowCount ?? 0) > 0) {
      for (const character of registered) recordLogChange(discordGuildId, { kind: "registration", action: "unregistered", character });
      for (const profile of affectedProfiles) recordLogChange(discordGuildId, { kind: "profile", action: "removed", profile });
    }
    return registered;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setMainCharacter(pool: PostgresPool, input: RegisteredCharacterRef): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    await lockMemberAccess(client, input.discordGuildId, input.discordUserId);
    await assertMemberAccessAllowed(client, input.discordGuildId, input.discordUserId);
    await lockCharacterRegistrationHierarchy(client, input.discordGuildId, input.discordUserId);
    await client.query(
      `
      with hierarchy as (
        select min(registration_order) as first_order
        from discord_user_characters
        where discord_guild_id = $1
          and discord_user_id = $2
      )
      update discord_user_characters registration
      set registration_order = hierarchy.first_order - 1,
        updated_at = now()
      from hierarchy
      where registration.discord_guild_id = $1
        and registration.discord_user_id = $2
        and registration.albion_server = $3
        and registration.albion_character_id = $4
        and registration.registration_order <> hierarchy.first_order
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]
    );
    await client.query(
      `
      insert into discord_user_main_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id,
        selected_at
      )
      values ($1, $2, $3, $4, now())
      on conflict (discord_guild_id, discord_user_id) do update set
        albion_server = excluded.albion_server,
        albion_character_id = excluded.albion_character_id,
        selected_at = excluded.selected_at
      `,
      [input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setCustomNickname(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string,
  nickname: string
): Promise<void> {
  await pool.query(
    `
    insert into discord_user_custom_nicknames (discord_guild_id, discord_user_id, nickname, updated_at)
    values ($1, $2, $3, now())
    on conflict (discord_guild_id, discord_user_id) do update set
      nickname = excluded.nickname,
      updated_at = excluded.updated_at
    `,
    [discordGuildId, discordUserId, nickname]
  );
}

async function resetCustomNickname(pool: PostgresPool, discordGuildId: string, discordUserId: string): Promise<void> {
  await pool.query(
    "delete from discord_user_custom_nicknames where discord_guild_id = $1 and discord_user_id = $2",
    [discordGuildId, discordUserId]
  );
}

async function getEffectiveNickname(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<string | undefined> {
  const result = await pool.query<{ nickname: string | null; character_name: string | null }>(
    `
    select
      ducn.nickname,
      ac.character_name
    from (select $1::text as discord_guild_id, $2::text as discord_user_id) scope
    left join discord_user_custom_nicknames ducn
      on ducn.discord_guild_id = scope.discord_guild_id
      and ducn.discord_user_id = scope.discord_user_id
    left join discord_user_main_characters dumc
      on dumc.discord_guild_id = scope.discord_guild_id
      and dumc.discord_user_id = scope.discord_user_id
    left join albion_characters ac
      on ac.albion_server = dumc.albion_server
      and ac.albion_character_id = dumc.albion_character_id
    `,
    [discordGuildId, discordUserId]
  );
  const row = result.rows[0];
  return row?.nickname ?? row?.character_name ?? undefined;
}

async function createGroup(pool: PostgresPool, input: CreateGroupInput): Promise<MemberGroup> {
  const result = await pool.query<MemberGroupRow>(
    `
    insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
    values ($1, $2, 'group', $3)
    returning member_group_id, discord_guild_id, albion_server, group_type, group_name
    `,
    [input.discordGuildId, input.albionServer, input.groupName]
  );
  return mapMemberGroup(result.rows[0]);
}

async function renameGroup(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  groupName: string
): Promise<MemberGroup | undefined> {
  const result = await pool.query<MemberGroupRow>(
    `
    update member_groups
    set group_name = $3, updated_at = now()
    where discord_guild_id = $1
      and member_group_id = $2
      and group_type = 'group'
    returning member_group_id, discord_guild_id, albion_server, group_type, group_name
    `,
    [discordGuildId, memberGroupId, groupName]
  );
  const row = result.rows[0];
  return row ? mapMemberGroup(row) : undefined;
}

async function previewMemberGroupRemoval(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string
): Promise<MemberGroupRemovalPreview | undefined> {
  return readMemberGroupRemovalPreview(pool, discordGuildId, memberGroupId, false);
}

async function removeMemberGroup(
  pool: PostgresPool,
  input: RemoveMemberGroupInput
): Promise<MemberGroupRemovalResult | undefined> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const preview = await readMemberGroupRemovalPreview(
      client,
      input.discordGuildId,
      input.memberGroupId,
      true
    );
    if (!preview) {
      await client.query("commit");
      return undefined;
    }

    if (isLogCaptureActive(input.discordGuildId)) {
      // The already locked group blocks new child references; lock retained
      // profiles too so concurrent deletion/orphaning cannot stale the summary.
      const profiles = await client.query<{ discord_user_id: string | null }>(
        "select discord_user_id from member_group_profiles where discord_guild_id = $1 and member_group_id = $2 for update",
        [input.discordGuildId, input.memberGroupId]);
      preview.totalMembershipProfiles = profiles.rows.length;
      preview.ownedMembershipProfiles = profiles.rows.filter(row => row.discord_user_id !== null).length;
      preview.orphanedMembershipProfiles = profiles.rows.length - preview.ownedMembershipProfiles;
      preview.affectedDiscordUserIds = distinct(profiles.rows.map(row => row.discord_user_id).filter(isNonEmptyString));
    }

    const applicationClasses = await client.query<ApplicationClassRemovalRow>(
      `
      select
        c.application_class_id,
        c.source_channel_id,
        c.source_message_id,
        c.reviewer_role_id,
        c.active_role_id
      from application_classes c
      where c.discord_guild_id = $1
        and c.member_group_id = $2
        and c.archived_at is null
      order by c.application_class_id asc
      for update of c
      `,
      [input.discordGuildId, input.memberGroupId]
    );
    const applicationClassIds = applicationClasses.rows.map((row) => row.application_class_id);
    const retainedApplicationClassIds = applicationClassIds.length === 0
      ? new Set<string>()
      : new Set((await client.query<{ application_class_id: string }>(
        `
        select distinct application_class_id
        from open_applications
        where discord_guild_id = $1
          and application_class_id = any($2::bigint[])
        `,
        [input.discordGuildId, applicationClassIds]
      )).rows.map((row) => row.application_class_id));
    const archivedClasses = applicationClasses.rows.filter((row) => retainedApplicationClassIds.has(row.application_class_id));
    const deletedClasses = applicationClasses.rows.filter((row) => !retainedApplicationClassIds.has(row.application_class_id));
    const archivedApplicationClassIds = archivedClasses.map((row) => row.application_class_id);
    const deletedApplicationClassIds = deletedClasses.map((row) => row.application_class_id);

    let archivedApplications: ArchivedApplicationTarget[] = [];
    if (archivedApplicationClassIds.length > 0) {
      const applications = await client.query<ArchivedApplicationRemovalRow>(
        `
        with targets as materialized (
          select
            oa.application_id,
            oa.application_class_id,
            oa.applicant_discord_user_id,
            oa.ticket_channel_id,
            oa.channel_status,
            c.reviewer_role_id,
            c.active_role_id
          from open_applications oa
          join application_classes c
            on c.discord_guild_id = oa.discord_guild_id
            and c.application_class_id = oa.application_class_id
          where oa.discord_guild_id = $1
            and oa.application_class_id = any($2::bigint[])
          order by oa.application_id asc
          for update of oa
        ), closed as (
          update open_applications oa
          set channel_status = 'closed',
            closed_at = now(),
            closed_by_discord_user_id = $3,
            updated_at = now()
          from targets
          where oa.discord_guild_id = $1
            and oa.application_id = targets.application_id
            and targets.channel_status = 'open'
          returning oa.application_id
        )
        select
          targets.*,
          (closed.application_id is not null) as channel_closed_by_removal
        from targets
        left join closed on closed.application_id = targets.application_id
        order by targets.application_id asc
        `,
        [input.discordGuildId, archivedApplicationClassIds, input.archivedByDiscordUserId]
      );
      archivedApplications = applications.rows.map(mapArchivedApplicationTarget);

      await client.query(
        `
        update application_classes
        set enabled = false,
          member_group_id = null,
          source_channel_id = null,
          source_message_id = null,
          button_label = null,
          button_style = null,
          archived_at = now(),
          archived_by_discord_user_id = $3,
          archive_reason = 'member_group_removed',
          archived_member_group_id = $2,
          archived_member_group_type = $4,
          archived_member_group_name = $5,
          archived_albion_entity_id = $6,
          archived_albion_alliance_tag = $7,
          updated_at = now()
        where discord_guild_id = $1
          and application_class_id = any($8::bigint[])
        `,
        [
          input.discordGuildId,
          input.memberGroupId,
          input.archivedByDiscordUserId,
          preview.memberGroup.groupType,
          preview.memberGroup.groupName,
          preview.albionEntityId ?? null,
          preview.albionAllianceTag ?? null,
          archivedApplicationClassIds
        ]
      );
    }

    if (deletedApplicationClassIds.length > 0) {
      await client.query(
        `
        delete from application_classes
        where discord_guild_id = $1
          and application_class_id = any($2::bigint[])
        `,
        [input.discordGuildId, deletedApplicationClassIds]
      );
    }

    const deletedGroup = await client.query(
      `
      delete from member_groups
      where discord_guild_id = $1
        and member_group_id = $2
      `,
      [input.discordGuildId, input.memberGroupId]
    );
    if ((deletedGroup.rowCount ?? 0) !== 1) {
      throw new Error("The locked member group could not be removed.");
    }

    await client.query("commit");
    const result: MemberGroupRemovalResult = {
      ...preview,
      archivedApplicationClassCount: archivedClasses.length,
      deletedApplicationClassCount: deletedClasses.length,
      archivedApplicationClassIds,
      deletedApplicationClassIds,
      archivedApplicationIds: archivedApplications.map((application) => application.applicationId),
      archivedApplicationClasses: archivedClasses.map(mapArchivedApplicationClassTarget),
      deletedApplicationClasses: deletedClasses.map(mapArchivedApplicationClassTarget),
      archivedApplications
    };
    recordLogChange(input.discordGuildId, { kind: "groupRemoved", result });
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function readMemberGroupRemovalPreview(
  pool: Queryable,
  discordGuildId: string,
  memberGroupId: string,
  lock: boolean
): Promise<MemberGroupRemovalPreview | undefined> {
  const groupResult = await pool.query<MemberGroupRemovalRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      cag.albion_guild_id,
      caa.albion_alliance_id,
      caa.albion_alliance_tag
    from member_groups mg
    left join configured_albion_guilds cag on cag.member_group_id = mg.member_group_id
    left join configured_albion_alliances caa on caa.member_group_id = mg.member_group_id
    where mg.discord_guild_id = $1
      and mg.member_group_id = $2
    ${lock ? "for update of mg" : ""}
    `,
    [discordGuildId, memberGroupId]
  );
  const group = groupResult.rows[0];
  if (!group) return undefined;

  const [profileResult, roleResult] = await Promise.all([
    pool.query<MemberGroupRemovalProfileSummaryRow>(
      `
      select
        count(*)::text as total_membership_profiles,
        count(*) filter (where discord_user_id is not null)::text as owned_membership_profiles,
        count(*) filter (where discord_user_id is null)::text as orphaned_membership_profiles,
        coalesce(
          array_agg(distinct discord_user_id order by discord_user_id)
            filter (where discord_user_id is not null),
          array[]::text[]
        ) as affected_discord_user_ids
      from member_group_profiles
      where discord_guild_id = $1
        and member_group_id = $2
      `,
      [discordGuildId, memberGroupId]
    ),
    pool.query<MemberGroupRemovalRoleSummaryRow>(
      `
      select coalesce(array_agg(discord_role_id order by discord_role_id), array[]::text[]) as retired_role_ids
      from (
        select discord_role_id
        from member_group_role_configs
        where member_group_id = $2
        union
        select discord_role_id
        from member_group_positions
        where discord_guild_id = $1
          and member_group_id = $2
      ) roles
      `,
      [discordGuildId, memberGroupId]
    )
  ]);
  const profile = profileResult.rows[0];
  return {
    memberGroup: mapMemberGroup(group),
    displayName: group.group_type === "alliance" && group.albion_alliance_tag
      ? `${group.group_name} [${group.albion_alliance_tag}]`
      : group.group_name,
    albionEntityId: group.albion_guild_id ?? group.albion_alliance_id ?? undefined,
    albionAllianceTag: group.albion_alliance_tag ?? undefined,
    totalMembershipProfiles: Number(profile?.total_membership_profiles ?? "0"),
    ownedMembershipProfiles: Number(profile?.owned_membership_profiles ?? "0"),
    orphanedMembershipProfiles: Number(profile?.orphaned_membership_profiles ?? "0"),
    affectedDiscordUserIds: profile?.affected_discord_user_ids ?? [],
    retiredRoleIds: roleResult.rows[0]?.retired_role_ids ?? []
  };
}

async function listGroups(pool: PostgresPool, discordGuildId: string): Promise<MemberGroup[]> {
  const result = await pool.query<MemberGroupRow>(
    `
    select member_group_id, discord_guild_id, albion_server, group_type, group_name
    from member_groups
    where discord_guild_id = $1
      and group_type = 'group'
    order by albion_server asc, lower(group_name) asc, member_group_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapMemberGroup);
}

async function getMemberGroupById(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  groupType: MemberGroupType,
  albionServer?: AlbionServer
): Promise<MemberGroup | undefined> {
  const result = await pool.query<MemberGroupRow>(
    `
    select member_group_id, discord_guild_id, albion_server, group_type, group_name
    from member_groups
    where discord_guild_id = $1
      and member_group_id = $2
      and group_type = $3
      and ($4::text is null or albion_server = $4)
    `,
    [discordGuildId, memberGroupId, groupType, albionServer ?? null]
  );
  const row = result.rows[0];
  return row ? mapMemberGroup(row) : undefined;
}

async function configureAlbionGuild(pool: PostgresPool, input: ConfigureAlbionGuildInput): Promise<MemberGroup> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const groupResult = await client.query<MemberGroupRow>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'guild', $3)
      returning member_group_id, discord_guild_id, albion_server, group_type, group_name
      `,
      [input.discordGuildId, input.albionServer, input.albionGuildName]
    );
    const group = mapMemberGroup(groupResult.rows[0]);
    await client.query(
      `
      insert into configured_albion_guilds (
        member_group_id,
        discord_guild_id,
        albion_server,
        albion_guild_id,
        albion_guild_name,
        managed
      )
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        group.memberGroupId,
        input.discordGuildId,
        input.albionServer,
        input.albionGuildId,
        input.albionGuildName,
        input.managed
      ]
    );
    await client.query("commit");
    return group;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateConfiguredAlbionGuild(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  managed: boolean
): Promise<ConfiguredAlbionGuild | undefined> {
  const result = await pool.query<ConfiguredAlbionGuildRow>(
    `
    update configured_albion_guilds cag
    set managed = $3, updated_at = now()
    from member_groups mg
    where cag.member_group_id = mg.member_group_id
      and cag.discord_guild_id = $1
      and cag.member_group_id = $2
    returning
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      cag.albion_guild_id,
      cag.albion_guild_name,
      cag.managed
    `,
    [discordGuildId, memberGroupId, managed]
  );
  const row = result.rows[0];
  return row ? mapConfiguredAlbionGuild(row) : undefined;
}

async function listConfiguredAlbionGuilds(pool: PostgresPool, discordGuildId: string): Promise<ConfiguredAlbionGuild[]> {
  const result = await pool.query<ConfiguredAlbionGuildRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      cag.albion_guild_id,
      cag.albion_guild_name,
      cag.managed
    from configured_albion_guilds cag
    join member_groups mg on mg.member_group_id = cag.member_group_id
    where cag.discord_guild_id = $1
    order by mg.albion_server asc, lower(cag.albion_guild_name) asc, cag.albion_guild_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapConfiguredAlbionGuild);
}

async function getConfiguredAlbionGuild(
  pool: Queryable,
  discordGuildId: string,
  memberGroupId: string,
  albionServer?: AlbionServer
): Promise<ConfiguredAlbionGuild | undefined> {
  const result = await pool.query<ConfiguredAlbionGuildRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      cag.albion_guild_id,
      cag.albion_guild_name,
      cag.managed
    from configured_albion_guilds cag
    join member_groups mg on mg.member_group_id = cag.member_group_id
    where cag.discord_guild_id = $1
      and cag.member_group_id = $2
      and ($3::text is null or cag.albion_server = $3)
    `,
    [discordGuildId, memberGroupId, albionServer ?? null]
  );
  const row = result.rows[0];
  return row ? mapConfiguredAlbionGuild(row) : undefined;
}

async function getDefaultAlbionGuild(
  pool: PostgresPool,
  discordGuildId: string
): Promise<ConfiguredAlbionGuild | undefined> {
  const result = await pool.query<ConfiguredAlbionGuildRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      cag.albion_guild_id,
      cag.albion_guild_name,
      cag.managed
    from discord_guild_defaults dgd
    join configured_albion_guilds cag
      on cag.member_group_id = dgd.default_albion_guild_member_group_id
      and cag.discord_guild_id = dgd.discord_guild_id
      and cag.albion_server = dgd.default_albion_server
    join member_groups mg on mg.member_group_id = cag.member_group_id
    where dgd.discord_guild_id = $1
    `,
    [discordGuildId]
  );
  const row = result.rows[0];
  return row ? mapConfiguredAlbionGuild(row) : undefined;
}

async function setDefaultAlbionGuild(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  albionServer: AlbionServer
): Promise<ConfiguredAlbionGuild | undefined> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const configured = await getConfiguredAlbionGuild(client, discordGuildId, memberGroupId, albionServer);
    if (!configured) {
      await client.query("rollback");
      return undefined;
    }

    await client.query(
      `
      insert into discord_guild_defaults (
        discord_guild_id,
        default_albion_guild_member_group_id,
        default_albion_server,
        updated_at
      )
      values ($1, $2, $3, now())
      on conflict (discord_guild_id) do update set
        default_albion_guild_member_group_id = excluded.default_albion_guild_member_group_id,
        default_albion_server = excluded.default_albion_server,
        updated_at = excluded.updated_at
      `,
      [discordGuildId, configured.memberGroupId, configured.albionServer]
    );
    await client.query("commit");
    return configured;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearDefaultAlbionGuild(pool: PostgresPool, discordGuildId: string): Promise<boolean> {
  const result = await pool.query(
    `
    delete from discord_guild_defaults
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function configureAlbionAlliance(pool: PostgresPool, input: ConfigureAlbionAllianceInput): Promise<MemberGroup> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const groupResult = await client.query<MemberGroupRow>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'alliance', $3)
      returning member_group_id, discord_guild_id, albion_server, group_type, group_name
      `,
      [input.discordGuildId, input.albionServer, input.albionAllianceName]
    );
    const group = mapMemberGroup(groupResult.rows[0]);
    await client.query(
      `
      insert into configured_albion_alliances (
        member_group_id,
        discord_guild_id,
        albion_server,
        albion_alliance_id,
        albion_alliance_name,
        albion_alliance_tag
      )
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        group.memberGroupId,
        input.discordGuildId,
        input.albionServer,
        input.albionAllianceId,
        input.albionAllianceName,
        input.albionAllianceTag ?? null
      ]
    );
    await client.query("commit");
    return group;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function listConfiguredAlbionAlliances(pool: PostgresPool, discordGuildId: string): Promise<ConfiguredAlbionAlliance[]> {
  const result = await pool.query<ConfiguredAlbionAllianceRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      caa.albion_alliance_id,
      caa.albion_alliance_name,
      caa.albion_alliance_tag
    from configured_albion_alliances caa
    join member_groups mg on mg.member_group_id = caa.member_group_id
    where caa.discord_guild_id = $1
    order by mg.albion_server asc, lower(caa.albion_alliance_name) asc, caa.albion_alliance_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapConfiguredAlbionAlliance);
}

async function getConfiguredAlbionAlliance(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  albionServer?: AlbionServer
): Promise<ConfiguredAlbionAlliance | undefined> {
  const result = await pool.query<ConfiguredAlbionAllianceRow>(
    `
    select
      mg.member_group_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      caa.albion_alliance_id,
      caa.albion_alliance_name,
      caa.albion_alliance_tag
    from configured_albion_alliances caa
    join member_groups mg on mg.member_group_id = caa.member_group_id
    where caa.discord_guild_id = $1
      and caa.member_group_id = $2
      and ($3::text is null or caa.albion_server = $3)
    `,
    [discordGuildId, memberGroupId, albionServer ?? null]
  );
  const row = result.rows[0];
  return row ? mapConfiguredAlbionAlliance(row) : undefined;
}

async function listMemberGroups(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer?: AlbionServer
): Promise<MemberGroup[]> {
  const result = await pool.query<MemberGroupRow>(
    `
    select member_group_id, discord_guild_id, albion_server, group_type, group_name
    from member_groups
    where discord_guild_id = $1
      and ($2::text is null or albion_server = $2)
    order by albion_server asc, group_type asc, lower(group_name) asc, member_group_id asc
    `,
    [discordGuildId, albionServer ?? null]
  );
  return result.rows.map(mapMemberGroup);
}

async function getActiveMemberGroupForUser(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  discordUserId: string
): Promise<MemberGroup | undefined> {
  const result = await pool.query<MemberGroupRow>(
    `
    select mg.member_group_id, mg.discord_guild_id, mg.albion_server, mg.group_type, mg.group_name
    from member_groups mg
    where mg.discord_guild_id = $1
      and mg.member_group_id = $2
      and exists (
        select 1
        from member_group_profiles mgp
        where mgp.discord_guild_id = mg.discord_guild_id
          and mgp.member_group_id = mg.member_group_id
          and mgp.discord_user_id = $3
      )
    `,
    [discordGuildId, memberGroupId, discordUserId]
  );
  const row = result.rows[0];
  return row ? mapMemberGroup(row) : undefined;
}

async function addRegisteredProfile(
  pool: Queryable,
  input: RegisteredProfileInput,
  pendingChanges?: LogChange[]
): Promise<MemberGroupProfile | undefined> {
  if (isLogCaptureActive(input.discordGuildId)) return addCapturedProfile(pool, input, pendingChanges, input.discordUserId);
  const result = await pool.query<MemberGroupProfileRow>(
    `
    insert into member_group_profiles (
      member_group_id,
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id,
      updated_at
    )
    select $1, $2, $3, $4, $5, now()
    from discord_user_characters
    where discord_guild_id = $2
      and discord_user_id = $3
      and albion_server = $4
      and albion_character_id = $5
      and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = $2 and r.albion_server = $4 and r.albion_character_id = $5)
    on conflict (member_group_id, albion_server, albion_character_id) do update set
      discord_user_id = excluded.discord_user_id, lifecycle_state = 'current', entitlement_preserved = true,
      updated_at = excluded.updated_at
    where member_group_profiles.lifecycle_state <> 'departed'
    returning *
    `,
    [
      input.memberGroupId,
      input.discordGuildId,
      input.discordUserId,
      input.albionServer,
      input.albionCharacterId
    ]
  );

  const row = result.rows[0];
  return row ? mapMemberGroupProfile(row) : undefined;
}

async function addOrphanProfile(pool: Queryable, input: ProfileInput, pendingChanges?: LogChange[]): Promise<MemberGroupProfile> {
  if (isLogCaptureActive(input.discordGuildId)) {
    const profile = await addCapturedProfile(pool, input, pendingChanges);
    if (!profile) throw new Error("The Albion Online membership profile could not be read after insertion.");
    return profile;
  }
  const result = await pool.query<MemberGroupProfileRow>(
    `
    insert into member_group_profiles (
      member_group_id,
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id,
      discovered_at,
      lifecycle_state,
      entitlement_preserved,
      updated_at
    )
    values ($1, $2, null, $3, $4, now(), 'unregistered', false, now())
    on conflict (member_group_id, albion_server, albion_character_id) do update set
      updated_at = excluded.updated_at
    returning *
    `,
    [input.memberGroupId, input.discordGuildId, input.albionServer, input.albionCharacterId]
  );
  return mapMemberGroupProfile(result.rows[0]);
}

async function removeCustomGroupProfile(
  pool: PostgresPool,
  input: ProfileInput
): Promise<MemberGroupProfile | undefined> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, input);
  const result = await client.query<MemberGroupProfileRow & { group_name: string; group_type: MemberGroupType; character_name: string }>(
    `
    delete from member_group_profiles mgp
    using member_groups mg, albion_characters ac
    where mg.member_group_id = mgp.member_group_id
      and mg.discord_guild_id = mgp.discord_guild_id
      and mg.albion_server = mgp.albion_server
      and mg.group_type = 'group'
      and ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
      and mgp.member_group_id = $1
      and mgp.discord_guild_id = $2
      and mgp.albion_server = $3
      and mgp.albion_character_id = $4
    returning
      mgp.member_group_profile_id,
      mgp.member_group_id,
      mgp.discord_guild_id,
      mgp.discord_user_id,
      mgp.albion_server,
      mgp.albion_character_id,
      mg.group_name,
      mg.group_type,
      ac.character_name
    `,
    [input.memberGroupId, input.discordGuildId, input.albionServer, input.albionCharacterId]
  );
  const row = result.rows[0];
  const profile = row ? mapMemberGroupProfile(row) : undefined;
  if (profile) await expireCharacterEntitlements(client, input);
  await client.query("commit");
  if (profile) recordLogChange(input.discordGuildId, { kind: "profile", action: "left", profile: profile });
  return profile;
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function orphanRegisteredProfile(
  pool: PostgresPool,
  input: RegisteredProfileInput
): Promise<MemberGroupProfile | undefined> {
  const result = await pool.query<MemberGroupProfileRow & { group_name: string; group_type: MemberGroupType; character_name: string }>(
    `
    update member_group_profiles mgp
    set discord_user_id = null, updated_at = now()
    from member_groups mg, albion_characters ac
    where mg.member_group_id = mgp.member_group_id
      and ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
      and mgp.member_group_id = $1
      and mgp.discord_guild_id = $2
      and mgp.discord_user_id = $3
      and mgp.albion_server = $4
      and mgp.albion_character_id = $5
    returning
      mgp.member_group_profile_id,
      mgp.member_group_id,
      mgp.discord_guild_id,
      mgp.discord_user_id,
      mgp.albion_server,
      mgp.albion_character_id,
      mg.group_name,
      mg.group_type,
      ac.character_name
    `,
    [input.memberGroupId, input.discordGuildId, input.discordUserId, input.albionServer, input.albionCharacterId]
  );
  const row = result.rows[0];
  const profile = row ? mapMemberGroupProfile(row) : undefined;
  if (profile) recordLogChange(input.discordGuildId, { kind: "profile", action: "left", profile: { ...profile, discordUserId: input.discordUserId } });
  return profile;
}

async function orphanProfilesNotInCharacterIds(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  albionServer: AlbionServer,
  albionCharacterIds: string[]
): Promise<OrphanedProfileResult> {
  if (isLogCaptureActive(discordGuildId)) return orphanCapturedProfiles(pool, discordGuildId,
    "mgp.discord_guild_id = $1 and mgp.member_group_id = $2 and mgp.albion_server = $3 and not (mgp.albion_character_id = any($4::text[]))",
    [discordGuildId, memberGroupId, albionServer, albionCharacterIds]);
  const result = await pool.query<{ discord_user_id: string | null }>(
    `
    update member_group_profiles
    set discord_user_id = null, updated_at = now()
    where discord_guild_id = $1
      and member_group_id = $2
      and albion_server = $3
      and discord_user_id is not null
      and not (albion_character_id = any($4::text[]))
    returning discord_user_id
    `,
    [discordGuildId, memberGroupId, albionServer, albionCharacterIds]
  );
  return {
    orphanedProfiles: result.rowCount ?? 0,
    affectedDiscordUserIds: distinct(result.rows.map((row) => row.discord_user_id).filter(isNonEmptyString))
  };
}

async function orphanAutoProfilesForCharacter(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string,
  selectedMemberGroupIds: string[],
  qualifiedMemberGroupIds: string[]
): Promise<OrphanedProfileResult> {
  if (selectedMemberGroupIds.length === 0) {
    return { orphanedProfiles: 0, affectedDiscordUserIds: [] };
  }

  if (isLogCaptureActive(discordGuildId)) return orphanCapturedProfiles(pool, discordGuildId,
    "mgp.discord_guild_id = $1 and mgp.albion_server = $2 and mgp.albion_character_id = $3 and mg.group_type in ('guild', 'alliance') and mgp.member_group_id = any($4::bigint[]) and not (mgp.member_group_id = any($5::bigint[]))",
    [discordGuildId, albionServer, albionCharacterId, selectedMemberGroupIds, qualifiedMemberGroupIds]);
  const result = await pool.query<{ discord_user_id: string | null }>(
    `
    update member_group_profiles mgp
    set discord_user_id = null, updated_at = now()
    from member_groups mg
    where mg.member_group_id = mgp.member_group_id
      and mgp.discord_guild_id = $1
      and mgp.albion_server = $2
      and mgp.albion_character_id = $3
      and mgp.discord_user_id is not null
      and mg.group_type in ('guild', 'alliance')
      and mgp.member_group_id = any($4::bigint[])
      and not (mgp.member_group_id = any($5::bigint[]))
    returning mgp.discord_user_id
    `,
    [discordGuildId, albionServer, albionCharacterId, selectedMemberGroupIds, qualifiedMemberGroupIds]
  );
  return {
    orphanedProfiles: result.rowCount ?? 0,
    affectedDiscordUserIds: distinct(result.rows.map((row) => row.discord_user_id).filter(isNonEmptyString))
  };
}

async function listProfilesForCharacter(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<MemberGroupProfile[]> {
  const result = await pool.query<MemberGroupProfileRow & { group_name: string; group_type: MemberGroupType; character_name: string }>(
    `
    select
      mgp.*,
      r.state as registration_state,
      r.source as registration_source,
      r.expires_at as registration_expires_at,
      coalesce(mgp.lifecycle_check_failed_at, r.check_failed_at) as lifecycle_check_failed_at,
      mg.group_name,
      mg.group_type,
      ac.character_name
    from member_group_profiles mgp
    join member_groups mg on mg.member_group_id = mgp.member_group_id
    join albion_characters ac
      on ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
    left join member_registration_lifecycle r on r.discord_guild_id = mgp.discord_guild_id
      and r.albion_server = mgp.albion_server and r.albion_character_id = mgp.albion_character_id
    where mgp.discord_guild_id = $1
      and mgp.albion_server = $2
      and mgp.albion_character_id = $3
    order by mg.group_type asc, lower(mg.group_name) asc
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return result.rows.map(mapMemberGroupProfile);
}

async function listProfilesForGroups(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupIds: string[]
): Promise<MemberGroupProfile[]> {
  if (memberGroupIds.length === 0) return [];

  const result = await pool.query<MemberGroupProfileRow & { group_name: string; group_type: MemberGroupType; character_name: string }>(
    `
    select
      mgp.*,
      r.state as registration_state,
      r.source as registration_source,
      r.expires_at as registration_expires_at,
      coalesce(mgp.lifecycle_check_failed_at, r.check_failed_at) as lifecycle_check_failed_at,
      mg.group_name,
      mg.group_type,
      ac.character_name
    from member_group_profiles mgp
    join member_groups mg on mg.member_group_id = mgp.member_group_id
    join albion_characters ac
      on ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
    left join member_registration_lifecycle r on r.discord_guild_id = mgp.discord_guild_id
      and r.albion_server = mgp.albion_server and r.albion_character_id = mgp.albion_character_id
    where mgp.discord_guild_id = $1
      and mgp.member_group_id = any($2::bigint[])
    order by mg.group_type asc, lower(mg.group_name) asc, ac.character_name asc
    `,
    [discordGuildId, memberGroupIds]
  );
  return result.rows.map(mapMemberGroupProfile);
}

async function listProfilesForGroupReport(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string
): Promise<MemberGroupProfile[]> {
  const result = await pool.query<MemberGroupProfileRow & { group_name: string; group_type: MemberGroupType; character_name: string }>(
    `
    select
      mgp.*,
      r.state as registration_state,
      r.source as registration_source,
      r.expires_at as registration_expires_at,
      coalesce(mgp.lifecycle_check_failed_at, r.check_failed_at) as lifecycle_check_failed_at,
      mg.group_name,
      mg.group_type,
      ac.character_name
    from member_group_profiles mgp
    join member_groups mg on mg.member_group_id = mgp.member_group_id
    join albion_characters ac
      on ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
    left join member_registration_lifecycle r on r.discord_guild_id = mgp.discord_guild_id
      and r.albion_server = mgp.albion_server and r.albion_character_id = mgp.albion_character_id
    where mgp.discord_guild_id = $1
      and mgp.member_group_id = $2
    order by lower(ac.character_name) asc, mgp.discord_user_id is null asc, mgp.discord_user_id asc
    `,
    [discordGuildId, memberGroupId]
  );
  return result.rows.map(mapMemberGroupProfile);
}

async function createGroupPosition(
  pool: PostgresPool,
  input: CreateGroupPositionInput
): Promise<GroupPosition | undefined> {
  const result = await pool.query<GroupPositionRow>(
    `
    insert into member_group_positions (
      discord_guild_id,
      member_group_id,
      name,
      discord_role_id,
      updated_at
    )
    select $1, mg.member_group_id, $3, $4, now()
    from member_groups mg
    where mg.discord_guild_id = $1
      and mg.member_group_id = $2
    returning
      member_group_position_id,
      discord_guild_id,
      member_group_id,
      name,
      discord_role_id,
      (select albion_server from member_groups where member_group_id = $2) as albion_server,
      (select group_type from member_groups where member_group_id = $2) as group_type,
      (select group_name from member_groups where member_group_id = $2) as group_name
    `,
    [input.discordGuildId, input.memberGroupId, input.name, input.discordRoleId]
  );
  const row = result.rows[0];
  return row ? mapGroupPosition(row) : undefined;
}

async function deleteGroupPosition(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupPositionId: string
): Promise<{ deleted?: GroupPosition; affectedDiscordUserIds: string[] }> {
  const client = await pool.connect();

  try {
    await client.query("begin");
    const affectedResult = await client.query<{ discord_user_id: string | null }>(
      `
      select distinct mgp.discord_user_id
      from member_group_position_appointments appointment
      join member_group_profiles mgp on mgp.member_group_profile_id = appointment.member_group_profile_id
      where appointment.discord_guild_id = $1
        and appointment.member_group_position_id = $2
        and mgp.discord_user_id is not null
      `,
      [discordGuildId, memberGroupPositionId]
    );
    const deletedResult = await client.query<GroupPositionRow>(
      `
      delete from member_group_positions position
      using member_groups mg
      where mg.member_group_id = position.member_group_id
        and position.discord_guild_id = $1
        and position.member_group_position_id = $2
      returning
        position.member_group_position_id,
        position.discord_guild_id,
        position.member_group_id,
        position.name,
        position.discord_role_id,
        mg.albion_server,
        mg.group_type,
        mg.group_name
      `,
      [discordGuildId, memberGroupPositionId]
    );
    await client.query("commit");
    return {
      deleted: deletedResult.rows[0] ? mapGroupPosition(deletedResult.rows[0]) : undefined,
      affectedDiscordUserIds: distinct(affectedResult.rows.map((row) => row.discord_user_id).filter(isNonEmptyString))
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getGroupPosition(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupPositionId: string,
  memberGroupId?: string
): Promise<GroupPosition | undefined> {
  const result = await pool.query<GroupPositionRow>(
    groupPositionSelectSql(`
      where position.discord_guild_id = $1
        and position.member_group_position_id = $2
        and ($3::bigint is null or position.member_group_id = $3)
    `),
    [discordGuildId, memberGroupPositionId, memberGroupId ?? null]
  );
  const row = result.rows[0];
  return row ? mapGroupPosition(row) : undefined;
}

async function listGroupPositions(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId?: string
): Promise<GroupPosition[]> {
  const result = await pool.query<GroupPositionRow>(
    groupPositionSelectSql(`
      where position.discord_guild_id = $1
        and ($2::bigint is null or position.member_group_id = $2)
      order by mg.albion_server asc, mg.group_type asc, lower(mg.group_name) asc, lower(position.name) asc
    `),
    [discordGuildId, memberGroupId ?? null]
  );
  return result.rows.map(mapGroupPosition);
}

async function appointGroupPosition(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupPositionId: string,
  memberGroupProfileId: string
): Promise<GroupPositionAppointment | undefined> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockMembershipLifecycleTenant(client, discordGuildId);
    const result = await client.query<GroupPositionAppointmentRow>(
      groupPositionAppointmentMutationSql(`
        insert into member_group_position_appointments (
          member_group_position_id,
          member_group_profile_id,
          discord_guild_id,
          updated_at
        )
        select position.member_group_position_id, mgp.member_group_profile_id, $1, now()
        from member_group_positions position
        join member_group_profiles mgp
          on mgp.member_group_id = position.member_group_id
          and mgp.discord_guild_id = position.discord_guild_id
        where position.discord_guild_id = $1
          and position.member_group_position_id = $2
          and mgp.member_group_profile_id = $3
          and not exists (select 1 from character_kick_recovery kicked
            where kicked.discord_guild_id = mgp.discord_guild_id and kicked.albion_server = mgp.albion_server
              and kicked.albion_character_id = mgp.albion_character_id and kicked.recovery_required)
          and not exists (select 1 from guild_member_access access
            where access.discord_guild_id = mgp.discord_guild_id and access.discord_user_id = mgp.discord_user_id and access.blocked)
        on conflict (member_group_position_id, member_group_profile_id) do update set
          updated_at = excluded.updated_at
        returning
          member_group_position_appointment_id,
          member_group_position_id,
          member_group_profile_id,
          discord_guild_id
      `),
      [discordGuildId, memberGroupPositionId, memberGroupProfileId]
    );
    const row = result.rows[0];
    if (row?.discord_user_id) {
      // A fresh officer appointment is an explicit new grant. Recovery and
      // automatic reconciliation never clear the saved role suppression.
      await client.query(`update guild_member_access access
        set revoked_role_ids = array_remove(access.revoked_role_ids, $3), updated_at = now()
        where access.discord_guild_id = $1 and access.discord_user_id = $2 and not access.blocked
          and exists (select 1 from discord_user_characters registration
            where registration.discord_guild_id = $1 and registration.discord_user_id = $2
              and registration.albion_server = $4 and registration.albion_character_id = $5)`,
      [discordGuildId, row.discord_user_id, row.discord_role_id, row.albion_server, row.albion_character_id]);
    }
    await client.query("commit");
    return row ? mapGroupPositionAppointment(row) : undefined;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function dismissGroupPosition(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupPositionId: string,
  memberGroupProfileId: string
): Promise<GroupPositionAppointment | undefined> {
  const result = await pool.query<GroupPositionAppointmentRow>(
    groupPositionAppointmentMutationSql(`
      delete from member_group_position_appointments
      where discord_guild_id = $1
        and member_group_position_id = $2
        and member_group_profile_id = $3
      returning
        member_group_position_appointment_id,
        member_group_position_id,
        member_group_profile_id,
        discord_guild_id
    `),
    [discordGuildId, memberGroupPositionId, memberGroupProfileId]
  );
  const row = result.rows[0];
  return row ? mapGroupPositionAppointment(row) : undefined;
}

async function listGroupPositionAppointments(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId?: string,
  memberGroupPositionId?: string
): Promise<GroupPositionAppointment[]> {
  const result = await pool.query<GroupPositionAppointmentRow>(
    groupPositionAppointmentSelectSql(`
      where appointment.discord_guild_id = $1
        and ($2::bigint is null or position.member_group_id = $2)
        and ($3::bigint is null or position.member_group_position_id = $3)
      order by mg.albion_server asc, mg.group_type asc, lower(mg.group_name) asc, lower(position.name) asc, lower(ac.character_name) asc
    `),
    [discordGuildId, memberGroupId ?? null, memberGroupPositionId ?? null]
  );
  return result.rows.map(mapGroupPositionAppointment);
}

async function listRegisteredUserIdsForGuild(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer?: AlbionServer
): Promise<string[]> {
  const result = await pool.query<{ discord_user_id: string }>(
    `
    select distinct discord_user_id
    from discord_user_characters
    where discord_guild_id = $1
      and ($2::text is null or albion_server = $2)
    order by discord_user_id asc
    `,
    [discordGuildId, albionServer ?? null]
  );
  return result.rows.map((row) => row.discord_user_id);
}

async function listActiveProfileUserIdsForGroups(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupIds: string[]
): Promise<string[]> {
  if (memberGroupIds.length === 0) return [];

  const result = await pool.query<{ discord_user_id: string }>(
    `
    select distinct discord_user_id
    from member_group_profiles
    where discord_guild_id = $1
      and member_group_id = any($2::bigint[])
      and discord_user_id is not null
    order by discord_user_id asc
    `,
    [discordGuildId, memberGroupIds]
  );
  return result.rows.map((row) => row.discord_user_id);
}

async function addCharacterRoleConfig(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer: AlbionServer | undefined,
  discordRoleId: string
): Promise<void> {
  await pool.query(
    `
    insert into character_role_configs (discord_guild_id, albion_server, discord_role_id, updated_at)
    values ($1, $2, $3, now())
    on conflict (discord_guild_id, coalesce(albion_server, 'all'), discord_role_id) do update set
      updated_at = excluded.updated_at
    `,
    [discordGuildId, albionServer ?? null, discordRoleId]
  );
}

async function removeCharacterRoleConfig(
  pool: PostgresPool,
  discordGuildId: string,
  albionServer: AlbionServer | undefined,
  discordRoleId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    delete from character_role_configs
    where discord_guild_id = $1
      and coalesce(albion_server, 'all') = coalesce($2::text, 'all')
      and discord_role_id = $3
    `,
    [discordGuildId, albionServer ?? null, discordRoleId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function listCharacterRoleConfigs(pool: PostgresPool, discordGuildId: string): Promise<CharacterRoleConfig[]> {
  const result = await pool.query<CharacterRoleConfigRow>(
    `
    select character_role_config_id, discord_guild_id, albion_server, discord_role_id
    from character_role_configs
    where discord_guild_id = $1
    order by coalesce(albion_server, 'all') asc, discord_role_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapCharacterRoleConfig);
}

async function addMemberGroupRoleConfig(
  pool: PostgresPool,
  memberGroupId: string,
  discordRoleId: string
): Promise<void> {
  await pool.query(
    `
    insert into member_group_role_configs (member_group_id, discord_role_id, updated_at)
    values ($1, $2, now())
    on conflict (member_group_id, discord_role_id) do update set
      updated_at = excluded.updated_at
    `,
    [memberGroupId, discordRoleId]
  );
}

async function removeMemberGroupRoleConfig(
  pool: PostgresPool,
  discordGuildId: string,
  memberGroupId: string,
  discordRoleId?: string
): Promise<number> {
  const result = await pool.query(
    `
    delete from member_group_role_configs mgrc
    using member_groups mg
    where mgrc.member_group_id = mg.member_group_id
      and mg.discord_guild_id = $1
      and mgrc.member_group_id = $2
      and ($3::text is null or mgrc.discord_role_id = $3)
    `,
    [discordGuildId, memberGroupId, discordRoleId ?? null]
  );
  return result.rowCount ?? 0;
}

async function listMemberGroupRoleConfigs(
  pool: PostgresPool,
  discordGuildId: string,
  groupType?: MemberGroupType
): Promise<MemberGroupRoleConfig[]> {
  const result = await pool.query<MemberGroupRoleConfigRow>(
    `
    select
      mgrc.member_group_role_config_id,
      mgrc.member_group_id,
      mgrc.discord_role_id,
      mg.discord_guild_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name
    from member_group_role_configs mgrc
    join member_groups mg on mg.member_group_id = mgrc.member_group_id
    where mg.discord_guild_id = $1
      and ($2::text is null or mg.group_type = $2)
    order by mg.albion_server asc, lower(mg.group_name) asc, mgrc.discord_role_id asc
    `,
    [discordGuildId, groupType ?? null]
  );
  return result.rows.map(mapMemberGroupRoleConfig);
}

async function listConfiguredRoleIdsForGuild(pool: Queryable, discordGuildId: string): Promise<string[]> {
  const result = await pool.query<{ discord_role_id: string }>(
    `
    select active_role_id as discord_role_id
    from application_classes
    where discord_guild_id = $1 and active_role_id is not null
    union
    select discord_role_id
    from character_role_configs
    where discord_guild_id = $1
    union
    select mgrc.discord_role_id
    from member_group_role_configs mgrc
    join member_groups mg on mg.member_group_id = mgrc.member_group_id
    where mg.discord_guild_id = $1
    union
    select discord_role_id
    from member_group_positions
    where discord_guild_id = $1
    union
    select discord_role_id
    from reaction_role_configs
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
  return result.rows.map((row) => row.discord_role_id);
}

async function listMembershipRoleIdsForUser(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<string[]> {
  const result = await pool.query<{ discord_role_id: string }>(
    `
    select crc.discord_role_id
    from discord_user_characters duc
    join character_role_configs crc
      on crc.discord_guild_id = duc.discord_guild_id
      and (crc.albion_server is null or crc.albion_server = duc.albion_server)
    where duc.discord_guild_id = $1
      and duc.discord_user_id = $2
    union
    select mgrc.discord_role_id
    from member_group_profiles mgp
    join member_group_role_configs mgrc
      on mgrc.member_group_id = mgp.member_group_id
    where mgp.discord_guild_id = $1
      and mgp.discord_user_id = $2
    union
    select position.discord_role_id
    from member_group_profiles mgp
    join member_group_position_appointments appointment
      on appointment.member_group_profile_id = mgp.member_group_profile_id
      and appointment.discord_guild_id = mgp.discord_guild_id
    join member_group_positions position
      on position.member_group_position_id = appointment.member_group_position_id
      and position.discord_guild_id = appointment.discord_guild_id
    where mgp.discord_guild_id = $1
      and mgp.discord_user_id = $2
    `,
    [discordGuildId, discordUserId]
  );
  return result.rows.map((row) => row.discord_role_id);
}

async function listDormantReactionRoleSubscriptions(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<DormantReactionRoleSubscription[]> {
  const result = await pool.query<{
    reaction_role_config_id: string;
    channel_id: string | null;
    message_id: string | null;
    emoji_key: string | null;
    emoji_display_value: string | null;
  }>(
    `
    select
      subscription.reaction_role_config_id,
      placement.channel_id,
      placement.message_id,
      placement.emoji_key,
      placement.emoji_display_value
    from reaction_role_subscriptions subscription
    left join reaction_role_emoji_placements placement
      on placement.reaction_role_config_id = subscription.reaction_role_config_id
      and placement.discord_guild_id = $1
    where subscription.discord_guild_id = $1
      and subscription.discord_user_id = $2
      and not exists (
        select 1
        from member_group_profiles profile
        join member_groups member_group
          on member_group.member_group_id = profile.member_group_id
          and member_group.discord_guild_id = profile.discord_guild_id
        where profile.discord_guild_id = subscription.discord_guild_id
          and profile.discord_user_id = subscription.discord_user_id
      )
    `,
    [discordGuildId, discordUserId]
  );
  return result.rows.map((row) => ({
    reactionRoleConfigId: row.reaction_role_config_id,
    channelId: row.channel_id ?? undefined,
    messageId: row.message_id ?? undefined,
    emojiKey: row.emoji_key ?? undefined,
    emojiDisplayValue: row.emoji_display_value ?? undefined
  }));
}

async function listSelfServiceCharacters(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<SelfServiceCharacter[]> {
  const result = await pool.query<{
    albion_server: AlbionServer;
    albion_character_id: string;
    character_name: string;
    discord_role_id: string | null;
  }>(
    `
    select
      registered.albion_server,
      registered.albion_character_id,
      character.character_name,
      role_config.discord_role_id
    from discord_user_characters registered
    join albion_characters character
      on character.albion_server = registered.albion_server
      and character.albion_character_id = registered.albion_character_id
    left join character_role_configs role_config
      on role_config.discord_guild_id = registered.discord_guild_id
      and (
        role_config.albion_server is null
        or role_config.albion_server = registered.albion_server
      )
    where registered.discord_guild_id = $1
      and registered.discord_user_id = $2
    order by
      registered.registration_order,
      role_config.discord_role_id
    `,
    [discordGuildId, discordUserId]
  );

  const characters = new Map<string, SelfServiceCharacter>();
  for (const row of result.rows) {
    const key = `${row.albion_server}:${row.albion_character_id}`;
    const character = characters.get(key) ?? {
      albionServer: row.albion_server,
      albionCharacterId: row.albion_character_id,
      characterName: row.character_name,
      discordRoleIds: []
    };
    if (row.discord_role_id && !character.discordRoleIds.includes(row.discord_role_id)) {
      character.discordRoleIds.push(row.discord_role_id);
    }
    characters.set(key, character);
  }
  return [...characters.values()];
}

async function listSelfServiceMemberships(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<SelfServiceMembership[]> {
  const result = await pool.query<{
    member_group_profile_id: string;
    member_group_id: string;
    albion_server: AlbionServer;
    albion_character_id: string;
    character_name: string;
    group_type: MemberGroupType;
    group_name: string;
    discord_role_id: string | null;
  }>(
    `
    select
      profile.member_group_profile_id,
      profile.member_group_id,
      profile.albion_server,
      profile.albion_character_id,
      character.character_name,
      member_group.group_type,
      member_group.group_name,
      role_config.discord_role_id
    from member_group_profiles profile
    join member_groups member_group
      on member_group.member_group_id = profile.member_group_id
      and member_group.discord_guild_id = profile.discord_guild_id
      and member_group.albion_server = profile.albion_server
    join albion_characters character
      on character.albion_server = profile.albion_server
      and character.albion_character_id = profile.albion_character_id
    left join member_group_role_configs role_config
      on role_config.member_group_id = profile.member_group_id
    where profile.discord_guild_id = $1
      and profile.discord_user_id = $2
    order by
      lower(member_group.group_name),
      member_group.group_type,
      member_group.albion_server,
      lower(character.character_name),
      profile.member_group_profile_id,
      role_config.discord_role_id
    `,
    [discordGuildId, discordUserId]
  );

  const memberships = new Map<string, SelfServiceMembership>();
  for (const row of result.rows) {
    const membership = memberships.get(row.member_group_profile_id) ?? {
      memberGroupProfileId: row.member_group_profile_id,
      memberGroupId: row.member_group_id,
      albionServer: row.albion_server,
      albionCharacterId: row.albion_character_id,
      characterName: row.character_name,
      groupType: row.group_type,
      groupName: row.group_name,
      discordRoleIds: []
    };
    if (row.discord_role_id && !membership.discordRoleIds.includes(row.discord_role_id)) {
      membership.discordRoleIds.push(row.discord_role_id);
    }
    memberships.set(row.member_group_profile_id, membership);
  }
  return [...memberships.values()];
}

async function listSelfServicePositions(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<SelfServicePosition[]> {
  const result = await pool.query<{
    member_group_position_appointment_id: string;
    albion_server: AlbionServer;
    albion_character_id: string;
    character_name: string;
    group_type: MemberGroupType;
    group_name: string;
    position_name: string;
    discord_role_id: string;
  }>(
    `
    select
      appointment.member_group_position_appointment_id,
      profile.albion_server,
      profile.albion_character_id,
      character.character_name,
      member_group.group_type,
      member_group.group_name,
      position.name as position_name,
      position.discord_role_id
    from member_group_profiles profile
    join member_groups member_group
      on member_group.member_group_id = profile.member_group_id
      and member_group.discord_guild_id = profile.discord_guild_id
    join albion_characters character
      on character.albion_server = profile.albion_server
      and character.albion_character_id = profile.albion_character_id
    join member_group_position_appointments appointment
      on appointment.member_group_profile_id = profile.member_group_profile_id
      and appointment.discord_guild_id = profile.discord_guild_id
    join member_group_positions position
      on position.member_group_position_id = appointment.member_group_position_id
      and position.discord_guild_id = appointment.discord_guild_id
      and position.member_group_id = profile.member_group_id
    where profile.discord_guild_id = $1
      and profile.discord_user_id = $2
    order by
      lower(member_group.group_name),
      member_group.group_type,
      member_group.albion_server,
      lower(character.character_name),
      lower(position.name),
      position.discord_role_id,
      appointment.member_group_position_appointment_id
    `,
    [discordGuildId, discordUserId]
  );

  return result.rows.map((row) => ({
    memberGroupPositionAppointmentId: row.member_group_position_appointment_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    groupType: row.group_type,
    groupName: row.group_name,
    positionName: row.position_name,
    discordRoleId: row.discord_role_id
  }));
}

async function listSelfServiceReactionRoles(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<SelfServiceReactionRole[]> {
  const result = await pool.query<{
    reaction_role_config_id: string;
    discord_role_id: string;
    active: boolean;
  }>(
    `
    select
      config.reaction_role_config_id,
      config.discord_role_id,
      exists (
        select 1
        from member_group_profiles profile
        join member_groups member_group
          on member_group.member_group_id = profile.member_group_id
          and member_group.discord_guild_id = profile.discord_guild_id
        where profile.discord_guild_id = subscription.discord_guild_id
          and profile.discord_user_id = subscription.discord_user_id
      ) as active
    from reaction_role_subscriptions subscription
    join reaction_role_configs config
      on config.reaction_role_config_id = subscription.reaction_role_config_id
      and config.discord_guild_id = subscription.discord_guild_id
    where subscription.discord_guild_id = $1
      and subscription.discord_user_id = $2
    order by config.discord_role_id, config.reaction_role_config_id
    `,
    [discordGuildId, discordUserId]
  );

  return result.rows.map((row) => ({
    reactionRoleConfigId: row.reaction_role_config_id,
    discordRoleId: row.discord_role_id,
    dormant: !row.active
  }));
}

interface RegisteredCharacterRow {
  discord_guild_id: string;
  discord_user_id: string;
  albion_server: AlbionServer;
  albion_character_id: string;
}

interface CharacterRecordRow {
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  guild_name: string | null;
  alliance_name: string | null;
}

interface MemberGroupRow {
  member_group_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer;
  group_type: MemberGroupType;
  group_name: string;
}

interface MemberGroupRemovalRow extends MemberGroupRow {
  albion_guild_id: string | null;
  albion_alliance_id: string | null;
  albion_alliance_tag: string | null;
}

interface MemberGroupRemovalProfileSummaryRow {
  total_membership_profiles: string;
  owned_membership_profiles: string;
  orphaned_membership_profiles: string;
  affected_discord_user_ids: string[];
}

interface MemberGroupRemovalRoleSummaryRow {
  retired_role_ids: string[];
}

interface ApplicationClassRemovalRow {
  application_class_id: string;
  source_channel_id: string | null;
  source_message_id: string | null;
  reviewer_role_id: string;
  active_role_id: string | null;
}

interface ArchivedApplicationRemovalRow {
  application_id: string;
  application_class_id: string;
  applicant_discord_user_id: string;
  ticket_channel_id: string | null;
  reviewer_role_id: string;
  active_role_id: string | null;
  channel_status: "open" | "closed" | "deleted";
  channel_closed_by_removal: boolean;
}

interface ConfiguredAlbionGuildRow extends MemberGroupRow {
  albion_guild_id: string;
  albion_guild_name: string;
  managed: boolean;
}

interface ConfiguredAlbionAllianceRow extends MemberGroupRow {
  albion_alliance_id: string;
  albion_alliance_name: string;
  albion_alliance_tag: string | null;
}

interface CharacterRoleConfigRow {
  character_role_config_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer | null;
  discord_role_id: string;
}

interface MemberGroupRoleConfigRow {
  member_group_role_config_id: string;
  member_group_id: string;
  discord_role_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer;
  group_type: MemberGroupType;
  group_name: string;
}

interface MemberGroupProfileRow {
  member_group_profile_id: string;
  member_group_id: string;
  discord_guild_id: string;
  discord_user_id: string | null;
  albion_server: AlbionServer;
  albion_character_id: string;
}

interface GroupPositionRow {
  member_group_position_id: string;
  discord_guild_id: string;
  member_group_id: string;
  name: string;
  discord_role_id: string;
  albion_server: AlbionServer;
  group_type: MemberGroupType;
  group_name: string;
}

interface GroupPositionAppointmentRow {
  member_group_position_appointment_id: string;
  member_group_position_id: string;
  member_group_profile_id: string;
  discord_guild_id: string;
  name: string;
  discord_role_id: string;
  member_group_id: string;
  albion_server: AlbionServer;
  group_type: MemberGroupType;
  group_name: string;
  discord_user_id: string | null;
  albion_character_id: string;
  character_name: string;
}

function mapRegisteredCharacter(row: RegisteredCharacterRow, characterName: string): RegisteredCharacter {
  return {
    discordGuildId: row.discord_guild_id,
    discordUserId: row.discord_user_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName
  };
}

function mapCharacterRecord(row: CharacterRecordRow): CharacterRecord {
  return {
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    guildName: row.guild_name ?? undefined,
    allianceName: row.alliance_name ?? undefined
  };
}

function mapMemberGroup(row: MemberGroupRow): MemberGroup {
  return {
    memberGroupId: row.member_group_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server,
    groupType: row.group_type,
    groupName: row.group_name
  };
}

function mapArchivedApplicationClassTarget(row: ApplicationClassRemovalRow): ArchivedApplicationClassTarget {
  return {
    applicationClassId: row.application_class_id,
    sourceChannelId: row.source_channel_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined
  };
}

function mapArchivedApplicationTarget(row: ArchivedApplicationRemovalRow): ArchivedApplicationTarget {
  return {
    applicationId: row.application_id,
    applicationClassId: row.application_class_id,
    applicantDiscordUserId: row.applicant_discord_user_id,
    ticketChannelId: row.ticket_channel_id ?? undefined,
    reviewerRoleId: row.reviewer_role_id,
    activeRoleId: row.active_role_id ?? undefined,
    channelStatus: row.channel_status,
    channelClosedByRemoval: row.channel_closed_by_removal
  };
}

function mapConfiguredAlbionGuild(row: ConfiguredAlbionGuildRow): ConfiguredAlbionGuild {
  return {
    ...mapMemberGroup(row),
    albionGuildId: row.albion_guild_id,
    albionGuildName: row.albion_guild_name,
    managed: row.managed
  };
}

function mapConfiguredAlbionAlliance(row: ConfiguredAlbionAllianceRow): ConfiguredAlbionAlliance {
  return {
    ...mapMemberGroup(row),
    albionAllianceId: row.albion_alliance_id,
    albionAllianceName: row.albion_alliance_name,
    albionAllianceTag: row.albion_alliance_tag ?? undefined
  };
}

function mapCharacterRoleConfig(row: CharacterRoleConfigRow): CharacterRoleConfig {
  return {
    characterRoleConfigId: row.character_role_config_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server ?? undefined,
    discordRoleId: row.discord_role_id
  };
}

function mapMemberGroupRoleConfig(row: MemberGroupRoleConfigRow): MemberGroupRoleConfig {
  return {
    memberGroupRoleConfigId: row.member_group_role_config_id,
    memberGroupId: row.member_group_id,
    discordRoleId: row.discord_role_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server,
    groupType: row.group_type,
    groupName: row.group_name
  };
}

function mapMemberGroupProfile(row: MemberGroupProfileRow): MemberGroupProfile {
  return mapLifecycleProfile(row);
}

function groupPositionSelectSql(whereAndOrder: string): string {
  return `
    select
      position.member_group_position_id,
      position.discord_guild_id,
      position.member_group_id,
      position.name,
      position.discord_role_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name
    from member_group_positions position
    join member_groups mg on mg.member_group_id = position.member_group_id
    ${whereAndOrder}
  `;
}

function groupPositionAppointmentSelectSql(whereAndOrder: string): string {
  return `
    select
      appointment.member_group_position_appointment_id,
      appointment.member_group_position_id,
      appointment.member_group_profile_id,
      appointment.discord_guild_id,
      position.name,
      position.discord_role_id,
      mg.member_group_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      mgp.discord_user_id,
      mgp.albion_character_id,
      ac.character_name
    from member_group_position_appointments appointment
    join member_group_positions position
      on position.member_group_position_id = appointment.member_group_position_id
      and position.discord_guild_id = appointment.discord_guild_id
    join member_groups mg on mg.member_group_id = position.member_group_id
    join member_group_profiles mgp on mgp.member_group_profile_id = appointment.member_group_profile_id
    join albion_characters ac
      on ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
    ${whereAndOrder}
  `;
}

function groupPositionAppointmentMutationSql(mutationSql: string): string {
  return `
    with changed_appointment as (
      ${mutationSql}
    )
    select
      changed_appointment.member_group_position_appointment_id,
      changed_appointment.member_group_position_id,
      changed_appointment.member_group_profile_id,
      changed_appointment.discord_guild_id,
      position.name,
      position.discord_role_id,
      mg.member_group_id,
      mg.albion_server,
      mg.group_type,
      mg.group_name,
      mgp.discord_user_id,
      mgp.albion_character_id,
      ac.character_name
    from changed_appointment
    join member_group_positions position
      on position.member_group_position_id = changed_appointment.member_group_position_id
      and position.discord_guild_id = changed_appointment.discord_guild_id
    join member_groups mg on mg.member_group_id = position.member_group_id
    join member_group_profiles mgp on mgp.member_group_profile_id = changed_appointment.member_group_profile_id
    join albion_characters ac
      on ac.albion_server = mgp.albion_server
      and ac.albion_character_id = mgp.albion_character_id
  `;
}

function mapGroupPosition(row: GroupPositionRow): GroupPosition {
  return {
    memberGroupPositionId: row.member_group_position_id,
    discordGuildId: row.discord_guild_id,
    memberGroupId: row.member_group_id,
    name: row.name,
    discordRoleId: row.discord_role_id,
    albionServer: row.albion_server,
    groupType: row.group_type,
    groupName: row.group_name
  };
}

function mapGroupPositionAppointment(row: GroupPositionAppointmentRow): GroupPositionAppointment {
  return {
    memberGroupPositionAppointmentId: row.member_group_position_appointment_id,
    memberGroupPositionId: row.member_group_position_id,
    memberGroupProfileId: row.member_group_profile_id,
    discordGuildId: row.discord_guild_id,
    name: row.name,
    discordRoleId: row.discord_role_id,
    memberGroupId: row.member_group_id,
    albionServer: row.albion_server,
    groupType: row.group_type,
    groupName: row.group_name,
    discordUserId: row.discord_user_id ?? undefined,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name
  };
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

/** Decorates exact affected rows before their group/character display metadata can disappear. */
function profileChangeSql(mutation: string): string {
  return `with changed as (${mutation})
    select changed.*, mg.group_name, mg.group_type, ac.character_name
    from changed
    join member_groups mg on mg.member_group_id = changed.member_group_id and mg.discord_guild_id = changed.discord_guild_id
    join albion_characters ac on ac.albion_server = changed.albion_server and ac.albion_character_id = changed.albion_character_id`;
}

async function adoptOrphanProfiles(client: Queryable, input: RegisterCharacterInput, pending: LogChange[]): Promise<void> {
  const mutation = `update member_group_profiles p
    set discord_user_id = $2, lifecycle_state = 'current', entitlement_preserved = true,
      departure_detected_at = null, departure_expires_at = null, lifecycle_check_failed_at = null, updated_at = now()
    where p.discord_guild_id = $1 and p.discord_user_id is null and p.albion_server = $3 and p.albion_character_id = $4
      and (p.member_group_id = any($5::bigint[]) or exists (select 1 from member_groups g where g.member_group_id = p.member_group_id and g.group_type = 'group'))`;
  const capture = isLogCaptureActive(input.discordGuildId);
  const result = await client.query<MemberGroupProfileRow>(capture ? profileChangeSql(`${mutation} returning p.*`) : mutation,
    [input.discordGuildId, input.discordUserId, input.albionServer, input.player.id, input.recovery?.verifiedMemberGroupIds ?? []]);
  if (capture) for (const row of result.rows) pending.push({ kind: "profile", action: "joined", profile: mapMemberGroupProfile(row) });
}

async function addCapturedProfile(pool: Queryable, input: ProfileInput, pending?: LogChange[], owner?: string): Promise<MemberGroupProfile | undefined> {
  const registered = owner !== undefined;
  // The conflict predicate evaluates the locked current tuple, so concurrent
  // identical additions cannot both claim a membership change.
  const result = await pool.query<MemberGroupProfileRow>(profileChangeSql(`
    insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id, discovered_at, lifecycle_state, entitlement_preserved, updated_at)
    ${registered ? `select $1, $2, $3, $4, $5, null, 'current', true, now() from discord_user_characters
      where discord_guild_id = $2 and discord_user_id = $3 and albion_server = $4 and albion_character_id = $5
      and not exists (select 1 from member_registration_lifecycle r where r.discord_guild_id = $2 and r.albion_server = $4 and r.albion_character_id = $5)`
      : "values ($1, $2, $3, $4, $5, now(), 'unregistered', false, now())"}
    on conflict (member_group_id, albion_server, albion_character_id) ${registered
      ? `do update set discord_user_id = excluded.discord_user_id, lifecycle_state = 'current', entitlement_preserved = true, updated_at = excluded.updated_at
        where member_group_profiles.lifecycle_state <> 'departed' and (member_group_profiles.discord_user_id is distinct from excluded.discord_user_id or not member_group_profiles.entitlement_preserved)`
      : "do nothing"}
    returning *`), [input.memberGroupId, input.discordGuildId, owner ?? null, input.albionServer, input.albionCharacterId]);
  if (result.rows[0]) {
    const profile = mapMemberGroupProfile(result.rows[0]);
    const change: LogChange = { kind: "profile", action: "joined", profile };
    if (pending) pending.push(change);
    else recordLogChange(input.discordGuildId, change);
    return profile;
  }
  // Preserve the repository's existing return-on-no-change behavior without
  // claiming that a timestamp refresh changes membership.
  const existing = await pool.query<MemberGroupProfileRow>(profileChangeSql(`
    update member_group_profiles mgp set updated_at = now()
    where mgp.member_group_id = $1 and mgp.discord_guild_id = $2 and mgp.albion_server = $4 and mgp.albion_character_id = $5
      and ($3::text is null or mgp.discord_user_id = $3)
    returning mgp.*`),
  [input.memberGroupId, input.discordGuildId, owner ?? null, input.albionServer, input.albionCharacterId]);
  return existing.rows[0] ? mapMemberGroupProfile(existing.rows[0]) : undefined;
}

async function orphanCapturedProfiles(pool: Queryable, discordGuildId: string, predicate: string, values: unknown[]): Promise<OrphanedProfileResult> {
  const result = await pool.query<MemberGroupProfileRow>(`
    with targets as materialized (
      select mgp.*, mg.group_name, mg.group_type, ac.character_name
      from member_group_profiles mgp
      join member_groups mg on mg.member_group_id = mgp.member_group_id and mg.discord_guild_id = mgp.discord_guild_id
      join albion_characters ac on ac.albion_server = mgp.albion_server and ac.albion_character_id = mgp.albion_character_id
      where ${predicate} and mgp.discord_user_id is not null
      for update of mgp
    ), changed as (
      update member_group_profiles mgp set discord_user_id = null, updated_at = now()
      from targets where mgp.member_group_profile_id = targets.member_group_profile_id and mgp.discord_guild_id = targets.discord_guild_id
      returning targets.*
    ) select * from changed`, values);
  for (const row of result.rows) recordLogChange(discordGuildId, { kind: "profile", action: "left", profile: mapMemberGroupProfile(row) });
  return { orphanedProfiles: result.rowCount ?? 0,
    affectedDiscordUserIds: distinct(result.rows.map((row) => row.discord_user_id).filter(isNonEmptyString)) };
}

/** Lock parents first: their foreign keys prevent a new owned profile racing the cascade. */
async function lockRegistrationProfiles(client: Queryable, predicate: string, values: unknown[]): Promise<MemberGroupProfile[]> {
  await client.query(`select discord_guild_id from discord_user_characters where ${predicate} for update`, values);
  const result = await client.query<MemberGroupProfileRow>(`
    select mgp.*, mg.group_name, mg.group_type, ac.character_name
    from member_group_profiles mgp
    join member_groups mg on mg.member_group_id = mgp.member_group_id and mg.discord_guild_id = mgp.discord_guild_id
    join albion_characters ac on ac.albion_server = mgp.albion_server and ac.albion_character_id = mgp.albion_character_id
    where ${predicate.replace(/\b(discord_guild_id|discord_user_id|albion_server|albion_character_id)\b/g, "mgp.$1")}
    for update of mgp`, values);
  return result.rows.map(mapMemberGroupProfile);
}

async function mutateProfileAtomically<T>(pool: PostgresPool, ref: ProfileInput, mutation: (client: Queryable, changes: LogChange[]) => Promise<T>): Promise<T> {
  const client = await pool.connect(); const changes: LogChange[] = [];
  try {
    await client.query("begin"); await lockCharacterEntitlements(client, ref);
    const result = await mutation(client, changes); await client.query("commit");
    for (const change of changes) recordLogChange(ref.discordGuildId, change);
    return result;
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
