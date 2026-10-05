import { createHash } from "node:crypto";
import {
  AttachmentBuilder,
  ComponentType,
  ContainerBuilder,
  FileBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type ContainerComponentBuilder,
  type BaseMessageOptions,
  type InteractionReplyOptions,
  type MessageEditOptions,
  type MessageMentionOptions
} from "discord.js";
import { TAILWIND_500_COLORS } from "./tailwindColors.js";

export const V2_TEXT_LIMIT = 4_000;
export const V2_COMPONENT_LIMIT = 40;
// The current Discord reference sets a 40-component message budget, including
// nested components. Container children have no separate documented maximum.
const CONTAINER_CHILD_LIMIT = V2_COMPONENT_LIMIT - 1;

/** Explicit presentation input for the bot's existing text/field card models.
 * This adapter is called at reviewed response boundaries, never installed on
 * Discord send methods. Officer posts and historical edits do not use it.
 */
export interface OperationalMessage {
  cards?: BaseMessageOptions["embeds"];
  text?: string | null;
  textBlocks?: readonly string[];
  actionRows?: BaseMessageOptions["components"];
  files?: BaseMessageOptions["files"];
  allowedMentions?: MessageMentionOptions;
  accentColor?: number;
  flags?: number;
}

export class OperationalMessageLayoutError extends Error {
  constructor(message: string) { super(message); this.name = "OperationalMessageLayoutError"; }
}

/** A new channel message. An explicit accent is required even for text-only output. */
export function v2Message(options: OperationalMessage) {
  const texts: string[] = [...(options.text ? [options.text] : []), ...(options.textBlocks ?? [])];
  let accent = options.accentColor;
  for (const model of options.cards ?? []) {
    const card = "toJSON" in model ? model.toJSON() : model;
    // These fields are absent from current operational models. A future caller
    // must add an explicit layout for them instead of silently losing content.
    if (card.author || card.image || card.thumbnail || card.video || card.provider || card.url || card.footer?.icon_url) {
      throw new OperationalMessageLayoutError("This operational card requires an explicit media or author layout.");
    }
    accent ??= card.color;
    if (card.title) texts.push(`# ${card.title}`);
    if (card.description) texts.push(card.description);
    for (const field of card.fields ?? []) texts.push(`**${field.name.replace(/:+$/, "")}**\n${field.value}`);
    if (card.footer?.text) texts.push(card.footer.text);
    if (card.timestamp) texts.push(`<t:${Math.floor(new Date(card.timestamp).getTime() / 1000)}:F>`);
  }
  const container = new ContainerBuilder().setAccentColor(accent ?? TAILWIND_500_COLORS.Slate);
  const rows = (options.actionRows ?? []).map(component => {
    const json = "toJSON" in component ? component.toJSON() : component;
    if (json.type !== ComponentType.ActionRow) throw new OperationalMessageLayoutError("Operational controls must be action rows.");
    return json as APIActionRowComponent<APIComponentInMessageActionRow>;
  });
  const files = [...(options.files ?? [])];
  const names = files.map(file => {
    if (typeof file === "object" && file !== null && "name" in file && typeof file.name === "string") return file.name;
    throw new OperationalMessageLayoutError("An operational file must have an explicit filename.");
  });
  let visible = texts;
  if (texts.join("\n\n").length > V2_TEXT_LIMIT) {
    let filename = "response.md";
    for (let suffix = 2; names.includes(filename); suffix++) filename = `response-${suffix}.md`;
    files.push(new AttachmentBuilder(Buffer.from(texts.join("\n\n"), "utf8"), { name: filename }));
    names.push(filename);
    visible = overflowSummary(texts, options.allowedMentions);
  }
  const textSlots = CONTAINER_CHILD_LIMIT - rows.length - names.length;
  if (textSlots < (visible.length ? 1 : 0)) throw new OperationalMessageLayoutError("The operational message has too many controls or files.");
  // Preserve separate fields when they fit; combine adjacent text blocks when
  // required by the Container child budget without omitting any text.
  if (visible.length > textSlots) visible = [visible.join("\n\n")];
  for (const text of visible) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  for (const name of names) container.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
  for (const row of rows) container.addActionRowComponents(row);
  if (!container.components.length) throw new OperationalMessageLayoutError("An operational message must have visible content.");
  const componentCount = 1 + container.components.length + rows.reduce((count, row) => count + row.components.length, 0);
  if (componentCount > V2_COMPONENT_LIMIT) throw new OperationalMessageLayoutError("The operational message exceeds the component budget.");
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [], repliedUser: false, ...options.allowedMentions } as MessageMentionOptions,
    ...(files.length ? { files } : {})
  };
}

function overflowSummary(texts: readonly string[], mentions?: MessageMentionOptions): string[] {
  const heading = texts.find(text => text.startsWith("# "))?.split("\n")[0];
  // Only repeat recipients already present in the original body and explicitly
  // allowed to notify. Report mentions remain silent; downloads cannot notify.
  const recipients = [...new Set(texts.join("\n").match(/<@!?[^>]+>|<@&[^>]+>/g) ?? [])].filter(token => {
    const role = token.startsWith("<@&");
    const id = token.slice(role || token.startsWith("<@!") ? 3 : 2, -1);
    return (role ? mentions?.roles : mentions?.users)?.includes(id);
  });
  const summary = [...(heading && heading.length < 500 ? [heading] : []), "The complete response is attached.", ...(recipients.length ? [recipients.join(" ")] : [])];
  if (summary.join("\n\n").length > V2_TEXT_LIMIT) throw new OperationalMessageLayoutError("The notification recipients exceed the visible message budget.");
  return summary;
}

/** Budget an explicitly authored text/media/control layout at its renderer.
 * Keep established layouts when they fit. Oversized text is preserved in full
 * in a File component; images and controls stay in their original order.
 */
export function boundedV2Container(container: ContainerBuilder, options: {
  allowedMentions?: MessageMentionOptions;
  overflowName: string;
  versioned?: boolean;
  summaryText?: readonly string[];
}) {
  const texts = container.components.filter((child): child is TextDisplayBuilder => child instanceof TextDisplayBuilder).map(child => child.data.content!);
  let result = container;
  const files: AttachmentBuilder[] = [];
  if (texts.join("\n\n").length > V2_TEXT_LIMIT) {
    const fullText = texts.join("\n\n");
    const filename = options.versioned ? options.overflowName.replace(/\.md$/, `-${createHash("sha256").update(fullText).digest("hex").slice(0, 12)}.md`) : options.overflowName;
    files.push(new AttachmentBuilder(Buffer.from(fullText, "utf8"), { name: filename }));
    result = new ContainerBuilder(container.data);
    const summary = options.summaryText ? [...options.summaryText, "The complete response is attached."] : overflowSummary(texts, options.allowedMentions);
    if (summary.join("\n\n").length > V2_TEXT_LIMIT) throw new OperationalMessageLayoutError("The authored overflow summary exceeds the message budget.");
    result.addTextDisplayComponents(...summary.map(text => new TextDisplayBuilder().setContent(text)));
    result.addFileComponents(new FileBuilder().setURL(`attachment://${filename}`));
    result.components.push(...container.components.filter(child => !(child instanceof TextDisplayBuilder)));
  }
  const count = (children: readonly ContainerComponentBuilder[]): number => children.reduce((n, child) => n + 1 + ("components" in child ? child.components.length : 0), 0);
  if (1 + count(result.components) > V2_COMPONENT_LIMIT) {
    // Coalesce adjacent text only; controls/media retain their placement.
    const compact = new ContainerBuilder(result.data);
    for (const child of result.components) {
      const previous = compact.components.at(-1);
      if (child instanceof TextDisplayBuilder && previous instanceof TextDisplayBuilder) {
        previous.setContent(`${previous.data.content}\n\n${child.data.content}`);
      } else compact.components.push(child);
    }
    result = compact;
  }
  if (1 + count(result.components) > V2_COMPONENT_LIMIT) throw new OperationalMessageLayoutError("The authored layout exceeds the component budget.");
  result.toJSON(); // Validate individual components as well as the message budget.
  return { components: [result], flags: MessageFlags.IsComponentsV2 as const,
    allowedMentions: { parse: [], repliedUser: false, ...options.allowedMentions } as MessageMentionOptions,
    ...(files.length ? { files } : {}) };
}

/** Initial replies and independent follow-ups preserve explicitly requested privacy. */
export function v2Reply(options: OperationalMessage) {
  return {
    ...v2Message(options),
    flags: (MessageFlags.IsComponentsV2 | (options.flags ?? 0)) as NonNullable<InteractionReplyOptions["flags"]>
  };
}

/** Replace an operational response, including a retained legacy prompt.
 * Ephemeral state belongs to the original acknowledgement. Old report files
 * are replaced too; evidence-card edits use their domain-specific renderers.
 */
export function v2Edit(options: OperationalMessage) {
  return {
    ...v2Message(options),
    content: null,
    embeds: [],
    attachments: [] as NonNullable<MessageEditOptions["attachments"]>
  };
}
