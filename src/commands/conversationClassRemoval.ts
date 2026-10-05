import { reconcileApplicationActiveRole } from "../services/applications/activeRoleService.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { randomUUID } from "node:crypto";
import type { createApplicationRepository } from "../db/applicationRepository.js";
import type { ConversationClassRemovalRepository, ConversationClassSnapshot, ConversationKind } from "../db/conversationClassRemovalRepository.js";
import type { createMembershipRepository } from "../db/membershipRepository.js";
import type { createTicketRepository } from "../db/ticketRepository.js";
import { asComponentsV2Edit, buildComponentsV2Card } from "../discord/componentsV2.js";
import { completeFeedbackPrompt, editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import { logErrorContext, type Logger } from "../logging/logger.js";
import { withConversationClassLock } from "../services/conversationClassLock.js";
import { isMissingDiscordResource, removeConversationClass } from "../services/conversationClassRemoval.js";
import { ERROR_COLOR, INFO_COLOR, INVALID_COLOR, SUCCESS_COLOR, WARNING_COLOR } from "./configurationHelpers.js";

const PREFIX = "class-remove:";
const LIFETIME_MS = 15 * 60_000;
interface Confirmation {
  kind: ConversationKind;
  classId: string;
  guildId: string;
  actorId: string;
  expiresAt: number;
  fingerprint: string;
}
const confirmations = new Map<string, Confirmation>();

export async function beginConversationClassRemoval(interaction: ChatInputCommandInteraction, repository: ConversationClassRemovalRepository): Promise<void> {
  const snapshot = await repository.getSnapshot(interaction.guildId!, interaction.options.getString(repository.kind, true));
  if (!snapshot) {
    await editFeedback(interaction, { text: `That ${repository.kind} class is no longer available.`, accentColor: INVALID_COLOR });
    return;
  }
  await showConfirmation(interaction, repository.kind, snapshot);
}

export async function handleConversationClassRemovalButton(
  interaction: ButtonInteraction,
  applications: ReturnType<typeof createApplicationRepository>,
  tickets: ReturnType<typeof createTicketRepository>,
  memberships: ReturnType<typeof createMembershipRepository>,
  logger: Logger
): Promise<boolean> {
  if (!interaction.customId.startsWith(PREFIX)) return false;
  const [token, action, extra] = interaction.customId.slice(PREFIX.length).split(":");
  const draft = confirmations.get(token);
  if (!draft || extra !== undefined || (action !== "confirm" && action !== "cancel")) {
    await interaction.reply(feedbackReply({ accentColor: INVALID_COLOR, text: "Class removal confirmation expired; run the remove command again.", flags: MessageFlags.Ephemeral }));
    return true;
  }
  if (!interaction.inCachedGuild() || interaction.guildId !== draft.guildId || interaction.user.id !== draft.actorId) {
    await interaction.reply(feedbackReply({ accentColor: INVALID_COLOR, text: "Only the person who started this removal can use these buttons in the original Discord server.", flags: MessageFlags.Ephemeral }));
    return true;
  }
  // Consume before any I/O, including cancellation, to reject duplicate clicks.
  confirmations.delete(token);
  if (Date.now() >= draft.expiresAt) {
    await completeFeedbackPrompt(interaction, { text: `Class removal confirmation expired; run \`/${draft.kind === "application" ? "applications" : "tickets"} remove\` again.`, accentColor: INVALID_COLOR });
    return true;
  }
  if (action === "cancel") {
    await completeFeedbackPrompt(interaction, { text: "Class removal cancelled. Nothing was changed.", accentColor: INFO_COLOR });
    return true;
  }
  await interaction.deferUpdate();
  const repository = draft.kind === "application" ? applications.classRemoval : tickets.classRemoval;
  await withConversationClassLock(draft.kind, draft.guildId, draft.classId, async () => {
    const snapshot = await repository.getSnapshot(draft.guildId, draft.classId);
    if (!snapshot) {
      await completeFeedbackPrompt(interaction, { text: `That ${draft.kind} class was already removed.`, accentColor: INVALID_COLOR });
      return;
    }
    if (fingerprint(snapshot) !== draft.fingerprint) {
      await showConfirmation(interaction, draft.kind, snapshot, true);
      return;
    }
    const cleanupActiveRole = draft.kind === "application" ? async (userId: string, roleId: string) => {
      const warnings = await reconcileApplicationActiveRole(interaction.guild, applications, { activeRoleId: roleId }, userId);
      if (warnings.length) throw new Error("Application role cleanup incomplete");
    } : undefined;
    let result: Awaited<ReturnType<typeof removeConversationClass>>;
    try {
      result = await removeConversationClass({ guild: interaction.guild, actorId: draft.actorId, snapshot, repository, cleanupActiveRole });
    } catch (error) {
      logger.error("conversation class removal failed", {
        discordGuildId: draft.guildId,
        conversationKind: draft.kind,
        classId: draft.classId,
        ...logErrorContext(error, true)
      });
      await interaction.editReply(resultCard("Class Removal Incomplete", `Removal of ${snapshot.name} could not finish. Some channels may already have been deleted. Check the bot's database connection and Discord permissions, then run the remove command again.`, WARNING_COLOR));
      return;
    }
    if (result.failures) {
      const cleanup = draft.kind === "application" ? "channel or application-role" : "channel";
      await interaction.editReply(resultCard("Class Removal Incomplete", `${snapshot.name} remains disabled. ${result.deletedChannels} channel(s) were deleted; ${result.failures} ${cleanup} cleanup operation(s) failed. Remaining records were kept. Check the bot's database connection and Discord permissions, then run the remove command again.`, WARNING_COLOR));
      return;
    }
    const description = `${snapshot.name} was removed with ${snapshot.conversations.length} ${draft.kind} record(s) and ${result.deletedChannels} channel(s) deleted.`;
    // Removing the invoking channel may also remove this ephemeral response.
    // Failure to display success must not be reported as failure to remove data.
    await completeFeedbackPrompt(interaction, { structured: result.entryWarning, cards: [{ title: `${title(draft.kind)} Removed`, description: description + (result.entryWarning ? " The entry button could not be removed from its message; it can no longer open this class." : ""), color: result.entryWarning ? WARNING_COLOR : SUCCESS_COLOR }] }).catch((error: unknown) => {
      if (!isMissingDiscordResource(error, 10003) && !isMissingDiscordResource(error, 10008)) throw error;
    });
  });
  return true;
}

async function showConfirmation(interaction: ChatInputCommandInteraction | ButtonInteraction, kind: ConversationKind, snapshot: ConversationClassSnapshot, changed = false): Promise<void> {
  const now = Date.now();
  for (const [token, draft] of confirmations) if (draft.expiresAt <= now) confirmations.delete(token);
  const token = randomUUID();
  confirmations.set(token, { kind, classId: snapshot.classId, guildId: interaction.guildId!, actorId: interaction.user.id, expiresAt: now + LIFETIME_MS, fingerprint: fingerprint(snapshot) });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}${token}:confirm`).setLabel("REMOVE").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${PREFIX}${token}:cancel`).setLabel("CANCEL").setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply(asComponentsV2Edit(buildComponentsV2Card({
    accentColor: ERROR_COLOR,
    title: `Remove ${title(kind)} Class?`,
    text: [
      ...(changed ? ["The class or its conversations changed. Review the removal warning and confirm again."] : []),
      `Permanently remove the **${snapshot.name}** class, all its ${kind} records, and all its remaining channels, including their messages and attachments. This cannot be undone.`
    ],
    actionRows: [row]
  })));
}

function fingerprint(snapshot: ConversationClassSnapshot): string { return JSON.stringify(snapshot); }
function title(kind: ConversationKind): string { return kind === "application" ? "Application" : "Ticket"; }
function resultCard(heading: string, description: string, accentColor: number) {
  return asComponentsV2Edit(buildComponentsV2Card({ accentColor, title: heading, text: [description] }));
}
