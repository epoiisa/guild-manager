import assert from "node:assert/strict";
import test from "node:test";
import { AccountOperationError, createAccountRepository } from "./accountRepository.js";

test("self-service account reads are bounded to one user, exclude closed accounts, and use registration order", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [{
          account_id: "account-1",
          discord_guild_id: "guild-1",
          albion_server: "asia",
          albion_character_id: "character-1",
          character_name: "Example",
          discord_user_id: "user-1",
          status: "frozen",
          balance: "123456",
          created_at: new Date("2026-07-01T00:00:00.000Z"),
          closed_at: null
        }]
      };
    }
  } as unknown as Parameters<typeof createAccountRepository>[0];
  const repository = createAccountRepository(pool);

  assert.deepEqual(
    await repository.listAccountsForUser("guild-1", "user-1"),
    [{
      accountId: "account-1",
      discordGuildId: "guild-1",
      albionServer: "asia",
      albionCharacterId: "character-1",
      characterName: "Example",
      discordUserId: "user-1",
      status: "frozen",
      balance: 123456n,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      closedAt: undefined
    }]
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /duc\.discord_user_id = \$2/);
  assert.match(calls[0].sql, /ca\.status <> 'closed'/);
  assert.match(calls[0].sql, /order by duc\.registration_order asc, ca\.albion_server asc, ca\.albion_character_id asc/);
  assert.deepEqual(calls[0].values, ["guild-1", "user-1"]);
});

test("Give locks and validates both selected registrations before atomic ledger writes", async () => {
  const f = ledgerFixture();
  const result = await f.repository.transfer(f.from, f.to, 200n, "caller", "A gift", { fromDiscordUserId: "caller", toDiscordUserId: "recipient" });
  assert.equal(result.from.balance, 800n);
  assert.equal(result.to.balance, 1200n);
  const locks = f.calls.filter((call) => call.sql.includes("from discord_user_characters"));
  assert.equal(locks.length, 2);
  assert.ok(locks.every((call) => /for share/.test(call.sql)));
  const transactions = f.calls.filter((call) => call.sql.startsWith("insert into account_transactions"));
  assert.deepEqual(transactions.map((call) => call.values.slice(2, 5)), [["transfer_debit", "-200", "800"], ["transfer_credit", "200", "1200"]]);
  assert.equal(f.calls.at(-1)?.sql, "commit");
});

test("Give rejects a changed selected owner before ledger writes and rolls back", async () => {
  const f = ledgerFixture();
  f.owners.destination = "new-owner";
  await assert.rejects(f.repository.transfer(f.from, f.to, 200n, "caller", undefined, { fromDiscordUserId: "caller", toDiscordUserId: "recipient" }),
    (error: unknown) => error instanceof AccountOperationError && error.code === "ownership_changed");
  assert.equal(f.calls.some((call) => call.sql.startsWith("insert") || call.sql.startsWith("update")), false);
  assert.equal(f.calls.at(-1)?.sql, "rollback");
});

test("transfers retain frozen, closed, and insufficient-funds protections inside the transaction", async () => {
  for (const reason of ["frozen", "closed", "insufficient_funds"] as const) {
    const f = ledgerFixture();
    if (reason !== "insufficient_funds") f.status.source = reason;
    await assert.rejects(f.repository.transfer(f.from, f.to, reason === "insufficient_funds" ? 1001n : 1n, "manager"),
      (error: unknown) => error instanceof AccountOperationError && error.code === reason);
    assert.equal(f.calls.some((call) => call.sql.startsWith("insert") || call.sql.startsWith("update")), false);
    assert.equal(f.calls.at(-1)?.sql, "rollback");
  }
});

test("Debit can produce a negative balance; excessive amounts roll back without ledger entries", async () => {
  const f = ledgerFixture();
  const updated = await f.repository.adjust(f.from, "debit", -2000n, "manager");
  assert.equal(updated.balance, -1000n);
  const huge = ledgerFixture();
  await assert.rejects(huge.repository.adjust(huge.from, "credit", 9223372036854775807n, "manager"),
    (error: unknown) => error instanceof AccountOperationError && error.code === "invalid_amount");
  assert.equal(huge.calls.some((call) => call.sql.startsWith("insert") || call.sql.startsWith("update")), false);
  assert.equal(huge.calls.at(-1)?.sql, "rollback");
});

function ledgerFixture() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const owners: Record<string, string> = { source: "caller", destination: "recipient" };
  const status: Record<string, string> = { source: "open", destination: "open" };
  const suspended: Record<string, boolean> = { source: false, destination: false };
  const client = {
    release() {},
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("character_financial_actions_suspended")) return { rows: [{ suspended: suspended[String(values[2])] }] };
      if (sql.includes("from discord_user_characters")) return { rows: [{ discord_user_id: owners[String(values[2])] }] };
      if (sql.includes("for update of ca")) {
        const id = String(values[2]);
        return { rows: [{ account_id: id, discord_guild_id: "guild", albion_server: "asia", albion_character_id: id,
          character_name: id, discord_user_id: owners[id], status: status[id], balance: "1000", created_at: new Date("2026-09-01"), closed_at: null }] };
      }
      if (sql.includes("nextval")) return { rows: [{ transfer_id: "transfer" }] };
      return { rows: [] };
    },
  };
  return { calls, owners, status, suspended, repository: createAccountRepository({ connect: async () => client } as never),
    from: { discordGuildId: "guild", albionServer: "asia" as const, albionCharacterId: "source" },
    to: { discordGuildId: "guild", albionServer: "asia" as const, albionCharacterId: "destination" },
  };
}


test("recovery suspension blocks every balance adjustment and either side of a transfer without ledger writes", async () => {
  for (const type of ["credit", "debit", "set_adjustment", "reset_adjustment"] as const) {
    const f = ledgerFixture();
    f.suspended.source = true;
    await assert.rejects(f.repository.adjust(f.from, type, 10n, "manager"),
      (error: unknown) => error instanceof AccountOperationError && error.code === "membership_suspended");
    assert.equal(f.calls.some(call => /^(insert|update)/.test(call.sql)), false);
    assert.equal(f.calls.at(-1)?.sql, "rollback");
  }
  for (const side of ["source", "destination"]) {
    const f = ledgerFixture();
    f.suspended[side] = true;
    await assert.rejects(f.repository.transfer(f.from, f.to, 10n, "manager"),
      (error: unknown) => error instanceof AccountOperationError && error.code === "membership_suspended");
    assert.equal(f.calls.some(call => /^(insert|update)/.test(call.sql)), false);
    assert.equal(f.calls.at(-1)?.sql, "rollback");
  }
});

test("manual freeze is preserved by recovery suspension and normal spending resumes only after both clear", async () => {
  const f = ledgerFixture();
  f.status.source = "frozen";
  f.suspended.source = true;
  await assert.rejects(f.repository.adjust(f.from, "credit", 10n, "manager"),
    (error: unknown) => error instanceof AccountOperationError && error.code === "frozen");
  f.suspended.source = false;
  await assert.rejects(f.repository.adjust(f.from, "credit", 10n, "manager"),
    (error: unknown) => error instanceof AccountOperationError && error.code === "frozen");
  f.status.source = "open";
  const result = await f.repository.adjust(f.from, "credit", 10n, "manager");
  assert.equal(result.balance, 1010n);
});
