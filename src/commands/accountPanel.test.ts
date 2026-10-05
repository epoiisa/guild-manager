import assert from "node:assert/strict";
import test from "node:test";
import { AccountOperationError, type AccountRef, type AccountTransferOwnership, type CharacterAccount } from "../db/accountRepository.js";
import { assertFeedbackCard, messageDescription, messageSummary, messageTexts } from "../testSupport/messageAssertions.js";
import { buildAccountsPanel, createAccountPanelInteractions, parseAccountFormAmount } from "./accountPanel.js";

test("Accounts public panel preserves exact text, order, styles, and privacy", () => {
  const payload = json(buildAccountsPanel("generation"));
  assert.deepEqual(texts(payload), ["# Accounts\n\nGive account funds and view your balances and statements.\n\n**Everyone**", "**Managers**"]);
  assert.deepEqual(nodes(payload, 2).map((b) => [b.label, b.style]), [["Give", 1], ["Balance", 2], ["Statement", 2], ["Credit", 2], ["Debit", 2], ["Transfer", 2]]);
  assert.ok(nodes(payload, 2).every((b) => b.custom_id.startsWith("entry-panel:accounts:generation:")));
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  assert.equal(payload.flags, 32768);
});

test("Balance is the existing private own-account report and remains available while timed out", async () => {
  const f = fixture([account("main", "caller", "frozen"), account("alt", "caller"), account("someone", "other")]);
  f.state.timeout = true;
  const i = await f.entry("balance");
  assert.equal(i.calls[0][1].flags, 64);
  const report = json(i.last());
  assert.equal(messageSummary(report), "Balance");
  assert.equal(messageDescription(report), "main • Asia • 1,000 • Frozen\nalt • Asia • 1,000");
  assert.equal(messageTexts(report).at(-1), "Use `/statement` to view your full account history.");
  const empty = fixture([]);
  assert.equal(messageDescription(json((await empty.entry("balance")).last())), "No accounts. Use `/statement` to view your full account history.");
});

test("Statement preserves registration order, preselects a sole frozen account, and sends complete history", async () => {
  const f = fixture([account("main", "caller", "frozen")]);
  const start = await f.entry("statement");
  const selection = nodes(json(start.last()), 3)[0];
  assert.equal(selection.placeholder, "Character");
  assert.equal(selection.options[0].default, true);
  const report = await f.press(start, "View Statement");
  assert.equal(report.calls[0][0], "deferReply");
  assert.equal(report.calls[0][1].flags, 64);
  const file = report.last().files[0];
  assert.equal(file.name, "statement.txt");
  assert.match(file.attachment.toString(), /Account Statement/);
  assert.match(file.attachment.toString(), /frozen/);
  assert.match(file.attachment.toString(), /Entire retained transaction description/);

  const two = fixture([account("ZMain", "caller"), account("AAlt", "caller")]);
  const menu = nodes(json((await two.entry("statement")).last()), 3)[0];
  assert.deepEqual(menu.options.map((o: any) => o.label), ["ZMain • Asia", "AAlt • Asia"]);
});

test("Statement rechecks ownership and does not expose a reassigned account", async () => {
  const f = fixture([account("main", "caller")]);
  const start = await f.entry("statement");
  f.accounts[0].discordUserId = "other";
  const report = await f.press(start, "View Statement");
  assert.match(texts(json(report.last())).join("\n"), /Start Again/);
  assert.equal(report.last().files, undefined);
});

test("Give empty states keep recipient selection available and exclude frozen sources", async () => {
  const empty = fixture([account("frozen", "caller", "frozen")]);
  assert.deepEqual(texts(json((await empty.entry("give")).last())), ["You have no open accounts to give from."]);
  const f = fixture([account("source", "caller")]);
  const start = await f.entry("give");
  const selected = await f.select(start, "Recipient", "other", "user");
  const payload = json(selected.last());
  assert.deepEqual(nodes(payload, 3).map((menu) => menu.placeholder), ["From", "To"]);
  assert.equal(nodes(payload, 5)[0].placeholder, "Recipient");
  assert.match(texts(payload).join("\n"), /That member has no open character accounts\. Choose another member\./);
  assert.equal(nodes(payload, 2).find((b) => b.label === "Continue")?.disabled, true);
});

test("Give freezes both selected accounts, retains receipts, and spends once", async () => {
  const f = fixture([account("source", "caller"), { ...account("destination", "other"), albionServer: "europe" }]);
  const start = await f.entry("give");
  const recipient = await f.select(start, "Recipient", "other", "user");
  const form = await f.press(recipient, "Continue");
  const modal = json(form.modal);
  assert.equal(modal.title, "Give Account Funds");
  assert.deepEqual(texts(modal), ["**From** source • Asia\n**To** destination • Europe"]);
  assert.deepEqual(nodes(modal, 18).map((l) => [l.label, l.description]), [["Amount", "Enter a positive amount in whole silver."], ["Description", "Optional transaction description, up to 200 characters."]]);
  const receipt = await f.submit(form, { amount: "125", description: "Thanks" });
  assertFeedbackCard(json(receipt.last()), { color: 0x22c55e, title: "Funds Given", description: "125 transferred from source to destination." });
  assert.deepEqual(f.transfers[0].ownership, { fromDiscordUserId: "caller", toDiscordUserId: "other" });
  assert.equal(f.accounts[0].balance, 875n);
  const duplicate = await f.submit(form, { amount: "125", description: "Again" });
  assert.match(texts(json(duplicate.last())).join("\n"), /Start Again/);
  assert.equal(f.transfers.length, 1);
});

test("Give rejects changed ownership and timed-out mutations without touching balances", async () => {
  for (const change of ["owner", "timeout"] as const) {
    const f = fixture([account("source", "caller"), account("destination", "other")]);
    const form = await f.press(await f.select(await f.entry("give"), "Recipient", "other", "user"), "Continue");
    if (change === "owner") f.accounts[0].discordUserId = "other";
    else f.state.timeout = true;
    const reply = await f.submit(form, { amount: "1", description: "" });
    assert.match(JSON.stringify(json(reply.last())), change === "owner" ? /ownership changed/ : /timed out/);
    assert.equal(f.accounts[0].balance, 1000n);
    assert.equal(f.transfers.length, 0);
  }
});

test("Credit and Debit authorize entry and submission, include ownerless open accounts, and allow negative debit", async () => {
  const f = fixture([account("orphan"), account("frozen", undefined, "frozen"), account("closed", undefined, "closed")]);
  f.state.manager = false;
  assert.match(texts(json((await f.entry("credit")).last())).join("\n"), /Accounts Manager Required/);
  f.state.manager = true;
  for (const action of ["credit", "debit"]) {
    const start = await f.entry(action);
    assert.deepEqual(nodes(json(start.last()), 3)[0].options.map((o: any) => o.label), ["orphan • Asia"]);
    const chosen = await f.select(start, "Character", "asia:orphan");
    const form = await f.press(chosen, "Continue");
    assert.equal(json(form.modal).title, action === "credit" ? "Credit Account" : "Debit Account");
    const receipt = await f.submit(form, { amount: "2000", description: "" });
    assert.equal(messageSummary(json(receipt.last())), action === "credit" ? "orphan's account was credited; its balance is now 3,000." : "orphan's account was debited; its balance is now 1,000.");
  }
  const chosen = await f.select(await f.entry("debit"), "Character", "asia:orphan");
  const form = await f.press(chosen, "Continue");
  const receipt = await f.submit(form, { amount: "2000", description: "" });
  assert.match(messageDescription(json(receipt.last())), /-1,000/);
  const revoked = await f.press(await f.select(await f.entry("credit"), "Character", "asia:orphan"), "Continue");
  f.state.manager = false;
  const denial = await f.submit(revoked, { amount: "99", description: "" });
  assert.match(texts(json(denial.last())).join("\n"), /Accounts Manager Required/);
  assert.equal(f.adjustments.length, 3);
});

test("Transfer directories search and paginate each step independently, including no matches", async () => {
  const f = fixture(Array.from({ length: 54 }, (_, n) => account(`Character${String(n).padStart(2, "0")}`)));
  const start = await f.entry("transfer");
  assert.match(texts(json(start.last())).join("\n"), /Page 1 of 3/);
  const page = await f.press(start, "Next");
  assert.match(texts(json(page.last())).join("\n"), /Page 2 of 3/);
  const search = await f.press(page, "Search");
  assert.equal(json(search.modal).title, "Search Accounts");
  assert.equal(nodes(json(search.modal), 18)[0].description, "Enter a character name, or leave blank to show all eligible accounts.");
  const noMatch = await f.submit(search, { query: "Missing" });
  assert.match(texts(json(noMatch.last())).join("\n"), /No matching accounts\./);
  assert.ok(nodes(json(noMatch.last()), 2).some((b) => b.label === "Search"));
  const filtered = await f.submit(await f.press(noMatch, "Search"), { query: "Character53" });
  const source = await f.select(filtered, "From", "asia:Character53");
  const destination = await f.press(source, "Continue");
  assert.equal(nodes(json(destination.last()), 3)[0].placeholder, "To");
  assert.equal(nodes(json(destination.last()), 3)[0].options.length, 25);
  assert.match(texts(json(destination.last())).join("\n"), /Page 1 of 3/);
  const selected = await f.select(destination, "To", "asia:Character00");
  const form = await f.press(selected, "Continue");
  assert.deepEqual(texts(json(form.modal)), ["**From** Character53 • Asia\n**To** Character00 • Asia"]);
  const receipt = await f.submit(form, { amount: "500", description: "" });
  assert.equal(messageSummary(json(receipt.last())), "500 transferred from Character53 to Character00.");
  assert.equal(f.transfers[0].ownership, undefined);
});

test("normal panel movement preserves drafts; reconfiguration, expiry, invalidation, and stop reject forms", async () => {
  for (const change of ["move", "revision", "expiry", "reset", "stop"] as const) {
    const f = fixture([account("orphan")]);
    const form = await f.press(await f.select(await f.entry("credit"), "Character", "asia:orphan"), "Continue");
    if (change === "move") f.state.generation = "new-generation";
    if (change === "revision") f.state.revision = "new-revision";
    if (change === "expiry") f.state.now += 15 * 60000;
    if (change === "reset") f.panel.invalidateGuild("guild");
    if (change === "stop") f.panel.stop();
    const result = await f.submit(form, { amount: "10", description: "" });
    if (change === "move") assert.equal(messageSummary(json(result.last())), "orphan's account was credited; its balance is now 1,010.");
    else assert.match(texts(json(result.last())).join("\n"), /Start Again/);
    assert.equal(f.adjustments.length, change === "move" ? 1 : 0);
  }
});

test("Cancel works after native modal dismissal and timeout, while changed channel settings expire controls", async () => {
  const f = fixture([account("orphan")]);
  const selected = await f.select(await f.entry("credit"), "Character", "asia:orphan");
  await f.press(selected, "Continue");
  f.state.timeout = true;
  f.state.manager = false;
  const cancelled = await f.press(selected, "Cancel");
  assert.deepEqual(texts(json(cancelled.last())), ["Cancelled. No changes were made."]);
  assert.equal(f.adjustments.length, 0);
  const g = fixture([account("orphan")]);
  const start = await g.entry("credit");
  g.state.revision = "changed";
  assert.match(texts(json((await g.press(start, "Cancel")).last())).join("\n"), /Start Again/);
});

test("changed private selections invalidate old modals instead of changing their frozen account", async () => {
  const f = fixture([account("one"), account("two")]);
  const initial = await f.select(await f.entry("credit"), "Character", "asia:one");
  const oldForm = await f.press(initial, "Continue");
  const changed = await f.select(initial, "Character", "asia:two");
  const oldResult = await f.submit(oldForm, { amount: "999", description: "" });
  assert.match(texts(json(oldResult.last())).join("\n"), /Start Again/);
  const replacement = await f.press(changed, "Continue");
  assert.deepEqual(texts(json(oldForm.modal)), ["**Character** one • Asia"]);
  assert.deepEqual(texts(json(replacement.modal)), ["**Character** two • Asia"]);
  await f.submit(replacement, { amount: "1", description: "" });
  assert.deepEqual(f.accounts.map((a) => a.balance), [1000n, 1001n]);
});

test("duplicate concurrent modal delivery and a lost receipt never duplicate a ledger action", async () => {
  const f = fixture([account("orphan")]);
  const form = await f.press(await f.select(await f.entry("credit"), "Character", "asia:orphan"), "Continue");
  const first = f.make("modal", json(form.modal).custom_id, { amount: "1", description: "" });
  first.editReply = async () => { throw new Error("Receipt lost"); };
  const duplicate = f.make("modal", json(form.modal).custom_id, { amount: "1", description: "" });
  const results = await Promise.allSettled([f.panel.handle(first as never), f.panel.handle(duplicate as never)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(f.adjustments.length, 1);
  await f.submit(form, { amount: "1", description: "" });
  assert.equal(f.adjustments.length, 1);
});

test("a Continue or selection overlapping an in-flight ledger write cannot reopen a spending draft", async () => {
  const f = fixture([account("one"), account("two")]);
  const selected = await f.select(await f.entry("credit"), "Character", "asia:one");
  const form = await f.press(selected, "Continue");
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.hooks.beforeAdjust = async () => { entered(); await held; };
  const submission = f.submit(form, { amount: "1", description: "" });
  await reached;
  const continuation = await f.press(selected, "Continue");
  assert.equal(continuation.modal, undefined);
  assert.match(texts(json(continuation.last())).join("\n"), /Start Again/);
  const selection = await f.select(selected, "Character", "asia:two");
  assert.match(texts(json(selection.last())).join("\n"), /Start Again/);
  release();
  await submission;
  assert.equal(f.adjustments.length, 1);
  assert.deepEqual(f.accounts.map((a) => a.balance), [1001n, 1000n]);
  const done = await f.press(selected, "Continue");
  assert.equal(done.modal, undefined);
});

test("Amount accepts only positive whole silver that PostgreSQL can retain", () => {
  for (const value of ["", "0", "-1", "+1", "1.5", "1,000", "1e3", "9223372036854775808"]) assert.equal(parseAccountFormAmount(value), undefined);
  assert.equal(parseAccountFormAmount(" 1000 "), 1000n);
  assert.equal(parseAccountFormAmount("9223372036854775807"), 9223372036854775807n);
});

function account(name: string, owner?: string, status: CharacterAccount["status"] = "open"): CharacterAccount {
  return { accountId: name, discordGuildId: "guild", albionServer: "asia", albionCharacterId: name, characterName: name, discordUserId: owner, status, balance: 1000n, createdAt: new Date("2026-09-01") };
}
function json(value: any): any { return JSON.parse(JSON.stringify(value)); }
function nodes(value: any, type: number): any[] {
  if (!value || typeof value !== "object") return [];
  return [...(value.type === type ? [value] : []), ...Object.values(value).flatMap((v) => Array.isArray(v) ? v.flatMap((item) => nodes(item, type)) : nodes(v, type))];
}
function texts(value: any): string[] {
  if (typeof (value as { content?: unknown })?.content === "string") return [(value as { content: string }).content]; return nodes(value, 10).map((node) => node.content); }
function fixture(initial: CharacterAccount[]) {
  const accounts = initial;
  const state = { manager: true, timeout: false, revision: "revision", generation: "generation", now: Date.now() };
  const transfers: Array<{ from: AccountRef; to: AccountRef; ownership?: AccountTransferOwnership }> = [];
  const adjustments: AccountRef[] = [];
  const hooks: { beforeAdjust?: () => Promise<void> } = {};
  const current = (ref: AccountRef) => accounts.find((a) => a.discordGuildId === ref.discordGuildId && a.albionServer === ref.albionServer && a.albionCharacterId === ref.albionCharacterId);
  const mutable = (ref: AccountRef) => {
    const a = current(ref);
    if (!a) throw new AccountOperationError("not_found");
    if (a.status !== "open") throw new AccountOperationError(a.status);
    return a;
  };
  async function error(i: any, title: string, text: string) {
    const payload = { components: [{ type: 17, components: [{ type: 10, content: `# ${title}\n\n${text}` }] }] };
    if (i.replied || i.deferred) await i.editReply(payload); else await i.reply(payload);
  }
  const panel = createAccountPanelInteractions({
    now: () => state.now,
    repository: {
      listAccounts: async () => accounts,
      listAccountsForUser: async (_guild: string, user: string) => accounts.filter((a) => a.discordUserId === user && a.status !== "closed"),
      getAccount: async (ref: AccountRef) => current(ref),
      listTransactions: async () => [{ transactionId: "tx", transactionType: "credit", amount: 1000n, balanceAfter: 1000n, description: "Entire retained transaction description", createdAt: new Date("2026-09-01") }],
      adjust: async (ref: AccountRef, _type: string, amount: bigint) => { await hooks.beforeAdjust?.(); const a = mutable(ref); adjustments.push(ref); a.balance += amount; return a; },
      transfer: async (from: AccountRef, to: AccountRef, amount: bigint, _actor: string, _description?: string, ownership?: AccountTransferOwnership) => {
        const a = mutable(from), b = mutable(to);
        if (ownership && (a.discordUserId !== ownership.fromDiscordUserId || b.discordUserId !== ownership.toDiscordUserId)) throw new AccountOperationError("ownership_changed");
        if (a.balance < amount) throw new AccountOperationError("insufficient_funds");
        transfers.push({ from, to, ownership }); a.balance -= amount; b.balance += amount;
        return { from: a, to: b, transferId: "transfer" };
      },
    } as never,
    entries: {
      checkAccess: async (i: any, _feature: string, options: any) => {
        if ((options.generation && options.generation !== state.generation) || (options.expected && options.expected.configurationRevision !== state.revision)) { await error(i, "Start Again", "This control is no longer current. Open the latest entry panel and start again."); return undefined; }
        if (options.mutation && state.timeout) { await error(i, "Action Unavailable", "You cannot use this action while timed out in this Discord server."); return undefined; }
        return { discordChannelId: "channel", configurationRevision: state.revision, channel: { id: "channel" }, member: { id: "caller" } };
      },
      requireRole: async (i: any) => { if (state.manager) return true; await error(i, "Accounts Manager Required", "You need an Accounts Manager role or Discord Administrator permission to use this action."); return false; },
      runExclusive: async (_guild: string, fn: () => Promise<unknown>) => fn(),
    } as never,
  });
  function make(kind: "button" | "select" | "user" | "modal", customId: string, fields: Record<string, string> = {}, values: string[] = []) {
    const calls: Array<[string, any]> = [];
    const i: any = {
      customId, guildId: "guild", channelId: "channel", user: { id: "caller", bot: false }, message: { id: "message" }, values,
      guild: { name: "Example", members: { cache: new Map(), fetch: async (value: any) => ({ id: typeof value === "string" ? value : value.user, displayName: typeof value === "string" ? value : value.user, user: { bot: false, username: "Example" } }) } },
      fields: { getTextInputValue: (name: string) => fields[name] ?? "" },
      isButton: () => kind === "button", isStringSelectMenu: () => kind === "select", isUserSelectMenu: () => kind === "user", isModalSubmit: () => kind === "modal",
      deferred: false, replied: false, calls,
      reply: async (value: any) => { i.replied = true; calls.push(["reply", value]); },
      editReply: async (value: any) => { calls.push(["editReply", value]); },
      update: async (value: any) => { i.replied = true; calls.push(["update", value]); },
      deferReply: async (value: any) => { i.deferred = true; calls.push(["deferReply", value]); },
      deferUpdate: async () => { i.deferred = true; calls.push(["deferUpdate", {}]); },
      showModal: async (value: any) => { i.replied = true; i.modal = value; calls.push(["showModal", value]); },
      last: () => calls.at(-1)?.[1],
    };
    return i;
  }
  return { accounts, state, transfers, adjustments, panel, make, hooks,
    async entry(action: string) { const i = make("button", `entry-panel:accounts:${state.generation}:${action}`); await panel.handle(i); return i; },
    async press(previous: any, label: string) { const control = nodes(json(previous.last()), 2).find((b) => b.label === label); assert.ok(control, `${label} missing`); const i = make("button", control.custom_id); await panel.handle(i); return i; },
    async select(previous: any, label: string, value: string, kind: "select" | "user" = "select") { const menu = nodes(json(previous.last()), kind === "user" ? 5 : 3).find((m) => m.placeholder === label); assert.ok(menu, `${label} missing`); const i = make(kind, menu.custom_id, {}, [value]); await panel.handle(i); return i; },
    async submit(form: any, fields: Record<string, string>) { const i = make("modal", json(form.modal).custom_id, fields); await panel.handle(i); return i; },
  };
}
