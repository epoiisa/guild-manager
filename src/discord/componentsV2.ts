import {
  MessageFlags,
  type ActionRowBuilder,
  type MessageActionRowComponentBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  type MessageMentionOptions
} from "discord.js";
import { v2Message } from "./operationalMessages.js";

export interface ComponentsV2Field {
  label: string;
  value: string;
}

export interface ComponentsV2CardOptions {
  accentColor: number;
  title: string;
  /** Text shown before the card heading, for deliberate notification banners. */
  leadingText?: readonly string[];
  text?: readonly string[];
  fields?: readonly ComponentsV2Field[];
  footer?: string;
  actionRows?: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[];
  allowedMentions?: MessageMentionOptions;
  ephemeral?: boolean;
}

const SAFE_ALLOWED_MENTIONS: MessageMentionOptions = {
  parse: [],
  repliedUser: false
};

/**
 * Builds the shared operational presentation with bounded text and explicit
 * attachments for overflow. Specialized media cards retain their own layouts.
 */
export function buildComponentsV2Card(options: ComponentsV2CardOptions): MessageCreateOptions {
  return {
    ...v2Message({
      accentColor: options.accentColor,
      textBlocks: [
        ...options.leadingText ?? [], `# ${options.title}`, ...options.text ?? [],
        ...(options.fields ?? []).map(formatComponentsV2Field),
        ...options.footer ? [options.footer] : []
      ],
      actionRows: options.actionRows,
      allowedMentions: options.allowedMentions ?? SAFE_ALLOWED_MENTIONS
    }),
    flags: MessageFlags.IsComponentsV2 | (options.ephemeral ? MessageFlags.Ephemeral : 0)
  };
}

export function formatComponentsV2Field(field: ComponentsV2Field): string {
  return `**${field.label.replace(/:+$/, "")}**\n${field.value}`;
}

/** Converts a V2 create payload into an edit which clears legacy presentation. */
export function asComponentsV2Edit(message: MessageCreateOptions, retainAttachments = false): MessageEditOptions {
  return {
    ...message,
    content: null,
    embeds: [],
    ...(!retainAttachments ? { attachments: [] } : {}),
    flags: MessageFlags.IsComponentsV2
  };
}

/** Returns every custom ID found at any nesting depth in Discord component data. */
export function findNestedComponentCustomIds(components: unknown): Set<string> {
  const customIds = new Set<string>();
  const visited = new WeakSet<object>();

  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    const component = value as Record<string, unknown>;
    for (const key of ["customId", "custom_id"]) {
      if (typeof component[key] === "string") customIds.add(component[key]);
    }
    for (const key of ["components", "data", "items"]) inspect(component[key]);

    if (typeof component.toJSON === "function") {
      try {
        inspect(component.toJSON());
      } catch {
        // Inspection is compatibility-oriented; an unrelated malformed builder
        // must not prevent callers from checking the remaining components.
      }
    }
  };

  inspect(components);
  return customIds;
}

export function hasNestedComponentCustomId(components: unknown, customId: string): boolean {
  return findNestedComponentCustomIds(components).has(customId);
}

export function messageHasNestedComponentCustomId(message: { components?: unknown }, customId: string): boolean {
  return hasNestedComponentCustomId(message.components, customId);
}
