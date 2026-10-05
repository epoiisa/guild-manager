import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationRepository, type ApplicationReviewPublication } from "./applicationRepository.js";

function fixture(rowCount = 1) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return { calls, query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); return { rows: [], rowCount }; } };
}
const initial: ApplicationReviewPublication = { initialMessage: "  Exact Markdown\n", reviewerRoleId: "role", answerMessageIds: [], notificationClaimed: false };

test("publication CAS scopes both tenant and exact prior state and reports lost claims", async () => {
  const pool = fixture(0);
  const repository = createApplicationRepository(pool as never);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", initial, { ...initial, notificationClaimed: true }), false);
  assert.match(pool.calls[0].sql, /discord_guild_id = \$1 and application_id = \$2/);
  assert.match(pool.calls[0].sql, /review_publication = \$3::jsonb/);
  assert.match(pool.calls[0].sql, /channel_status <> 'deleted'/);
  assert.equal(JSON.parse(pool.calls[0].values![2] as string).initialMessage, initial.initialMessage);
});

test("publication snapshots cannot be rewritten or a notification rearmed", async () => {
  const pool = fixture();
  const repository = createApplicationRepository(pool as never);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", initial, { ...initial, initialMessage: "changed" }), false);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", initial, { ...initial, reviewerRoleId: "other" }), false);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", { ...initial, notificationClaimed: true }, initial), false);
  assert.equal(pool.calls.length, 0);
});

test("review initialization checks exact identity and tenant ownership but permits silent legacy adoption", async () => {
  const pool = fixture();
  await createApplicationRepository(pool as never).ensureApplicationReviewPublication("guild", "app");
  const sql = pool.calls[0].sql;
  assert.match(sql, /a.review_publication is null/);
  assert.match(sql, /a.legacy_review_publication or/);
  assert.match(sql, /a.character_resolution_state = 'selected'/);
  assert.match(sql, /identity.albion_server = a.albion_server/);
  assert.match(sql, /owner.discord_guild_id = a.discord_guild_id/);
  assert.match(sql, /owner.discord_user_id <> a.applicant_discord_user_id/);
  assert.deepEqual(pool.calls[0].values, ["guild", "app"]);
});

test("canonical first message claims atomically synchronize both IDs", async () => {
  const pool = fixture();
  assert.equal(await createApplicationRepository(pool as never).claimApplicationFirstMessageId("guild", "app", undefined, "message"), true);
  assert.match(pool.calls[0].sql, /application_control_message_id = \$4, character_resolution_message_id = \$4/);
  assert.match(pool.calls[0].sql, /application_control_message_id is not distinct from \$3/);
  assert.deepEqual(pool.calls[0].values, ["guild", "app", null, "message"]);
});

test("legacy posted payload is immutable after its first snapshot", async () => {
  const pool = fixture();
  const repository = createApplicationRepository(pool as never);
  const retained = { ...initial, legacyHistoryPayload: { content: "Actually posted" } };
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", initial, retained), true);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", retained, { ...retained, legacyHistoryPayload: { content: "Current configuration" } }), false);
  assert.equal(await repository.updateApplicationReviewPublication("guild", "app", retained, { ...retained, legacyHistoryPayload: undefined }), false);
  assert.equal(pool.calls.length, 1);
});

test("selected identity reads retain display metadata and exact tenant/server/character ownership", async () => {
  const calls: string[] = [];
  const repository = createApplicationRepository({ query: async (sql: string) => {
    calls.push(sql);
    return { rows: [{ selected_character_owner_discord_user_id: "owner", modal_answers: [],
      selected_character_name: "AAZUM", selected_character_guild_name: "Dreamweavers",
      selected_character_alliance_name: "GUCHI", selected_character_alliance_tag: null,
    }] };
  } } as never);
  for (const application of [
    await repository.getOpenApplication("guild", "app"),
    await repository.getOpenApplicationByTicketChannel("guild", "channel"),
  ]) {
    assert.equal(application?.selectedCharacterOwnerDiscordUserId, "owner");
    assert.equal(application?.selectedCharacterName, "AAZUM");
    assert.equal(application?.selectedCharacterGuildName, "Dreamweavers");
    assert.equal(application?.selectedCharacterAllianceName, "GUCHI");
    assert.equal(application?.selectedCharacterAllianceTag, undefined);
  }
  assert.equal((await repository.listOperationalApplicationTargets("guild"))[0]?.selectedCharacterOwnerDiscordUserId, "owner");
  for (const sql of calls.slice(0, 2)) {
    assert.match(sql, /left join albion_characters identity/);
    assert.match(sql, /identity.albion_server = open_applications.albion_server/);
    assert.match(sql, /identity.albion_character_id = open_applications.selected_albion_character_id/);
    assert.match(sql, /identity.guild_name as selected_character_guild_name/);
    assert.match(sql, /identity.alliance_name as selected_character_alliance_name/);
    assert.match(sql, /identity.alliance_tag as selected_character_alliance_tag/);
    assert.match(sql, /owner.discord_guild_id = open_applications.discord_guild_id/);
    assert.match(sql, /owner.albion_server = open_applications.albion_server/);
    assert.match(sql, /owner.albion_character_id = open_applications.selected_albion_character_id/);
  }
  assert.match(calls[2], /owner.discord_guild_id=a.discord_guild_id and owner.albion_server=a.albion_server and owner.albion_character_id=a.selected_albion_character_id/);
});

test("rejection mutation itself requires a selected identity with no conflicting current owner", async () => {
  const pool = fixture();
  await createApplicationRepository(pool as never).markApplicationRejected("guild", "app", "reviewer");
  const sql = pool.calls[0].sql;
  assert.match(sql, /character_resolution_state = 'selected'/);
  assert.match(sql, /selected_albion_character_id is not null/);
  assert.match(sql, /owner.discord_guild_id = open_applications.discord_guild_id/);
  assert.match(sql, /owner.albion_server = open_applications.albion_server/);
  assert.match(sql, /owner.albion_character_id = open_applications.selected_albion_character_id/);
  assert.match(sql, /owner.discord_user_id <> open_applications.applicant_discord_user_id/);
});

test("valid selection atomically captures first review configuration while preserving any earlier snapshot", async () => {
  const pool = fixture();
  await createApplicationRepository(pool as never).selectApplicationCharacter("guild", "app", "identity", "selected");
  const sql = pool.calls[0].sql;
  assert.match(sql, /set selected_albion_character_id = \$3/);
  assert.match(sql, /review_publication = coalesce\(a.review_publication, case/);
  assert.match(sql, /when \$4 = 'selected'/);
  assert.match(sql, /identity.albion_server = a.albion_server and identity.albion_character_id = \$3/);
  assert.match(sql, /owner.discord_guild_id = a.discord_guild_id and owner.albion_server = a.albion_server/);
  assert.match(sql, /'initialMessage', case when a.legacy_review_publication then null else c.initial_message end/);
  assert.match(sql, /'notificationClaimed', a.legacy_review_publication/);
  assert.match(sql, /c.discord_guild_id = a.discord_guild_id/);
  assert.deepEqual(pool.calls[0].values, ["guild", "app", "identity", "selected"]);
});
