import {
  EmbedBuilder,
  type ActionRowBuilder,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type Message,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from "discord.js";
import { buildNotFoundEmbed } from "../../commands/configurationHelpers.js";
import {
  type ApplicationClass,
  type ApplicationStatus,
  type OpenApplication,
  type createApplicationRepository,
} from "../../db/applicationRepository.js";
import { findNestedComponentCustomIds } from "../../discord/componentsV2.js";
import { feedbackMessage } from "../../discord/feedbackMessages.js";
import { refreshApplicationIntakeCard, retireIntakeMessageControls } from "./intakePresentation.js";
import type { ApplicationLifecyclePresentation } from "./lifecycleService.js";
import {
  applicationOpenComponents,
  buildApplicationControlReplacementEmbed,
  buildApplicationV2Card,
  buildCloseButton,
  buildClosedApplicationEmbed,
  buildClosedChannelButtons,
  buildReopenedApplicationEmbed,
  buildWaitingButtons,
} from "./rendering.js";

type ApplicationRepository = ReturnType<typeof createApplicationRepository>;

export async function retireApplicationDecisionControls(
  channel: TextChannel,
  applicationRepository: ApplicationRepository,
  applicationId: string,
): Promise<void> {
  const application = await applicationRepository.getOpenApplication(channel.guild.id, applicationId);
  await retireStoredApplicationControl(channel, application?.applicationControlMessageId);
  await retireStoredApplicationControl(channel, application?.characterResolutionMessageId);
}

export async function retainWaitingApplicationControls(
  channel: TextChannel,
  applicationRepository: ApplicationRepository,
  applicationId: string,
): Promise<void> {
  const application = await applicationRepository.getOpenApplication(channel.guild.id, applicationId);
  if (!application?.applicationControlMessageId) return;
  const message = await channel.messages.fetch(application.applicationControlMessageId).catch(() => undefined);
  if (message?.author.id !== channel.client.user.id) return;
  const configured = await applicationRepository.getApplicationClass(channel.guild.id, application.applicationClassId);
  if (configured) {
    await rerenderApplicationMessage(
      message,
      buildApplicationControlReplacementEmbed(configured, application),
      [buildWaitingButtons(applicationId)],
    ).catch(() => undefined);
  }
}

export function createApplicationCommandLifecyclePresentation(
  channel: TextChannel,
  applicationRepository: ApplicationRepository,
  refreshUndecided?: (application: ApplicationClass, openApplication: OpenApplication) => Promise<void>,
): ApplicationLifecyclePresentation {
  return {
    renderClosed: async (applicationId, description) => {
      const replacement = await channel.send(buildApplicationV2Card(
        buildClosedApplicationEmbed(description),
        [buildClosedChannelButtons(applicationId)],
      ));
      const current = await applicationRepository.getOpenApplication(channel.guild.id, applicationId);
      await retireStoredApplicationControl(channel, current?.applicationControlMessageId, current);
      if (current?.characterResolutionMessageId !== current?.applicationControlMessageId) await retireStoredApplicationControl(channel, current?.characterResolutionMessageId, current);
      return replacement.id;
    },
    retireClosedCandidate: async (messageId) => {
      await retireStoredApplicationControl(channel, messageId);
    },
    renderOpen: async (application, openApplication, applicationId, description) => {
      await renderReopenedApplication(channel, applicationRepository, application, openApplication, description, { refreshUndecided });
      await retireStoredApplicationControl(channel, openApplication.closedControlMessageId);
    },
  };
}

export async function retireStoredApplicationControl(channel: TextChannel, messageId: string | undefined, application?: OpenApplication): Promise<void> {
  if (!messageId) return;
  const message = await channel.messages.fetch(messageId).catch(() => undefined);
  if (message) await retireApplicationMessage(channel, message, application).catch(() => undefined);
}

/** A first-selection prompt has no review history to retain after close or withdrawal. */
export async function retireApplicationMessage(channel: TextChannel, message: Message, application?: OpenApplication): Promise<void> {
  const unusedSelectionPrompt = application
    && message.author.id === channel.client.user.id
    && message.id === application.characterResolutionMessageId
    && !application.legacyReviewPublication && !application.reviewPublication
    && application.characterResolutionState !== "selected"
    && (application.status === "withdrawn" || (application.status === "open" && application.channelStatus === "closed"));
  if (unusedSelectionPrompt) {
    try {
      await message.delete();
      return;
    } catch (error) {
      if ((error as { code?: number }).code === 10008) return;
      // Failed deletion must not leave active controls on the obsolete prompt.
    }
  }
  await rerenderApplicationMessage(message, undefined, []);
}

export async function retireUndecidedControls(
  channel: TextChannel,
  interaction: ButtonInteraction<"cached">,
  openApplication: OpenApplication,
): Promise<void> {
  await retireApplicationMessage(channel, interaction.message, openApplication).catch(() => undefined);
  if (!openApplication.characterResolutionMessageId || openApplication.characterResolutionMessageId === interaction.message.id) return;
  const characterMessage = await channel.messages.fetch(openApplication.characterResolutionMessageId).catch(() => undefined);
  if (characterMessage) await retireApplicationMessage(channel, characterMessage, openApplication).catch(() => undefined);
}

/** Re-renders a V2 card when controls change; V2 cannot be edited to [] alone. */
export async function rerenderApplicationMessage(
  message: Message,
  replacement: EmbedBuilder | undefined,
  actionRows: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[],
): Promise<void> {
  const embed = replacement ?? message.embeds?.[0];
  if (!embed) {
    await retireIntakeMessageControls(message);
    return;
  }
  await message.edit(buildApplicationV2Card(embed instanceof EmbedBuilder ? embed : EmbedBuilder.from(embed), actionRows, { edit: true }));
}

/** Completed applications move Close to the new lifecycle card, preserving outcome history. */
export async function renderReopenedApplication(
  channel: TextChannel,
  applicationRepository: ApplicationRepository,
  application: ApplicationClass,
  openApplication: OpenApplication,
  description: string,
  options: {
    refreshUndecided?: (application: ApplicationClass, openApplication: OpenApplication) => Promise<void>;
    send?: (payload: ReturnType<typeof buildApplicationV2Card>) => Promise<Message>;
  } = {},
): Promise<void> {
  const send = options.send ?? ((payload) => channel.send(payload));
  const completed = ["accepted", "rejected", "withdrawn"].includes(openApplication.status);
  if (!completed) {
    if (openApplication.status === "open" && options.refreshUndecided) await options.refreshUndecided(application, openApplication);
    else await restoreApplicationControlMessage(channel, applicationRepository, application, openApplication, openApplication.applicationId);
    await send(feedbackMessage({
      cards: [buildReopenedApplicationEmbed(description.replace(/^Reopened by /u, "Application channel reopened by "))]
    }));
    return;
  }

  const previousMessage = openApplication.applicationControlMessageId
    ? await channel.messages.fetch(openApplication.applicationControlMessageId).catch(() => undefined)
    : undefined;
  if (previousMessage?.author.id !== channel.client.user.id) {
    await channel.send(buildApplicationV2Card(buildApplicationControlReplacementEmbed(application, openApplication)));
  }
  const reopened = await send(buildApplicationV2Card(buildReopenedApplicationEmbed(description), [buildCloseButton(openApplication.applicationId)]));
  try {
    const stored = await applicationRepository.setApplicationControlMessageId(openApplication.discordGuildId, openApplication.applicationId, reopened.id);
    if (!stored) throw new Error("The reopened application control message could not be stored.");
  } catch (error) {
    await rerenderApplicationMessage(reopened, undefined, []).catch(() => undefined);
    throw error;
  }
  if (previousMessage?.author.id === channel.client.user.id && previousMessage.id !== reopened.id) {
    await rerenderApplicationMessage(previousMessage, undefined, []);
  }
}

async function restoreApplicationControlMessage(
  channel: TextChannel,
  applicationRepository: ApplicationRepository,
  application: ApplicationClass,
  openApplication: OpenApplication,
  applicationId: string,
): Promise<void> {
  if (openApplication.status === "open") {
    await refreshApplicationIntakeCard(channel, applicationRepository, application, openApplication, undefined, { publishReview: false });
    return;
  }
  const components = applicationOpenComponents(openApplication.status, applicationId);
  const storedMessage = openApplication.applicationControlMessageId
    ? await channel.messages.fetch(openApplication.applicationControlMessageId).catch(() => undefined)
    : undefined;
  if (storedMessage && storedMessage.author.id === channel.client.user.id && hasExpectedApplicationControl(storedMessage, application, openApplication.status, applicationId)) {
    await rerenderApplicationMessage(storedMessage, buildApplicationControlReplacementEmbed(application, openApplication), components);
    return;
  }
  if (storedMessage?.author.id === channel.client.user.id) await rerenderApplicationMessage(storedMessage, undefined, []).catch(() => undefined);
  const replacement = await channel.send(buildApplicationV2Card(buildApplicationControlReplacementEmbed(application, openApplication), components));
  await applicationRepository.setApplicationControlMessageId(openApplication.discordGuildId, applicationId, replacement.id);
}

export async function requireCanonicalApplicationControlSource(
  interaction: ButtonInteraction<"cached">,
  applicationRepository: ApplicationRepository,
  application: ApplicationClass,
  openApplication: OpenApplication,
  expectedStatus: ApplicationStatus,
): Promise<boolean> {
  const sourceMatches = interaction.message.author.id === interaction.client.user.id
    && hasExpectedApplicationControl(interaction.message, application, expectedStatus, openApplication.applicationId);
  if (!sourceMatches) {
    await replyStaleApplicationControl(interaction);
    return false;
  }
  if (openApplication.applicationControlMessageId) {
    if (openApplication.applicationControlMessageId !== interaction.message.id) {
      await replyStaleApplicationControl(interaction);
      return false;
    }
    return true;
  }
  if (expectedStatus === "open") return true;
  const adopted = await applicationRepository.setApplicationControlMessageId(interaction.guildId, openApplication.applicationId, interaction.message.id);
  if (!adopted) {
    await replyStaleApplicationControl(interaction);
    return false;
  }
  return true;
}

export function isClosedControlSource(interaction: ButtonInteraction<"cached">, application: ApplicationClass): boolean {
  return interaction.message.author.id === interaction.client.user.id
    && (findNestedComponentCustomIds(interaction.message.components).has(`app:reopen:${interaction.customId.split(":").at(-1)}`)
      || interaction.message.embeds[0]?.title === "Application Closed"
      || (!!application.archivedAt && interaction.message.embeds[0]?.title === "Application Target Removed"));
}

function hasExpectedApplicationControl(message: { embeds?: readonly { title?: string | null }[]; components?: unknown }, application: ApplicationClass, status: ApplicationStatus, applicationId: string): boolean {
  const actionIds = status === "open" ? [`app:withdraw:${applicationId}`]
    : status === "awaiting_ingame_membership" ? [`app:verify:${applicationId}`, `app:cancel:${applicationId}`]
      : [`app:close:${applicationId}`];
  const ids = findNestedComponentCustomIds(message.components);
  return actionIds.every((id) => ids.has(id)) || message.embeds?.[0]?.title === applicationControlTitle(application, status);
}

function applicationControlTitle(application: ApplicationClass, status: ApplicationStatus): string {
  if (status === "open") return application.name;
  if (status === "awaiting_ingame_membership") return "Waiting For In-Game Membership";
  if (status === "accepted") return "Application Accepted";
  if (status === "rejected") return "Application Rejected";
  return "Application Withdrawn";
}

export async function replyStaleApplicationControl(interaction: ButtonInteraction<"cached">): Promise<void> {
  const payload = buildApplicationV2Card(
    buildNotFoundEmbed("Stale Application Control", "Use the controls on the current matching application message."),
    [],
    { ephemeral: true },
  ) as InteractionReplyOptions;
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}
