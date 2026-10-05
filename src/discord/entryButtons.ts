import {
  ComponentType, type APIButtonComponentWithCustomId, type APIComponentInContainer,
  type APIMessageTopLevelComponent
} from "discord.js";

type Component = APIMessageTopLevelComponent | APIComponentInContainer;
type StoredComponent = { toJSON(): APIMessageTopLevelComponent };

/** Removes only the selected entry button, including rows inside V2 Containers. */
export function removeEntryButtonComponents(existing: readonly StoredComponent[], customId: string): APIMessageTopLevelComponent[] {
  return removeFromComponents(existing.map((component) => component.toJSON()), customId) as APIMessageTopLevelComponent[];
}

function removeFromComponents(components: readonly Component[], customId: string, keepContainers = false): Component[] {
  return components.flatMap<Component>((component) => {
    if (component.type === ComponentType.Container) {
      const children = removeFromComponents(component.components, customId) as APIComponentInContainer[];
      return children.length || keepContainers ? [{ ...component, components: children }] : [];
    }
    if (component.type !== ComponentType.ActionRow) return [component];
    const children = component.components.filter((child) => !("custom_id" in child) || child.custom_id !== customId);
    return children.length ? [{ ...component, components: children }] : [];
  });
}

/** One-container hosts own their entry rows. Ambiguous multi-container hosts are rejected. */
export function mergeEntryButtonComponents(existing: readonly StoredComponent[], button: APIButtonComponentWithCustomId): APIMessageTopLevelComponent[] | undefined {
  const original = existing.map((component) => component.toJSON());
  const containers = original.filter((component) => component.type === ComponentType.Container);
  if (containers.length > 1) return;
  const container = containers[0];
  // Keep a button-only container available when replacing its last button.
  const cleaned = removeFromComponents(original, button.custom_id, true) as APIMessageTopLevelComponent[];
  let result: APIMessageTopLevelComponent[];
  if (container) {
    const children = removeFromComponents(container.components, button.custom_id) as APIComponentInContainer[];
    const updated = addToRows(children, button);
    if (updated.length > 10) return;
    const replacement = { ...container, components: updated as APIComponentInContainer[] };
    result = cleaned.map((component) => component.type === ComponentType.Container ? replacement : component);
  } else {
    result = addToRows(cleaned, button, false) as APIMessageTopLevelComponent[];
    // Legacy messages retain Discord's five-row limit.
    if (original.every((component) => component.type === ComponentType.ActionRow) && result.length > 5) return;
  }
  return countMessageComponents(result) <= 40 ? result : undefined;
}

function addToRows(components: readonly Component[], button: APIButtonComponentWithCustomId, trailingOnly = true): Component[] {
  // Append at the bottom, reusing only a trailing button row so media stays above controls.
  const index = components.findIndex((component, index) => (!trailingOnly || index === components.length - 1)
    && component.type === ComponentType.ActionRow && component.components.length < 5
    && component.components.every((child) => child.type === ComponentType.Button));
  const row = components[index];
  if (row?.type === ComponentType.ActionRow) {
    return components.map((component, candidate) => candidate === index ? { ...row, components: [...row.components, button] } : component);
  }
  return [...components, { type: ComponentType.ActionRow, components: [button] }];
}

export function countMessageComponents(components: readonly Component[]): number {
  return components.reduce((count, component) => count + 1
    + ("components" in component ? countMessageComponents(component.components as Component[]) : 0)
    + ("accessory" in component ? 1 : 0), 0);
}
