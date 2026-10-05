import { ChannelType, ComponentType, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationClassSnapshot, ConversationKind } from "../db/conversationClassRemovalRepository.js";
import { findNestedComponentCustomIds } from "../discord/componentsV2.js";
import type { Logger } from "../logging/logger.js";
import { handleApplicationAutocomplete, handleApplicationsCommand } from "./application.js";
import { handleConversationClassRemovalButton } from "./conversationClassRemoval.js";
import { handleTicketButton, handleTicketsCommand } from "./ticket.js";

for (const kind of ["application", "ticket"] as const) {
  const confirmationText = [
    `# Remove ${kind === "application" ? "Application" : "Ticket"} Class?`,
    `Permanently remove the **Support** class, all its ${kind} records, and all its remaining channels, including their messages and attachments. This cannot be undone.`
  ];

  test(`${kind} disable still preserves the class and conversations without a removal confirmation`, async () => {
    const f = fixture(kind, ["open", "closed"]);
    f.command.options.getSubcommand = () => "disable";
    f.command.reply = f.command.editReply;
    f.applications.getApplicationClass = async () => ({ applicationClassId: "42", name: "Support" });
    f.tickets.getTicketClass = async () => ({ ticketClassId: "42", name: "Support" });
    const disable = async () => { f.enabled = false; };
    f.applications.setApplicationEnabled = disable;
    f.tickets.setTicketEnabled = disable;
    await f.begin();
    assert.equal(f.enabled, false);
    assert.equal(f.snapshot?.conversations.length, 2);
    assert.equal(f.channels.size, 2);
    assert.match(f.text(), /was disabled/);
    assert.equal(findNestedComponentCustomIds(f.edits.at(-1)).size, 0);
  });

  test(`${kind} removal with only history shows the concise warning and removes on confirmation`, async () => {
    const f = fixture(kind, ["deleted"]);
    await f.begin();
    assert.deepEqual(f.textDisplays(), confirmationText);
    assert.deepEqual(f.events, ["deferReply"]);
    assert.equal(f.deferFlags, MessageFlags.Ephemeral);
    await f.confirm();
    assert.equal(f.snapshot, undefined);
    assert.match(f.text(), /1 .* record\(s\) and 0 channel/);
    assert.deepEqual(f.events, ["deferReply", "deferUpdate", "disable", "purge"]);
  });

  test(`${kind} confirmation deletes open and closed channels before records and preserves shared entry buttons`, async () => {
    const f = fixture(kind, ["open", "closed", "deleted"]);
    f.addEntry();
    await f.begin();
    assert.deepEqual(f.textDisplays(), confirmationText);
    await f.confirm();
    assert.equal(f.snapshot, undefined);
    assert.deepEqual(f.events.slice(2), ["disable", "delete:channel-0", "mark:0", "delete:channel-1", "mark:1", "entry", "purge"]);
    assert.deepEqual([...findNestedComponentCustomIds(f.entryEdit)], ["unrelated:button"]);
    assert.match(f.text(), /3 .* record\(s\) and 2 channel/);
    assert.equal(findNestedComponentCustomIds(f.edits.at(-1)).size, 0);
  });

  test(`${kind} cancellation consumes the confirmation and never mutates the class`, async () => {
    const f = fixture(kind, ["open"]);
    await f.begin();
    const confirm = f.button("confirm");
    await f.click(f.button("cancel"));
    await f.click(confirm);
    assert.equal(f.snapshot?.conversations[0].status, "open");
    assert.deepEqual(f.events, ["deferReply"]);
    assert.match(f.text(), /Class removal cancelled\. Nothing was changed/s);
    assert.match(JSON.stringify(f.replies), /Class removal confirmation expired/);
  });

  test(`${kind} removal cleans its nested entry button and preserves the composed message`, async () => {
    const f = fixture(kind, []);
    f.addEntry(true);
    await f.begin();
    await f.confirm();
    assert.deepEqual([...findNestedComponentCustomIds(f.entryEdit)], ["unrelated:button"]);
    assert.equal(f.entryEdit.components[0].accent_color, 0x009688);
    assert.equal(f.entryEdit.components[0].components[0].content, "Keep this message");
    assert.equal(f.entryEdit.components[0].components[1].items[0].media.url, "attachment://keep.png");
    assert.deepEqual(f.entryEdit.allowedMentions, { parse: [], repliedUser: false });
    assert.equal(f.snapshot, undefined);
  });

  test(`${kind} confirms only for its initiator and Discord server`, async () => {
    const f = fixture(kind, ["open"]);
    await f.begin();
    await f.click({ ...f.button("confirm"), user: { id: "someone-else" } });
    await f.click({ ...f.button("confirm"), guildId: "another-guild" });
    assert.equal(f.snapshot?.conversations[0].status, "open");
    assert.deepEqual(f.events, ["deferReply"]);
    assert.equal(f.replies.length, 2);
    await f.confirm();
    assert.equal(f.snapshot, undefined);
  });

  test(`${kind} expired confirmation leaves records and channels intact`, async (t) => {
    const f = fixture(kind, ["open"]);
    const now = Date.now();
    await f.begin();
    t.mock.method(Date, "now", () => now + 16 * 60_000);
    await f.confirm();
    assert.match(f.text(), /Class removal confirmation expired/);
    assert.deepEqual(f.events, ["deferReply"]);
    assert.equal(f.snapshot?.conversations[0].status, "open");
  });

  test(`${kind} changed conversation state refreshes the warning and requires another confirmation`, async () => {
    const f = fixture(kind, ["closed"]);
    await f.begin();
    f.snapshot!.conversations[0].status = "open";
    await f.confirm();
    assert.deepEqual(f.textDisplays(), [
      confirmationText[0],
      "The class or its conversations changed. Review the removal warning and confirm again.",
      confirmationText[1]
    ]);
    assert.deepEqual(f.events, ["deferReply", "deferUpdate"]);
    await f.confirm();
    assert.equal(f.snapshot, undefined);
  });

  test(`${kind} missing channels succeed but access failures retain disabled class for retry`, async () => {
    const f = fixture(kind, ["open", "closed"]);
    f.channels.delete("channel-0");
    f.channelFailures.add("channel-1");
    await f.begin();
    await f.confirm();
    assert.match(f.text(), /Class Removal Incomplete.*remains disabled/s);
    assert.equal(f.enabled, false);
    assert.deepEqual(f.snapshot?.conversations.map((record) => record.status), ["deleted", "closed"]);
    assert.ok(!f.events.includes("purge"));
    f.channelFailures.clear();
    await f.begin();
    await f.confirm();
    assert.equal(f.snapshot, undefined);
    assert.equal(f.events.filter((event) => event === "delete:channel-1").length, 1);
  });

  test(`${kind} concurrent confirmation clicks delete each channel once`, async () => {
    const f = fixture(kind, ["open"]);
    await f.begin();
    const button = f.button("confirm");
    await Promise.all([f.click(button), f.click({ ...button })]);
    assert.equal(f.events.filter((event) => event === "delete:channel-0").length, 1);
    assert.equal(f.events.filter((event) => event === "purge").length, 1);
  });

  test(`${kind} entry-message failure reports the obsolete button after successful removal`, async () => {
    const f = fixture(kind, []);
    f.addEntry();
    f.channelFailures.add("entry-channel");
    await f.begin();
    await f.confirm();
    assert.equal(f.snapshot, undefined);
    assert.match(f.text(), /entry button could not be removed.*can no longer open/s);
  });

  test(`${kind} a Discord delete failure does not mark or purge the conversation`, async () => {
    const f = fixture(kind, ["open"]);
    f.channels.get("channel-0").delete = async () => { throw Object.assign(new Error("Missing permissions"), { code: 50013 }); };
    await f.begin();
    await f.confirm();
    assert.equal(f.snapshot?.conversations[0].status, "open");
    assert.equal(f.enabled, false);
    assert.ok(!f.events.includes("mark:0"));
    assert.ok(!f.events.includes("purge"));
  });

  for (const step of ["disable", "remove"] as const) {
    test(`${kind} ${step} failure retains records and logs the underlying error`, async () => {
      const f = fixture(kind, ["open"]);
      const error = Object.assign(new Error("Database write failed"), { code: "XX001" });
      f.applications.classRemoval[step] = async () => { throw error; };
      await f.begin();
      await f.confirm();
      assert.match(f.text(), /Class Removal Incomplete/);
      assert.equal(f.snapshot?.conversations[0].status, step === "disable" ? "open" : "deleted");
      assert.equal(f.channels.size, step === "disable" ? 1 : 0);
      assert.equal(f.enabled, step === "disable");
      assert.deepEqual(f.logs, [{ message: "conversation class removal failed", context: {
        discordGuildId: "guild", conversationKind: kind, classId: "42",
        error: error.message, errorType: "Error", errorCode: "XX001", errorStack: error.stack
      } }]);
    });
  }
}

test("application removal autocomplete identifies archived classes and preserves their exact IDs", async () => {
  const choices: unknown[] = [];
  const calls: unknown[] = [];
  await handleApplicationAutocomplete({ commandName: "applications", guildId: "guild", options: {
    getSubcommand: () => "remove", getFocused: () => ({ name: "application", value: "support" })
  }, respond: async (values: unknown) => { choices.push(values); } } as any, {
    listApplicationClasses: async (...args: unknown[]) => { calls.push(args); return [{ applicationClassId: "123", name: "Support", enabled: false, archivedAt: new Date() }]; }
  } as any, {} as any);
  assert.deepEqual(calls, [["guild", true]]);
  assert.deepEqual(choices, [[{ name: "Archived • Support", value: "123" }]]);
});

for (const entitlement of ["none", "application", "membership"] as const) {
  test(`application removal reconciles temporary role with ${entitlement} remaining entitlement`, async () => {
    const f = fixture("application", ["open"]);
    f.snapshot!.activeRoleId = "active-role";
    f.requiredByApplication = entitlement === "application";
    f.qualifiedByMembership = entitlement === "membership";
    await f.begin();
    await f.confirm();
    assert.equal(f.events.includes("role:active-role"), entitlement === "none");
    assert.equal(f.snapshot, undefined);
  });
}

test("application role cleanup failure keeps records so a retry can finish", async () => {
  const f = fixture("application", ["open"]);
  f.snapshot!.activeRoleId = "active-role";
  f.roleFailure = true;
  await f.begin();
  await f.confirm();
  assert.equal(f.snapshot?.conversations[0].status, "deleted");
  assert.match(f.text(), /Class Removal Incomplete/);
  f.roleFailure = false;
  await f.begin();
  await f.confirm();
  assert.equal(f.snapshot, undefined);
  assert.equal(f.events.filter((event) => event === "delete:channel-0").length, 1);
});

test("ticket removal waits for in-flight channel provisioning and refreshes its preview", async () => {
  const f = fixture("ticket", []);
  let release!: () => void;
  let creating!: () => void;
  const creationStarted = new Promise<void>((resolve) => { creating = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.guild.channels.create = async () => { creating(); await gate; return f.addChannel("new-channel"); };
  f.tickets.getTicketClass = async () => f.enabled ? { ticketClassId: "42", name: "Support", enabled: true, reviewerRoleId: "reviewer" } : undefined;
  f.tickets.createTicket = async () => {
    f.snapshot!.conversations.push({ id: "new", userId: "member", status: "open" });
    return { ticketId: "new", ticketClassId: "42", openerDiscordUserId: "member", status: "open" };
  };
  f.tickets.setTicketChannel = async (_guild: string, _id: string, channel: string) => { f.snapshot!.conversations[0].channelId = channel; };
  f.tickets.setTicketControlMessageId = async () => undefined;
  const opening = handleTicketButton({ ...f.command, customId: "ticket:open:42", inCachedGuild: () => true, user: { id: "member", username: "Member" }, editReply: async () => undefined } as any, f.tickets);
  await creationStarted;
  await f.begin();
  const removing = f.confirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.enabled, true);
  assert.ok(!f.events.includes("purge"));
  release();
  await opening;
  await removing;
  assert.match(f.text(), /removal warning/);
  await f.confirm();
  assert.equal(f.snapshot, undefined);
  assert.ok(f.events.includes("delete:new-channel"));
});

for (const failure of [undefined, "receipt", "cleanup"] as const) {
  test(`class removal consumes its confirmation before ${failure ?? "successful receipt delivery"}`, async () => {
    const f = fixture("ticket", ["deleted"]);
    await f.begin();
    const button: any = f.button("confirm");
    const defer = button.deferUpdate;
    button.deferUpdate = async () => { await defer(); button.deferred = true; };
    button.message = { flags: { has: (bit: number) => bit === MessageFlags.IsComponentsV2 || bit === MessageFlags.Ephemeral } };
    const receipts: any[] = [];
    let deletes = 0;
    button.followUp = async (payload: any) => { receipts.push(payload); if (failure === "receipt") throw new Error("uncertain delivery"); };
    button.deleteReply = async () => { deletes++; if (failure === "cleanup") throw new Error("cleanup failed"); };
    await f.click(button);
    assert.equal(f.snapshot, undefined);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].flags, MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds);
    assert.equal(receipts[0].content, "Support was removed with 1 ticket record(s) and 0 channel(s) deleted.");
    assert.equal(deletes, failure === "receipt" ? 0 : 1);
    assert.match(f.text(), /Support was removed/);
    const purges = f.events.filter(event => event === "purge").length;
    await f.click({ ...button, deferred: false });
    assert.equal(f.events.filter(event => event === "purge").length, purges);
  });
}

function fixture(kind: ConversationKind, statuses: Array<"open" | "closed" | "deleted">) {
  const f = {
    snapshot: { classId: "42", name: "Support", conversations: statuses.map((status, index) => ({ id: String(index), channelId: `channel-${index}`, userId: "member", status })) } as ConversationClassSnapshot | undefined,
    enabled: true, requiredByApplication: false, qualifiedByMembership: false, roleFailure: false,
    deferFlags: 0, events: [] as string[], edits: [] as any[], replies: [] as any[],
    logs: [] as Array<{ message: string; context?: Record<string, unknown> }>, logger: {} as Logger,
    channels: new Map<string, any>(), channelFailures: new Set<string>(), entryEdit: undefined as any,
    applications: {} as any, tickets: {} as any, memberships: {} as any, guild: {} as any, command: {} as any,
    text() { return JSON.stringify(f.edits.at(-1)); },
    textDisplays(): string[] {
      return f.edits.at(-1).components[0].toJSON().components
        .filter((component: any) => component.type === ComponentType.TextDisplay)
        .map((component: any) => component.content);
    },
    addChannel(id: string) {
      const channel = { id, type: ChannelType.GuildText, guild: f.guild, send: async () => ({ id: "control" }), delete: async () => { f.events.push(`delete:${id}`); f.channels.delete(id); } };
      f.channels.set(id, channel);
      return channel;
    },
    addEntry(v2 = false) {
      f.snapshot!.sourceChannelId = "entry-channel";
      f.snapshot!.sourceMessageId = "entry-message";
      const row = { type: ComponentType.ActionRow, components: [
        { type: ComponentType.Button, custom_id: `${kind === "application" ? "app" : "ticket"}:open:42`, style: 1, label: "Open" },
        { type: ComponentType.Button, custom_id: "unrelated:button", style: 1, label: "Keep" }
      ] };
      f.channels.set("entry-channel", { isTextBased: () => true, messages: { fetch: async () => ({
        author: { id: "bot" }, components: [{ toJSON: () => v2 ? {
          type: ComponentType.Container, accent_color: 0x009688, components: [
            { type: ComponentType.TextDisplay, content: "Keep this message" },
            { type: ComponentType.MediaGallery, items: [{ media: { url: "attachment://keep.png" } }] }, row
          ]
        } : row }], edit: async (payload: any) => { f.entryEdit = payload; f.events.push("entry"); }
      }) } });
    },
    async begin() { if (kind === "application") await handleApplicationsCommand(f.command, f.applications, f.memberships); else await handleTicketsCommand(f.command, f.tickets); },
    button(action: "confirm" | "cancel") {
      return { customId: [...findNestedComponentCustomIds(f.edits.at(-1))].find((id) => id.endsWith(`:${action}`))!,
        guildId: "guild", guild: f.guild, user: { id: "admin" }, inCachedGuild: () => true,
        deferUpdate: async () => { f.events.push("deferUpdate"); },
        update: async (payload: any) => { f.edits.push(payload); }, editReply: async (payload: any) => { f.edits.push(payload); },
        reply: async (payload: any) => { f.replies.push(payload); }
      };
    },
    async click(button: any) { return handleConversationClassRemovalButton(button, f.applications, f.tickets, f.memberships, f.logger); },
    async confirm() { return f.click(f.button("confirm")); }
  };
  f.logger = { debug() {}, info() {}, warn() {}, error: (message, context) => { f.logs.push({ message, context }); } };
  const classRemoval = {
    kind,
    getSnapshot: async () => structuredClone(f.snapshot),
    disable: async () => { f.events.push("disable"); f.enabled = false; },
    markDeleted: async (_guild: string, id: string) => { f.events.push(`mark:${id}`); f.snapshot!.conversations.find((record) => record.id === id)!.status = "deleted"; },
    remove: async () => { assert.ok(f.snapshot!.conversations.every((record) => record.status === "deleted")); f.events.push("purge"); f.snapshot = undefined; return true; }
  };
  f.applications = { classRemoval, listQualifiedRoleIdsForUser: async () => f.requiredByApplication || f.qualifiedByMembership ? ["active-role"] : [] };
  f.tickets = { classRemoval };
  f.memberships = { listQualifiedRoleIdsForUser: async () => f.qualifiedByMembership ? ["active-role"] : [] };
  f.guild = {
    id: "guild", client: { user: { id: "bot" } }, roles: { everyone: { id: "everyone" } },
    members: { fetch: async () => ({ roles: { cache: new Set(["active-role"]), remove: async (role: string) => { if (f.roleFailure) throw new Error("Missing permissions"); f.events.push(`role:${role}`); } } }) },
    channels: { fetch: async (id: string) => {
      if (f.channelFailures.has(id)) throw Object.assign(new Error("Missing access"), { code: 50001 });
      if (!f.channels.has(id)) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
      return f.channels.get(id);
    } }
  };
  for (const record of f.snapshot!.conversations) if (record.status !== "deleted") f.addChannel(record.channelId!);
  f.command = {
    guildId: "guild", guild: f.guild, user: { id: "admin" }, inGuild: () => true,
    options: { getSubcommandGroup: () => null, getSubcommand: () => "remove", getString: () => "42" },
    deferReply: async (options: any) => { f.deferFlags = options.flags; f.events.push("deferReply"); },
    editReply: async (payload: any) => { f.edits.push(payload); }
  };
  return f;
}
