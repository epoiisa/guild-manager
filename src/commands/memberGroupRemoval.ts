import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction
} from "discord.js";
import type { MemberGroup, createMembershipRepository } from "../db/membershipRepository.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { v2Edit, v2Reply } from "../discord/operationalMessages.js";
import { getAlbionServerLabel } from "../services/albion/servers.js";
import { recordLogChange } from "../services/logFeed/events.js";
import { reconcileConfiguredRoles } from "../services/membership/discordMemberUpdates.js";
import { ERROR_COLOR, INFO_COLOR, SUCCESS_COLOR, WARNING_COLOR, buildNotFoundEmbed, formatMemberGroupTypeTitle } from "./configurationHelpers.js";

type MembershipRepository = ReturnType<typeof createMembershipRepository>;
type MemberGroupRemovalResult = NonNullable<Awaited<ReturnType<MembershipRepository["removeMemberGroup"]>>>;
type MemberGroupAction = "delete" | "remove";

const DELETE_CUSTOM_ID_PREFIX = "member-group-delete";
const REMOVE_CUSTOM_ID_PREFIX = "member-group-remove";
const CONFIRMATION_LIFETIME_MS = 15 * 60_000;

export async function beginMemberGroupRemoval(
  interaction: ChatInputCommandInteraction,
  membershipRepository: MembershipRepository,
  memberGroup: MemberGroup,
  displayLabel: string
): Promise<void> {
  const preview = await membershipRepository.previewMemberGroupRemoval(interaction.guildId!, memberGroup.memberGroupId);
  if (!preview) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed(`${formatMemberGroupTypeTitle(memberGroup.groupType)} Not Found`, "That configured member group is no longer available.")],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const typeTitle = formatMemberGroupTypeTitle(memberGroup.groupType);
  const action = memberGroupAction(memberGroup);
  const actionTitle = titleCase(action);
  const consequence = action === "delete"
    ? `This permanently deletes ${displayLabel} and **${countLabel(preview.totalMembershipProfiles, "membership profile")}** in that group.`
    : `This permanently removes **${countLabel(preview.totalMembershipProfiles, "membership profile")}** from ${displayLabel}.`;
  const expiry = Date.now() + CONFIRMATION_LIFETIME_MS;
  await interaction.reply(v2Reply({
    cards: [new EmbedBuilder()
      .setColor(ERROR_COLOR)
      .setTitle(`${actionTitle} ${typeTitle}?`)
      .setDescription([
        consequence,
        `**${countLabel(preview.affectedDiscordUserIds.length, "Discord member")}** will have membership entitlements recalculated.`,
        "Memberships in other groups and character registrations are retained.",
        "Related application intake will be archived automatically."
      ].join("\n"))
      .addFields(
        { name: "Membership Profiles", value: String(preview.totalMembershipProfiles), inline: true },
        { name: "Discord Members", value: String(preview.affectedDiscordUserIds.length), inline: true },
        { name: "Orphaned Profiles", value: String(preview.orphanedMembershipProfiles), inline: true }
      )],
    actionRows: [confirmationRow(memberGroup.memberGroupId, interaction.user.id, expiry, action)],
    flags: MessageFlags.Ephemeral
  }));
}

export async function handleMemberGroupRemovalButton(
  interaction: ButtonInteraction,
  membershipRepository: MembershipRepository,
  afterRemoval?: (result: MemberGroupRemovalResult) => Promise<string[]>
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return false;

  const actionNoun = parsed.actionType === "delete" ? "Deletion" : "Removal";
  if (!interaction.inCachedGuild() || interaction.user.id !== parsed.actorId) {
    await interaction.reply(feedbackReply({
      cards: [buildNotFoundEmbed(`${actionNoun} Confirmation Not Allowed`, `Only the person who started this ${actionNoun.toLocaleLowerCase()} can use these buttons.`)],
      flags: MessageFlags.Ephemeral
    }));
    return true;
  }
  if (Date.now() >= parsed.expiry) {
    await completeFeedbackPrompt(interaction, {
      cards: [buildNotFoundEmbed(`${actionNoun} Confirmation Expired`, `${actionNoun} confirmation expired; run the ${parsed.actionType} command again.`)],
      actionRows: []
    }, "body");
    return true;
  }
  if (parsed.action === "cancel") {
    await completeFeedbackPrompt(interaction, {
      cards: [new EmbedBuilder().setColor(INFO_COLOR).setTitle(`${actionNoun} Cancelled`).setDescription(`${actionNoun} cancelled. Nothing was changed.`)],
      actionRows: []
    }, "body");
    return true;
  }

  await interaction.deferUpdate();
  const result = await membershipRepository.removeMemberGroup({
    discordGuildId: interaction.guildId,
    memberGroupId: parsed.memberGroupId,
    archivedByDiscordUserId: interaction.user.id
  });
  if (!result) {
    await editFeedback(interaction, {
      cards: [buildNotFoundEmbed(
        parsed.actionType === "delete" ? "Group Not Found" : "Member Group Not Found",
        `That configured member group was already ${parsed.actionType === "delete" ? "deleted" : "removed"}.`
      )],
      actionRows: []
    }, "body", true);
    return true;
  }

  let failedUsers = 0;
  for (const userId of result.affectedDiscordUserIds) {
    try {
      const warnings = await reconcileConfiguredRoles(
        interaction.guild,
        membershipRepository,
        userId,
        result.retiredRoleIds
      );
      if (warnings.length > 0) failedUsers += 1;
    } catch {
      failedUsers += 1;
    }
  }
  let cleanupWarnings: string[] = [];
  try {
    cleanupWarnings = await afterRemoval?.(result) ?? [];
  } catch {
    cleanupWarnings = ["Application presentation cleanup failed unexpectedly."];
  }

  const typeTitle = formatMemberGroupTypeTitle(result.memberGroup.groupType);
  const resultAction = memberGroupAction(result.memberGroup);
  const resultActionPast = resultAction === "delete" ? "deleted" : "removed";
  const label = `${result.displayName ?? result.memberGroup.groupName} • ${getAlbionServerLabel(result.memberGroup.albionServer)}`;
  const incomplete = failedUsers > 0 || cleanupWarnings.length > 0;
  if (incomplete) recordLogChange(interaction.guildId, { kind: "incomplete", area: "membership" });
  const profileSummary = `${label} was ${resultActionPast}. **${countLabel(result.totalMembershipProfiles, "membership profile")}** ${result.totalMembershipProfiles === 1 ? "was" : "were"} removed.`;
  const affectedUsers = result.affectedDiscordUserIds.length;
  const successfulUsers = affectedUsers - failedUsers;
  const reconciliationSummary = failedUsers === 0
    ? `**${countLabel(affectedUsers, "Discord member")}** ${affectedUsers === 1 ? "was" : "were"} reconciled.`
    : `Entitlement reconciliation completed without warnings for **${successfulUsers} of ${affectedUsers} Discord members**.`;
  const details = [[
    profileSummary,
    reconciliationSummary,
    "Other memberships and character registrations were retained."
  ].join(" ")];
  if (failedUsers > 0) details.push(`Entitlement reconciliation reported warnings for **${countLabel(failedUsers, "Discord member")}**.`);
  if (cleanupWarnings.length > 0) details.push(`Application presentation cleanup reported **${countLabel(cleanupWarnings.length, "warning")}**; archived intake remains disabled.`);

  await interaction.editReply(v2Edit({
    cards: [new EmbedBuilder()
      .setColor(incomplete ? WARNING_COLOR : SUCCESS_COLOR)
      .setTitle(incomplete
        ? `${typeTitle} ${titleCase(resultActionPast)}; Entitlement Reconciliation Incomplete`
        : `${typeTitle} ${titleCase(resultActionPast)}`)
      .setDescription(details.join("\n"))],
    actionRows: []
  }));
  return true;
}

function confirmationRow(
  memberGroupId: string,
  actorId: string,
  expiry: number,
  action: MemberGroupAction
): ActionRowBuilder<ButtonBuilder> {
  const prefix = action === "delete" ? DELETE_CUSTOM_ID_PREFIX : REMOVE_CUSTOM_ID_PREFIX;
  const base = `${prefix}:${memberGroupId}:${actorId}:${expiry.toString(36)}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${base}:confirm`).setLabel(action.toUpperCase()).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${base}:cancel`).setLabel("CANCEL").setStyle(ButtonStyle.Secondary)
  );
}

function parseCustomId(customId: string): {
  memberGroupId: string;
  actorId: string;
  expiry: number;
  actionType: MemberGroupAction;
  action: "confirm" | "cancel";
} | undefined {
  const actionType = customId.startsWith(`${DELETE_CUSTOM_ID_PREFIX}:`)
    ? "delete"
    : customId.startsWith(`${REMOVE_CUSTOM_ID_PREFIX}:`)
      ? "remove"
      : undefined;
  if (!actionType) return undefined;
  const prefix = actionType === "delete" ? DELETE_CUSTOM_ID_PREFIX : REMOVE_CUSTOM_ID_PREFIX;
  const [memberGroupId, actorId, expiryText, action] = customId.slice(prefix.length + 1).split(":");
  const expiry = Number.parseInt(expiryText, 36);
  if (!memberGroupId || !actorId || !Number.isFinite(expiry) || (action !== "confirm" && action !== "cancel")) return undefined;
  return { memberGroupId, actorId, expiry, actionType, action };
}

function memberGroupAction(memberGroup: Pick<MemberGroup, "groupType">): MemberGroupAction {
  return memberGroup.groupType === "group" ? "delete" : "remove";
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}
