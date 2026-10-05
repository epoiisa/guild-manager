import {
  ComponentType, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, TextDisplayBuilder, type APIContainerComponent, type Message,
  type MessageCreateOptions
} from "discord.js";
import { countMessageComponents } from "./entryButtons.js";

export const COMPOSED_MESSAGE_MAX_LENGTH = 4000;
// Persisted Discord component IDs identify this editable format across restarts.
// They are deliberately outside the automatically assigned IDs of operational cards.
const CONTAINER_ID = 0x474d01;

export function buildComposedMessage(text: string, color: number, imageName?: string): MessageCreateOptions {
  const container = new ContainerBuilder().setId(CONTAINER_ID).setAccentColor(color);
  if (text) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  if (imageName) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(`attachment://${imageName}`)
  ));
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: ["users", "roles", "everyone"] }
  };
}

export function readComposedMessage(message: Message): { container: APIContainerComponent; text: string } | undefined {
  if (!message.flags.has(MessageFlags.IsComponentsV2) || message.components.length !== 1) return;
  if (typeof message.components[0].toJSON !== "function") return;
  const container = message.components[0].toJSON();
  if (container.type !== ComponentType.Container || container.id !== CONTAINER_ID) return;
  let text = "";
  let hasText = false;
  let hasImage = false;
  let hasButtons = false;
  for (const component of container.components) {
    if (component.type === ComponentType.TextDisplay) {
      if (hasText || hasImage || hasButtons || component.content.length > COMPOSED_MESSAGE_MAX_LENGTH) return;
      text = component.content;
      hasText = true;
    } else if (component.type === ComponentType.MediaGallery) {
      if (hasImage || hasButtons || component.items.length !== 1) return;
      hasImage = true;
    } else if (component.type === ComponentType.ActionRow && component.components.every((child) => child.type === ComponentType.Button)) {
      hasButtons = true;
    } else return;
  }
  return hasText || hasImage ? { container, text } : undefined;
}

export function replaceComposedMessageText(container: APIContainerComponent, text: string): APIContainerComponent | undefined {
  const remaining = container.components.filter((component) => component.type !== ComponentType.TextDisplay);
  const current = container.components.find((component) => component.type === ComponentType.TextDisplay);
  const updated: APIContainerComponent = {
    ...container,
    components: text ? [{ type: ComponentType.TextDisplay, ...current, content: text }, ...remaining] : remaining
  };
  return updated.components.length <= 10 && countMessageComponents([updated]) <= 40 ? updated : undefined;
}
