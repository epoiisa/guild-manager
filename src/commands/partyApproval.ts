import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild
} from "discord.js";
import type { ContentSnapshot, createContentRepository } from "../db/contentRepository.js";
import { editFeedback } from "../discord/feedbackMessages.js";
import { v2Edit } from "../discord/operationalMessages.js";
import { getContentCleanupAt } from "../services/content/lifecycle.js";
import { refreshContentMessages } from "../services/content/messages.js";
import { reconcileSignupApprovals } from "../services/content/signupApproval.js";
import { buildInfoEmbed, buildNotFoundEmbed, buildSuccessEmbed } from "./configurationHelpers.js";

type ContentRepository = ReturnType<typeof createContentRepository>;
type ReviewInteraction = ButtonInteraction | ChatInputCommandInteraction;
type ReviewAction = "accept" | "decline";

const NOT_PENDING = "That request is no longer pending.";
const CLOSED = "This party is no longer open for signups.";
const HOST_ONLY = "Only the party host can review signup requests.";

/** Both command and button reviews use the same authorization and atomic decision. */
export async function handlePartyApprovalReview(
  interaction: ReviewInteraction,
  repository: ContentRepository,
  previous: ContentSnapshot,
  action: ReviewAction,
  userId: string | undefined,
  requestId?: string
): Promise<void> {
  await acknowledge(interaction);
  if (!interaction.guild || interaction.guildId !== previous.content.discordGuildId) {
    await respond(interaction, "Party Thread Required", "Use this action inside its managed party thread.");
    return;
  }
  const snapshot = await repository.getContentSnapshot(interaction.guildId, previous.content.contentId);
  if (!snapshot || interaction.channelId !== snapshot.content.threadChannelId) {
    await respond(interaction, "Request Unavailable", NOT_PENDING);
    return;
  }
  if (snapshot.content.hostDiscordUserId !== interaction.user.id
    || await repository.isHostAuthorityRevoked(interaction.guildId, interaction.user.id, snapshot.content.contentId)) {
    await respond(interaction, "Host Only", HOST_ONLY);
    return;
  }
  if (!isOpen(snapshot)) {
    await repairSilently(interaction, repository, snapshot);
    await retireClickedControls(interaction);
    await respond(interaction, "Signups Closed", CLOSED);
    return;
  }
  const request = requestId
    ? await repository.getSignupRequest(interaction.guildId, snapshot.content.contentId, requestId)
    : userId ? await repository.getPendingSignupRequest(interaction.guildId, snapshot.content.contentId, userId) : undefined;
  if (!request || request.status !== "pending"
    || (interaction.isButton() && request.requestMessageId !== interaction.message.id)) {
    await repairSilently(interaction, repository, snapshot);
    await retireClickedControls(interaction);
    await respond(interaction, "Request Unavailable", NOT_PENDING);
    return;
  }

  // The repository rechecks the current host, request, role and deadline under its
  // party lock. Membership/access is refreshed there too, so a queued decision
  // cannot rely on a check made before a withdrawal or host transfer.
  let result: Awaited<ReturnType<ContentRepository["decideSignupRequest"]>>;
  try {
    result = await repository.decideSignupRequest({
      discordGuildId: interaction.guildId,
      contentId: snapshot.content.contentId,
      actorDiscordUserId: interaction.user.id,
      decision: action,
      requestId: request.requestId,
      ...(interaction.isButton() ? { requestMessageId: interaction.message.id } : {}),
      ...(action === "accept" ? {
        validateAvailability: (current: typeof request) => hasCurrentThreadAccess(
          interaction.guild!, snapshot.content.threadChannelId, current.discordUserId
        )
      } : {})
    });
  } catch (error) {
    if (!(error instanceof AvailabilityCheckError)) throw error;
    await respond(interaction, "Request Still Pending", "Guild Manager could not verify that member's current access. Try again.");
    return;
  }

  if (result.status !== "accepted" && result.status !== "declined") {
    if (result.status === "closed" || result.status === "slot_changed" || result.status === "not_pending") {
      await repairSilently(interaction, repository, snapshot);
      await retireClickedControls(interaction);
    }
    const message = result.status === "not_host" ? HOST_ONLY
      : result.status === "closed" ? CLOSED
      : result.status === "slot_filled" ? "That role is already filled. No changes were made."
      : result.status === "unavailable" ? "That member is no longer in this Discord server or cannot access this party thread. No changes were made."
      : NOT_PENDING;
    await respond(interaction, "Request Not Updated", message);
    return;
  }

  let complete = false;
  try {
    const delivery = await reconcileSignupApprovals(interaction.guild, repository, snapshot.content.contentId, {
      notifyOutcomeRequestId: result.request?.requestId ?? request.requestId
    });
    complete = delivery.complete;
    const current = await repository.getContentSnapshot(interaction.guildId, snapshot.content.contentId);
    if (current) await refreshContentMessages(interaction.guild, repository, current, undefined, true);
    else complete = false;
  } catch {
    // The decision is already committed. A retry repairs presentation only.
    complete = false;
  }
  if (!complete) {
    await retireClickedControls(interaction);
    await interaction.editReply(v2Edit({
      cards: [buildInfoEmbed("Request Updated With Warning", "The decision was saved, but Guild Manager could not finish updating its messages. The saved decision will be repaired without applying it again.")],
      allowedMentions: { parse: [] }
    }));
    return;
  }
  await editFeedback(interaction, {
    cards: [buildSuccessEmbed(result.status === "accepted" ? "Request Accepted" : "Request Declined", result.status === "accepted" ? "The signup request was accepted." : "The signup request was not accepted.")],
    allowedMentions: { parse: [] }
  });
}

export async function handlePartyApprovalButton(
  interaction: ButtonInteraction,
  repository: ContentRepository
): Promise<boolean> {
  if (!interaction.customId.startsWith("content:approval:")) return false;
  await acknowledge(interaction);
  const parsed = /^content:approval:(accept|decline):([^:]+):([^:]+)$/.exec(interaction.customId);
  if (!parsed || !interaction.guild || !interaction.guildId
    || interaction.message.author.id !== interaction.guild.client.user?.id) {
    await respond(interaction, "Request Unavailable", NOT_PENDING);
    return true;
  }
  const snapshot = await repository.getContentSnapshot(interaction.guildId, parsed[2]);
  if (!snapshot) {
    await retireClickedControls(interaction);
    await respond(interaction, "Request Unavailable", NOT_PENDING);
    return true;
  }
  await handlePartyApprovalReview(interaction, repository, snapshot, parsed[1] as ReviewAction, undefined, parsed[3]);
  return true;
}

async function acknowledge(interaction: ReviewInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function respond(interaction: ReviewInteraction, title: string, description: string): Promise<void> {
  await editFeedback(interaction, { cards: [buildNotFoundEmbed(title, description)], allowedMentions: { parse: [] } }, "context");
}

function isOpen(snapshot: ContentSnapshot): boolean {
  return ["scheduled", "unscheduled", "active"].includes(snapshot.content.state)
    && getContentCleanupAt(snapshot.content).getTime() > Date.now();
}

async function repairSilently(interaction: ReviewInteraction, repository: ContentRepository, snapshot: ContentSnapshot): Promise<void> {
  if (interaction.guild) {
    await reconcileSignupApprovals(interaction.guild, repository, snapshot.content.contentId).catch(() => undefined);
  }
}

async function retireClickedControls(interaction: ReviewInteraction): Promise<void> {
  if (interaction.isButton() && interaction.message.author.id === interaction.guild?.client.user?.id) {
    await interaction.message.edit({ components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
  }
}

class AvailabilityCheckError extends Error {}

async function hasCurrentThreadAccess(guild: Guild, threadId: string, userId: string): Promise<boolean> {
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    const thread = await guild.channels.fetch(threadId, { force: true });
    if (!member || !thread?.isThread()) return false;
    const permissions = thread.permissionsFor(member);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return false;
    if (thread.type === ChannelType.PrivateThread && !permissions.has(PermissionFlagsBits.ManageThreads)) {
      return Boolean(await thread.members.fetch({ member: userId, force: true }));
    }
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && [10003, 10007].includes(Number(error.code))) return false;
    throw new AvailabilityCheckError("Could not verify current party thread access.", { cause: error });
  }
}
