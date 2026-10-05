import assert from "node:assert/strict";
import test from "node:test";
import { createRegearRepository, RegearOperationError } from "./regearRepository.js";

const baseClaimRow = {
  regear_claim_id: "22222222-2222-4222-8222-222222222222",
  discord_guild_id: "guild-1",
  regear_content_id: "11111111-1111-4111-8111-111111111111",
  albion_server: "asia",
  albion_character_id: "character-1",
  character_name: "Example",
  current_owner_discord_user_id: "owner-1",
  original_submitter_discord_user_id: "owner-1",
  requested_value: "1250000",
  accepted_value: null,
  status: "pending",
  review_channel_id: "channel-1",
  review_message_id: "message-1",
  outcome_channel_id: null,
  outcome_message_id: null,
  submitted_at: new Date("2026-08-12T12:30:00.000Z"),
  updated_at: new Date("2026-08-12T12:30:00.000Z"),
  accepted_by_discord_user_id: null,
  accepted_at: null,
  acceptance_reason: null,
  content_name: "Reset Day",
  content_date: "2026-08-12",
  content_at: new Date("2026-08-12T12:00:00.000Z"),
  content_state: "open",
  content_channel_id: "channel-1"
};

test("request reviewer mentions use all re-gear bindings from the invoking guild", async () => {
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      assert.deepEqual(values, ["guild-1", "regears"]);
      assert.match(sql, /discord_guild_id = \$1 and domain = \$2/);
      assert.doesNotMatch(sql, /albion_server/);
      return { rows: [{ discord_role_id: "role-1" }, { discord_role_id: "role-2" }] };
    }
  } as unknown as Parameters<typeof createRegearRepository>[0];
  assert.deepEqual(await createRegearRepository(pool).listReviewerRoleIds("guild-1"), ["role-1", "role-2"]);
});

test("content date mapping preserves the PostgreSQL calendar date in non-UTC runtimes", async () => {
  const localCalendarMidnight = new Date(2026, 7, 14);
  const pool = {
    query: async () => ({
      rows: [{
        regear_content_id: "11111111-1111-4111-8111-111111111111",
        discord_guild_id: "guild-1",
        albion_server: "asia",
        name: "Test",
        content_date: localCalendarMidnight,
        content_at: null,
        state: "open",
        channel_id: "channel-1",
        announcement_message_id: null,
        created_by_discord_user_id: "reviewer-1",
        created_at: new Date("2026-08-14T00:00:00.000Z"),
        closed_by_discord_user_id: null,
        closed_at: null,
        updated_at: new Date("2026-08-14T00:00:00.000Z")
      }],
      rowCount: 1
    })
  } as unknown as Parameters<typeof createRegearRepository>[0];

  const content = await createRegearRepository(pool).getContent(
    "guild-1",
    "11111111-1111-4111-8111-111111111111"
  );

  assert.equal(content?.contentDate, "2026-08-14");
});

test("acceptance locks the claim and account and creates one linked re-gear credit in one transaction", async () => {
  const calls: Array<{ source: "client" | "pool"; sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ source: "client", sql, values });
      if (sql.includes("for update of claim")) return { rows: [baseClaimRow], rowCount: 1 };
      if (sql.includes("select registered.discord_user_id")) return { rows: [{ discord_user_id: "owner-1" }], rowCount: 1 };
      if (sql.includes("from character_accounts") && sql.includes("for update")) {
        return { rows: [{ account_id: "account-1", status: "open", balance: "500000" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ source: "pool", sql, values });
      return {
        rows: [{
          ...baseClaimRow,
          status: "accepted",
          accepted_value: "1100000",
          accepted_by_discord_user_id: "reviewer-1",
          accepted_at: new Date("2026-08-12T12:35:00.000Z"),
          acceptance_reason: "Adjusted after review"
        }],
        rowCount: 1
      };
    }
  } as unknown as Parameters<typeof createRegearRepository>[0];

  const result = await createRegearRepository(pool).acceptPendingClaim(
    "guild-1",
    baseClaimRow.regear_claim_id,
    "reviewer-1",
    1_100_000n,
    "Adjusted after review"
  );

  assert.equal(result.alreadyAccepted, false);
  assert.equal(result.claim.acceptedValue, 1_100_000n);
  const normalized = calls.map((call) => call.sql.replace(/\s+/g, " ").trim().toLowerCase());
  assert.equal(normalized[0], "begin");
  assert.match(normalized[1], /membership-entitlements:/);
  assert.match(normalized[2], /for update of claim/);
  assert.ok(normalized.some((sql) => /from character_accounts .* for update/.test(sql)));
  const creditIndex = normalized.findIndex((sql) => sql.startsWith("insert into account_transactions"));
  assert.ok(creditIndex > 0);
  assert.match(normalized[creditIndex], /'regear_credit'/);
  assert.match(normalized[creditIndex], /regear_claim_id/);
  assert.deepEqual(calls[creditIndex].values?.slice(-2), ["Re-gear • Reset Day • 12 Aug 2026", baseClaimRow.regear_claim_id]);
  assert.equal(normalized.filter((sql) => sql.startsWith("insert into account_transactions")).length, 1);
  assert.equal(normalized.filter((sql) => sql === "commit").length, 1);
});

test("a changed acceptance amount requires a reason before any account write", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
      if (sql.includes("for update of claim")) return { rows: [baseClaimRow], rowCount: 1 };
      if (sql.includes("from reviewer_role_bindings")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("select registered.discord_user_id")) return { rows: [{ discord_user_id: "owner-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createRegearRepository>[0];
  await assert.rejects(
    createRegearRepository(pool).acceptPendingClaim("guild-1", baseClaimRow.regear_claim_id, "reviewer-1", 1_100_000n),
    (error: unknown) => error instanceof RegearOperationError && error.code === "reason_required"
  );
  assert.equal(calls.at(-1), "rollback");
  assert.equal(calls.some((sql) => sql.includes("account_transactions")), false);
});

test("Open content capacity is serialized and soft-fails at 25", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push(normalized);
      if (sql.includes("from reviewer_role_bindings")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("count(*)::text as content_count")) return { rows: [{ content_count: "25" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createRegearRepository>[0];
  await assert.rejects(
    createRegearRepository(pool).createContent({
      discordGuildId: "guild-1",
      albionServer: "asia",
      name: "Reset Day",
      contentDate: "2026-08-12",
      channelId: "channel-1",
      actorDiscordUserId: "reviewer-1"
    }),
    (error: unknown) => error instanceof RegearOperationError && error.code === "content_limit"
  );
  assert.ok(calls.some((sql) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(calls.at(-1), "rollback");
  assert.equal(calls.some((sql) => sql.startsWith("insert into regear_contents")), false);
});

test("administrator effectiveness is computed from reviewer roles", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: ["americas", "asia", "europe"].map(albion_server => ({ albion_server })), rowCount: 3 };
    }
  } as unknown as Parameters<typeof createRegearRepository>[0];
  assert.deepEqual(await createRegearRepository(pool).listEffectiveAdminServers("guild-1", ["reviewer-role"]), ["americas", "asia", "europe"]);
  assert.deepEqual(calls[0].values, ["guild-1", ["reviewer-role"]]);
  assert.match(calls[0].sql, /from reviewer_role_bindings binding/);
  assert.match(calls[0].sql, /binding\.domain = 'regears'/);
  assert.doesNotMatch(calls[0].sql, /regear_admin_grants|reviewer_scope_migrations|binding\.albion_server/);
});
