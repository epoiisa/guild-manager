import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction
} from "discord.js";
import type { CharacterAccount, createAccountRepository } from "../db/accountRepository.js";
import type {
  SelfServiceCharacter,
  SelfServiceMembership,
  SelfServicePosition,
  SelfServiceReactionRole,
  createMembershipRepository
} from "../db/membershipRepository.js";
import { feedbackReply } from "../discord/feedbackMessages.js";
import { v2Reply } from "../discord/operationalMessages.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { formatAccountAmount } from "./account.js";
import {
  INFO_COLOR,
  REPORT_COLOR,
  formatMemberGroupType,
  formatRole,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

type AccountRepository = ReturnType<typeof createAccountRepository>;
type MembershipRepository = ReturnType<typeof createMembershipRepository>;

const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
const MAX_EMBED_FIELDS = 25;
const MAX_EMBED_TOTAL_LENGTH = 6000;
const MAX_EMBEDS_PER_RESPONSE = 10;

interface Category {
  name: string;
  lines: string[];
}

interface RenderedField {
  name: string;
  value: string;
}

export interface MemberProfile {
  discordUserId: string;
  discordUsername: string;
  displayName: string;
  characters: SelfServiceCharacter[];
  memberships: SelfServiceMembership[];
  positions: SelfServicePosition[];
  accounts: CharacterAccount[];
}

export const membershipCommand = new SlashCommandBuilder()
  .setName("membership")
  .setDescription("Show your Guild Manager membership details.")
  .setDefaultMemberPermissions(0);

export const balanceCommand = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Show your account balances.")
  .setDefaultMemberPermissions(0);

export const rolesCommand = new SlashCommandBuilder()
  .setName("roles")
  .setDescription("Show your membership and reaction roles.")
  .setDefaultMemberPermissions(0);

export async function handleMembershipCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  accountRepository: AccountRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const discordGuildId = interaction.guildId!;
  const discordUserId = interaction.user.id;
  const [characters, memberships, positions, accounts] = await Promise.all([
    membershipRepository.listSelfServiceCharacters(discordGuildId, discordUserId),
    membershipRepository.listSelfServiceMemberships(discordGuildId, discordUserId),
    membershipRepository.listSelfServicePositions(discordGuildId, discordUserId),
    accountRepository.listAccountsForUser(discordGuildId, discordUserId)
  ]);

  await replyWithEmbedPages(
    interaction,
    buildMemberProfileEmbeds({
      discordUserId,
      discordUsername: interaction.user.username,
      displayName: selfServiceTitle(interaction),
      characters,
      memberships,
      positions,
      accounts
    })
  );
}

export async function handleBalanceCommand(
  interaction: ChatInputCommandInteraction,
  accountRepository: AccountRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const accounts = await accountRepository.listAccountsForUser(
    interaction.guildId!,
    interaction.user.id
  );
  await interaction.reply(feedbackReply({ ...buildBalanceFeedback(accounts), flags: MessageFlags.Ephemeral }));
}

export async function handleRolesCommand(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;
  const [membershipRoleIds, reactionRoles] = await Promise.all([
    membershipRepository.listMembershipRoleIdsForUser(
      interaction.guildId!,
      interaction.user.id
    ),
    membershipRepository.listSelfServiceReactionRoles(
      interaction.guildId!,
      interaction.user.id
    )
  ]);
  if (membershipRoleIds.length === 0 && reactionRoles.length === 0) {
    await interaction.reply(feedbackReply({ text: `${formatSelfServiceTitle(selfServiceTitle(interaction))} has no membership roles or reaction roles.`, flags: MessageFlags.Ephemeral }));
    return;
  }
  await replyWithEmbedPages(
    interaction,
    buildRolesEmbeds(selfServiceTitle(interaction), membershipRoleIds, reactionRoles)
  );
}

export function buildMemberProfileEmbeds(profile: MemberProfile): EmbedBuilder[] {
  const characterOrder = new Map(profile.characters.map((character, index) => [characterKey(character), index]));
  const membershipRoleIds = new Set<string>();
  for (const character of profile.characters) {
    for (const roleId of character.discordRoleIds) membershipRoleIds.add(roleId);
  }
  for (const membership of profile.memberships) {
    for (const roleId of membership.discordRoleIds) membershipRoleIds.add(roleId);
  }
  for (const position of profile.positions) membershipRoleIds.add(position.discordRoleId);

  return buildEmbedPages(formatMemberProfileTitle(profile.displayName), [
    { name: "User", lines: [`<@${profile.discordUserId}> • \`${profile.discordUsername}\``] },
    {
      name: "Registered Characters",
      lines: profile.characters.map((character, index) => formatProfileCharacterLine(character, index === 0))
    },
    {
      name: "Memberships",
      lines: [...profile.memberships].sort((left, right) => compareMembershipsByCharacter(left, right, characterOrder)).map(formatMembershipLine)
    },
    {
      name: "Membership Roles",
      lines: [...membershipRoleIds].sort(compareText).map(formatRole)
    },
    {
      name: "Membership Positions",
      lines: [...profile.positions].sort((left, right) => comparePositionsByCharacter(left, right, characterOrder)).map(formatPositionLine)
    },
    {
      name: "Account Balances",
      lines: profile.accounts.filter((account) => account.status !== "closed").map(formatAccountLine)
    }
  ], REPORT_COLOR);
}

export function buildBalanceEmbeds(
  accounts: CharacterAccount[]
): EmbedBuilder[] {
  const lines = accounts
    .filter((account) => account.status !== "closed")
    .map(formatAccountLine);
  return [new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle("Balance")
    .setDescription(lines.length > 0 ? lines.join("\n") : "No accounts.")
    .setFooter({ text: "Use `/statement` to view your full account history." })];
}

export function buildBalanceFeedback(accounts: CharacterAccount[]) {
  const current = accounts.filter(account => account.status !== "closed");
  if (current.length > 1) return { structured: true, cards: buildBalanceEmbeds(current) };
  const account = current[0];
  const summary = account
    ? `${account.characterName} • ${getAlbionServerLabel(account.albionServer)}: ${formatAccountAmount(account.balance)}${account.status === "frozen" ? " [Frozen]" : ""}.`
    : "No accounts.";
  return { text: `${summary} Use \`/statement\` to view your full account history.`, accentColor: INFO_COLOR };
}

export function buildRolesEmbeds(
  title: string,
  membershipRoleIds: string[],
  reactionRoles: SelfServiceReactionRole[]
): EmbedBuilder[] {
  const uniqueMembershipRoleIds = [...new Set(membershipRoleIds)].sort(compareText);
  const uniqueReactionRoles = [...new Map(
    [...reactionRoles]
      .sort(compareReactionRoles)
      .map((reactionRole) => [reactionRole.discordRoleId, reactionRole])
  ).values()];
  return buildEmbedPages(formatSelfServiceCommandTitle("Roles", title), [
    { name: "Membership Roles", lines: uniqueMembershipRoleIds.map(formatRole) },
    { name: "Reaction Roles", lines: uniqueReactionRoles.map(formatReactionRoleLine) }
  ]);
}

export function formatSelfServiceTitle(displayName: string): string {
  return `@${normalizeDisplayName(displayName)}`.slice(0, 256);
}

export function formatSelfServiceCommandTitle(commandName: string, displayName: string): string {
  return `${commandName} • ${formatSelfServiceTitle(displayName)}`.slice(0, 256);
}

function formatMemberProfileTitle(displayName: string): string {
  return `Member Profile • ${normalizeDisplayName(displayName)}`.slice(0, 256);
}

function normalizeDisplayName(displayName: string): string {
  return displayName.trim().replace(/^@+/, "") || "Unknown User";
}

export function formatProfileCharacterLine(character: SelfServiceCharacter, isMain: boolean): string {
  const base = `${character.characterName} • ${getAlbionServerLabel(character.albionServer)}${isMain ? " • Main" : ""}`;
  return appendRoles(base, character.discordRoleIds);
}

export function formatMembershipLine(membership: SelfServiceMembership): string {
  return appendRoles(
    `${membership.groupName} • ${formatMemberGroupType(membership.groupType)} • ${membership.characterName} • ${getAlbionServerLabel(membership.albionServer)}`,
    membership.discordRoleIds
  );
}

export function formatPositionLine(position: SelfServicePosition): string {
  return `${position.groupName} • ${formatMemberGroupType(position.groupType)} • ${position.characterName} • ${getAlbionServerLabel(position.albionServer)} • ${position.positionName} • ${formatRole(position.discordRoleId)}`;
}

export function formatAccountLine(account: CharacterAccount): string {
  return [
    account.characterName,
    getAlbionServerLabel(account.albionServer),
    formatAccountAmount(account.balance),
    ...(account.status === "frozen" ? ["Frozen"] : [])
  ].join(" • ");
}

export function formatReactionRoleLine(reactionRole: SelfServiceReactionRole): string {
  return `${formatRole(reactionRole.discordRoleId)}${reactionRole.dormant ? " • dormant" : ""}`;
}

export function buildEmbedPages(title: string, categories: Category[], color = INFO_COLOR): EmbedBuilder[] {
  const safeTitle = title.trim().slice(0, 256) || "Unknown User";
  const fields = categories.flatMap(renderCategoryFields);
  const pages: EmbedBuilder[] = [];
  let pageFields: RenderedField[] = [];
  let pageLength = safeTitle.length;

  const flush = () => {
    if (pageFields.length === 0) return;
    pages.push(
      new EmbedBuilder()
        .setColor(color)
        .setTitle(safeTitle)
        .addFields(pageFields.map((field) => ({ ...field, inline: false })))
    );
    pageFields = [];
    pageLength = safeTitle.length;
  };

  for (const field of fields) {
    const fieldLength = field.name.length + field.value.length;
    if (
      pageFields.length >= MAX_EMBED_FIELDS
      || pageLength + fieldLength > MAX_EMBED_TOTAL_LENGTH
    ) {
      flush();
    }
    pageFields.push(field);
    pageLength += fieldLength;
  }
  flush();
  return pages;
}

function renderCategoryFields(category: Category): RenderedField[] {
  return splitFieldValue(category.lines.length > 0 ? category.lines : ["None"]).map(
    (value, index) => ({
      name: index === 0 ? category.name : `${category.name} (continued)`,
      value
    })
  );
}

function splitFieldValue(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const lineChunks = splitLongLine(line);
    for (const lineChunk of lineChunks) {
      const candidate = current ? `${current}\n${lineChunk}` : lineChunk;
      if (candidate.length <= MAX_EMBED_FIELD_VALUE_LENGTH) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = lineChunk;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongLine(line: string): string[] {
  const chunks: string[] = [];
  let remaining = line || "None";
  while (remaining.length > MAX_EMBED_FIELD_VALUE_LENGTH) {
    let splitAt = remaining.lastIndexOf(" ", MAX_EMBED_FIELD_VALUE_LENGTH);
    if (splitAt <= 0) splitAt = MAX_EMBED_FIELD_VALUE_LENGTH;
    if (
      splitAt < remaining.length
      && splitAt > 0
      && isHighSurrogate(remaining.charCodeAt(splitAt - 1))
    ) {
      splitAt -= 1;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith(" ")) remaining = remaining.slice(1);
  }
  chunks.push(remaining);
  return chunks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export async function replyWithEmbedPages(
  interaction: ChatInputCommandInteraction,
  embeds: EmbedBuilder[]
): Promise<void> {
  for (let index = 0; index < embeds.length; index += MAX_EMBEDS_PER_RESPONSE) {
    const batch = embeds.slice(index, index + MAX_EMBEDS_PER_RESPONSE);
    if (index === 0) {
      await interaction.reply(v2Reply({ cards: batch, flags: MessageFlags.Ephemeral }));
    } else {
      await interaction.followUp(v2Reply({ cards: batch, flags: MessageFlags.Ephemeral }));
    }
  }
}

function selfServiceTitle(interaction: ChatInputCommandInteraction): string {
  const member = interaction.member;
  const displayName = member && "displayName" in member && typeof member.displayName === "string"
    ? member.displayName
    : member && "nick" in member && typeof member.nick === "string"
      ? member.nick
      : interaction.user.displayName || interaction.user.username;
  return displayName;
}

function appendRoles(prefix: string, roleIds: string[]): string {
  const roles = [...new Set(roleIds)].sort(compareText).map(formatRole);
  return roles.length > 0 ? `${prefix} • ${roles.join(" ")}` : prefix;
}

function compareMemberships(left: SelfServiceMembership, right: SelfServiceMembership): number {
  return compareTuple(
    [left.groupName, left.groupType, left.albionServer, left.characterName, left.memberGroupProfileId],
    [right.groupName, right.groupType, right.albionServer, right.characterName, right.memberGroupProfileId]
  );
}

function compareMembershipsByCharacter(
  left: SelfServiceMembership,
  right: SelfServiceMembership,
  characterOrder: Map<string, number>
): number {
  return compareCharacterOrder(left, right, characterOrder)
    || compareMemberships(left, right);
}

function comparePositions(left: SelfServicePosition, right: SelfServicePosition): number {
  return compareTuple(
    [left.groupName, left.groupType, left.albionServer, left.characterName, left.positionName, left.discordRoleId],
    [right.groupName, right.groupType, right.albionServer, right.characterName, right.positionName, right.discordRoleId]
  );
}

function comparePositionsByCharacter(
  left: SelfServicePosition,
  right: SelfServicePosition,
  characterOrder: Map<string, number>
): number {
  return compareCharacterOrder(left, right, characterOrder)
    || comparePositions(left, right);
}

function compareCharacterOrder(
  left: Pick<SelfServiceCharacter, "albionServer" | "albionCharacterId">,
  right: Pick<SelfServiceCharacter, "albionServer" | "albionCharacterId">,
  characterOrder: Map<string, number>
): number {
  const leftOrder = characterOrder.get(characterKey(left)) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = characterOrder.get(characterKey(right)) ?? Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder;
}

function characterKey(character: Pick<SelfServiceCharacter, "albionServer" | "albionCharacterId">): string {
  return `${character.albionServer}:${character.albionCharacterId}`;
}

function compareReactionRoles(left: SelfServiceReactionRole, right: SelfServiceReactionRole): number {
  return compareTuple(
    [left.discordRoleId, left.reactionRoleConfigId],
    [right.discordRoleId, right.reactionRoleConfigId]
  );
}

function compareTuple(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const compared = compareText(left[index] ?? "", right[index] ?? "");
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareText(left: string, right: string): number {
  return left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase())
    || left.localeCompare(right);
}
