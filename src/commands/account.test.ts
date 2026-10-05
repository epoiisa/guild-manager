import type { ChatInputCommandInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assertFeedbackCard, assertV2Message, messageNodes } from "../testSupport/messageAssertions.js";
import {
  accountCommand,
  creditCommand,
  debitCommand,
  formatAccountAmount,
  formatAccountCounterparty,
  formatAccountFullDate,
  formatAccountShortDate,
  formatAccountTime,
  formatAccountTransactionType,
  giveCommand,
  handleAccountAutocomplete,
  handleAccountCommand,
  handleCreditCommand,
  handleDebitCommand,
  handleStatementCommand,
  handleTransferCommand,
  renderAccountTextTable,
  statementCommand,
  transferCommand
} from "./account.js";

test("account commands remain hidden and expose the approved surface", () => {
  const commands = [accountCommand, statementCommand, creditCommand, debitCommand, transferCommand, giveCommand].map((command) => command.toJSON());
  assert.deepEqual(commands.map((command) => command.name), ["account", "statement", "credit", "debit", "transfer", "give"]);
  assert.ok(commands.every((command) => command.default_member_permissions === "0"));
  assert.deepEqual(accountCommand.toJSON().options?.map((option) => option.name), ["list", "statement", "set", "reset", "freeze", "unfreeze"]);
  const groups = accountCommand.toJSON().options?.filter((option) => option.type === 2) as Array<{ name: string; options: Array<{ name: string }> }>;
  assert.deepEqual(groups.map((group) => [group.name, group.options.map((option) => option.name)]), []);
  const statementOption = statementCommand.toJSON().options?.[0] as Record<string, unknown>;
  assert.deepEqual({
    type: statementOption.type,
    name: statementOption.name,
    description: statementOption.description,
    required: statementOption.required,
    autocomplete: statementOption.autocomplete
  }, {
    type: 3, name: "character", description: "Your registered character.", required: false, autocomplete: true
  });
});

test("every account operator command requires Accounts Manager access before account reads or changes", async () => {
  for (const handler of [handleAccountCommand, handleCreditCommand, handleDebitCommand, handleTransferCommand]) {
    let required = "";
    const i = {
      inGuild: () => true, guildId: "guild", user: { id: "caller" },
      options: { getSubcommand: () => { throw new Error("Must authorize first."); }, getString: () => { throw new Error("Must authorize first."); } },
    } as unknown as ChatInputCommandInteraction;
    await handler(i, {} as never, { requireRole: async (_interaction, role) => { required = role; return false; }, hasRole: async () => false });
    assert.equal(required, "accounts_manager");
  }
});

test("unauthorized account operator autocomplete exposes no account directory", async () => {
  const choices: unknown[] = [];
  const member = { user: { bot: false }, permissions: { has: () => false } };
  await handleAccountAutocomplete({
    commandName: "credit", guildId: "guild", user: { id: "caller" },
    guild: { members: { fetch: async () => member } }, options: { getFocused: () => ({ name: "character", value: "" }) },
    respond: async (value: unknown) => choices.push(value),
  } as never, { listAccounts: async () => { throw new Error("Must not read other accounts."); } } as never,
  { requireRole: async () => false, hasRole: async () => false });
  assert.deepEqual(choices, [[]]);
});

test("statement omission selects the first registered character and exposes the statement file inside a private report Container", async () => {
  const replies: any[] = [];
  const account = accountFixture();
  const accountQueries: unknown[] = [];
  const membershipQueries: unknown[] = [];
  await handleStatementCommand(
    statementInteraction(null, replies),
    {
      getAccount: async (ref: unknown) => {
        accountQueries.push(ref);
        return account;
      },
      listTransactions: async () => []
    } as never,
    {
      listRegisteredCharacters: async (...args: unknown[]) => {
        membershipQueries.push(args);
        return [
          { discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "asia", albionCharacterId: "main", characterName: "Main" },
          { discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", albionCharacterId: "later", characterName: "Later" }
        ];
      }
    } as never
  );
  assert.deepEqual(membershipQueries, [["guild-1", "user-1"]]);
  assert.deepEqual(accountQueries, [{ discordGuildId: "guild-1", albionServer: "asia", albionCharacterId: "main" }]);
  assert.equal(replies[0].flags, 32832);
  assertV2Message(replies[0]);
  assert.equal(messageNodes(replies[0], 13)[0].file.url, "attachment://statement.txt");
  assert.equal(replies[0].files[0].name, "statement.txt");
});

test("statement omission returns the exact no-registration and no-account responses without fallback", async () => {
  const noCharacterReplies: any[] = [];
  await handleStatementCommand(
    statementInteraction(null, noCharacterReplies),
    { getAccount: async () => { throw new Error("Account lookup should not run."); } } as never,
    { listRegisteredCharacters: async () => [] } as never
  );
  assertFeedbackCard(noCharacterReplies[0], {
    color: 0xeab308,
    title: "Character Not Found",
    description: "You have no registered characters."
  }, true);

  const noAccountReplies: any[] = [];
  await handleStatementCommand(
    statementInteraction(null, noAccountReplies),
    { getAccount: async () => undefined } as never,
    {
      listRegisteredCharacters: async () => [
        { discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", albionCharacterId: "main", characterName: "Main" },
        { discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "asia", albionCharacterId: "later", characterName: "Later" }
      ]
    } as never
  );
  assertFeedbackCard(noAccountReplies[0], {
    color: 0xeab308,
    title: "Account Not Found",
    description: "No account for Main • Europe."
  }, true);

  const closedAccountReplies: any[] = [];
  await handleStatementCommand(
    statementInteraction(null, closedAccountReplies),
    { getAccount: async () => ({ ...accountFixture(), status: "closed" }), listTransactions: async () => [] } as never,
    { listRegisteredCharacters: async () => [{ discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", albionCharacterId: "main", characterName: "Main" }] } as never
  );
  assertFeedbackCard(closedAccountReplies[0], {
    color: 0xeab308,
    title: "Account Not Found",
    description: "No account for Main • Europe."
  }, true);
});

test("statement rejects supplied malformed, stale, closed, and other-user references without account data", async () => {
  for (const [value, account] of [
    ["invalid", undefined],
    ["asia:stale", undefined],
    ["asia:closed", { ...accountFixture(), status: "closed" }],
    ["asia:other", { ...accountFixture(), discordUserId: "other-user" }]
  ] as const) {
    const replies: any[] = [];
    await handleStatementCommand(
      statementInteraction(value, replies),
      { getAccount: async () => account, listTransactions: async () => [] } as never,
      { listRegisteredCharacters: async () => { throw new Error("Supplied values must not read registrations."); } } as never
    );
    assertFeedbackCard(replies[0], {
      color: 0xeab308,
      title: value === "invalid" ? "Character Not Found" : "Account Not Found",
      description: value === "invalid" ? "Choose one of your registered characters from autocomplete." : "Choose one of your registered character accounts."
    }, true);
    assert.equal(replies[0].flags, 68);
  }
});

test("account export dates are UTC and follow the approved formats", () => {
  const date = new Date("2026-07-12T14:35:59.000Z");
  assert.equal(formatAccountFullDate(date), "12/07/2026 • 14:35 UTC");
  assert.equal(formatAccountShortDate(date), "12/07/2026");
  assert.equal(formatAccountTime(date), "14:35 UTC");
});

test("re-gear account credits use the friendly statement type", () => {
  assert.equal(formatAccountTransactionType("regear_credit"), "REGEAR");
  assert.equal(formatAccountTransactionType("transfer_credit"), "transfer credit");
});

test("account exports use readable counterparties and only negative amounts use a sign", () => {
  const transaction = {
    transactionId: "201",
    amount: -500000n,
    balanceAfter: 500000n,
    createdAt: new Date("2026-07-12T14:35:59.000Z")
  };
  assert.equal(formatAccountCounterparty({ ...transaction, transactionType: "transfer_debit", counterpartyCharacterName: "Destination" }), "To Destination");
  assert.equal(formatAccountCounterparty({ ...transaction, transactionType: "transfer_credit", counterpartyCharacterName: "Source" }), "From Source");
  assert.equal(formatAccountCounterparty({ ...transaction, transactionType: "credit" }), "—");
  assert.equal(formatAccountAmount(500000n), "500,000");
  assert.equal(formatAccountAmount(-500000n), "-500,000");
  assert.equal(formatAccountAmount(0n), "0");
});

test("account text tables align columns with spaces and no separators", () => {
  assert.equal(
    renderAccountTextTable(
      ["CHARACTER", "USER", "SERVER"],
      [["Alice", "@One", "Europe"], ["Long Character", "—", "Asia"]]
    ),
    [
      "CHARACTER      USER SERVER",
      "Alice          @One Europe",
      "Long Character —    Asia"
    ].join("\n")
  );
});

function statementInteraction(character: string | null, replies: any[]): ChatInputCommandInteraction {
  return {
    inGuild: () => true,
    guildId: "guild-1",
    guild: null,
    user: { id: "user-1" },
    options: { getString: () => character },
    reply: async (payload: unknown) => { replies.push(payload); }
  } as unknown as ChatInputCommandInteraction;
}

function accountFixture() {
  return {
    accountId: "account-1",
    discordGuildId: "guild-1",
    discordUserId: "user-1",
    albionServer: "asia" as const,
    albionCharacterId: "main",
    characterName: "Main",
    status: "open" as const,
    balance: 1234n,
    createdAt: new Date("2026-07-01T00:00:00.000Z")
  };
}
