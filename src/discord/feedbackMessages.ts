import {
  ComponentType,
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageCreateOptions,
  type RepliableInteraction
} from "discord.js";
import { v2Edit, v2Message, type OperationalMessage } from "./operationalMessages.js";

export interface FeedbackMessage extends OperationalMessage {
  /** An explicitly authored complete sentence, when the card body is insufficient. */
  summary?: string;
  /** Only reviewed short notices may keep ordinary buttons. */
  allowActionRows?: boolean;
  /** A partial result or report can require structure even without newlines. */
  structured?: boolean;
}
export type FeedbackWording = "body" | "context";

/** Opt-in construction for reviewed receipts and short state feedback only.
 * Reports, evidence, configured text and workflow prompts continue to use V2
 * constructors directly. Limits are a lossless fallback, not a selection rule.
 */
export function feedbackMessage(options: FeedbackMessage, wording: FeedbackWording = "body") {
  const cards = (options.cards ?? []).map(card => "toJSON" in card ? card.toJSON() : card);
  const card = cards[0];
  const description = options.text ?? card?.description;
  const text = options.summary ?? (wording === "context" && card?.title
    ? `${card.title}: ${description ?? ""}` : description);
  const structured = options.structured || cards.length > 1 || options.textBlocks?.length
    || options.files?.length || card?.fields?.length || card?.footer || card?.timestamp
    || card?.author || card?.image || card?.thumbnail || card?.url
    || ((options.actionRows?.length ?? 0) > 0 && !options.allowActionRows);
  if (structured || !text || /[\r\n\u2028\u2029]/u.test(text) || text.length > 2_000) return v2Message(options);
  const components = options.actionRows ?? [];
  for (const component of components) {
    const json = "toJSON" in component ? component.toJSON() : component;
    if (json.type !== ComponentType.ActionRow) throw new Error("Plain feedback controls must be ordinary Action Rows.");
  }
  return {
    content: text,
    components,
    flags: MessageFlags.SuppressEmbeds as const,
    allowedMentions: { parse: [] as never[], repliedUser: false, ...options.allowedMentions }
  };
}

export function feedbackReply(options: FeedbackMessage, wording: FeedbackWording = "body") {
  const message = feedbackMessage(options, wording);
  return { ...message, flags: (Number(message.flags) | (options.flags ?? 0)) as NonNullable<InteractionReplyOptions["flags"]> };
}

/** A compatible edit, including the permitted standard-to-V2 transition. */
export function feedbackEdit(options: FeedbackMessage, wording: FeedbackWording = "body"): InteractionEditReplyOptions {
  const message = feedbackMessage(options, wording);
  if (Number(message.flags) & MessageFlags.IsComponentsV2) return v2Edit(options);
  return { ...message, embeds: [], attachments: [] };
}

type FeedbackInteraction = Pick<RepliableInteraction, "editReply" | "followUp" | "deleteReply" | "deferred" | "replied" | "ephemeral"> & {
  update?: (options: InteractionUpdateOptions) => Promise<unknown>;
  message?: { flags?: { has(bit: number): boolean } } | null;
};

/** Terminal private prompt completion. The caller consumes its draft or saves
 * its outcome before calling. Retire controls with the truthful V2 result first;
 * send once, then delete only after confirmed delivery. Ambiguous delivery and
 * cleanup failure leave the completed prompt and never rerun the operation.
 */
export async function completeFeedbackPrompt(
  interaction: FeedbackInteraction,
  options: FeedbackMessage,
  wording: FeedbackWording = "body"
): Promise<void> {
  const payload = feedbackReply({ ...options, flags: MessageFlags.Ephemeral }, wording);
  const isV2 = interaction.message?.flags?.has(MessageFlags.IsComponentsV2) ?? true;
  const update = async (value: InteractionUpdateOptions & InteractionEditReplyOptions) => {
    if (!interaction.deferred && !interaction.replied && interaction.update) await interaction.update(value);
    else await interaction.editReply(value);
  };
  if (!isV2 || Number(payload.flags) & MessageFlags.IsComponentsV2) {
    await update(feedbackEdit(options, wording) as InteractionUpdateOptions & InteractionEditReplyOptions);
    return;
  }
  // Do not remove active navigation: this helper only completes disposable prompts.
  const completed = { ...options, actionRows: [] };
  try {
    await update(v2Edit(completed));
  } catch {
    // A failed/uncertain retirement cannot safely be followed by another receipt.
    return;
  }
  try {
    await interaction.followUp(payload);
  } catch {
    // The completed V2 state remains visible. Never blindly retry a send.
    return;
  }
  try { await interaction.deleteReply(); } catch { /* Completed state is safe to retain. */ }
}

/** First result of a private deferReply, or terminal result of a deferUpdate.
 * Explicit prompt mode covers shared command/selection completion functions.
 * Discord sets ephemeral on deferReply, but not on deferUpdate.
 */
export async function editFeedback(
  interaction: FeedbackInteraction,
  options: FeedbackMessage,
  wording: FeedbackWording = "body",
  prompt = false
): Promise<void> {
  const updatingPrompt = prompt || (interaction.ephemeral !== true && interaction.message?.flags?.has(MessageFlags.Ephemeral));
  if (updatingPrompt) await completeFeedbackPrompt(interaction, options, wording);
  else await interaction.editReply(feedbackEdit(options, wording));
}

/** Deliver an already classified private panel result. Empty terminal states
 * may be plain; the persistent panel and any remaining selections stay V2.
 */
export async function editPrivatePanel(interaction: FeedbackInteraction, payload: MessageCreateOptions): Promise<void> {
  if (typeof payload.content === "string") {
    const options = { text: payload.content, allowedMentions: payload.allowedMentions, actionRows: payload.components, allowActionRows: true };
    if (!interaction.deferred && !interaction.replied) await completeFeedbackPrompt(interaction, options);
    else await editFeedback(interaction, options);
    return;
  }
  const compatible = { ...payload, content: null, embeds: [], attachments: [], flags: MessageFlags.IsComponentsV2 as const };
  if (!interaction.deferred && !interaction.replied && interaction.update) await interaction.update(compatible);
  else await interaction.editReply(compatible);
}
