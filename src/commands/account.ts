import { AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type AutocompleteInteraction, type ChatInputCommandInteraction, type Guild } from "discord.js";
import { AccountOperationError, type AccountRef, type AccountTransaction, type CharacterAccount, type createAccountRepository } from "../db/accountRepository.js";
import { type createMembershipRepository } from "../db/membershipRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import { getAlbionServerLabel, isAlbionServer } from "../services/albion/servers.js";
import type { EntryPanelContext } from "../services/entryPanels/types.js";
import { INVALID_COLOR, REPORT_COLOR, SUCCESS_COLOR, formatUserText, normalizeQuery, rejectNonGuildInteraction, truncateChoiceName } from "./configurationHelpers.js";

type AccountRepository = ReturnType<typeof createAccountRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;
const DESCRIPTION_MAX = 200;
const EM_DASH = "—";
type AccountManagerAccess = Pick<EntryPanelContext, "requireRole" | "hasRole">;

function characterOption(option: any, name = "character", description = "Character account.", required = true) {
  return option.setName(name).setDescription(description).setRequired(required).setAutocomplete(true);
}
function amountOption(option: any) { return option.setName("amount").setDescription("Whole silver amount.").setRequired(true).setMinValue(1); }
function descriptionOption(option: any, required = false) { return option.setName(required ? "description" : "description").setDescription(required ? "Required reason for the adjustment." : "Optional transaction description.").setRequired(required).setMinLength(1).setMaxLength(DESCRIPTION_MAX); }

export const accountCommand = new SlashCommandBuilder()
  .setName("account").setDescription("Manage character accounts.").setDefaultMemberPermissions(0)
  .addSubcommand((s) => s.setName("list").setDescription("Export character accounts and balances.").addStringOption((o) => o.setName("filter").setDescription("Accounts to include.").addChoices(
    { name: "Current", value: "current" }, { name: "Registered", value: "registered" }, { name: "Unregistered", value: "unregistered" }, { name: "Frozen", value: "frozen" }, { name: "Closed", value: "closed" }, { name: "All", value: "all" }
  )))
  .addSubcommand((s) => s.setName("statement").setDescription("Export a character's account statement.").addStringOption((o) => characterOption(o)))
  .addSubcommand((s) => s.setName("set").setDescription("Set a character's account balance.").addStringOption((o) => characterOption(o)).addIntegerOption((o) => o.setName("balance").setDescription("New signed whole-silver balance.").setRequired(true)).addStringOption((o) => descriptionOption(o, true)))
  .addSubcommand((s) => s.setName("reset").setDescription("Reset a character's account balance to zero.").addStringOption((o) => characterOption(o)).addStringOption((o) => descriptionOption(o, true)))
  .addSubcommand((s) => s.setName("freeze").setDescription("Freeze a character's account.").addStringOption((o) => characterOption(o)).addStringOption((o) => o.setName("reason").setDescription("Reason for freezing the account.").setRequired(true).setMinLength(1).setMaxLength(DESCRIPTION_MAX)))
  .addSubcommand((s) => s.setName("unfreeze").setDescription("Unfreeze a character's account.").addStringOption((o) => characterOption(o)).addStringOption((o) => o.setName("reason").setDescription("Reason for unfreezing the account.").setRequired(true).setMinLength(1).setMaxLength(DESCRIPTION_MAX)));

export const statementCommand = new SlashCommandBuilder().setName("statement").setDescription("Show your account statement.").setDefaultMemberPermissions(0).addStringOption((o) => characterOption(o, "character", "Your registered character.", false));
export const creditCommand = transactionCommand("credit", "Credit a character's account.");
export const debitCommand = transactionCommand("debit", "Debit a character's account.");
export const transferCommand = transferBuilder("transfer", "Transfer funds between character accounts.");
export const giveCommand = transferBuilder("give", "Give account funds to another member.");

function transactionCommand(name: "credit" | "debit", description: string) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(0)
    .addStringOption((o) => characterOption(o)).addIntegerOption(amountOption).addStringOption((o) => descriptionOption(o));
}
function transferBuilder(name: "transfer" | "give", description: string) {
  return new SlashCommandBuilder().setName(name).setDescription(description).setDefaultMemberPermissions(0)
    .addStringOption((o) => characterOption(o, "from", "Source character account."))
    .addStringOption((o) => characterOption(o, "to", "Destination character account."))
    .addIntegerOption(amountOption).addStringOption((o) => descriptionOption(o));
}

export async function handleAccountCommand(interaction: ChatInputCommandInteraction, repository: AccountRepository, entries?: AccountManagerAccess): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  if (!(await requireAccountManager(interaction, entries))) return;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") return sendAccountsFile(interaction, repository);
  const ref = parseRef(interaction.guildId!, interaction.options.getString("character", true));
  if (!ref) return invalid(interaction, "Character Not Found", "Choose a character account from autocomplete.");
  if (subcommand === "statement") return sendStatementFile(interaction, repository, ref);
  if (!(await allowAccountMutation(interaction))) return;
  try {
    const account = await requireAccount(repository, ref);
    if (subcommand === "set") {
      const target = BigInt(interaction.options.getInteger("balance", true));
      const difference = target - account.balance;
      if (difference === 0n) return invalid(interaction, "Balance Unchanged", "That account already has the specified balance.");
      await repository.adjust(ref, "set_adjustment", difference, interaction.user.id, interaction.options.getString("description", true).trim());
      return success(interaction, "Account Balance Set", `${account.characterName}'s balance is now ${formatAccountAmount(target)}.`);
    }
    if (subcommand === "reset") {
      if (account.balance === 0n) return invalid(interaction, "Balance Already Zero", "That account already has a zero balance.");
      await repository.adjust(ref, "reset_adjustment", -account.balance, interaction.user.id, interaction.options.getString("description", true).trim());
      return success(interaction, "Account Balance Reset", `${account.characterName}'s balance is now 0.`);
    }
    const frozen = subcommand === "freeze";
    const updated = await repository.setFrozen(ref, frozen, interaction.user.id, interaction.options.getString("reason", true).trim());
    return success(interaction, frozen ? "Account Frozen" : "Account Unfrozen", `${updated.characterName}'s account is now ${updated.status}.`);
  } catch (error) { return accountError(interaction, error); }
}

export async function handleStatementCommand(
  interaction: ChatInputCommandInteraction,
  repository: AccountRepository,
  membershipRepository: MembershipRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const suppliedCharacter = interaction.options.getString("character");
  let ref: AccountRef;
  let selectedCharacterName: string;
  let selectedAccount: CharacterAccount | undefined;
  if (suppliedCharacter) {
    const parsedRef = parseRef(interaction.guildId!, suppliedCharacter);
    if (!parsedRef) return invalid(interaction, "Character Not Found", "Choose one of your registered characters from autocomplete.");
    ref = parsedRef;
    selectedAccount = await repository.getAccount(ref);
    if (!selectedAccount || selectedAccount.discordUserId !== interaction.user.id || selectedAccount.status === "closed") return invalid(interaction, "Account Not Found", "Choose one of your registered character accounts.");
    selectedCharacterName = selectedAccount.characterName;
  } else {
    const character = (await membershipRepository.listRegisteredCharacters(interaction.guildId!, interaction.user.id))[0];
    if (!character) return invalid(interaction, "Character Not Found", "You have no registered characters.");
    ref = {
      discordGuildId: interaction.guildId!,
      albionServer: character.albionServer,
      albionCharacterId: character.albionCharacterId
    };
    selectedCharacterName = character.characterName;
  }
  const account = selectedAccount ?? await repository.getAccount(ref);
  if (!account || account.discordUserId !== interaction.user.id || account.status === "closed") {
    if (!suppliedCharacter) return invalid(interaction, "Account Not Found", `No account for ${selectedCharacterName} • ${getAlbionServerLabel(ref.albionServer)}.`);
    return invalid(interaction, "Account Not Found", "Choose one of your registered character accounts.");
  }
  const transactions = await repository.listTransactions(account.accountId);
  const statement = await buildStatementText(interaction.guild, interaction.guild?.name ?? "Unknown Server", account, transactions);
  await interaction.reply(v2Reply({ accentColor: REPORT_COLOR,
    files: [new AttachmentBuilder(Buffer.from(statement, "utf8"), { name: "statement.txt" })],
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleCreditCommand(interaction: ChatInputCommandInteraction, repository: AccountRepository, entries?: AccountManagerAccess) { return handleAdjustment(interaction, repository, "credit", 1n, entries); }
export async function handleDebitCommand(interaction: ChatInputCommandInteraction, repository: AccountRepository, entries?: AccountManagerAccess) { return handleAdjustment(interaction, repository, "debit", -1n, entries); }
async function handleAdjustment(interaction: ChatInputCommandInteraction, repository: AccountRepository, type: "credit" | "debit", sign: bigint, entries?: AccountManagerAccess): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  if (!(await requireAccountManager(interaction, entries)) || !(await allowAccountMutation(interaction))) return;
  const ref = parseRef(interaction.guildId!, interaction.options.getString("character", true));
  if (!ref) return invalid(interaction, "Character Not Found", "Choose a character account from autocomplete.");
  try {
    const amount = BigInt(interaction.options.getInteger("amount", true)) * sign;
    const account = await repository.adjust(ref, type, amount, interaction.user.id, interaction.options.getString("description")?.trim());
    await success(interaction, type === "credit" ? "Account Credited" : "Account Debited", `${account.characterName}'s account was ${type === "credit" ? "credited" : "debited"}; its balance is now ${formatAccountAmount(account.balance)}.`);
  } catch (error) { await accountError(interaction, error); }
}

export async function handleTransferCommand(interaction: ChatInputCommandInteraction, repository: AccountRepository, entries?: AccountManagerAccess) { return handleTransfer(interaction, repository, false, entries); }
export async function handleGiveCommand(interaction: ChatInputCommandInteraction, repository: AccountRepository) { return handleTransfer(interaction, repository, true); }
async function handleTransfer(interaction: ChatInputCommandInteraction, repository: AccountRepository, give: boolean, entries?: AccountManagerAccess): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  if ((!give && !(await requireAccountManager(interaction, entries))) || !(await allowAccountMutation(interaction))) return;
  const from = parseRef(interaction.guildId!, interaction.options.getString("from", true));
  const to = parseRef(interaction.guildId!, interaction.options.getString("to", true));
  if (!from || !to) return invalid(interaction, "Character Not Found", "Choose character accounts from autocomplete.");
  try {
    let recipient: string | undefined;
    if (give) {
      const [fromAccount, toAccount] = await Promise.all([repository.getAccount(from), repository.getAccount(to)]);
      if (!fromAccount || fromAccount.discordUserId !== interaction.user.id || fromAccount.status !== "open") return invalid(interaction, "Invalid Source", "Choose one of your open registered character accounts.");
      if (!toAccount?.discordUserId || toAccount.discordUserId === interaction.user.id || toAccount.status !== "open") return invalid(interaction, "Invalid Destination", "Choose an open character account registered to another member.");
      recipient = toAccount.discordUserId;
    }
    const result = await repository.transfer(from, to, BigInt(interaction.options.getInteger("amount", true)), interaction.user.id, interaction.options.getString("description")?.trim(), give ? { fromDiscordUserId: interaction.user.id, toDiscordUserId: recipient! } : undefined);
    await success(interaction, give ? "Funds Given" : "Funds Transferred", `${formatAccountAmount(BigInt(interaction.options.getInteger("amount", true)))} transferred from ${result.from.characterName} to ${result.to.characterName}.`);
  } catch (error) { await accountError(interaction, error); }
}

export async function handleAccountAutocomplete(interaction: AutocompleteInteraction, repository: AccountRepository, entries?: AccountManagerAccess): Promise<boolean> {
  if (!["account", "statement", "credit", "debit", "transfer", "give"].includes(interaction.commandName)) return false;
  const focused = interaction.options.getFocused(true);
  if (!["character", "from", "to"].includes(focused.name)) return false;
  if (["account", "credit", "debit", "transfer"].includes(interaction.commandName)) {
    const member = await interaction.guild?.members.fetch({ user: interaction.user.id, force: true }).catch(() => undefined);
    const allowed = member && !member.user.bot && (entries ? await entries.hasRole(interaction.guildId!, "accounts_manager", member) : member.permissions.has(PermissionFlagsBits.Administrator));
    if (!allowed) { await interaction.respond([]); return true; }
  }
  const accounts = await repository.listAccounts(interaction.guildId ?? "");
  const query = normalizeQuery(focused.value);
  const filtered = accounts.filter((account) => {
    if (interaction.commandName === "statement") return account.discordUserId === interaction.user.id && account.status !== "closed";
    if (interaction.commandName === "give" && focused.name === "from") return account.discordUserId === interaction.user.id && account.status === "open";
    if (interaction.commandName === "give" && focused.name === "to") return Boolean(account.discordUserId && account.discordUserId !== interaction.user.id && account.status === "open");
    if (interaction.commandName === "account" && interaction.options.getSubcommand(false) === "statement") return true;
    return account.status !== "closed";
  }).filter((account) => `${account.characterName} ${getAlbionServerLabel(account.albionServer)} ${account.albionCharacterId}`.toLocaleLowerCase().includes(query));
  await interaction.respond(filtered.slice(0, 25).map((account) => ({ name: truncateChoiceName(`${account.characterName} • ${getAlbionServerLabel(account.albionServer)}`), value: `${account.albionServer}:${account.albionCharacterId}` })));
  return true;
}

async function sendAccountsFile(interaction: ChatInputCommandInteraction, repository: AccountRepository): Promise<void> {
  const filter = interaction.options.getString("filter") ?? "current";
  const accounts = (await repository.listAccounts(interaction.guildId!)).filter((a) => matchesFilter(a, filter));
  const rows = await Promise.all(accounts.map(async (a) => accountRow(interaction.guild, a)));
  const content = ["Accounts", "", `${interaction.guild?.name ?? "Unknown Server"} • ${formatAccountFullDate(new Date())} • ${filter}`, "", renderAccountTextTable(["CHARACTER", "USER", "SERVER", "BALANCE", "MEMBERSHIP", "ACCOUNT"], rows)].join("\n");
  await interaction.reply(v2Reply({ accentColor: REPORT_COLOR, files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: "accounts.txt" })], flags: MessageFlags.Ephemeral }));
}

async function sendStatementFile(interaction: ChatInputCommandInteraction, repository: AccountRepository, ref: AccountRef): Promise<void> {
  const account = await repository.getAccount(ref);
  if (!account) return invalid(interaction, "Account Not Found", "No account exists for that character.");
  const transactions = await repository.listTransactions(account.accountId);
  const content = await buildStatementText(interaction.guild, interaction.guild?.name ?? "Unknown Server", account, transactions);
  await interaction.reply(v2Reply({ accentColor: REPORT_COLOR, files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: "statement.txt" })], flags: MessageFlags.Ephemeral }));
}

export async function buildStatementText(guild: Guild | null, serverName: string, account: CharacterAccount, transactions: AccountTransaction[]): Promise<string> {
  const accountTable = renderAccountTextTable(["CHARACTER", "USER", "SERVER", "BALANCE", "MEMBERSHIP", "ACCOUNT"], [await accountRow(guild, account)]);
  const transactionRows = await Promise.all(transactions.map(async (t) => [formatAccountShortDate(t.createdAt), formatAccountTime(t.createdAt), formatAccountTransactionType(t.transactionType), formatAccountAmount(t.amount), formatAccountAmount(t.balanceAfter), t.actorDiscordUserId ? await formatUserText(guild, t.actorDiscordUserId) : "System", formatAccountCounterparty(t), t.description ?? EM_DASH]));
  return ["Account Statement", "", `${serverName} • ${formatAccountFullDate(new Date())}`, "", accountTable, "", renderAccountTextTable(["DATE", "TIME", "TYPE", "AMOUNT", "BALANCE", "USER", "COUNTERPARTY", "DESCRIPTION"], transactionRows)].join("\n");
}

async function accountRow(guild: Guild | null, account: CharacterAccount): Promise<string[]> {
  return [account.characterName, account.discordUserId ? await formatUserText(guild, account.discordUserId) : EM_DASH, getAlbionServerLabel(account.albionServer), formatAccountAmount(account.balance), account.discordUserId ? "registered" : "unregistered", account.status];
}
export function renderAccountTextTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  return [headers, ...rows].map((row) => row.map((value, i) => i === row.length - 1 ? value : value.padEnd(widths[i])).join(" ")).join("\n");
}
function matchesFilter(account: CharacterAccount, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "current") return account.status !== "closed";
  if (filter === "registered") return Boolean(account.discordUserId);
  if (filter === "unregistered") return !account.discordUserId;
  return account.status === filter;
}
function parseRef(discordGuildId: string, value: string): AccountRef | undefined { const [server, ...id] = value.split(":"); return isAlbionServer(server) && id.join(":") ? { discordGuildId, albionServer: server, albionCharacterId: id.join(":") } : undefined; }
async function requireAccount(repository: AccountRepository, ref: AccountRef) { const account = await repository.getAccount(ref); if (!account) throw new AccountOperationError("not_found"); return account; }
export function formatAccountAmount(value: bigint) { return value.toLocaleString("en-AU"); }
export function formatAccountCounterparty(transaction: AccountTransaction) {
  if (!transaction.counterpartyCharacterName) return EM_DASH;
  if (transaction.transactionType === "transfer_debit") return `To ${transaction.counterpartyCharacterName}`;
  if (transaction.transactionType === "transfer_credit") return `From ${transaction.counterpartyCharacterName}`;
  return EM_DASH;
}
export function formatAccountTransactionType(type: AccountTransaction["transactionType"]) {
  return type === "regear_credit" ? "REGEAR" : type.replaceAll("_", " ");
}
export function formatAccountShortDate(date: Date) { return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`; }
export function formatAccountTime(date: Date) { return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`; }
export function formatAccountFullDate(date: Date) { return `${formatAccountShortDate(date)} • ${formatAccountTime(date)}`; }
async function success(interaction: ChatInputCommandInteraction, title: string, description: string) { await interaction.reply(feedbackReply({ cards: [new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle(title).setDescription(description)], flags: MessageFlags.Ephemeral })); }
async function invalid(interaction: ChatInputCommandInteraction, title: string, description: string) { await interaction.reply(feedbackReply({ cards: [new EmbedBuilder().setColor(INVALID_COLOR).setTitle(title).setDescription(description)], flags: MessageFlags.Ephemeral }, "context")); }
async function accountError(interaction: ChatInputCommandInteraction, error: unknown) {
  if (!(error instanceof AccountOperationError)) throw error;
  await invalid(interaction, "Account Unchanged", accountOperationErrorMessage(error));
}

export function accountOperationErrorMessage(error: AccountOperationError): string {
  const messages = { membership_suspended: "This character’s account is preserved during membership recovery. Financial changes are unavailable until membership is restored.", not_found: "That account was not found.", frozen: "That account is frozen.", closed: "That account is closed.", insufficient_funds: "The source account has insufficient funds.", same_account: "Source and destination accounts must be different.", already_open: "That account is already open.", already_frozen: "That account is already frozen.", ownership_changed: "Account ownership changed. Choose the accounts again.", invalid_amount: "Enter a positive amount in whole silver within the account balance limit." };
  return messages[error.code];
}

async function requireAccountManager(interaction: ChatInputCommandInteraction, entries?: AccountManagerAccess): Promise<boolean> {
  if (entries) return entries.requireRole(interaction, "accounts_manager");
  const member = await interaction.guild?.members.fetch({ user: interaction.user.id, force: true }).catch(() => undefined);
  if (member && !member.user.bot && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  await invalid(interaction, "Accounts Manager Required", "You need an Accounts Manager role or Discord Administrator permission to use this action.");
  return false;
}

async function allowAccountMutation(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = await interaction.guild?.members.fetch({ user: interaction.user.id, force: true }).catch(() => undefined);
  if (member && !member.user.bot && (member.communicationDisabledUntilTimestamp ?? 0) <= Date.now()) return true;
  await invalid(interaction, "Account Unchanged", "You must be a current Discord member without a timeout to change accounts.");
  return false;
}
