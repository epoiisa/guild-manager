import assert from "node:assert/strict";
import test from "node:test";
import { ComponentType, ContainerBuilder, type APIButtonComponentWithCustomId, type APIMessageTopLevelComponent } from "discord.js";
import { buildComposedMessage } from "./composedMessage.js";
import { mergeEntryButtonComponents, removeEntryButtonComponents } from "./entryButtons.js";
import { findNestedComponentCustomIds } from "./componentsV2.js";
import { handleApplicationsCommand } from "../commands/application.js";
import { handleTicketsCommand } from "../commands/ticket.js";

const button = (id: string, label = id): APIButtonComponentWithCustomId => ({ type: ComponentType.Button, style: 1, custom_id: id, label });
const row = (...ids: string[]): APIMessageTopLevelComponent => ({ type: ComponentType.ActionRow, components: ids.map((id) => button(id)) });
const stored = (components: APIMessageTopLevelComponent[]) => components.map((component) => ({ toJSON: () => structuredClone(component) }));
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const host = () => json(buildComposedMessage("# Entry information", 0x64748b, "poster.png").components) as APIMessageTopLevelComponent[];

test("entry buttons share the bottom of the V2 container and replacement removes only the selected duplicate", () => {
  const original = host();
  const first = mergeEntryButtonComponents(stored(original), button("app:open:1"))!;
  const second = mergeEntryButtonComponents(stored(first), button("ticket:open:2"))!;
  const replacement = mergeEntryButtonComponents(stored([...second, row("app:open:1", "unrelated")]), button("app:open:1", "Apply now"))!;
  assert.equal(first.length, 1);
  const container = replacement[0];
  assert.equal(container.type, ComponentType.Container);
  if (container.type !== ComponentType.Container) return;
  assert.deepEqual(container.components.slice(0, 2), (original[0] as any).components);
  assert.deepEqual(container.components.at(-1), { type: ComponentType.ActionRow, components: [button("ticket:open:2"), button("app:open:1", "Apply now")] });
  assert.deepEqual(replacement[1], row("unrelated"));
  assert.deepEqual([...findNestedComponentCustomIds(replacement)], ["ticket:open:2", "app:open:1", "unrelated"]);
  assert.equal((original[0] as any).components.length, 2);
});

test("entry button removal preserves the container, accent, attachment gallery and unrelated controls", () => {
  const source = host();
  (source[0] as any).components.push(row("app:open:1"), row("ticket:open:2"));
  const removed = removeEntryButtonComponents(stored(source), "app:open:1");
  assert.deepEqual((removed[0] as any).components, [...(host()[0] as any).components, row("ticket:open:2")]);
  assert.equal((removed[0] as any).accent_color, 0x64748b);
  assert.deepEqual(removeEntryButtonComponents(stored(removed), "not-present"), removed);
  assert.deepEqual(removeEntryButtonComponents(stored(removed), "ticket:open:2"), host());
});

test("legacy hosts fill existing button rows, preserve unrelated rows and enforce the five-row limit", () => {
  const original = [row("first"), row("second")];
  assert.deepEqual(mergeEntryButtonComponents(stored(original), button("new")), [row("first", "new"), row("second")]);
  const full = Array.from({ length: 5 }, (_, index) => row(...Array.from({ length: 5 }, (_, buttonIndex) => `${index}:${buttonIndex}`)));
  assert.equal(mergeEntryButtonComponents(stored(full), button("overflow")), undefined);
  assert.ok(mergeEntryButtonComponents(stored(full), button("0:0", "Updated")));
});

test("V2 buttons enforce the whole-message component budget including nested buttons", () => {
  const source = host();
  for (let index = 0; index < 6; index++) (source[0] as any).components.push(row(...Array.from({ length: 5 }, (_, child) => `${index}:${child}`)));
  assert.equal(mergeEntryButtonComponents(stored(source), button("overflow")), undefined);
  assert.ok(mergeEntryButtonComponents(stored(source), button("5:4", "Updated")));
  const crowded = host();
  for (let index = 0; index < 8; index++) (crowded[0] as any).components.push({ type: ComponentType.Separator });
  assert.equal(mergeEntryButtonComponents(stored(crowded), button("overflow")), undefined);
});

test("entry button attachment rejects ambiguous multiple containers without modifying them", () => {
  const source = [...host(), ...host()];
  const original = json(source);
  assert.equal(mergeEntryButtonComponents(stored(source), button("app:open:1")), undefined);
  assert.deepEqual(source, original);
});

test("replacing the last button in a button-only container preserves other top-level buttons", () => {
  const source: APIMessageTopLevelComponent[] = [{ type: ComponentType.Container, accent_color: 1, components: [row("app:open:1") as any] }, row("unrelated", "app:open:1")];
  const result = mergeEntryButtonComponents(stored(source), button("app:open:1", "Changed"))!;
  assert.deepEqual(result[1], row("unrelated"));
  assert.equal((result[0] as any).components[0].components[0].label, "Changed");
});

test("both real entry commands attach and update within one composed container", async () => {
  const components = host();
  const edits: any[] = [];
  const configurations: any[] = [];
  const message: any = {
    id: "host", url: "https://discord.com/channels/guild/channel/host", author: { id: "bot" },
    components: stored(components),
    edit: async (payload: any) => { edits.push(payload); message.components = stored(payload.components); return message; }
  };
  const channel = { id: "channel", messages: { fetch: async () => message } };
  let label = "Apply";
  const interaction: any = {
    inGuild: () => true, guildId: "guild", client: { user: { id: "bot" } },
    options: { getSubcommandGroup: () => "button", getSubcommand: () => "add", getChannel: () => channel,
      getString: (name: string) => ({ application: "application", ticket: "ticket", id: "host", style: "primary", label })[name] },
    reply: async () => undefined, deferReply: async () => undefined, editReply: async () => undefined
  };
  const application = { applicationClassId: "application", name: "Membership" };
  const applications: any = {
    getApplicationClass: async () => application,
    configureApplicationButton: async (...args: any[]) => { configurations.push(args); return application; }
  };
  const tickets: any = {
    getTicketClass: async () => ({ ticketClassId: "ticket", name: "Help" }),
    configureTicketButton: async (...args: any[]) => { configurations.push(args); }
  };
  await handleApplicationsCommand(interaction, applications, {} as any);
  label = "Help";
  await handleTicketsCommand(interaction, tickets);
  label = "Join us";
  await handleApplicationsCommand(interaction, applications, {} as any);
  assert.equal(configurations.length, 3);
  assert.deepEqual(configurations[0].slice(0, 4), ["guild", "application", "channel", "host"]);
  assert.deepEqual(configurations[1].slice(0, 4), ["guild", "ticket", "channel", "host"]);
  const final = edits.at(-1);
  assert.equal(final.components.length, 1);
  assert.deepEqual(final.components[0].components.slice(0, 2), (components[0] as any).components);
  assert.deepEqual([...findNestedComponentCustomIds(final)], ["ticket:open:ticket", "app:open:application"]);
  assert.equal(final.components[0].components.at(-1).components.at(-1).label, "Join us");
  assert.ok(edits.every((edit) => JSON.stringify(edit.allowedMentions) === JSON.stringify({ parse: [], repliedUser: false })));
  // Validate the same nested payload through the installed Discord builder.
  new ContainerBuilder(final.components[0]).toJSON();
});
