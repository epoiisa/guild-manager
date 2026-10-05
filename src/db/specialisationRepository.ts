import { lockCharacterEntitlements } from "./membershipEntitlementCleanup.js";
import type { PoolClient } from "pg";
import type { AlbionServer } from "../services/albion/servers.js";
import type {
  CatalogueEntry,
  SpecialisationKind,
  SpecialisationLevel
} from "../services/specialisations/catalogue.js";
import {
  SPECIALISATION_CATALOGUE,
  catalogueByKey
} from "../services/specialisations/catalogue.js";
import type { PostgresPool } from "./postgres.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type SpecialisationRequestState = "pending" | "confirmed" | "dismissed";
export type SpecialisationRecordSource = "request" | "manual";
export type SpecialisationRecordState = "active" | "removed" | "all";

export class SpecialisationOperationError extends Error {
  constructor(public readonly code:
    | "active_exists"
    | "active_not_found"
    | "character_ineligible"
    | "pending_exists"
    | "proof_missing"
    | "request_not_found"
    | "submitter_ineligible"
    | "target_disabled"
  ) {
    super(code);
    this.name = "SpecialisationOperationError";
  }
}

export interface CatalogueExclusion {
  discordGuildId: string;
  catalogueKey: string;
  excludedByDiscordUserId: string;
  excludedAt: Date;
}

export interface EligibleSpecialisationCharacter {
  discordGuildId: string;
  discordUserId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
}

export interface SpecialisationRequest {
  specialisationRequestId: string;
  discordGuildId: string;
  submittedByDiscordUserId: string;
  currentOwnerDiscordUserId?: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  targetKey: string;
  targetKind: SpecialisationKind;
  targetDisplayName: string;
  level: SpecialisationLevel;
  state: SpecialisationRequestState;
  reviewedByDiscordUserId?: string;
  reviewedAt?: Date;
  reviewChannelId: string;
  reviewMessageId?: string;
  reviewMessageDeletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CharacterSpecialisation {
  characterSpecialisationId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  targetKey: string;
  targetKind: SpecialisationKind;
  targetDisplayName: string;
  level: SpecialisationLevel;
  source: SpecialisationRecordSource;
  sourceRequestId?: string;
  recordedByDiscordUserId: string;
  recordedAt: Date;
  removedByDiscordUserId?: string;
  removedAt?: Date;
}

export interface ReserveSpecialisationRequestInput {
  discordGuildId: string;
  submittedByDiscordUserId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  target: CatalogueEntry;
  level: SpecialisationLevel;
  reviewChannelId: string;
}

export interface DecideSpecialisationRequestInput {
  discordGuildId: string;
  specialisationRequestId: string;
  decision: "confirmed" | "dismissed";
  reviewerDiscordUserId: string;
  proofAvailable: boolean;
}

export interface DecideSpecialisationRequestResult {
  request: SpecialisationRequest;
  characterSpecialisation?: CharacterSpecialisation;
  changed: boolean;
}

export interface ManualSpecialisationInput {
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  target: CatalogueEntry;
  level: SpecialisationLevel;
  actorDiscordUserId: string;
}

export interface SpecialisationRequestFilters {
  state?: SpecialisationRequestState | "all";
  albionServer?: AlbionServer;
  albionCharacterId?: string;
}

export interface SpecialisationRecordFilters {
  state?: SpecialisationRecordState;
  albionServer?: AlbionServer;
  albionCharacterId?: string;
}

interface ExclusionRow {
  discord_guild_id: string;
  catalogue_key: string;
  excluded_by_discord_user_id: string;
  excluded_at: Date;
}

interface EligibleCharacterRow {
  discord_guild_id: string;
  discord_user_id: string;
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
}

interface RequestRow {
  specialisation_request_id: string;
  discord_guild_id: string;
  submitted_by_discord_user_id: string;
  current_owner_discord_user_id?: string | null;
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  target_key: string;
  target_kind: SpecialisationKind;
  target_display_name: string;
  level: SpecialisationLevel;
  state: SpecialisationRequestState;
  reviewed_by_discord_user_id: string | null;
  reviewed_at: Date | null;
  review_channel_id: string;
  review_message_id: string | null;
  review_message_deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SpecialisationRow {
  character_specialisation_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  target_key: string;
  target_kind: SpecialisationKind;
  target_display_name: string;
  level: SpecialisationLevel;
  source: SpecialisationRecordSource;
  source_request_id: string | null;
  recorded_by_discord_user_id: string;
  recorded_at: Date;
  removed_by_discord_user_id: string | null;
  removed_at: Date | null;
}

export function createSpecialisationRepository(pool: PostgresPool) {
  return {
    listCatalogueExclusions: (discordGuildId: string) => listCatalogueExclusions(pool, discordGuildId),
    exclusionKeys: (discordGuildId: string) => exclusionKeys(pool, discordGuildId),
    replaceCatalogueExclusions: (
      discordGuildId: string,
      keys: readonly string[],
      actorDiscordUserId: string
    ) => replaceCatalogueExclusions(pool, discordGuildId, keys, actorDiscordUserId),
    listEligibleCharacters: (discordGuildId: string, discordUserId?: string) =>
      listEligibleCharacters(pool, discordGuildId, discordUserId),
    getEligibleCharacter: (
      discordGuildId: string,
      discordUserId: string,
      albionServer: AlbionServer,
      albionCharacterId: string
    ) => getEligibleCharacter(pool, discordGuildId, discordUserId, albionServer, albionCharacterId),
    getManagedCharacter: (
      discordGuildId: string,
      albionServer: AlbionServer,
      albionCharacterId: string
    ) => getManagedCharacter(pool, discordGuildId, albionServer, albionCharacterId),
    reserveRequest: (input: ReserveSpecialisationRequestInput) => reserveRequest(pool, input),
    attachReviewMessage: (
      discordGuildId: string,
      specialisationRequestId: string,
      reviewMessageId: string
    ) => attachReviewMessage(pool, discordGuildId, specialisationRequestId, reviewMessageId),
    deleteUnattachedPendingRequest: (discordGuildId: string, specialisationRequestId: string) =>
      deleteUnattachedPendingRequest(pool, discordGuildId, specialisationRequestId),
    getRequest: (discordGuildId: string, specialisationRequestId: string) =>
      getRequest(pool, discordGuildId, specialisationRequestId),
    getRequestByReviewMessage: (discordGuildId: string, reviewMessageId: string) =>
      getRequestByReviewMessage(pool, discordGuildId, reviewMessageId),
    listRequests: (discordGuildId: string, filters: SpecialisationRequestFilters = {}) =>
      listRequests(pool, discordGuildId, filters),
    markReviewMessageDeleted: (discordGuildId: string, reviewMessageId: string) =>
      markReviewMessageDeleted(pool, discordGuildId, reviewMessageId),
    decideRequest: (input: DecideSpecialisationRequestInput) => decideRequest(pool, input),
    addManualSpecialisation: (input: ManualSpecialisationInput) => addManualSpecialisation(pool, input),
    removeSpecialisation: (
      discordGuildId: string,
      characterSpecialisationId: string,
      actorDiscordUserId: string
    ) => removeSpecialisation(pool, discordGuildId, characterSpecialisationId, actorDiscordUserId),
    getSpecialisation: (discordGuildId: string, characterSpecialisationId: string) =>
      getSpecialisation(pool, discordGuildId, characterSpecialisationId),
    listSpecialisations: (discordGuildId: string, filters: SpecialisationRecordFilters = {}) =>
      listSpecialisations(pool, discordGuildId, filters),
    listSpecialisationsForOwner: (discordGuildId: string, discordUserId: string) =>
      listSpecialisationsForOwner(pool, discordGuildId, discordUserId)
  };
}

export type SpecialisationRepository = ReturnType<typeof createSpecialisationRepository>;

async function listCatalogueExclusions(
  pool: Queryable,
  discordGuildId: string
): Promise<CatalogueExclusion[]> {
  const result = await pool.query<ExclusionRow>(
    `
    select * from specialisation_catalogue_exclusions
    where discord_guild_id = $1
    order by catalogue_key
    `,
    [discordGuildId]
  );
  return result.rows.map(mapExclusion);
}

async function exclusionKeys(pool: Queryable, discordGuildId: string): Promise<Set<string>> {
  return new Set((await listCatalogueExclusions(pool, discordGuildId)).map((row) => row.catalogueKey));
}

async function replaceCatalogueExclusions(
  pool: PostgresPool,
  discordGuildId: string,
  keys: readonly string[],
  actorDiscordUserId: string
): Promise<CatalogueExclusion[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `select discord_guild_id from discord_guild_lifecycle where discord_guild_id = $1 for update`,
      [discordGuildId]
    );
    await client.query(`delete from specialisation_catalogue_exclusions where discord_guild_id = $1`, [discordGuildId]);
    const uniqueKeys = [...new Set(keys)].sort();
    if (uniqueKeys.length > 0) {
      await client.query(
        `
        insert into specialisation_catalogue_exclusions (
          discord_guild_id, catalogue_key, excluded_by_discord_user_id
        )
        select $1, key, $3 from unnest($2::text[]) as key
        `,
        [discordGuildId, uniqueKeys, actorDiscordUserId]
      );
    }
    const exclusions = await listCatalogueExclusions(client, discordGuildId);
    await client.query("commit");
    return exclusions;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function listEligibleCharacters(
  pool: Queryable,
  discordGuildId: string,
  discordUserId?: string
): Promise<EligibleSpecialisationCharacter[]> {
  const result = await pool.query<EligibleCharacterRow>(
    `
    select registration.discord_guild_id, registration.discord_user_id,
      registration.albion_server, registration.albion_character_id, character.character_name
    from discord_user_characters registration
    join albion_characters character
      on character.albion_server = registration.albion_server
      and character.albion_character_id = registration.albion_character_id
    where registration.discord_guild_id = $1
      and ($2::text is null or registration.discord_user_id = $2)
      and exists (
        select 1 from member_group_profiles profile
        where profile.discord_guild_id = registration.discord_guild_id
          and profile.discord_user_id = registration.discord_user_id
          and profile.albion_server = registration.albion_server
          and profile.albion_character_id = registration.albion_character_id
          and character_has_active_membership(registration.discord_guild_id, registration.albion_server, registration.albion_character_id, registration.discord_user_id)
      )
    order by character.character_name, registration.albion_server, registration.albion_character_id
    `,
    [discordGuildId, discordUserId ?? null]
  );
  return result.rows.map(mapEligibleCharacter);
}

async function getEligibleCharacter(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<EligibleSpecialisationCharacter | undefined> {
  const result = await pool.query<EligibleCharacterRow>(
    `
    select registration.discord_guild_id, registration.discord_user_id,
      registration.albion_server, registration.albion_character_id, character.character_name
    from discord_user_characters registration
    join albion_characters character
      on character.albion_server = registration.albion_server
      and character.albion_character_id = registration.albion_character_id
    where registration.discord_guild_id = $1 and registration.discord_user_id = $2
      and registration.albion_server = $3 and registration.albion_character_id = $4
      and exists (
        select 1 from member_group_profiles profile
        where profile.discord_guild_id = registration.discord_guild_id
          and profile.discord_user_id = registration.discord_user_id
          and profile.albion_server = registration.albion_server
          and profile.albion_character_id = registration.albion_character_id
          and character_has_active_membership(registration.discord_guild_id, registration.albion_server, registration.albion_character_id, registration.discord_user_id)
      )
    limit 1
    `,
    [discordGuildId, discordUserId, albionServer, albionCharacterId]
  );
  return result.rows[0] ? mapEligibleCharacter(result.rows[0]) : undefined;
}

async function getManagedCharacter(
  pool: Queryable,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<EligibleSpecialisationCharacter | undefined> {
  const result = await pool.query<EligibleCharacterRow>(
    `
    select registration.discord_guild_id, registration.discord_user_id,
      registration.albion_server, registration.albion_character_id, character.character_name
    from discord_user_characters registration
    join albion_characters character
      on character.albion_server = registration.albion_server
      and character.albion_character_id = registration.albion_character_id
    where registration.discord_guild_id = $1 and registration.albion_server = $2
      and registration.albion_character_id = $3
      and exists (
        select 1 from member_group_profiles profile
        where profile.discord_guild_id = registration.discord_guild_id
          and profile.discord_user_id = registration.discord_user_id
          and profile.albion_server = registration.albion_server
          and profile.albion_character_id = registration.albion_character_id
          and character_has_active_membership(registration.discord_guild_id, registration.albion_server, registration.albion_character_id, registration.discord_user_id)
      )
    limit 1
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return result.rows[0] ? mapEligibleCharacter(result.rows[0]) : undefined;
}

async function reserveRequest(
  pool: PostgresPool,
  input: ReserveSpecialisationRequestInput
): Promise<SpecialisationRequest> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, input);
    await lockGuildCatalogue(client, input.discordGuildId);
    await requireTargetEnabled(client, input.discordGuildId, input.target.key);
    await lockTarget(client, input);
    if (!await getEligibleCharacter(
      client,
      input.discordGuildId,
      input.submittedByDiscordUserId,
      input.albionServer,
      input.albionCharacterId
    )) {
      throw new SpecialisationOperationError("submitter_ineligible");
    }
    await requireNoActiveOrPending(client, input, true);
    const result = await client.query<RequestRow>(
      `
      insert into specialisation_requests (
        discord_guild_id, submitted_by_discord_user_id, albion_server, albion_character_id,
        target_key, target_kind, target_display_name, level, review_channel_id
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning ${requestColumns("specialisation_requests")},
        (select character_name from albion_characters
          where albion_server = $3 and albion_character_id = $4) as character_name
      `,
      [
        input.discordGuildId,
        input.submittedByDiscordUserId,
        input.albionServer,
        input.albionCharacterId,
        input.target.key,
        input.target.kind,
        input.target.name,
        input.level,
        input.reviewChannelId
      ]
    );
    await client.query("commit");
    return mapRequest(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function attachReviewMessage(
  pool: Queryable,
  discordGuildId: string,
  specialisationRequestId: string,
  reviewMessageId: string
): Promise<SpecialisationRequest> {
  const result = await pool.query<RequestRow>(
    `
    update specialisation_requests request
    set review_message_id = $3, review_message_deleted_at = null, updated_at = now()
    from albion_characters character
    where request.discord_guild_id = $1 and request.specialisation_request_id = $2
      and request.state = 'pending'
      and (request.review_message_id is null or request.review_message_id = $3)
      and character.albion_server = request.albion_server
      and character.albion_character_id = request.albion_character_id
    returning ${requestColumns("request")}, character.character_name
    `,
    [discordGuildId, specialisationRequestId, reviewMessageId]
  );
  if (!result.rows[0]) throw new SpecialisationOperationError("request_not_found");
  return mapRequest(result.rows[0]);
}

async function deleteUnattachedPendingRequest(
  pool: Queryable,
  discordGuildId: string,
  specialisationRequestId: string
): Promise<boolean> {
  const result = await pool.query(
    `
    delete from specialisation_requests
    where discord_guild_id = $1 and specialisation_request_id = $2
      and state = 'pending' and review_message_id is null
    `,
    [discordGuildId, specialisationRequestId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function getRequest(
  pool: Queryable,
  discordGuildId: string,
  specialisationRequestId: string
): Promise<SpecialisationRequest | undefined> {
  const result = await pool.query<RequestRow>(
    `${requestSelect()} where request.discord_guild_id = $1 and request.specialisation_request_id = $2`,
    [discordGuildId, specialisationRequestId]
  );
  return result.rows[0] ? mapRequest(result.rows[0]) : undefined;
}

async function getRequestByReviewMessage(
  pool: Queryable,
  discordGuildId: string,
  reviewMessageId: string
): Promise<SpecialisationRequest | undefined> {
  const result = await pool.query<RequestRow>(
    `${requestSelect()} where request.discord_guild_id = $1 and request.review_message_id = $2`,
    [discordGuildId, reviewMessageId]
  );
  return result.rows[0] ? mapRequest(result.rows[0]) : undefined;
}

async function listRequests(
  pool: Queryable,
  discordGuildId: string,
  filters: SpecialisationRequestFilters
): Promise<SpecialisationRequest[]> {
  const state = filters.state ?? "all";
  const result = await pool.query<RequestRow>(
    `
    ${requestSelect()}
    where request.discord_guild_id = $1
      and ($2::text = 'all' or request.state = $2)
      and ($3::text is null or request.albion_server = $3)
      and ($4::text is null or request.albion_character_id = $4)
    order by request.created_at, request.specialisation_request_id
    `,
    [discordGuildId, state, filters.albionServer ?? null, filters.albionCharacterId ?? null]
  );
  return result.rows.map(mapRequest);
}

async function markReviewMessageDeleted(
  pool: Queryable,
  discordGuildId: string,
  reviewMessageId: string
): Promise<SpecialisationRequest | undefined> {
  const result = await pool.query<RequestRow>(
    `
    update specialisation_requests request
    set review_message_deleted_at = coalesce(review_message_deleted_at, now()), updated_at = now()
    from albion_characters character
    where request.discord_guild_id = $1 and request.review_message_id = $2
      and character.albion_server = request.albion_server
      and character.albion_character_id = request.albion_character_id
    returning ${requestColumns("request")}, character.character_name
    `,
    [discordGuildId, reviewMessageId]
  );
  return result.rows[0] ? mapRequest(result.rows[0]) : undefined;
}

async function decideRequest(
  pool: PostgresPool,
  input: DecideSpecialisationRequestInput
): Promise<DecideSpecialisationRequestResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtextextended(
      'membership-entitlements:' || discord_guild_id || ':' || albion_server || ':' || albion_character_id, 0))
      from specialisation_requests where discord_guild_id = $1 and specialisation_request_id = $2`,
      [input.discordGuildId, input.specialisationRequestId]);
    const locked = await client.query<RequestRow>(
      `${requestSelect()} where request.discord_guild_id = $1 and request.specialisation_request_id = $2 for update of request`,
      [input.discordGuildId, input.specialisationRequestId]
    );
    if (!locked.rows[0]) throw new SpecialisationOperationError("request_not_found");
    let request = mapRequest(locked.rows[0]);
    if (request.state !== "pending") {
      const characterSpecialisation = request.state === "confirmed"
        ? await getSpecialisationByRequest(client, input.discordGuildId, input.specialisationRequestId)
        : undefined;
      await client.query("commit");
      return { request, characterSpecialisation, changed: false };
    }

    let characterSpecialisation: CharacterSpecialisation | undefined;
    if (input.decision === "confirmed") {
      if (!input.proofAvailable || !request.reviewMessageId || request.reviewMessageDeletedAt) {
        throw new SpecialisationOperationError("proof_missing");
      }
      await lockTarget(client, request);
      if (!await getManagedCharacter(
        client,
        request.discordGuildId,
        request.albionServer,
        request.albionCharacterId
      )) {
        throw new SpecialisationOperationError("submitter_ineligible");
      }
      if (await activeExists(client, request)) {
        throw new SpecialisationOperationError("active_exists");
      }
      const inserted = await client.query<SpecialisationRow>(
        `
        insert into character_specialisations (
          discord_guild_id, albion_server, albion_character_id, target_key, target_kind,
          target_display_name, level, source, source_request_id, recorded_by_discord_user_id
        ) values ($1, $2, $3, $4, $5, $6, $7, 'request', $8, $9)
        returning ${specialisationColumns("character_specialisations")},
          (select character_name from albion_characters
            where albion_server = $2 and albion_character_id = $3) as character_name
        `,
        [
          request.discordGuildId,
          request.albionServer,
          request.albionCharacterId,
          request.targetKey,
          request.targetKind,
          request.targetDisplayName,
          request.level,
          request.specialisationRequestId,
          input.reviewerDiscordUserId
        ]
      );
      characterSpecialisation = mapSpecialisation(inserted.rows[0]);
      await softRemoveWeaponsCoveredByTree(client, request, input.reviewerDiscordUserId);
    }

    const updated = await client.query<RequestRow>(
      `
      update specialisation_requests request
      set state = $3, reviewed_by_discord_user_id = $4, reviewed_at = now(), updated_at = now()
      from albion_characters character
      where request.discord_guild_id = $1 and request.specialisation_request_id = $2
        and request.state = 'pending'
        and character.albion_server = request.albion_server
        and character.albion_character_id = request.albion_character_id
      returning ${requestColumns("request")}, character.character_name
      `,
      [input.discordGuildId, input.specialisationRequestId, input.decision, input.reviewerDiscordUserId]
    );
    request = mapRequest(updated.rows[0]);
    await client.query("commit");
    return { request, characterSpecialisation, changed: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function addManualSpecialisation(
  pool: PostgresPool,
  input: ManualSpecialisationInput
): Promise<CharacterSpecialisation> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, input);
    await lockGuildCatalogue(client, input.discordGuildId);
    await requireTargetEnabled(client, input.discordGuildId, input.target.key);
    await lockTarget(client, input);
    if (!await getManagedCharacter(
      client,
      input.discordGuildId,
      input.albionServer,
      input.albionCharacterId
    )) {
      throw new SpecialisationOperationError("character_ineligible");
    }
    await requireNoActiveOrPending(client, input, true);
    const result = await client.query<SpecialisationRow>(
      `
      insert into character_specialisations (
        discord_guild_id, albion_server, albion_character_id, target_key, target_kind,
        target_display_name, level, source, recorded_by_discord_user_id
      ) values ($1, $2, $3, $4, $5, $6, $7, 'manual', $8)
      returning ${specialisationColumns("character_specialisations")},
        (select character_name from albion_characters
          where albion_server = $2 and albion_character_id = $3) as character_name
      `,
      [
        input.discordGuildId,
        input.albionServer,
        input.albionCharacterId,
        input.target.key,
        input.target.kind,
        input.target.name,
        input.level,
        input.actorDiscordUserId
      ]
    );
    await softRemoveWeaponsCoveredByTree(client, input, input.actorDiscordUserId);
    await client.query("commit");
    return mapSpecialisation(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeSpecialisation(
  pool: PostgresPool,
  discordGuildId: string,
  characterSpecialisationId: string,
  actorDiscordUserId: string
): Promise<CharacterSpecialisation> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<SpecialisationRow>(
      `${specialisationSelect()} where specialisation.discord_guild_id = $1
        and specialisation.character_specialisation_id = $2 for update of specialisation`,
      [discordGuildId, characterSpecialisationId]
    );
    if (!locked.rows[0] || locked.rows[0].removed_at) {
      throw new SpecialisationOperationError("active_not_found");
    }
    await lockTarget(client, mapSpecialisation(locked.rows[0]));
    const result = await client.query<SpecialisationRow>(
      `
      update character_specialisations specialisation
      set removed_by_discord_user_id = $3, removed_at = now()
      from albion_characters character
      where specialisation.discord_guild_id = $1
        and specialisation.character_specialisation_id = $2
        and specialisation.removed_at is null
        and character.albion_server = specialisation.albion_server
        and character.albion_character_id = specialisation.albion_character_id
      returning ${specialisationColumns("specialisation")}, character.character_name
      `,
      [discordGuildId, characterSpecialisationId, actorDiscordUserId]
    );
    await client.query("commit");
    return mapSpecialisation(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getSpecialisation(
  pool: Queryable,
  discordGuildId: string,
  characterSpecialisationId: string
): Promise<CharacterSpecialisation | undefined> {
  const result = await pool.query<SpecialisationRow>(
    `${specialisationSelect()} where specialisation.discord_guild_id = $1
      and specialisation.character_specialisation_id = $2`,
    [discordGuildId, characterSpecialisationId]
  );
  return result.rows[0] ? mapSpecialisation(result.rows[0]) : undefined;
}

async function listSpecialisations(
  pool: Queryable,
  discordGuildId: string,
  filters: SpecialisationRecordFilters
): Promise<CharacterSpecialisation[]> {
  const state = filters.state ?? "active";
  const result = await pool.query<SpecialisationRow>(
    `
    ${specialisationSelect()}
    where specialisation.discord_guild_id = $1
      and ($2::text = 'all'
        or ($2 = 'active' and specialisation.removed_at is null)
        or ($2 = 'removed' and specialisation.removed_at is not null))
      and ($3::text is null or specialisation.albion_server = $3)
      and ($4::text is null or specialisation.albion_character_id = $4)
    order by character.character_name, specialisation.albion_server,
      specialisation.target_kind desc, specialisation.target_display_name,
      specialisation.recorded_at, specialisation.character_specialisation_id
    `,
    [discordGuildId, state, filters.albionServer ?? null, filters.albionCharacterId ?? null]
  );
  return result.rows.map(mapSpecialisation);
}

async function listSpecialisationsForOwner(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string
): Promise<CharacterSpecialisation[]> {
  const result = await pool.query<SpecialisationRow>(
    `
    ${specialisationSelect()}
    join discord_user_characters registration
      on registration.discord_guild_id = specialisation.discord_guild_id
      and registration.albion_server = specialisation.albion_server
      and registration.albion_character_id = specialisation.albion_character_id
    where specialisation.discord_guild_id = $1 and registration.discord_user_id = $2
      and specialisation.removed_at is null
    order by character.character_name, specialisation.albion_server,
      specialisation.target_kind desc, specialisation.target_display_name
    `,
    [discordGuildId, discordUserId]
  );
  return result.rows.map(mapSpecialisation);
}

async function getSpecialisationByRequest(
  pool: Queryable,
  discordGuildId: string,
  specialisationRequestId: string
): Promise<CharacterSpecialisation | undefined> {
  const result = await pool.query<SpecialisationRow>(
    `${specialisationSelect()} where specialisation.discord_guild_id = $1
      and specialisation.source_request_id = $2`,
    [discordGuildId, specialisationRequestId]
  );
  return result.rows[0] ? mapSpecialisation(result.rows[0]) : undefined;
}

async function requireNoActiveOrPending(
  pool: Queryable,
  target: TargetReference,
  includePending: boolean
): Promise<void> {
  if (await activeExists(pool, target)) throw new SpecialisationOperationError("active_exists");
  if (!includePending) return;
  const pendingKeys = pendingTargetKeys(target);
  const pending = await pool.query(
    `
    select 1 from specialisation_requests
    where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3
      and target_key = any($4::text[]) and state = 'pending'
    limit 1
    `,
    [...targetScopeValues(target), pendingKeys]
  );
  if ((pending.rowCount ?? 0) > 0) throw new SpecialisationOperationError("pending_exists");
}

async function activeExists(pool: Queryable, target: TargetReference): Promise<boolean> {
  const activeKeys = activeTargetKeys(target);
  const result = await pool.query(
    `
    select 1 from character_specialisations
    where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3
      and target_key = any($4::text[]) and removed_at is null
    limit 1
    `,
    [...targetScopeValues(target), activeKeys]
  );
  return (result.rowCount ?? 0) > 0;
}

async function softRemoveWeaponsCoveredByTree(
  pool: Queryable,
  target: TargetReference,
  actorDiscordUserId: string
): Promise<number> {
  const entry = targetEntry(target);
  if (entry?.kind !== "tree") return 0;
  const weaponKeys = weaponKeysForTree(entry.key);
  if (weaponKeys.length === 0) return 0;
  const result = await pool.query(
    `
    update character_specialisations
    set removed_by_discord_user_id = $4, removed_at = now()
    where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3
      and target_kind = 'weapon' and target_key = any($5::text[])
      and removed_at is null
    `,
    [...targetScopeValues(target), actorDiscordUserId, weaponKeys]
  );
  return result.rowCount ?? 0;
}

async function lockGuildCatalogue(pool: Queryable, discordGuildId: string): Promise<void> {
  await pool.query(
    `select discord_guild_id from discord_guild_lifecycle where discord_guild_id = $1 for share`,
    [discordGuildId]
  );
}

async function requireTargetEnabled(
  pool: Queryable,
  discordGuildId: string,
  targetKey: string
): Promise<void> {
  const result = await pool.query(
    `
    select 1 from specialisation_catalogue_exclusions
    where discord_guild_id = $1 and catalogue_key = $2
    limit 1
    `,
    [discordGuildId, targetKey]
  );
  if ((result.rowCount ?? 0) > 0) throw new SpecialisationOperationError("target_disabled");
}

interface TargetReference {
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  level: SpecialisationLevel;
  target?: CatalogueEntry;
  targetKey?: string;
}

async function lockTarget(pool: Queryable, target: TargetReference): Promise<void> {
  const familyKey = targetFamilyKey(target);
  await pool.query(
    `select pg_advisory_xact_lock(hashtextextended(
      concat_ws(chr(31), $1::text, $2::text, $3::text, $4::text), 0
    ))`,
    [...targetScopeValues(target), familyKey]
  );
}

function targetScopeValues(target: TargetReference): [string, AlbionServer, string] {
  return [target.discordGuildId, target.albionServer, target.albionCharacterId];
}

function targetEntry(target: TargetReference): CatalogueEntry | undefined {
  return target.target ?? (target.targetKey ? catalogueByKey.get(target.targetKey) : undefined);
}

function targetFamilyKey(target: TargetReference): string {
  const entry = targetEntry(target);
  const targetKey = entry?.key ?? target.targetKey;
  if (!targetKey) throw new Error("A specialisation target key is required.");
  return entry?.kind === "weapon" ? entry.treeKey ?? targetKey : targetKey;
}

function activeTargetKeys(target: TargetReference): string[] {
  const entry = targetEntry(target);
  const targetKey = entry?.key ?? target.targetKey;
  if (!targetKey) throw new Error("A specialisation target key is required.");
  return entry?.kind === "weapon" && entry.treeKey ? [targetKey, entry.treeKey] : [targetKey];
}

function pendingTargetKeys(target: TargetReference): string[] {
  const entry = targetEntry(target);
  const targetKey = entry?.key ?? target.targetKey;
  if (!targetKey) throw new Error("A specialisation target key is required.");
  if (entry?.kind === "weapon") return entry.treeKey ? [targetKey, entry.treeKey] : [targetKey];
  if (entry?.kind === "tree") return [targetKey, ...weaponKeysForTree(targetKey)];
  return [targetKey];
}

function weaponKeysForTree(treeKey: string): string[] {
  return SPECIALISATION_CATALOGUE
    .filter((entry) => entry.kind === "weapon" && entry.treeKey === treeKey)
    .map((entry) => entry.key);
}

function requestSelect(): string {
  return `
    select ${requestColumns("request")}, character.character_name
    from specialisation_requests request
    join albion_characters character
      on character.albion_server = request.albion_server
      and character.albion_character_id = request.albion_character_id
  `;
}

function requestColumns(alias: string): string {
  return `${alias}.specialisation_request_id, ${alias}.discord_guild_id,
    ${alias}.submitted_by_discord_user_id, ${alias}.albion_server, ${alias}.albion_character_id,
    ${alias}.target_key, ${alias}.target_kind, ${alias}.target_display_name, ${alias}.level,
    ${alias}.state, ${alias}.reviewed_by_discord_user_id, ${alias}.reviewed_at,
    ${alias}.review_channel_id, ${alias}.review_message_id, ${alias}.review_message_deleted_at,
    ${alias}.created_at, ${alias}.updated_at,
    (select owner.discord_user_id from discord_user_characters owner
      where owner.discord_guild_id = ${alias}.discord_guild_id
        and owner.albion_server = ${alias}.albion_server
        and owner.albion_character_id = ${alias}.albion_character_id
        and character_has_active_membership(owner.discord_guild_id, owner.albion_server, owner.albion_character_id, owner.discord_user_id)
      limit 1) as current_owner_discord_user_id`;
}

function specialisationSelect(): string {
  return `
    select ${specialisationColumns("specialisation")}, character.character_name
    from character_specialisations specialisation
    join albion_characters character
      on character.albion_server = specialisation.albion_server
      and character.albion_character_id = specialisation.albion_character_id
  `;
}

function specialisationColumns(alias: string): string {
  return `${alias}.character_specialisation_id, ${alias}.discord_guild_id,
    ${alias}.albion_server, ${alias}.albion_character_id, ${alias}.target_key,
    ${alias}.target_kind, ${alias}.target_display_name, ${alias}.level, ${alias}.source,
    ${alias}.source_request_id, ${alias}.recorded_by_discord_user_id, ${alias}.recorded_at,
    ${alias}.removed_by_discord_user_id, ${alias}.removed_at`;
}

function mapExclusion(row: ExclusionRow): CatalogueExclusion {
  return {
    discordGuildId: row.discord_guild_id,
    catalogueKey: row.catalogue_key,
    excludedByDiscordUserId: row.excluded_by_discord_user_id,
    excludedAt: row.excluded_at
  };
}

function mapEligibleCharacter(row: EligibleCharacterRow): EligibleSpecialisationCharacter {
  return {
    discordGuildId: row.discord_guild_id,
    discordUserId: row.discord_user_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name
  };
}

function mapRequest(row: RequestRow): SpecialisationRequest {
  return {
    specialisationRequestId: row.specialisation_request_id,
    discordGuildId: row.discord_guild_id,
    submittedByDiscordUserId: row.submitted_by_discord_user_id,
    currentOwnerDiscordUserId: row.current_owner_discord_user_id ?? undefined,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    targetKey: row.target_key,
    targetKind: row.target_kind,
    targetDisplayName: row.target_display_name,
    level: row.level,
    state: row.state,
    reviewedByDiscordUserId: row.reviewed_by_discord_user_id ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewChannelId: row.review_channel_id,
    reviewMessageId: row.review_message_id ?? undefined,
    reviewMessageDeletedAt: row.review_message_deleted_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSpecialisation(row: SpecialisationRow): CharacterSpecialisation {
  return {
    characterSpecialisationId: row.character_specialisation_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    targetKey: row.target_key,
    targetKind: row.target_kind,
    targetDisplayName: row.target_display_name,
    level: row.level,
    source: row.source,
    sourceRequestId: row.source_request_id ?? undefined,
    recordedByDiscordUserId: row.recorded_by_discord_user_id,
    recordedAt: row.recorded_at,
    removedByDiscordUserId: row.removed_by_discord_user_id ?? undefined,
    removedAt: row.removed_at ?? undefined
  };
}
