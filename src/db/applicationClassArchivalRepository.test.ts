import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationClassUnavailableError, createApplicationRepository } from "./applicationRepository.js";
import type { PostgresPool } from "./postgres.js";

type Call = { sql: string; values: unknown[] };

test("configurable application-class listing excludes archived classes while exact lookup retains history", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));

  await repository.listApplicationClasses("guild-id");
  await repository.getApplicationClass("guild-id", "class-id");

  assert.match(calls[0].sql, /where discord_guild_id = \$1\s+and archived_at is null/);
  assert.doesNotMatch(calls[1].sql, /archived_at is null/);
});

test("removal choices can include archived application classes without changing normal configuration lists", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));
  await repository.listApplicationClasses("guild-id", true);
  await repository.listApplicationClasses("guild-id");
  assert.doesNotMatch(calls[0].sql, /archived_at is null/);
  assert.match(calls[1].sql, /archived_at is null/);
  assert.deepEqual(calls.map((call) => call.values), [["guild-id"], ["guild-id"]]);
});

test("application creation atomically requires an enabled unarchived class with a live target", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));

  await assert.rejects(
    repository.createOpenApplication({
      applicationClassId: "class-id",
      discordGuildId: "guild-id",
      applicantDiscordUserId: "applicant-id",
      submittedCharacterName: "Character",
      modalAnswers: [],
      albionServer: "europe"
    }),
    ApplicationClassUnavailableError
  );

  assert.match(calls[0].sql, /insert into open_applications/);
  assert.match(calls[0].sql, /from application_classes application_class/);
  assert.match(calls[0].sql, /application_class\.enabled = true/);
  assert.match(calls[0].sql, /application_class\.archived_at is null/);
  assert.match(calls[0].sql, /application_class\.outcome_type <> 'member_group'/);
  assert.match(calls[0].sql, /or member_group\.member_group_id is not null/);
  assert.match(calls[0].sql, /for share of application_class/);
});

test("active application-role checks require another open application on an unarchived class", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, [{ required: true }]));

  const required = await repository.hasOpenApplicationRequiringRole("guild-id", "applicant-id", "active-role-id");

  assert.equal(required, true);
  assert.match(calls[0].sql, /open_application\.channel_status = 'open'/);
  assert.match(calls[0].sql, /open_application\.status in \('open', 'awaiting_ingame_membership'\)/);
  assert.match(calls[0].sql, /application_class\.archived_at is null/);
  assert.match(calls[0].sql, /application_class\.active_role_id = \$3/);
  assert.deepEqual(calls[0].values, ["guild-id", "applicant-id", "active-role-id"]);
});

test("application-class configuration mutations cannot update archived classes", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));

  await repository.configureApplicationButton("guild-id", "class-id", "channel", "message", "Apply", "primary");
  await repository.setApplicationQuestions("guild-id", "class-id", []);
  await repository.setApplicationMessage("guild-id", "class-id", "initial", "Hello");
  await repository.setApplicationEnabled("guild-id", "class-id", true);

  for (const call of calls) assert.match(call.sql, /and archived_at is null/);
});

test("ticket linking and final provisioning checks lock and reject archived classes", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));

  assert.equal(await repository.setOpenApplicationTicketChannel("guild-id", "application-id", "channel-id"), undefined);
  assert.equal(await repository.isOpenApplicationClassOperational("guild-id", "application-id"), false);

  assert.match(calls[0].sql, /with available_class as materialized/);
  assert.match(calls[0].sql, /application_class\.archived_at is null/);
  assert.match(calls[0].sql, /for share of application_class/);
  assert.match(calls[0].sql, /exists \(select 1 from available_class\)/);
  assert.match(calls[1].sql, /application_class\.archived_at is null/);
  assert.match(calls[1].sql, /for share of application_class/);
});

test("reopen locks and excludes an archived application class", async () => {
  const calls: Call[] = [];
  const repository = createApplicationRepository(capturingPool(calls, []));

  assert.equal(await repository.markApplicationReopened("guild-id", "application-id", "actor-id"), undefined);

  assert.match(calls[0].sql, /with available_class as materialized/);
  assert.match(calls[0].sql, /application_class\.archived_at is null/);
  assert.match(calls[0].sql, /for share of application_class/);
  assert.match(calls[0].sql, /exists \(select 1 from available_class\)/);
});

function capturingPool(calls: Call[], rows: unknown[]): PostgresPool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    }
  } as unknown as PostgresPool;
}
