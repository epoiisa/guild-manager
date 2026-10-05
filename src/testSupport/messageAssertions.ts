import { ComponentType, MessageFlags, type APIEmbed } from "discord.js";
import assert from "node:assert/strict";

/** Inspect the actual serialized Discord payload, including nested controls. */
export function messageJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

export function messageNodes(value: unknown, type?: number): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "number" && (type === undefined || node.type === type)) found.push(node);
    for (const child of node.components ?? []) visit(child);
  };
  visit(messageJson(value));
  return found;
}

export function assertV2Message(value: unknown): any {
  const json = messageJson(value);
  assert.ok((json.flags & MessageFlags.IsComponentsV2) !== 0, "message must set IsComponentsV2");
  assert.equal(json.content ?? null, null, "V2 text belongs inside the Container");
  assert.deepEqual(json.embeds ?? [], [], "classic embeds must not be sent");
  assert.equal(json.components.length, 1, "one operational Container");
  assert.equal(json.components[0].type, ComponentType.Container);
  assert.equal(typeof json.components[0].accent_color, "number", "explicit accent");
  assert.ok(messageNodes(json).length <= 40);
  assert.ok(messageNodes(json, ComponentType.TextDisplay).reduce((n, node) => n + node.content.length, 0) <= 4000);
  return json;
}

export function assertStandardMessage(value: unknown): any {
  const json = messageJson(value);
  assert.equal((json.flags ?? 0) & MessageFlags.IsComponentsV2, 0, "standard messages must not set IsComponentsV2");
  assert.equal(typeof json.content, "string");
  assert.ok(json.content.length > 0 && json.content.length <= 2000);
  assert.doesNotMatch(json.content, /[\r\n\u2028\u2029]/u);
  assert.deepEqual(json.embeds ?? [], []);
  assert.ok((json.flags & MessageFlags.SuppressEmbeds) !== 0, "receipt previews must be suppressed");
  for (const component of json.components ?? []) assert.equal(component.type, ComponentType.ActionRow);
  return json;
}

/** Read either explicitly supported format without weakening the V2 assertions. */
export function messageText(value: unknown): string {
  const json = messageJson(value);
  return typeof json.content === "string" ? assertStandardMessage(json).content : v2Text(json);
}
export function messageDescription(value: unknown): string {
  const json = messageJson(value);
  return typeof json.content === "string" ? assertStandardMessage(json).content : v2Description(json);
}
export function messageSummary(value: unknown): string {
  const json = messageJson(value);
  return typeof json.content === "string" ? assertStandardMessage(json).content : v2Title(json);
}
export function messageTexts(value: unknown): string[] {
  const json = messageJson(value);
  return typeof json.content === "string" ? [assertStandardMessage(json).content] : v2Texts(json);
}

export function assertFeedbackCard(value: unknown, expected: APIEmbed, context = false): void {
  assert.equal(assertStandardMessage(value).content, context ? `${expected.title}: ${expected.description}` : expected.description);
}
export function messageRows(value: unknown): any[] {
  const json = messageJson(value);
  if (typeof json.content === "string") assertStandardMessage(json); else assertV2Message(json);
  return messageNodes(json, ComponentType.ActionRow);
}

export function v2Texts(value: unknown): string[] {
  return messageNodes(assertV2Message(value), ComponentType.TextDisplay).map(node => node.content);
}
export function v2Text(value: unknown): string { return v2Texts(value).join("\n\n"); }
export function v2Title(value: unknown): string { const title = v2Texts(value).find(text => text.startsWith("# "))?.split("\n")[0].slice(2); assert.equal(typeof title, "string"); return title!; }
export function v2Description(value: unknown): string { const description = v2Texts(value)[1]; assert.equal(typeof description, "string"); return description; }
export function v2Accent(value: unknown): number { return assertV2Message(value).components[0].accent_color; }
export function v2Rows(value: unknown): any[] { return messageNodes(assertV2Message(value), ComponentType.ActionRow); }

/** Compare preserved content against the independently specified card wording. */
export function assertV2Card(value: unknown, expected: APIEmbed): void {
  assert.equal(v2Accent(value), expected.color);
  const texts = [
    ...(expected.title ? [`# ${expected.title}`] : []),
    ...(expected.description ? [expected.description] : []),
    ...(expected.fields ?? []).map(field => `**${field.name.replace(/:+$/, "")}**\n${field.value}`),
    ...(expected.footer?.text ? [expected.footer.text] : [])
  ];
  assert.equal(v2Text(value), texts.join("\n\n"));
}

export function assertV2Fields(value: unknown, fields: NonNullable<APIEmbed["fields"]>): void {
  const text = v2Text(value);
  let previous = -1;
  for (const field of fields) {
    const index = text.indexOf(`**${field.name.replace(/:+$/, "")}**\n${field.value}`, previous + 1);
    assert.ok(index > previous, `field ${field.name} must appear with its full value in order`);
    previous = index;
  }
}
