import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPool } from "./postgres.js";
import {
  createSpecialisationRepository,
  SpecialisationOperationError
} from "./specialisationRepository.js";
import { catalogueByKey } from "../services/specialisations/catalogue.js";

const now = new Date("2026-08-16T00:00:00Z");

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function requestRow(state: "pending" | "confirmed" | "dismissed" = "pending") {
  return {
    specialisation_request_id: "request-1",
    discord_guild_id: "guild-1",
    submitted_by_discord_user_id: "user-1",
    albion_server: "europe",
    albion_character_id: "character-1",
    character_name: "Character",
    target_key: "weapon:battleaxe",
    target_kind: "weapon",
    target_display_name: "Battleaxe",
    level: 100,
    state,
    reviewed_by_discord_user_id: state === "pending" ? null : "reviewer-1",
    reviewed_at: state === "pending" ? null : now,
    review_channel_id: "channel-1",
    review_message_id: "message-1",
    review_message_deleted_at: null,
    created_at: now,
    updated_at: now
  };
}

function treeRequestRow(state: "pending" | "confirmed" | "dismissed" = "pending") {
  return {
    ...requestRow(state),
    target_key: "tree:axe",
    target_kind: "tree",
    target_display_name: "Axes",
    level: 800
  };
}

function specialisationRow(removed = false) {
  return {
    character_specialisation_id: "specialisation-1",
    discord_guild_id: "guild-1",
    albion_server: "europe",
    albion_character_id: "character-1",
    character_name: "Character",
    target_key: "weapon:battleaxe",
    target_kind: "weapon",
    target_display_name: "Battleaxe",
    level: 100,
    source: "request",
    source_request_id: "request-1",
    recorded_by_discord_user_id: "reviewer-1",
    recorded_at: now,
    removed_by_discord_user_id: removed ? "reviewer-2" : null,
    removed_at: removed ? now : null
  };
}

function treeSpecialisationRow() {
  return {
    ...specialisationRow(),
    target_key: "tree:axe",
    target_kind: "tree",
    target_display_name: "Axes",
    level: 800
  };
}

function eligibleRow() {
  return {
    discord_guild_id: "guild-1",
    discord_user_id: "user-1",
    albion_server: "europe",
    albion_character_id: "character-1",
    character_name: "Character"
  };
}

function withoutEntitlementFence<T extends { sql: string }>(queries: T[]): T[] {
  return queries.filter(query => !query.sql.includes("membership-entitlements:"));
}

function transactionalPool(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>
): { pool: PostgresPool; queries: Array<{ sql: string; values?: unknown[] }>; released: () => boolean } {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let didRelease = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql: normalize(sql), values });
      return query(sql, values);
    },
    release: () => { didRelease = true; }
  };
  return {
    pool: { connect: async () => client } as unknown as PostgresPool,
    queries,
    released: () => didRelease
  };
}

test("catalogue exclusions are replaced atomically on one checked-out connection", async () => {
  const exclusion = {
    discord_guild_id: "guild-1",
    catalogue_key: "weapon:battleaxe",
    excluded_by_discord_user_id: "reviewer-1",
    excluded_at: now
  };
  const mock = transactionalPool(async (sql) => {
    if (normalize(sql).startsWith("select * from specialisation_catalogue_exclusions")) {
      return { rows: [exclusion], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).replaceCatalogueExclusions(
    "guild-1",
    ["weapon:battleaxe", "weapon:battleaxe"],
    "reviewer-1"
  );

  assert.equal(withoutEntitlementFence(mock.queries)[0]?.sql, "begin");
  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /discord_guild_lifecycle .* for update/);
  assert.match(withoutEntitlementFence(mock.queries)[2]?.sql ?? "", /^delete from specialisation_catalogue_exclusions/);
  assert.match(withoutEntitlementFence(mock.queries)[3]?.sql ?? "", /insert into specialisation_catalogue_exclusions/);
  assert.deepEqual(withoutEntitlementFence(mock.queries)[3]?.values, ["guild-1", ["weapon:battleaxe"], "reviewer-1"]);
  assert.equal(mock.queries.at(-1)?.sql, "commit");
  assert.equal(mock.released(), true);
  assert.deepEqual(result.map((row) => row.catalogueKey), ["weapon:battleaxe"]);
});

test("request reservation locks its target, rechecks exact eligibility, and commits one pending row", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("select 1 from specialisation_requests")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("insert into specialisation_requests")) return { rows: [requestRow()], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const target = catalogueByKey.get("weapon:battleaxe")!;

  const request = await createSpecialisationRepository(mock.pool).reserveRequest({
    discordGuildId: "guild-1",
    submittedByDiscordUserId: "user-1",
    albionServer: "europe",
    albionCharacterId: "character-1",
    target,
    level: 100,
    reviewChannelId: "channel-1"
  });

  assert.equal(withoutEntitlementFence(mock.queries)[0]?.sql, "begin");
  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /discord_guild_lifecycle .* for share/);
  assert.match(withoutEntitlementFence(mock.queries)[2]?.sql ?? "", /specialisation_catalogue_exclusions/);
  assert.match(withoutEntitlementFence(mock.queries)[3]?.sql ?? "", /pg_advisory_xact_lock/);
  assert.deepEqual(withoutEntitlementFence(mock.queries)[3]?.values, ["guild-1", "europe", "character-1", "tree:axe"]);
  assert.match(withoutEntitlementFence(mock.queries)[4]?.sql ?? "", /profile\.albion_character_id = registration\.albion_character_id/);
  assert.match(withoutEntitlementFence(mock.queries)[5]?.sql ?? "", /character_specialisations/);
  assert.match(withoutEntitlementFence(mock.queries)[6]?.sql ?? "", /specialisation_requests/);
  assert.match(withoutEntitlementFence(mock.queries)[7]?.sql ?? "", /^insert into specialisation_requests/);
  assert.equal(mock.queries.at(-1)?.sql, "commit");
  assert.equal(request.specialisationRequestId, "request-1");
});

test("request reservation rejects an active target or its covering tree and rolls back without inserting", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createSpecialisationRepository(mock.pool).reserveRequest({
      discordGuildId: "guild-1",
      submittedByDiscordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      target: catalogueByKey.get("weapon:battleaxe")!,
      level: 100,
      reviewChannelId: "channel-1"
    }),
    (error) => error instanceof SpecialisationOperationError && error.code === "active_exists"
  );
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into specialisation_requests")), false);
  assert.deepEqual(mock.queries.find((query) => query.sql.startsWith("select 1 from character_specialisations"))?.values, [
    "guild-1", "europe", "character-1", ["weapon:battleaxe", "tree:axe"]
  ]);
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
  assert.equal(mock.released(), true);
});

test("request reservation serializes with catalogue replacement and rejects a newly disabled target", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.startsWith("select 1 from specialisation_catalogue_exclusions")) {
      return { rows: [{}], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createSpecialisationRepository(mock.pool).reserveRequest({
      discordGuildId: "guild-1",
      submittedByDiscordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      target: catalogueByKey.get("weapon:battleaxe")!,
      level: 100,
      reviewChannelId: "channel-1"
    }),
    (error) => error instanceof SpecialisationOperationError && error.code === "target_disabled"
  );
  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /discord_guild_lifecycle .* for share/);
  assert.equal(withoutEntitlementFence(mock.queries).some((query) => query.sql.includes("pg_advisory_xact_lock")), false);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into specialisation_requests")), false);
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
});

test("a tree request cannot overtake a pending individual weapon in that tree", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("select 1 from specialisation_requests")) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createSpecialisationRepository(mock.pool).reserveRequest({
      discordGuildId: "guild-1",
      submittedByDiscordUserId: "user-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      target: catalogueByKey.get("tree:axe")!,
      level: 800,
      reviewChannelId: "channel-1"
    }),
    (error) => error instanceof SpecialisationOperationError && error.code === "pending_exists"
  );

  const pendingCheck = mock.queries.find((query) => query.sql.startsWith("select 1 from specialisation_requests"));
  assert.equal((pendingCheck?.values?.[3] as string[]).length, 9);
  assert.deepEqual((pendingCheck?.values?.[3] as string[]).slice(0, 2), ["tree:axe", "weapon:battleaxe"]);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into specialisation_requests")), false);
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
});

test("failed card creation can delete only an unattached Pending reservation", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql: normalize(sql), values });
      return { rows: [], rowCount: 1 };
    }
  } as unknown as PostgresPool;

  assert.equal(await createSpecialisationRepository(pool).deleteUnattachedPendingRequest("guild-1", "request-1"), true);
  assert.match(queries[0]?.sql ?? "", /state = 'pending' and review_message_id is null/);
  assert.deepEqual(queries[0]?.values, ["guild-1", "request-1"]);
});

test("confirmation row-locks the request and atomically creates one active record", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of request")) return { rows: [requestRow()], rowCount: 1 };
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("insert into character_specialisations")) return { rows: [specialisationRow()], rowCount: 1 };
    if (normalized.startsWith("update specialisation_requests request")) return { rows: [requestRow("confirmed")], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1",
    specialisationRequestId: "request-1",
    decision: "confirmed",
    reviewerDiscordUserId: "reviewer-1",
    proofAvailable: true
  });

  assert.equal(withoutEntitlementFence(mock.queries)[0]?.sql, "begin");
  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /for update of request/);
  assert.match(withoutEntitlementFence(mock.queries)[2]?.sql ?? "", /pg_advisory_xact_lock/);
  assert.ok(mock.queries.find((query) => query.sql.startsWith("insert into character_specialisations")));
  assert.ok(mock.queries.find((query) => query.sql.startsWith("update specialisation_requests request")));
  assert.equal(mock.queries.at(-1)?.sql, "commit");
  assert.equal(result.changed, true);
  assert.equal(result.request.state, "confirmed");
  assert.equal(result.characterSpecialisation?.sourceRequestId, "request-1");
});

test("confirming a tree atomically soft-removes its active individual weapons", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of request")) return { rows: [treeRequestRow()], rowCount: 1 };
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("insert into character_specialisations")) return { rows: [treeSpecialisationRow()], rowCount: 1 };
    if (normalized.startsWith("update character_specialisations")) return { rows: [], rowCount: 2 };
    if (normalized.startsWith("update specialisation_requests request")) return { rows: [treeRequestRow("confirmed")], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1",
    specialisationRequestId: "request-1",
    decision: "confirmed",
    reviewerDiscordUserId: "reviewer-1",
    proofAvailable: true
  });

  const removal = mock.queries.find((query) => query.sql.startsWith("update character_specialisations"));
  assert.match(removal?.sql ?? "", /target_kind = 'weapon'/);
  assert.deepEqual(removal?.values?.slice(0, 4), ["guild-1", "europe", "character-1", "reviewer-1"]);
  assert.deepEqual(removal?.values?.[4], [
    "weapon:battleaxe", "weapon:greataxe", "weapon:halberd", "weapon:carrioncaller",
    "weapon:infernal-scythe", "weapon:bear-paws", "weapon:realmbreaker", "weapon:crystal-reaper"
  ]);
  assert.equal(result.characterSpecialisation?.targetKind, "tree");
  assert.ok(mock.queries.indexOf(removal!) < mock.queries.findIndex((query) => query.sql.startsWith("update specialisation_requests request")));
  assert.equal(mock.queries.at(-1)?.sql, "commit");
});

test("a repeated confirmation returns the retained decision without another insert", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of request")) return { rows: [requestRow("confirmed")], rowCount: 1 };
    if (normalized.includes("source_request_id = $2")) return { rows: [specialisationRow()], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1",
    specialisationRequestId: "request-1",
    decision: "confirmed",
    reviewerDiscordUserId: "reviewer-2",
    proofAvailable: true
  });

  assert.equal(result.changed, false);
  assert.equal(result.request.reviewedByDiscordUserId, "reviewer-1");
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into character_specialisations")), false);
  assert.equal(mock.queries.at(-1)?.sql, "commit");
});

test("dismissal remains available without proof or current submitter eligibility", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of request")) return { rows: [requestRow()], rowCount: 1 };
    if (normalized.startsWith("update specialisation_requests request")) return { rows: [requestRow("dismissed")], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1",
    specialisationRequestId: "request-1",
    decision: "dismissed",
    reviewerDiscordUserId: "reviewer-1",
    proofAvailable: false
  });

  assert.equal(result.request.state, "dismissed");
  assert.equal(mock.queries.some((query) => query.sql.includes("discord_user_characters registration")), false);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into character_specialisations")), false);
  assert.equal(mock.queries.at(-1)?.sql, "commit");
});

test("manual add uses the same target lock and refuses to bypass a pending request", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("select 1 from specialisation_requests")) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createSpecialisationRepository(mock.pool).addManualSpecialisation({
      discordGuildId: "guild-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      target: catalogueByKey.get("weapon:battleaxe")!,
      level: 100,
      actorDiscordUserId: "reviewer-1"
    }),
    (error) => error instanceof SpecialisationOperationError && error.code === "pending_exists"
  );
  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /discord_guild_lifecycle .* for share/);
  assert.match(withoutEntitlementFence(mock.queries)[3]?.sql ?? "", /pg_advisory_xact_lock/);
  assert.deepEqual(mock.queries.find((query) => query.sql.startsWith("select 1 from specialisation_requests"))?.values, [
    "guild-1", "europe", "character-1", ["weapon:battleaxe", "tree:axe"]
  ]);
  assert.equal(mock.queries.some((query) => query.sql.startsWith("insert into character_specialisations")), false);
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
});

test("manually adding a tree atomically soft-removes its active individual weapons", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("from discord_user_characters registration")) return { rows: [eligibleRow()], rowCount: 1 };
    if (normalized.startsWith("select 1 from character_specialisations")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("select 1 from specialisation_requests")) return { rows: [], rowCount: 0 };
    if (normalized.startsWith("insert into character_specialisations")) return { rows: [treeSpecialisationRow()], rowCount: 1 };
    if (normalized.startsWith("update character_specialisations")) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 0 };
  });

  const result = await createSpecialisationRepository(mock.pool).addManualSpecialisation({
    discordGuildId: "guild-1",
    albionServer: "europe",
    albionCharacterId: "character-1",
    target: catalogueByKey.get("tree:axe")!,
    level: 800,
    actorDiscordUserId: "reviewer-1"
  });

  const removal = mock.queries.find((query) => query.sql.startsWith("update character_specialisations"));
  assert.deepEqual(removal?.values?.slice(0, 4), ["guild-1", "europe", "character-1", "reviewer-1"]);
  assert.equal((removal?.values?.[4] as string[]).length, 8);
  assert.equal(result.targetKind, "tree");
  assert.equal(mock.queries.at(-1)?.sql, "commit");
});

test("soft removal locks the active row and records the acting reviewer", async () => {
  const mock = transactionalPool(async (sql) => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of specialisation")) return { rows: [specialisationRow()], rowCount: 1 };
    if (normalized.startsWith("update character_specialisations specialisation")) {
      return { rows: [specialisationRow(true)], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  const removed = await createSpecialisationRepository(mock.pool).removeSpecialisation(
    "guild-1",
    "specialisation-1",
    "reviewer-2"
  );

  assert.match(withoutEntitlementFence(mock.queries)[1]?.sql ?? "", /for update of specialisation/);
  assert.match(withoutEntitlementFence(mock.queries)[2]?.sql ?? "", /pg_advisory_xact_lock/);
  assert.deepEqual(withoutEntitlementFence(mock.queries)[3]?.values, ["guild-1", "specialisation-1", "reviewer-2"]);
  assert.equal(removed.removedByDiscordUserId, "reviewer-2");
  assert.equal(mock.queries.at(-1)?.sql, "commit");
});

test("transaction failures roll back and release the checked-out connection", async () => {
  const mock = transactionalPool(async (sql) => {
    if (normalize(sql).startsWith("delete from specialisation_catalogue_exclusions")) {
      throw new Error("delete failed");
    }
    return { rows: [], rowCount: 0 };
  });

  await assert.rejects(
    createSpecialisationRepository(mock.pool).replaceCatalogueExclusions("guild-1", [], "reviewer-1"),
    /delete failed/
  );
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
  assert.equal(mock.released(), true);
});

test("restored ownership confirms Pending proof for the current eligible owner without changing original provenance", async () => {
  const mock = transactionalPool(async sql => {
    const normalized = normalize(sql);
    if (normalized.includes("for update of request")) return { rows: [{ ...requestRow(), current_owner_discord_user_id: "restored-owner" }], rowCount: 1 };
    if (normalized.includes("from discord_user_characters registration")) return { rows: [{ ...eligibleRow(), discord_user_id: "restored-owner" }], rowCount: 1 };
    if (normalized.startsWith("insert into character_specialisations")) return { rows: [specialisationRow()], rowCount: 1 };
    if (normalized.startsWith("update specialisation_requests request")) return { rows: [{ ...requestRow("confirmed"), current_owner_discord_user_id: "restored-owner" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const result = await createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1", specialisationRequestId: "request-1", decision: "confirmed",
    reviewerDiscordUserId: "reviewer-1", proofAvailable: true
  });
  assert.equal(result.request.currentOwnerDiscordUserId, "restored-owner");
  assert.equal(result.request.submittedByDiscordUserId, "user-1");
  const eligibility = mock.queries.find(query => query.sql.includes("from discord_user_characters registration"));
  assert.deepEqual(eligibility?.values, ["guild-1", "europe", "character-1"]);
  assert.match(eligibility?.sql ?? "", /character_has_active_membership/);
  const fence = mock.queries.findIndex(query => query.sql.includes("membership-entitlements:"));
  const rowLock = mock.queries.findIndex(query => query.sql.includes("for update of request"));
  assert.ok(fence > 0 && fence < rowLock);
});

test("expiry winning the lifecycle fence prevents an old Pending control from writing a record", async () => {
  const mock = transactionalPool(async () => ({ rows: [], rowCount: 0 }));
  await assert.rejects(createSpecialisationRepository(mock.pool).decideRequest({
    discordGuildId: "guild-1", specialisationRequestId: "expired", decision: "confirmed",
    reviewerDiscordUserId: "reviewer-1", proofAvailable: true
  }), (error: unknown) => error instanceof SpecialisationOperationError && error.code === "request_not_found");
  assert.equal(mock.queries.some(query => /^(insert|update)/.test(query.sql)), false);
  assert.equal(mock.queries.at(-1)?.sql, "rollback");
});
