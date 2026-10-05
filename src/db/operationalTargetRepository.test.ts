import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationRepository } from "./applicationRepository.js";
import { createTicketRepository } from "./ticketRepository.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

type Call = { sql: string; values: unknown[] | undefined };

function pool(rows: unknown[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return { rows, rowCount: 1 };
    }
  };
}

test("application closed-control setters are tenant-scoped and can clear", async () => {
  const value = pool(); const repository = createApplicationRepository(value as never);
  await repository.setClosedControlMessageId("guild-a", "application-a", "message-a");
  await repository.setClosedControlMessageId("guild-a", "application-a", undefined);
  assert.equal(await repository.claimClosedControlMessageId("guild-a", "application-a", undefined, "candidate-a"), true);
  assert.match(value.calls[0].sql, /discord_guild_id=\$1 and application_id=\$2/);
  assert.deepEqual(value.calls[0].values, ["guild-a", "application-a", "message-a"]);
  assert.deepEqual(value.calls[1].values, ["guild-a", "application-a", null]);
  assert.match(value.calls[2].sql, /closed_control_message_id is not distinct from \$3/);
  assert.deepEqual(value.calls[2].values, ["guild-a", "application-a", null, "candidate-a"]);
});

test("ticket control setters and channel lookup are tenant-scoped and can clear", async () => {
  const value = pool(); const repository = createTicketRepository(value as never);
  await repository.setTicketControlMessageId("guild-a", "ticket-a", "message-a");
  await repository.setTicketControlMessageId("guild-a", "ticket-a", undefined);
  assert.equal(await repository.claimTicketControlMessageId("guild-a", "ticket-a", "message-a", "candidate-a"), true);
  await repository.getTicketByChannel("guild-a", "channel-a");
  assert.match(value.calls[0].sql, /discord_guild_id=\$1 and ticket_id=\$2/);
  assert.deepEqual(value.calls[1].values, ["guild-a", "ticket-a", null]);
  assert.match(value.calls[2].sql, /control_message_id is not distinct from \$3/);
  assert.deepEqual(value.calls[2].values, ["guild-a", "ticket-a", "message-a", "candidate-a"]);
  assert.match(value.calls[3].sql, /discord_guild_id=\$1 and ticket_channel_id=\$2/);
});

test("operational target lists are tenant-scoped, exclude deleted rows, and map class and target-group names", async () => {
  const applications = pool([{ application_id: "1", application_name: "Applicants", target_member_group_name: "Hearties", applicant_discord_user_id: "user", ticket_channel_id: "channel", character_resolution_state: "selected", selected_albion_character_id: "exact-character", status: "accepted", channel_status: "open", reviewer_role_id: "role" }]);
  const appTargets = await createApplicationRepository(applications as never).listOperationalApplicationTargets("guild-a");
  assert.equal(appTargets[0]?.applicationName, "Applicants");
  assert.equal(appTargets[0]?.characterResolutionState, "selected");
  assert.equal(appTargets[0]?.selectedAlbionCharacterId, "exact-character");
  assert.equal(appTargets[0]?.targetMemberGroupName, "Hearties");
  assert.match(applications.calls[0].sql, /left join member_groups g/);
  assert.match(applications.calls[0].sql, /coalesce\(g\.group_name, c\.archived_member_group_name\) as target_member_group_name/);
  assert.doesNotMatch(applications.calls[0].sql, /g\.name/);
  assert.match(applications.calls[0].sql, /a\.discord_guild_id=\$1\s+and a\.channel_status <> 'deleted'/);
  assert.match(applications.calls[0].sql, /\$2::boolean or c\.archived_at is null/);
  assert.deepEqual(applications.calls[0].values, ["guild-a", false]);
  await createApplicationRepository(applications as never).listOperationalApplicationTargets("guild-a", true);
  assert.deepEqual(applications.calls[1].values, ["guild-a", true]);
  const tickets = pool([{ ticket_id: "1", ticket_name: "General", opener_discord_user_id: "user", ticket_channel_id: "channel", status: "open", reviewer_role_id: "role" }]);
  const ticketTargets = await createTicketRepository(tickets as never).listOperationalTicketTargets("guild-a");
  assert.equal(ticketTargets[0]?.ticketName, "General");
  assert.match(tickets.calls[0].sql, /t\.discord_guild_id=\$1 and t\.status <> 'deleted'/);
});

test("schema target includes migration 38 for application review publication", () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 38);
});
