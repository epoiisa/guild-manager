import { lockCharacterEntitlements } from "./membershipEntitlementCleanup.js";
import type { PoolClient } from "pg";
import type { PostgresPool } from "./postgres.js";
import type { AlbionServer } from "../services/albion/servers.js";
import { createReviewerRepository } from "./reviewerRepository.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type RegearContentState = "open" | "closed";
export type RegearClaimStatus = "pending" | "accepted";

export const MAX_OPEN_REGEAR_CONTENT_PER_SERVER = 25;

export class RegearOperationError extends Error {
  constructor(public readonly code:
    | "admin_ineligible"
    | "content_limit"
    | "content_not_found"
    | "content_closed"
    | "claim_not_found"
    | "claim_resolved"
    | "character_ineligible"
    | "owner_changed"
    | "not_owner"
    | "reason_required"
    | "invalid_amount"
    | "account_not_found"
    | "account_frozen"
    | "account_closed"
  ) {
    super(code);
    this.name = "RegearOperationError";
  }
}

export interface EligibleRegearCharacter {
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  discordUserId: string;
}

export interface RegearContent {
  regearContentId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  name: string;
  contentDate: string;
  contentAt?: Date;
  state: RegearContentState;
  channelId: string;
  announcementMessageId?: string;
  createdByDiscordUserId: string;
  createdAt: Date;
  closedByDiscordUserId?: string;
  closedAt?: Date;
  updatedAt: Date;
}

export interface RegearClaim {
  regearClaimId: string;
  discordGuildId: string;
  regearContentId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  currentOwnerDiscordUserId?: string;
  originalSubmitterDiscordUserId: string;
  requestedValue: bigint;
  acceptedValue?: bigint;
  status: RegearClaimStatus;
  reviewChannelId: string;
  reviewMessageId: string;
  outcomeChannelId?: string;
  outcomeMessageId?: string;
  submittedAt: Date;
  updatedAt: Date;
  acceptedByDiscordUserId?: string;
  acceptedAt?: Date;
  acceptanceReason?: string;
  contentName: string;
  contentDate: string;
  contentAt?: Date;
  contentState: RegearContentState;
  contentChannelId: string;
}

export interface CreateRegearContentInput {
  discordGuildId: string;
  albionServer: AlbionServer;
  name: string;
  contentDate: string;
  contentAt?: Date;
  channelId: string;
  actorDiscordUserId: string;
  actorDiscordRoleIds?: readonly string[];
}

export interface CreatePendingRegearClaimInput {
  regearClaimId: string;
  discordGuildId: string;
  regearContentId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  expectedOwnerDiscordUserId: string;
  requestedValue: bigint;
  reviewChannelId: string;
  reviewMessageId: string;
}

export interface RegearClaimFilters {
  contentId?: string;
  ownerDiscordUserId?: string;
  status?: RegearClaimStatus | "all";
  albionServer?: AlbionServer;
}

interface CharacterRow {
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  discord_user_id: string;
}

interface ContentRow {
  regear_content_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer;
  name: string;
  content_date: string | Date;
  content_at: Date | null;
  state: RegearContentState;
  channel_id: string;
  announcement_message_id: string | null;
  created_by_discord_user_id: string;
  created_at: Date;
  closed_by_discord_user_id: string | null;
  closed_at: Date | null;
  updated_at: Date;
}

interface ClaimRow {
  regear_claim_id: string;
  discord_guild_id: string;
  regear_content_id: string;
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  current_owner_discord_user_id: string | null;
  original_submitter_discord_user_id: string;
  requested_value: string;
  accepted_value: string | null;
  status: RegearClaimStatus;
  review_channel_id: string;
  review_message_id: string;
  outcome_channel_id: string | null;
  outcome_message_id: string | null;
  submitted_at: Date;
  updated_at: Date;
  accepted_by_discord_user_id: string | null;
  accepted_at: Date | null;
  acceptance_reason: string | null;
  content_name: string;
  content_date: string | Date;
  content_at: Date | null;
  content_state: RegearContentState;
  content_channel_id: string;
}

export function createRegearRepository(pool: PostgresPool) {
  const reviewers = createReviewerRepository(pool);
  return {
    listReviewerRoleIds: (discordGuildId: string) =>
      reviewers.effectiveRoleIds(discordGuildId, "regears"),
    listEffectiveAdminServers: (discordGuildId: string, discordRoleIds: readonly string[] = []) =>
      listEffectiveAdminServers(pool, discordGuildId, discordRoleIds),
    isEffectiveAdministrator: (discordGuildId: string, discordRoleIds: readonly string[]) =>
      isEffectiveAdministrator(pool, discordGuildId, discordRoleIds),
    listEligibleCharactersForUser: (discordGuildId: string, discordUserId: string, albionServer?: AlbionServer) =>
      listEligibleCharactersForUser(pool, discordGuildId, discordUserId, albionServer),
    createContent: (input: CreateRegearContentInput) => createContent(pool, input),
    getContent: (discordGuildId: string, regearContentId: string) => getContent(pool, discordGuildId, regearContentId),
    listContents: (discordGuildId: string, albionServer?: AlbionServer, state?: RegearContentState) =>
      listContents(pool, discordGuildId, albionServer, state),
    closeContent: (discordGuildId: string, regearContentId: string, actorDiscordUserId: string, actorDiscordRoleIds: readonly string[] = []) =>
      setContentState(pool, discordGuildId, regearContentId, actorDiscordUserId, actorDiscordRoleIds, "closed"),
    reopenContent: (discordGuildId: string, regearContentId: string, actorDiscordUserId: string, actorDiscordRoleIds: readonly string[] = []) =>
      setContentState(pool, discordGuildId, regearContentId, actorDiscordUserId, actorDiscordRoleIds, "open"),
    setContentAnnouncement: (discordGuildId: string, regearContentId: string, channelId: string, messageId: string) =>
      setContentAnnouncement(pool, discordGuildId, regearContentId, channelId, messageId),
    clearAnnouncementByMessage: (discordGuildId: string, messageId: string) =>
      clearAnnouncementByMessage(pool, discordGuildId, messageId),
    createPendingClaim: (input: CreatePendingRegearClaimInput) => createPendingClaim(pool, input),
    getClaim: (discordGuildId: string, regearClaimId: string) => getClaim(pool, discordGuildId, regearClaimId),
    listClaimsForOwner: (discordGuildId: string, discordUserId: string) =>
      listClaimsForOwner(pool, discordGuildId, discordUserId),
    listClaimsForAdministrator: (discordGuildId: string, discordRoleIds: readonly string[] = [], filters: RegearClaimFilters = {}) =>
      listClaimsForAdministrator(pool, discordGuildId, discordRoleIds, filters),
    listPendingClaims: (discordGuildId: string) => listPendingClaims(pool, discordGuildId),
    listPendingClaimsForCharacter: (discordGuildId: string, albionServer: AlbionServer, albionCharacterId: string) =>
      listPendingClaimsForCharacter(pool, discordGuildId, albionServer, albionCharacterId),
    withdrawPendingClaim: (discordGuildId: string, regearClaimId: string, discordUserId: string) =>
      withdrawPendingClaim(pool, discordGuildId, regearClaimId, discordUserId),
    rejectPendingClaim: (discordGuildId: string, regearClaimId: string, discordUserId: string, discordRoleIds: readonly string[] = []) =>
      rejectPendingClaim(pool, discordGuildId, regearClaimId, discordUserId, discordRoleIds),
    removePendingClaim: (discordGuildId: string, regearClaimId: string) =>
      removePendingClaim(pool, discordGuildId, regearClaimId),
    removePendingByReviewMessage: (discordGuildId: string, reviewMessageId: string) =>
      removePendingByReviewMessage(pool, discordGuildId, reviewMessageId),
    acceptPendingClaim: (discordGuildId: string, regearClaimId: string, discordUserId: string, rolesOrValue?: readonly string[] | bigint, valueOrReason?: bigint | string, maybeReason?: string) =>
      acceptPendingClaim(pool, discordGuildId, regearClaimId, discordUserId,
        Array.isArray(rolesOrValue) ? rolesOrValue : [],
        (Array.isArray(rolesOrValue) ? valueOrReason : rolesOrValue) as bigint | undefined,
        (Array.isArray(rolesOrValue) ? maybeReason : valueOrReason) as string | undefined),
    setAcceptedOutcome: (discordGuildId: string, regearClaimId: string, channelId: string, messageId: string) =>
      setAcceptedOutcome(pool, discordGuildId, regearClaimId, channelId, messageId),
    clearAcceptedOutcomeByMessage: (discordGuildId: string, messageId: string) =>
      clearAcceptedOutcomeByMessage(pool, discordGuildId, messageId)
  };
}

async function listEffectiveAdminServers(
  pool: Queryable,
  discordGuildId: string,
  discordRoleIds: readonly string[]
): Promise<AlbionServer[]> {
  const roleIdsExpression = discordRoleIds.length ? "$2" : "'{}'";
  const result = await pool.query<{ albion_server: AlbionServer }>(
    `
    select server.albion_server from (values ('americas'::text), ('asia'::text), ('europe'::text)) server(albion_server)
    where ${effectiveAdministratorExists("$1", roleIdsExpression)}
    order by server.albion_server
    `,
    discordRoleIds.length ? [discordGuildId, [...discordRoleIds]] : [discordGuildId]
  );
  return result.rows.map((row) => row.albion_server);
}

async function isEffectiveAdministrator(
  pool: Queryable,
  discordGuildId: string,
  discordRoleIds: readonly string[]
): Promise<boolean> {
  const result = await pool.query(
    `
    select 1 where ${effectiveAdministratorExists("$1", "$2")}
    `,
    [discordGuildId, [...discordRoleIds]]
  );
  return (result.rowCount ?? 0) > 0;
}

async function listEligibleCharactersForUser(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string,
  albionServer?: AlbionServer
): Promise<EligibleRegearCharacter[]> {
  const result = await pool.query<CharacterRow>(
    `
    select registered.albion_server, registered.albion_character_id,
      character.character_name, registered.discord_user_id
    from discord_user_characters registered
    join albion_characters character
      on character.albion_server = registered.albion_server
      and character.albion_character_id = registered.albion_character_id
    where registered.discord_guild_id = $1 and registered.discord_user_id = $2
      and ($3::text is null or registered.albion_server = $3)
      and exists (
        select 1 from member_group_profiles profile
        where profile.discord_guild_id = registered.discord_guild_id
          and profile.discord_user_id = registered.discord_user_id
          and profile.albion_server = registered.albion_server
          and profile.albion_character_id = registered.albion_character_id
          and character_has_active_membership(registered.discord_guild_id, registered.albion_server, registered.albion_character_id, registered.discord_user_id)
      )
    order by lower(character.character_name), registered.albion_server, registered.albion_character_id
    `,
    [discordGuildId, discordUserId, albionServer ?? null]
  );
  return result.rows.map(mapCharacter);
}

async function createContent(pool: PostgresPool, input: CreateRegearContentInput): Promise<RegearContent> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireEffectiveAdministrator(client, input.discordGuildId, input.actorDiscordRoleIds ?? []);
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`regear-content:${input.discordGuildId}:${input.albionServer}`]
    );
    const count = await client.query<{ content_count: string }>(
      `select count(*)::text as content_count from regear_contents
       where discord_guild_id = $1 and albion_server = $2 and state = 'open'`,
      [input.discordGuildId, input.albionServer]
    );
    if (Number.parseInt(count.rows[0]?.content_count ?? "0", 10) >= MAX_OPEN_REGEAR_CONTENT_PER_SERVER) {
      throw new RegearOperationError("content_limit");
    }
    const result = await client.query<ContentRow>(
      `
      insert into regear_contents (
        discord_guild_id, albion_server, name, content_date, content_at,
        channel_id, created_by_discord_user_id
      ) values ($1, $2, $3, $4::date, $5, $6, $7)
      returning *
      `,
      [input.discordGuildId, input.albionServer, input.name, input.contentDate,
        input.contentAt ?? null, input.channelId, input.actorDiscordUserId]
    );
    await client.query("commit");
    return mapContent(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getContent(
  pool: Queryable,
  discordGuildId: string,
  regearContentId: string
): Promise<RegearContent | undefined> {
  const result = await pool.query<ContentRow>(
    `select * from regear_contents where discord_guild_id = $1 and regear_content_id = $2`,
    [discordGuildId, regearContentId]
  );
  return result.rows[0] ? mapContent(result.rows[0]) : undefined;
}

async function listContents(
  pool: Queryable,
  discordGuildId: string,
  albionServer?: AlbionServer,
  state?: RegearContentState
): Promise<RegearContent[]> {
  const result = await pool.query<ContentRow>(
    `
    select * from regear_contents
    where discord_guild_id = $1
      and ($2::text is null or albion_server = $2)
      and ($3::text is null or state = $3)
    order by content_date desc, coalesce(content_at, content_date::timestamptz) desc,
      created_at desc, regear_content_id desc
    `,
    [discordGuildId, albionServer ?? null, state ?? null]
  );
  return result.rows.map(mapContent);
}

async function setContentState(
  pool: PostgresPool,
  discordGuildId: string,
  regearContentId: string,
  actorDiscordUserId: string,
  actorDiscordRoleIds: readonly string[],
  state: RegearContentState
): Promise<RegearContent> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<ContentRow>(
      `select * from regear_contents where discord_guild_id = $1 and regear_content_id = $2 for update`,
      [discordGuildId, regearContentId]
    );
    const content = existing.rows[0];
    if (!content) throw new RegearOperationError("content_not_found");
    await requireEffectiveAdministrator(client, discordGuildId, actorDiscordRoleIds);
    if (state === "open" && content.state !== "open") {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`regear-content:${discordGuildId}:${content.albion_server}`]
      );
      const count = await client.query<{ content_count: string }>(
        `select count(*)::text as content_count from regear_contents
         where discord_guild_id = $1 and albion_server = $2 and state = 'open'`,
        [discordGuildId, content.albion_server]
      );
      if (Number.parseInt(count.rows[0]?.content_count ?? "0", 10) >= MAX_OPEN_REGEAR_CONTENT_PER_SERVER) {
        throw new RegearOperationError("content_limit");
      }
    }
    const result = await client.query<ContentRow>(
      `
      update regear_contents set state = $3,
        closed_by_discord_user_id = case when $3 = 'closed' then $4 else null end,
        closed_at = case when $3 = 'closed' then now() else null end,
        updated_at = now()
      where discord_guild_id = $1 and regear_content_id = $2
      returning *
      `,
      [discordGuildId, regearContentId, state, actorDiscordUserId]
    );
    await client.query("commit");
    return mapContent(result.rows[0]);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setContentAnnouncement(
  pool: Queryable,
  discordGuildId: string,
  regearContentId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  const result = await pool.query(
    `update regear_contents set channel_id = $3, announcement_message_id = $4, updated_at = now()
     where discord_guild_id = $1 and regear_content_id = $2`,
    [discordGuildId, regearContentId, channelId, messageId]
  );
  if ((result.rowCount ?? 0) === 0) throw new RegearOperationError("content_not_found");
}

async function clearAnnouncementByMessage(
  pool: Queryable,
  discordGuildId: string,
  messageId: string
): Promise<boolean> {
  const result = await pool.query(
    `update regear_contents set announcement_message_id = null, updated_at = now()
     where discord_guild_id = $1 and announcement_message_id = $2`,
    [discordGuildId, messageId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function createPendingClaim(
  pool: PostgresPool,
  input: CreatePendingRegearClaimInput
): Promise<RegearClaim> {
  if (input.requestedValue <= 0n) throw new RegearOperationError("invalid_amount");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, input);
    const contentResult = await client.query<ContentRow>(
      `select * from regear_contents where discord_guild_id = $1 and regear_content_id = $2 for update`,
      [input.discordGuildId, input.regearContentId]
    );
    const content = contentResult.rows[0];
    if (!content || content.albion_server !== input.albionServer) {
      throw new RegearOperationError("content_not_found");
    }
    if (content.state !== "open") throw new RegearOperationError("content_closed");
    const owner = await getCurrentEligibleOwner(
      client,
      input.discordGuildId,
      input.albionServer,
      input.albionCharacterId
    );
    if (!owner) throw new RegearOperationError("character_ineligible");
    if (owner.discordUserId !== input.expectedOwnerDiscordUserId) {
      throw new RegearOperationError("owner_changed");
    }
    await client.query(
      `
      insert into regear_claims (
        regear_claim_id, discord_guild_id, regear_content_id, albion_server,
        albion_character_id, original_submitter_discord_user_id, requested_value,
        review_channel_id, review_message_id
      ) values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9)
      `,
      [input.regearClaimId, input.discordGuildId, input.regearContentId, input.albionServer,
        input.albionCharacterId, input.expectedOwnerDiscordUserId, input.requestedValue.toString(),
        input.reviewChannelId, input.reviewMessageId]
    );
    await client.query("commit");
    return (await getClaim(pool, input.discordGuildId, input.regearClaimId))!;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getClaim(
  pool: Queryable,
  discordGuildId: string,
  regearClaimId: string
): Promise<RegearClaim | undefined> {
  const result = await pool.query<ClaimRow>(
    `${claimSelect()} where claim.discord_guild_id = $1 and claim.regear_claim_id = $2`,
    [discordGuildId, regearClaimId]
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : undefined;
}

async function listClaimsForOwner(
  pool: Queryable,
  discordGuildId: string,
  discordUserId: string
): Promise<RegearClaim[]> {
  const result = await pool.query<ClaimRow>(
    `${claimSelect()}
     where claim.discord_guild_id = $1
       and current_owner.discord_user_id = $2
     order by claim.submitted_at desc, claim.regear_claim_id desc`,
    [discordGuildId, discordUserId]
  );
  return result.rows.map(mapClaim);
}

async function listClaimsForAdministrator(
  pool: Queryable,
  discordGuildId: string,
  discordRoleIds: readonly string[],
  filters: RegearClaimFilters
): Promise<RegearClaim[]> {
  const result = await pool.query<ClaimRow>(
    `${claimSelect()}
     where claim.discord_guild_id = $1
       and ${effectiveAdministratorExists("claim.discord_guild_id", "$2")}
       and ($3::uuid is null or claim.regear_content_id = $3)
       and ($4::text is null or current_owner.discord_user_id = $4)
       and ($5::text is null or $5 = 'all' or claim.status = $5)
       and ($6::text is null or claim.albion_server = $6)
     order by claim.submitted_at desc, claim.regear_claim_id desc`,
    [discordGuildId, [...discordRoleIds], filters.contentId ?? null,
      filters.ownerDiscordUserId ?? null, filters.status ?? null, filters.albionServer ?? null]
  );
  return result.rows.map(mapClaim);
}

async function listPendingClaims(pool: Queryable, discordGuildId: string): Promise<RegearClaim[]> {
  const result = await pool.query<ClaimRow>(
    `${claimSelect()} where claim.discord_guild_id = $1 and claim.status = 'pending'
     order by claim.submitted_at, claim.regear_claim_id`,
    [discordGuildId]
  );
  return result.rows.map(mapClaim);
}

async function listPendingClaimsForCharacter(
  pool: Queryable,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<RegearClaim[]> {
  const result = await pool.query<ClaimRow>(
    `${claimSelect()} where claim.discord_guild_id = $1 and claim.albion_server = $2
       and claim.albion_character_id = $3 and claim.status = 'pending'
     order by claim.submitted_at, claim.regear_claim_id`,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return result.rows.map(mapClaim);
}

async function withdrawPendingClaim(
  pool: PostgresPool,
  discordGuildId: string,
  regearClaimId: string,
  discordUserId: string
): Promise<RegearClaim> {
  return deletePendingClaimWithAuthorization(pool, discordGuildId, regearClaimId, async (client, claim) => {
    const owner = await getCurrentEligibleOwner(client, discordGuildId, claim.albionServer, claim.albionCharacterId);
    if (!owner || owner.discordUserId !== discordUserId) throw new RegearOperationError("not_owner");
  });
}

async function rejectPendingClaim(
  pool: PostgresPool,
  discordGuildId: string,
  regearClaimId: string,
  discordUserId: string,
  discordRoleIds: readonly string[]
): Promise<RegearClaim> {
  return deletePendingClaimWithAuthorization(pool, discordGuildId, regearClaimId, async (client) => {
    await requireEffectiveAdministrator(client, discordGuildId, discordRoleIds);
  });
}

async function deletePendingClaimWithAuthorization(
  pool: PostgresPool,
  discordGuildId: string,
  regearClaimId: string,
  authorize: (client: PoolClient, claim: RegearClaim) => Promise<void>
): Promise<RegearClaim> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await getClaimForUpdate(client, discordGuildId, regearClaimId);
    if (!claim) throw new RegearOperationError("claim_not_found");
    if (claim.status !== "pending") throw new RegearOperationError("claim_resolved");
    await authorize(client, claim);
    await client.query(
      `delete from regear_claims where discord_guild_id = $1 and regear_claim_id = $2 and status = 'pending'`,
      [discordGuildId, regearClaimId]
    );
    await client.query("commit");
    return claim;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removePendingClaim(
  pool: PostgresPool,
  discordGuildId: string,
  regearClaimId: string
): Promise<RegearClaim | undefined> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await getClaimForUpdate(client, discordGuildId, regearClaimId);
    if (!claim || claim.status !== "pending") {
      await client.query("rollback");
      return undefined;
    }
    await client.query(
      `delete from regear_claims where discord_guild_id = $1 and regear_claim_id = $2 and status = 'pending'`,
      [discordGuildId, regearClaimId]
    );
    await client.query("commit");
    return claim;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removePendingByReviewMessage(
  pool: PostgresPool,
  discordGuildId: string,
  reviewMessageId: string
): Promise<RegearClaim | undefined> {
  const result = await pool.query<{ regear_claim_id: string }>(
    `select regear_claim_id from regear_claims
     where discord_guild_id = $1 and review_message_id = $2 and status = 'pending'`,
    [discordGuildId, reviewMessageId]
  );
  const id = result.rows[0]?.regear_claim_id;
  return id ? removePendingClaim(pool, discordGuildId, id) : undefined;
}

async function acceptPendingClaim(
  pool: PostgresPool,
  discordGuildId: string,
  regearClaimId: string,
  discordUserId: string,
  discordRoleIds: readonly string[],
  acceptedValue?: bigint,
  reason?: string
): Promise<{ claim: RegearClaim; alreadyAccepted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await getClaimForUpdate(client, discordGuildId, regearClaimId);
    if (!claim) throw new RegearOperationError("claim_not_found");
    await requireEffectiveAdministrator(client, discordGuildId, discordRoleIds);
    if (claim.status === "accepted") {
      await client.query("rollback");
      return { claim, alreadyAccepted: true };
    }
    const owner = await getCurrentEligibleOwner(client, discordGuildId, claim.albionServer, claim.albionCharacterId);
    if (!owner) throw new RegearOperationError("character_ineligible");
    const value = acceptedValue ?? claim.requestedValue;
    if (value <= 0n) throw new RegearOperationError("invalid_amount");
    const normalizedReason = reason?.trim() || undefined;
    if (value !== claim.requestedValue && !normalizedReason) {
      throw new RegearOperationError("reason_required");
    }
    const accountResult = await client.query<{ account_id: string; status: "open" | "frozen" | "closed"; balance: string }>(
      `select account_id, status, balance from character_accounts
       where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3
       for update`,
      [discordGuildId, claim.albionServer, claim.albionCharacterId]
    );
    const account = accountResult.rows[0];
    if (!account) throw new RegearOperationError("account_not_found");
    if (account.status === "frozen") throw new RegearOperationError("account_frozen");
    if (account.status === "closed") throw new RegearOperationError("account_closed");
    const balanceAfter = BigInt(account.balance) + value;
    await client.query(
      `update regear_claims set status = 'accepted', accepted_value = $3,
        accepted_by_discord_user_id = $4, accepted_at = now(), acceptance_reason = $5,
        updated_at = now()
       where discord_guild_id = $1 and regear_claim_id = $2 and status = 'pending'`,
      [discordGuildId, regearClaimId, value.toString(), discordUserId, normalizedReason ?? null]
    );
    await client.query(
      `insert into account_transactions (
        account_id, discord_guild_id, transaction_type, amount, balance_after,
        actor_discord_user_id, description, regear_claim_id
      ) values ($1, $2, 'regear_credit', $3, $4, $5, $6, $7)`,
      [account.account_id, discordGuildId, value.toString(), balanceAfter.toString(), discordUserId,
        regearStatementDescription(claim), regearClaimId]
    );
    await client.query(
      `update character_accounts set balance = $2, updated_at = now() where account_id = $1`,
      [account.account_id, balanceAfter.toString()]
    );
    await client.query("commit");
    return { claim: (await getClaim(pool, discordGuildId, regearClaimId))!, alreadyAccepted: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function setAcceptedOutcome(
  pool: Queryable,
  discordGuildId: string,
  regearClaimId: string,
  channelId: string,
  messageId: string
): Promise<void> {
  const result = await pool.query(
    `update regear_claims set outcome_channel_id = $3, outcome_message_id = $4, updated_at = now()
     where discord_guild_id = $1 and regear_claim_id = $2 and status = 'accepted'`,
    [discordGuildId, regearClaimId, channelId, messageId]
  );
  if ((result.rowCount ?? 0) === 0) throw new RegearOperationError("claim_not_found");
}

async function clearAcceptedOutcomeByMessage(
  pool: Queryable,
  discordGuildId: string,
  messageId: string
): Promise<boolean> {
  const result = await pool.query(
    `update regear_claims set outcome_channel_id = null, outcome_message_id = null, updated_at = now()
     where discord_guild_id = $1 and outcome_message_id = $2 and status = 'accepted'`,
    [discordGuildId, messageId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function getClaimForUpdate(
  client: PoolClient,
  discordGuildId: string,
  regearClaimId: string
): Promise<RegearClaim | undefined> {
  // Obtain the lifecycle fence before the claim row/account locks. A concurrent
  // expiry may delete the claim while this waits; the following read rechecks it.
  await client.query(`select pg_advisory_xact_lock(hashtextextended(
    'membership-entitlements:' || discord_guild_id || ':' || albion_server || ':' || albion_character_id, 0))
    from regear_claims where discord_guild_id = $1 and regear_claim_id = $2`, [discordGuildId, regearClaimId]);
  const result = await client.query<ClaimRow>(
    `${claimSelect()} where claim.discord_guild_id = $1 and claim.regear_claim_id = $2 for update of claim`,
    [discordGuildId, regearClaimId]
  );
  return result.rows[0] ? mapClaim(result.rows[0]) : undefined;
}

async function getCurrentEligibleOwner(
  pool: Queryable,
  discordGuildId: string,
  albionServer: AlbionServer,
  albionCharacterId: string
): Promise<{ discordUserId: string } | undefined> {
  const result = await pool.query<{ discord_user_id: string }>(
    `
    select registered.discord_user_id
    from discord_user_characters registered
    where registered.discord_guild_id = $1 and registered.albion_server = $2
      and registered.albion_character_id = $3
      and exists (
        select 1 from member_group_profiles profile
        where profile.discord_guild_id = registered.discord_guild_id
          and profile.discord_user_id = registered.discord_user_id
          and profile.albion_server = registered.albion_server
          and profile.albion_character_id = registered.albion_character_id
          and character_has_active_membership(registered.discord_guild_id, registered.albion_server, registered.albion_character_id, registered.discord_user_id)
      )
    limit 1
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  return result.rows[0] ? { discordUserId: result.rows[0].discord_user_id } : undefined;
}

async function requireEffectiveAdministrator(
  pool: Queryable,
  discordGuildId: string,
  discordRoleIds: readonly string[]
): Promise<void> {
  if (!await isEffectiveAdministrator(pool, discordGuildId, discordRoleIds)) {
    throw new RegearOperationError("admin_ineligible");
  }
}

function effectiveAdministratorExists(guildExpression: string, roleIdsExpression: string): string {
  return `('__guild_manager_discord_administrator__' = any(${roleIdsExpression}::text[]) or exists (select 1 from reviewer_role_bindings binding
      where binding.discord_guild_id = ${guildExpression} and binding.domain = 'regears'
        and binding.discord_role_id = any(${roleIdsExpression}::text[])))`;
}

function claimSelect(): string {
  return `
    select claim.regear_claim_id, claim.discord_guild_id, claim.regear_content_id,
      claim.albion_server, claim.albion_character_id, character.character_name,
      current_owner.discord_user_id as current_owner_discord_user_id,
      claim.original_submitter_discord_user_id, claim.requested_value, claim.accepted_value,
      claim.status, claim.review_channel_id, claim.review_message_id,
      claim.outcome_channel_id, claim.outcome_message_id, claim.submitted_at, claim.updated_at,
      claim.accepted_by_discord_user_id, claim.accepted_at, claim.acceptance_reason,
      content.name as content_name, content.content_date, content.content_at,
      content.state as content_state, content.channel_id as content_channel_id
    from regear_claims claim
    join regear_contents content
      on content.regear_content_id = claim.regear_content_id
      and content.discord_guild_id = claim.discord_guild_id
      and content.albion_server = claim.albion_server
    join albion_characters character
      on character.albion_server = claim.albion_server
      and character.albion_character_id = claim.albion_character_id
    left join lateral (
      select registered.discord_user_id
      from discord_user_characters registered
      where registered.discord_guild_id = claim.discord_guild_id
        and registered.albion_server = claim.albion_server
        and registered.albion_character_id = claim.albion_character_id
        and exists (
          select 1 from member_group_profiles profile
          where profile.discord_guild_id = registered.discord_guild_id
            and profile.discord_user_id = registered.discord_user_id
            and profile.albion_server = registered.albion_server
            and profile.albion_character_id = registered.albion_character_id
          and character_has_active_membership(registered.discord_guild_id, registered.albion_server, registered.albion_character_id, registered.discord_user_id)
        )
      limit 1
    ) current_owner on true`;
}

function regearStatementDescription(claim: RegearClaim): string {
  const date = new Date(`${claim.contentDate}T00:00:00.000Z`);
  const shortDate = date.toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  return `Re-gear • ${claim.contentName} • ${shortDate}`.slice(0, 200);
}


function mapCharacter(row: CharacterRow): EligibleRegearCharacter {
  return {
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    discordUserId: row.discord_user_id
  };
}

function mapContent(row: ContentRow): RegearContent {
  return {
    regearContentId: row.regear_content_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server,
    name: row.name,
    contentDate: mapDate(row.content_date),
    contentAt: row.content_at ?? undefined,
    state: row.state,
    channelId: row.channel_id,
    announcementMessageId: row.announcement_message_id ?? undefined,
    createdByDiscordUserId: row.created_by_discord_user_id,
    createdAt: row.created_at,
    closedByDiscordUserId: row.closed_by_discord_user_id ?? undefined,
    closedAt: row.closed_at ?? undefined,
    updatedAt: row.updated_at
  };
}

function mapClaim(row: ClaimRow): RegearClaim {
  return {
    regearClaimId: row.regear_claim_id,
    discordGuildId: row.discord_guild_id,
    regearContentId: row.regear_content_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    currentOwnerDiscordUserId: row.current_owner_discord_user_id ?? undefined,
    originalSubmitterDiscordUserId: row.original_submitter_discord_user_id,
    requestedValue: BigInt(row.requested_value),
    acceptedValue: row.accepted_value === null ? undefined : BigInt(row.accepted_value),
    status: row.status,
    reviewChannelId: row.review_channel_id,
    reviewMessageId: row.review_message_id,
    outcomeChannelId: row.outcome_channel_id ?? undefined,
    outcomeMessageId: row.outcome_message_id ?? undefined,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    acceptedByDiscordUserId: row.accepted_by_discord_user_id ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    acceptanceReason: row.acceptance_reason ?? undefined,
    contentName: row.content_name,
    contentDate: mapDate(row.content_date),
    contentAt: row.content_at ?? undefined,
    contentState: row.content_state,
    contentChannelId: row.content_channel_id
  };
}

function mapDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
