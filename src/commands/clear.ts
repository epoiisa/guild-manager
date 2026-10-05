import {
  Collection,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type User
} from "discord.js";
import { editFeedback, feedbackReply } from "../discord/feedbackMessages.js";
import {
  INVALID_COLOR,
  SUCCESS_COLOR,
  WARNING_COLOR,
  rejectNonGuildInteraction
} from "./configurationHelpers.js";

const DEFAULT_MESSAGE_COUNT = 10;
const MAX_MESSAGE_COUNT = 100;
const MESSAGE_PAGE_SIZE = 100;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BULK_DELETE_AGE_BUFFER_MS = 60 * 1000;

export const clearCommand = new SlashCommandBuilder()
  .setName("clear")
  .setDescription("Delete recent messages from this channel.")
  .setDefaultMemberPermissions(0)
  .addIntegerOption((option) =>
    option
      .setName("number")
      .setDescription("Number of messages to delete. Defaults to 10.")
      .setMinValue(1)
      .setMaxValue(MAX_MESSAGE_COUNT)
  )
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("Delete only messages sent by this user.")
  );

type ClearableChannel = {
  bulkDelete(messages: Message[], filterOld?: boolean): Promise<Collection<string, Message>>;
  messages: {
    fetch(options: { before?: string; limit: number }): Promise<Collection<string, Message>>;
  };
};

export async function handleClearCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (await rejectNonGuildInteraction(interaction)) return;

  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("bulkDelete" in channel)) {
    await interaction.reply(feedbackReply({
      cards: [buildClearEmbed("This command can only be used in a text channel.", INVALID_COLOR)],
      flags: MessageFlags.Ephemeral
    }));
    return;
  }

  const requestedCount = interaction.options.getInteger("number") ?? DEFAULT_MESSAGE_COUNT;
  const user = interaction.options.getUser("user") ?? undefined;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const clearableChannel = channel as ClearableChannel;
  const { messages, skippedPinnedCount } = await collectMessages(clearableChannel, requestedCount, user);

  let deletedCount = 0;
  if (messages.length === 1) {
    await messages[0].delete();
    deletedCount = 1;
  } else if (messages.length > 1) {
    const deletedMessages = await clearableChannel.bulkDelete(messages, true);
    deletedCount = deletedMessages.size;
  }

  await editFeedback(interaction, {
    cards: [
      buildClearEmbed(
        formatClearResult(deletedCount, user, skippedPinnedCount),
        skippedPinnedCount > 0 ? WARNING_COLOR : SUCCESS_COLOR
      )
    ]
  });
}

async function collectMessages(
  channel: ClearableChannel,
  requestedCount: number,
  user?: User
): Promise<{ messages: Message[]; skippedPinnedCount: number }> {
  const messages: Message[] = [];
  let before: string | undefined;
  let skippedPinnedCount = 0;
  const oldestAllowedTimestamp = Date.now() - BULK_DELETE_MAX_AGE_MS + BULK_DELETE_AGE_BUFFER_MS;

  while (messages.length < requestedCount) {
    const page = await channel.messages.fetch({ before, limit: MESSAGE_PAGE_SIZE });
    if (page.size === 0) {
      break;
    }

    let reachedAgeLimit = false;
    for (const message of page.values()) {
      if (message.createdTimestamp < oldestAllowedTimestamp) {
        reachedAgeLimit = true;
        break;
      }

      if (user && message.author.id !== user.id) {
        continue;
      }

      if (message.pinned) {
        skippedPinnedCount += 1;
        continue;
      }

      messages.push(message);
      if (messages.length === requestedCount) {
        break;
      }
    }

    if (messages.length === requestedCount || reachedAgeLimit) {
      break;
    }

    before = page.last()?.id;
    if (!before) {
      break;
    }
  }

  return { messages, skippedPinnedCount };
}

function formatClearResult(deletedCount: number, user: User | undefined, skippedPinnedCount: number): string {
  const messageLabel = deletedCount === 1 ? "message" : "messages";
  const userLabel = user ? ` from ${user.toString()}` : "";
  const pinnedLabel = skippedPinnedCount > 0
    ? ` Skipped ${skippedPinnedCount} pinned ${skippedPinnedCount === 1 ? "message" : "messages"}.`
    : "";

  return `Deleted ${deletedCount} ${messageLabel}${userLabel}.${pinnedLabel}`;
}

function buildClearEmbed(description: string, color: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(description);
}
