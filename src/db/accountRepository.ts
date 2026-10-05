import type { PoolClient } from "pg";
import type { PostgresPool } from "./postgres.js";
import { lockCharacterEntitlements } from "./membershipEntitlementCleanup.js";
import type { AlbionServer } from "../services/albion/servers.js";

export type AccountStatus = "open" | "frozen" | "closed";
export type AccountTransactionType = "credit" | "debit" | "transfer_credit" | "transfer_debit" | "set_adjustment" | "reset_adjustment" | "purge_adjustment" | "closure_adjustment" | "regear_credit";

export interface CharacterAccount {
  accountId: string;
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
  characterName: string;
  discordUserId?: string;
  status: AccountStatus;
  balance: bigint;
  createdAt: Date;
  closedAt?: Date;
}

export interface AccountTransaction {
  transactionId: string;
  transactionType: AccountTransactionType;
  amount: bigint;
  balanceAfter: bigint;
  actorDiscordUserId?: string;
  transferId?: string;
  counterpartyCharacterName?: string;
  description?: string;
  createdAt: Date;
}

export class AccountOperationError extends Error {
  constructor(public readonly code: "not_found" | "frozen" | "closed" | "insufficient_funds" | "same_account" | "already_open" | "already_frozen" | "ownership_changed" | "invalid_amount" | "membership_suspended") {
    super(code);
  }
}

interface AccountRow {
  account_id: string;
  discord_guild_id: string;
  albion_server: AlbionServer;
  albion_character_id: string;
  character_name: string;
  discord_user_id: string | null;
  status: AccountStatus;
  balance: string;
  created_at: Date;
  closed_at: Date | null;
}

interface TransactionRow {
  transaction_id: string;
  transaction_type: AccountTransactionType;
  amount: string;
  balance_after: string;
  actor_discord_user_id: string | null;
  transfer_id: string | null;
  counterparty_character_name: string | null;
  description: string | null;
  created_at: Date;
}

export interface AccountRef {
  discordGuildId: string;
  albionServer: AlbionServer;
  albionCharacterId: string;
}

export interface AccountTransferOwnership {
  fromDiscordUserId: string;
  toDiscordUserId: string;
}

export function createAccountRepository(pool: PostgresPool) {
  return {
    listAccounts: (discordGuildId: string) => listAccounts(pool, discordGuildId),
    listAccountsForUser: (discordGuildId: string, discordUserId: string) =>
      listAccountsForUser(pool, discordGuildId, discordUserId),
    getAccount: (ref: AccountRef) => getAccount(pool, ref),
    listTransactions: (accountId: string) => listTransactions(pool, accountId),
    adjust: (ref: AccountRef, type: Exclude<AccountTransactionType, "transfer_credit" | "transfer_debit" | "purge_adjustment" | "closure_adjustment" | "regear_credit">, amount: bigint, actorDiscordUserId: string, description?: string) =>
      adjust(pool, ref, type, amount, actorDiscordUserId, description),
    transfer: (from: AccountRef, to: AccountRef, amount: bigint, actorDiscordUserId: string, description?: string, ownership?: AccountTransferOwnership) =>
      transfer(pool, from, to, amount, actorDiscordUserId, description, ownership),
    setFrozen: (ref: AccountRef, frozen: boolean, actorDiscordUserId: string, reason: string) =>
      setFrozen(pool, ref, frozen, actorDiscordUserId, reason)
  };
}

async function listAccounts(pool: PostgresPool, discordGuildId: string): Promise<CharacterAccount[]> {
  const result = await pool.query<AccountRow>(`${accountSelect()} where ca.discord_guild_id = $1 order by lower(ac.character_name), ca.albion_server, ca.albion_character_id`, [discordGuildId]);
  return result.rows.map(mapAccount);
}

async function listAccountsForUser(
  pool: PostgresPool,
  discordGuildId: string,
  discordUserId: string
): Promise<CharacterAccount[]> {
  const result = await pool.query<AccountRow>(
    `${accountSelect()}
    where ca.discord_guild_id = $1
      and duc.discord_user_id = $2
      and ca.status <> 'closed'
    order by duc.registration_order asc, ca.albion_server asc, ca.albion_character_id asc`,
    [discordGuildId, discordUserId]
  );
  return result.rows.map(mapAccount);
}

async function getAccount(queryable: Pick<PostgresPool, "query">, ref: AccountRef): Promise<CharacterAccount | undefined> {
  const result = await queryable.query<AccountRow>(`${accountSelect()} where ca.discord_guild_id = $1 and ca.albion_server = $2 and ca.albion_character_id = $3`, [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
}

async function listTransactions(pool: PostgresPool, accountId: string): Promise<AccountTransaction[]> {
  const result = await pool.query<TransactionRow>(
    `
    select
      account_transaction.transaction_id,
      account_transaction.transaction_type,
      account_transaction.amount,
      account_transaction.balance_after,
      account_transaction.actor_discord_user_id,
      account_transaction.transfer_id,
      counterparty.character_name as counterparty_character_name,
      account_transaction.description,
      account_transaction.created_at
    from account_transactions account_transaction
    left join lateral (
      select character.character_name
      from account_transactions paired_transaction
      join character_accounts paired_account
        on paired_account.account_id = paired_transaction.account_id
        and paired_account.discord_guild_id = paired_transaction.discord_guild_id
      join albion_characters character
        on character.albion_server = paired_account.albion_server
        and character.albion_character_id = paired_account.albion_character_id
      where account_transaction.transfer_id is not null
        and paired_transaction.transfer_id = account_transaction.transfer_id
        and paired_transaction.transaction_id <> account_transaction.transaction_id
        and paired_transaction.discord_guild_id = account_transaction.discord_guild_id
      order by paired_transaction.transaction_id
      limit 1
    ) counterparty on true
    where account_transaction.account_id = $1
    order by account_transaction.created_at desc, account_transaction.transaction_id desc
    `,
    [accountId]
  );
  return result.rows.map((row) => ({
    transactionId: row.transaction_id,
    transactionType: row.transaction_type,
    amount: BigInt(row.amount),
    balanceAfter: BigInt(row.balance_after),
    actorDiscordUserId: row.actor_discord_user_id ?? undefined,
    transferId: row.transfer_id ?? undefined,
    counterpartyCharacterName: row.counterparty_character_name ?? undefined,
    description: row.description ?? undefined,
    createdAt: row.created_at
  }));
}

async function adjust(
  pool: PostgresPool,
  ref: AccountRef,
  type: Exclude<AccountTransactionType, "transfer_credit" | "transfer_debit" | "purge_adjustment" | "closure_adjustment" | "regear_credit">,
  amount: bigint,
  actorDiscordUserId: string,
  description?: string
): Promise<CharacterAccount> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, ref);
    const account = await requireMutableAccount(client, ref);
    const nextBalance = account.balance + amount;
    assertBalanceRange(nextBalance);
    if (amount !== 0n) await insertTransaction(client, account, type, amount, nextBalance, actorDiscordUserId, undefined, description);
    await client.query(`update character_accounts set balance = $2, updated_at = now() where account_id = $1`, [account.accountId, nextBalance.toString()]);
    await client.query("commit");
    return { ...account, balance: nextBalance };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function transfer(pool: PostgresPool, from: AccountRef, to: AccountRef, amount: bigint, actorDiscordUserId: string, description?: string, ownership?: AccountTransferOwnership) {
  if (from.discordGuildId !== to.discordGuildId || (from.albionServer === to.albionServer && from.albionCharacterId === to.albionCharacterId)) throw new AccountOperationError("same_account");
  if (amount <= 0n || amount > 9223372036854775807n) throw new AccountOperationError("invalid_amount");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const refs = [from, to].sort((a, b) => `${a.albionServer}:${a.albionCharacterId}`.localeCompare(`${b.albionServer}:${b.albionCharacterId}`));
    for (const ref of refs) await lockCharacterEntitlements(client, ref);
    // Hold the exact registrations until commit so a Give cannot follow an
    // account to a different owner after its private selection was opened.
    if (ownership) {
      if (ownership.fromDiscordUserId === ownership.toDiscordUserId) throw new AccountOperationError("ownership_changed");
      for (const ref of refs) {
        const owner = await client.query<{ discord_user_id: string }>(
          `select discord_user_id from discord_user_characters
           where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3 for share`,
          [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]
        );
        const expected = ref === from ? ownership.fromDiscordUserId : ownership.toDiscordUserId;
        if (owner.rows[0]?.discord_user_id !== expected) throw new AccountOperationError("ownership_changed");
      }
    }
    const locked = new Map<string, CharacterAccount>();
    for (const ref of refs) locked.set(`${ref.albionServer}:${ref.albionCharacterId}`, await requireMutableAccount(client, ref));
    const fromAccount = locked.get(`${from.albionServer}:${from.albionCharacterId}`)!;
    const toAccount = locked.get(`${to.albionServer}:${to.albionCharacterId}`)!;
    if (fromAccount.balance < amount) throw new AccountOperationError("insufficient_funds");
    const transferResult = await client.query<{ transfer_id: string }>(`select nextval('account_transfer_id_seq')::text as transfer_id`);
    const transferId = transferResult.rows[0].transfer_id;
    const fromBalance = fromAccount.balance - amount;
    const toBalance = toAccount.balance + amount;
    assertBalanceRange(fromBalance);
    assertBalanceRange(toBalance);
    await insertTransaction(client, fromAccount, "transfer_debit", -amount, fromBalance, actorDiscordUserId, transferId, description);
    await insertTransaction(client, toAccount, "transfer_credit", amount, toBalance, actorDiscordUserId, transferId, description);
    await client.query(`update character_accounts set balance = case account_id when $1 then $2::bigint when $3 then $4::bigint end, updated_at = now() where account_id in ($1, $3)`, [fromAccount.accountId, fromBalance.toString(), toAccount.accountId, toBalance.toString()]);
    await client.query("commit");
    return { from: { ...fromAccount, balance: fromBalance }, to: { ...toAccount, balance: toBalance }, transferId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function assertBalanceRange(balance: bigint): void {
  if (balance < -9223372036854775808n || balance > 9223372036854775807n) throw new AccountOperationError("invalid_amount");
}

async function setFrozen(pool: PostgresPool, ref: AccountRef, frozen: boolean, actorDiscordUserId: string, reason: string): Promise<CharacterAccount> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCharacterEntitlements(client, ref);
    const account = await lockAccount(client, ref);
    if (!account) throw new AccountOperationError("not_found");
    if (account.status === "closed") throw new AccountOperationError("closed");
    if ((frozen && account.status === "frozen") || (!frozen && account.status === "open")) throw new AccountOperationError(frozen ? "already_frozen" : "already_open");
    const nextStatus: AccountStatus = frozen ? "frozen" : "open";
    await client.query(`update character_accounts set status = $2, updated_at = now() where account_id = $1`, [account.accountId, nextStatus]);
    await client.query(
      `insert into account_status_events (account_id, discord_guild_id, from_status, to_status, actor_discord_user_id, reason, event_type) values ($1, $2, $3, $4, $5, $6, $7)`,
      [account.accountId, ref.discordGuildId, account.status, nextStatus, actorDiscordUserId, reason, frozen ? "frozen" : "unfrozen"]
    );
    await client.query("commit");
    return { ...account, status: nextStatus };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function requireMutableAccount(client: PoolClient, ref: AccountRef): Promise<CharacterAccount> {
  const account = await lockAccount(client, ref);
  if (!account) throw new AccountOperationError("not_found");
  if (account.status === "frozen") throw new AccountOperationError("frozen");
  if (account.status === "closed") throw new AccountOperationError("closed");
  const eligibility = await client.query<{ suspended: boolean }>(
    "select character_financial_actions_suspended($1, $2, $3) as suspended",
    [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]
  );
  if (eligibility.rows[0]?.suspended) throw new AccountOperationError("membership_suspended");
  return account;
}

async function lockAccount(client: PoolClient, ref: AccountRef): Promise<CharacterAccount | undefined> {
  const result = await client.query<AccountRow>(`${accountSelect()} where ca.discord_guild_id = $1 and ca.albion_server = $2 and ca.albion_character_id = $3 for update of ca`, [ref.discordGuildId, ref.albionServer, ref.albionCharacterId]);
  return result.rows[0] ? mapAccount(result.rows[0]) : undefined;
}

async function insertTransaction(client: PoolClient, account: CharacterAccount, type: AccountTransactionType, amount: bigint, balanceAfter: bigint, actor?: string, transferId?: string, description?: string): Promise<void> {
  await client.query(
    `insert into account_transactions (account_id, discord_guild_id, transaction_type, amount, balance_after, actor_discord_user_id, transfer_id, description) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [account.accountId, account.discordGuildId, type, amount.toString(), balanceAfter.toString(), actor ?? null, transferId ?? null, description ?? null]
  );
}

function accountSelect(): string {
  return `select ca.account_id, ca.discord_guild_id, ca.albion_server, ca.albion_character_id, ac.character_name,
    duc.discord_user_id, ca.status, ca.balance, ca.created_at, ca.closed_at
    from character_accounts ca
    join albion_characters ac on ac.albion_server = ca.albion_server and ac.albion_character_id = ca.albion_character_id
    left join discord_user_characters duc on duc.discord_guild_id = ca.discord_guild_id and duc.albion_server = ca.albion_server and duc.albion_character_id = ca.albion_character_id`;
}

function mapAccount(row: AccountRow): CharacterAccount {
  return {
    accountId: row.account_id,
    discordGuildId: row.discord_guild_id,
    albionServer: row.albion_server,
    albionCharacterId: row.albion_character_id,
    characterName: row.character_name,
    discordUserId: row.discord_user_id ?? undefined,
    status: row.status,
    balance: BigInt(row.balance),
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined
  };
}
