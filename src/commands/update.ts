import {
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import type { AlbionClient } from "../services/albion/client.js";
import {
  auditMembershipForGuild,
  reconcileMembershipForGuild,
  type MembershipReconciliationOutcome,
  type MembershipReconciliationResult,
  type MembershipReconciliationWarning
} from "../services/membership/reconciliation.js";
import { rejectNonGuildInteraction } from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;

export const updateCommand = buildAuditUpdateCommand(
  "update",
  "Reconcile configured membership groups and Discord roles."
);

export const auditCommand = buildAuditUpdateCommand(
  "audit",
  "Preview configured membership group and Discord role reconciliation."
);

export async function handleUpdateCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository
): Promise<void> {
  await handleAuditUpdateCommand("update", interaction, albionClient, membershipRepository);
}

export async function handleAuditCommand(
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository
): Promise<void> {
  await handleAuditUpdateCommand("audit", interaction, albionClient, membershipRepository);
}

export async function handleUpdateAutocomplete(
  interaction: AutocompleteInteraction,
  _membershipRepository: MembershipRepository
): Promise<boolean> {
  if (interaction.commandName !== "update" && interaction.commandName !== "audit") return false;
  return false;
}

function buildAuditUpdateCommand(name: "audit" | "update", description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(0);
}

async function handleAuditUpdateCommand(
  mode: "audit" | "update",
  interaction: ChatInputCommandInteraction,
  albionClient: AlbionClient,
  membershipRepository: MembershipRepository
): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = mode === "audit"
    ? await auditMembershipForGuild(interaction.guild!, albionClient, membershipRepository)
    : await reconcileMembershipForGuild(interaction.guild!, albionClient, membershipRepository);

  const response = formatAuditUpdateResponse(mode, result, interaction.guild!.name, new Date());
  await interaction.editReply({
    ...response,
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [], repliedUser: false }
  });
}

export function formatAuditUpdateResponse(
  mode: "audit" | "update",
  result: MembershipReconciliationResult,
  guildName: string,
  generatedAt: Date
): { content: string; files: AttachmentBuilder[] } {
  const title = mode === "audit" ? "Audit" : "Update";
  const outcomeLines = result.outcomes.flatMap((outcome) => {
    const line = formatOutcome(mode, outcome);
    return line ? [line] : [];
  });
  const auditNotice = "Audit only. /update checks current membership again before applying changes.";
  const summary = mode === "audit"
    ? (result.warnings.length > 0
      ? "No changes were identified in the checks that completed."
      : "No changes found.")
    : (result.warnings.length > 0
      ? "No changes were confirmed."
      : "No changes were needed.");
  const lines = [
    title,
    guildName,
    formatUtcReportTime(generatedAt),
    "",
    ...(outcomeLines.length > 0 ? outcomeLines : [summary]),
    ...formatWarningLines(result.warnings),
    ...(mode === "audit" && outcomeLines.length > 0
      ? ["", auditNotice]
      : [])
  ];
  const report = lines.join("\n");
  const name = guildName.normalize("NFKC").toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)?.join("-") || "unnamed";
  const timestamp = `${generatedAt.toISOString().slice(0, 16).replace(/[-:]/g, "")}Z`;
  const attachment = new AttachmentBuilder(Buffer.from(report, "utf8"), {
    name: `${mode}-${name}-${timestamp}.txt`
  });
  return {
    content: `${title} report for ${escapeMarkdown(guildName)} at <t:${Math.floor(generatedAt.getTime() / 1000)}:F>.`,
    files: [attachment]
  };
}

function formatUtcReportTime(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} • ${iso.slice(11, 16)} UTC`;
}

function formatOutcome(
  mode: "audit" | "update",
  outcome: MembershipReconciliationOutcome
): string | undefined {
  if (outcome.kind === "profile") {
    const group = `${outcome.groupName} • ${outcome.albionServerLabel}`;
    const character = `${outcome.characterName} • ${outcome.discordUserId ? `<@${outcome.discordUserId}>` : "not registered"}`;
    if (outcome.action === "depart") {
      return mode === "audit"
        ? `${character} will be marked departed in ${group}`
        : `${character} marked departed in ${group}`;
    }
    if (outcome.action === "prune") {
      return mode === "audit"
        ? `${character} • unregistered roster entry will be removed from ${group}; no retained entitlements.`
        : `${character} • unregistered roster entry removed from ${group}; no retained entitlements.`;
    }
    if (outcome.action === "waiting") return undefined;
    if (outcome.action === "restore") {
      return mode === "audit"
        ? `${character} • membership in ${group} will be restored.`
        : `${character} • membership in ${group} restored.`;
    }
    if (outcome.action === "expire") {
      return mode === "audit"
        ? `${character} • departed membership in ${group} will be removed.`
        : `${character} • departed membership in ${group} removed.`;
    }
    if (outcome.action === "add") {
      return mode === "audit"
        ? `${character} will be added to ${group}.`
        : `${character} added to ${group}.`;
    }
    if (outcome.action === "remove") {
      return mode === "audit"
        ? `${character} will be removed from ${group}.`
        : `${character} removed from ${group}.`;
    }
    if (outcome.action === "record") {
      return mode === "audit"
        ? `${outcome.characterName} • not registered will be recorded in ${group}.`
        : `${outcome.characterName} • not registered recorded in ${group}.`;
    }

    const newOwner = outcome.discordUserId ? `<@${outcome.discordUserId}>` : "not registered";
    if (!outcome.previousDiscordUserId) {
      return mode === "audit"
        ? `${outcome.characterName} • profile will be assigned to ${newOwner} in ${group}.`
        : `${outcome.characterName} • profile assigned to ${newOwner} in ${group}.`;
    }
    return mode === "audit"
      ? `${outcome.characterName} • profile will be reassigned from <@${outcome.previousDiscordUserId}> to ${newOwner} in ${group}.`
      : `${outcome.characterName} • profile reassigned from <@${outcome.previousDiscordUserId}> to ${newOwner} in ${group}.`;
  }

  if (outcome.kind === "role") {
    if (outcome.action === "add") {
      return mode === "audit"
        ? `<@&${outcome.roleId}> will be added to <@${outcome.discordUserId}>.`
        : `<@&${outcome.roleId}> added to <@${outcome.discordUserId}>.`;
    }
    return mode === "audit"
      ? `<@&${outcome.roleId}> will be removed from <@${outcome.discordUserId}>.`
      : `<@&${outcome.roleId}> removed from <@${outcome.discordUserId}>.`;
  }

  if (outcome.action === "set") {
    return mode === "audit"
      ? `<@${outcome.discordUserId}>'s nickname will be set to \`${outcome.nickname}\`.`
      : `<@${outcome.discordUserId}>'s nickname set to \`${outcome.nickname}\`.`;
  }
  return mode === "audit"
    ? `<@${outcome.discordUserId}>'s nickname will be cleared.`
    : `<@${outcome.discordUserId}>'s nickname cleared.`;
}

function formatWarningLines(warnings: MembershipReconciliationWarning[]): string[] {
  if (warnings.length === 0) return [];
  const failures = new Map<string, Map<string, Set<string>>>();
  const other = new Set<string>();
  for (const warning of warnings) {
    if (!warning.checkFailure) { other.add(warning.message); continue; }
    const { reason, scope, subject } = warning.checkFailure;
    let scopes = failures.get(reason);
    if (!scopes) { scopes = new Map(); failures.set(reason, scopes); }
    let subjects = scopes.get(scope);
    if (!subjects) { subjects = new Set(); scopes.set(scope, subjects); }
    subjects.add(subject);
  }
  const lines = ["", "Warnings"];
  for (const [reason, scopes] of failures) {
    lines.push(`- Albion Online checks unavailable: ${reason}. No departures inferred from these failures.`);
    for (const [scope, subjects] of scopes) lines.push(`  ${scope}: ${[...subjects].join(", ")}.`);
  }
  lines.push(...[...other].map(message => `- ${message}`));
  return lines;
}
