import assert from "node:assert/strict";
import test from "node:test";
import { createTasksRepository } from "./tasksRepository.js";

type Call = { sql: string; values: unknown[] };
function fixture(respond: (call: Call) => unknown[] = () => []) {
  const calls: Call[] = [];
  const pool = { query: async (sql: string, values: unknown[]) => {
    const call = { sql, values };
    calls.push(call);
    const rows = respond(call);
    return { rows, rowCount: rows.length };
  } } as never;
  return { repository: createTasksRepository(pool), calls };
}
function query(calls: Call[], from: string) {
  const found = calls.find((call) => call.sql.includes(from));
  assert.ok(found, `Missing ${from} query`);
  return found.sql;
}

test("five read-only queues use only the invoking guild and tenant-safe domain joins", async () => {
  const { repository, calls } = fixture();
  await repository.getSnapshot("guild");
  assert.equal(calls.length, 5);
  for (const { sql, values } of calls) {
    assert.deepEqual(values, ["guild"]);
    assert.match(sql.trim(), /^select\b/i);
    assert.match(sql, /where (?:\w+\.)?discord_guild_id = \$1/);
    assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|begin|commit|notify)\b/i);
    assert.doesNotMatch(sql, /select \*|\$2|reviewer|member_group_profiles|content_items|giveaways/i);
  }
  assert.match(query(calls, "from open_applications application"), /class\.discord_guild_id = application\.discord_guild_id/);
  assert.match(query(calls, "from open_applications application"), /left join member_groups member_group on member_group\.member_group_id = class\.member_group_id\s+and member_group\.discord_guild_id = class\.discord_guild_id/);
  assert.match(query(calls, "from tickets ticket"), /class\.discord_guild_id = ticket\.discord_guild_id/);
  const regear = query(calls, "from regear_claims claim");
  for (const predicate of ["content.discord_guild_id = claim.discord_guild_id", "content.albion_server = claim.albion_server",
    "registered.discord_guild_id = claim.discord_guild_id", "registered.albion_server = claim.albion_server",
    "registered.albion_character_id = claim.albion_character_id"]) assert.ok(regear.includes(predicate));
});

test("lifecycle filters include all open conversations, open content without requests, and pending requests regardless of ownership or content state", async () => {
  const { repository, calls } = fixture();
  await repository.getSnapshot("guild");
  const applications = query(calls, "from open_applications application");
  assert.match(applications, /application\.channel_status = 'open'/);
  assert.doesNotMatch(applications, /application\.status\s*(?:=|in\s*\()/);
  assert.match(query(calls, "from tickets ticket"), /ticket\.status = 'open'/);
  const content = query(calls, "from regear_contents\n");
  assert.match(content, /state = 'open'/);
  assert.doesNotMatch(content, /join|exists|regear_claims/);
  const regear = query(calls, "from regear_claims claim");
  assert.match(regear, /claim\.status = 'pending'/);
  assert.match(regear, /left join lateral/);
  assert.doesNotMatch(regear, /content\.state|current_owner\.discord_user_id\s*=/);
  assert.match(query(calls, "from specialisation_requests request"), /request\.state = 'pending'/);
});

test("queues preserve chronological and stable ID ordering, with date-only content first on the same date", async () => {
  const { repository, calls } = fixture();
  await repository.getSnapshot("guild");
  for (const [table, order] of [
    ["from open_applications application", "application.created_at, application.application_id"],
    ["from tickets ticket", "ticket.created_at, ticket.ticket_id"],
    ["from regear_contents\n", "content_date, content_at nulls first, created_at, regear_content_id"],
    ["from regear_claims claim", "claim.submitted_at, claim.regear_claim_id"],
    ["from specialisation_requests request", "request.created_at, request.specialisation_request_id"]
  ]) assert.ok(query(calls, table).includes(`order by ${order}`));
});

test("empty snapshots retain all five queues without a reviewer relationship", async () => {
  const { repository } = fixture();
  assert.deepEqual(await repository.getSnapshot("guild"), {
    discordGuildId: "guild", applications: [], tickets: [], regearContents: [], regears: [], specialisations: []
  });
});

test("projection preserves dates, bigint precision, missing references and owners, and deleted review-message markers", async () => {
  const date = new Date("2026-09-01T12:00:00Z");
  const { repository, calls } = fixture(({ sql }) => {
    if (sql.includes("from open_applications application")) return [{ applicationId: "1", name: "Members", targetMemberGroupName: "Target Group", applicantDiscordUserId: "caller", ticketChannelId: null, status: "withdrawn", characterResolutionState: "selected", createdAt: date }];
    if (sql.includes("from tickets ticket")) return [{ ticketId: "2", name: "Help", openerDiscordUserId: null, ticketChannelId: null, createdAt: date }];
    if (sql.includes("from regear_contents\n")) return [{ regearContentId: "5", name: "Content", albionServer: "asia", contentDate: "2026-09-01", contentAt: null, channelId: null, announcementMessageId: null, createdAt: date }];
    if (sql.includes("from regear_claims claim")) return [{ regearClaimId: "3", characterName: "Character", contentName: "Content", contentDate: "2026-08-31", contentAt: null, currentOwnerDiscordUserId: null, albionServer: "europe", requestedValue: "9007199254740993", reviewChannelId: null, reviewMessageId: null, submittedAt: date }];
    if (sql.includes("from specialisation_requests request")) return [{ specialisationRequestId: "4", characterName: "Character", targetDisplayName: "Carrioncaller", level: 100, submittedByDiscordUserId: null, albionServer: "asia", reviewChannelId: "channel", reviewMessageId: null, createdAt: date }];
    return [];
  });
  const snapshot = await repository.getSnapshot("guild");
  assert.equal(snapshot.applications[0].createdAt, date);
  assert.equal(snapshot.applications[0].name, "Members");
  assert.equal(snapshot.applications[0].targetMemberGroupName, "Target Group");
  assert.equal(snapshot.applications[0].ticketChannelId, undefined);
  assert.equal(snapshot.tickets[0].openerDiscordUserId, undefined);
  assert.equal(snapshot.regears[0].requestedValue, 9007199254740993n);
  assert.equal(snapshot.regears[0].currentOwnerDiscordUserId, undefined);
  assert.equal(snapshot.regears[0].contentDate, "2026-08-31");
  assert.equal(snapshot.regears[0].contentAt, undefined);
  assert.equal(snapshot.specialisations[0].reviewMessageId, undefined);
  assert.equal(snapshot.regearContents[0].contentDate, "2026-09-01");
  assert.equal(snapshot.regearContents[0].contentAt, undefined);
  assert.equal(snapshot.regearContents[0].announcementMessageId, undefined);
  assert.match(query(calls, "from regear_contents\n"), /content_date::text as "contentDate"/);
  assert.match(query(calls, "from regear_claims claim"), /content\.content_date::text as "contentDate", content\.content_at as "contentAt"/);
  assert.match(query(calls, "from open_applications application"), /coalesce\(member_group\.group_name, class\.archived_member_group_name\) as "targetMemberGroupName"/);
  assert.match(query(calls, "from specialisation_requests request"), /case when request\.review_message_deleted_at is null then request\.review_message_id end/);
});

test("Pending specialisations display the eligible replacement owner while preserving original provenance", async () => {
  const { repository, calls } = fixture(({ sql }) => sql.includes("from specialisation_requests request") ? [{
    specialisationRequestId: "request", characterName: "Character", targetDisplayName: "Battleaxe", level: 100,
    submittedByDiscordUserId: "original", currentOwnerDiscordUserId: "replacement", albionServer: "europe",
    reviewChannelId: "channel", reviewMessageId: "message", createdAt: new Date("2026-09-28")
  }] : []);
  const snapshot = await repository.getSnapshot("guild");
  assert.equal(snapshot.specialisations[0].submittedByDiscordUserId, "original");
  assert.equal(snapshot.specialisations[0].currentOwnerDiscordUserId, "replacement");
  assert.match(query(calls, "from specialisation_requests request"), /left join lateral/);
  assert.match(query(calls, "from specialisation_requests request"), /character_has_active_membership/);
  assert.match(query(calls, "from regear_claims claim"), /character_has_active_membership/);
});
