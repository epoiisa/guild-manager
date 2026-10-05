import { ComponentType, ContainerBuilder, MessageFlags, type ChatInputCommandInteraction, type ModalSubmitInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { buildComposedMessage } from "../discord/composedMessage.js";
import { assertFeedbackCard, assertV2Card, messageSummary } from "../testSupport/messageAssertions.js";
import { handleMessageAutocomplete, handleMessageCommand, handleMessageModalSubmit, messageCommand } from "./message.js";

type TestMessage = {
  attachments: Map<string, unknown>;
  author: { id: string };
  components: unknown[];
  content: string;
  edit: (payload: Record<string, unknown>) => Promise<TestMessage>;
  editedTimestamp: number | null;
  embeds: unknown[];
  flags: { has: (flag: number) => boolean };
  id: string;
  poll: null;
  stickers: Map<string, unknown>;
  url: string;
};

const logger = {
  info: () => undefined
} as unknown as Parameters<typeof handleMessageCommand>[1];

function createMessage(overrides: Partial<TestMessage> = {}): TestMessage {
  const message: TestMessage = {
    attachments: new Map([["attachment-1", {}]]),
    author: { id: "bot-1" },
    components: [],
    content: "Original message",
    edit: async () => message,
    editedTimestamp: null,
    embeds: [],
    flags: { has: () => false },
    id: "message-1",
    poll: null,
    stickers: new Map(),
    url: "https://discord.com/channels/guild-1/channel-1/message-1",
    ...overrides
  };
  return message;
}

function createChannel(message: TestMessage) {
  return {
    id: "channel-1",
    isTextBased: () => true,
    messages: {
      fetch: async () => message
    },
    send: async () => undefined,
    toString: () => "<#channel-1>"
  };
}

async function tryOpenEditModal(message: TestMessage) {
  const channel = createChannel(message);
  let modal: { toJSON(): Record<string, unknown> } | undefined;
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const interaction = {
    channel,
    client: { user: { id: "bot-1" } },
    guild: { id: "guild-1" },
    inCachedGuild: () => true,
    inGuild: () => true,
    options: {
      getChannel: () => null,
      getString: () => "message-1",
      getSubcommand: () => "edit"
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    showModal: async (shown: typeof modal) => {
      modal = shown;
    },
    user: { id: "user-1" }
  } as unknown as ChatInputCommandInteraction;

  await handleMessageCommand(interaction, logger);
  return { channel, modal: modal?.toJSON(), replies };
}

async function openEditModal(message: TestMessage) {
  const { channel, modal } = await tryOpenEditModal(message);
  assert.ok(modal);
  return { channel, modal };
}

function getModalInput(modal: Record<string, unknown>): Record<string, unknown> {
  const rows = modal.components as Array<{ components: Array<Record<string, unknown>> }>;
  return rows[0].components[0];
}

test("message command exposes the approved edit surface", () => {
  const command = messageCommand.toJSON();
  const edit = command.options?.find((option) => option.name === "edit");

  assert.equal(edit?.type, 1);
  assert.equal(edit?.name, "edit");
  assert.equal(edit?.description, "Edit a message posted as Guild Manager.");
  assert.deepEqual(edit && "options" in edit
    ? edit.options?.map((option) => ({
      name: option.name,
      description: option.description,
      required: "required" in option ? option.required === true : false,
      type: option.type,
      channelTypes: "channel_types" in option ? option.channel_types : undefined
    }))
    : [], [
    {
      name: "id",
      description: "Message ID to edit.",
      required: true,
      type: 3,
      channelTypes: undefined
    },
    {
      name: "channel",
      description: "Channel containing the message. Defaults to the current channel.",
      required: false,
      type: 7,
      channelTypes: [0, 5, 11, 12, 10]
    }
  ]);
});

test("message post acknowledges before waiting to send", async () => {
  const events: string[] = [];
  let resolveSend: (() => void) | undefined;
  const channel = {
    id: "channel-1",
    isTextBased: () => true,
    messages: {},
    send: async () => {
      events.push("send");
      await new Promise<void>((resolve) => { resolveSend = resolve; });
      return { id: "message-1", url: "https://discord.com/channels/guild-1/channel-1/message-1" };
    },
    toString: () => "<#channel-1>"
  };
  const interaction = {
    channel,
    guild: { id: "guild-1" },
    inCachedGuild: () => true,
    inGuild: () => true,
    options: { getAttachment: () => null, getChannel: () => null, getString: () => "Hello", getSubcommand: () => "post" },
    deferReply: async () => { events.push("defer"); },
    editReply: async () => { events.push("edit"); },
    user: { id: "user-1" }
  } as unknown as ChatInputCommandInteraction;
  const pending = handleMessageCommand(interaction, logger);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["defer", "send"]);
  resolveSend?.();
  await pending;
  assert.deepEqual(events, ["defer", "send", "edit"]);
});

test("message edit preloads text and preserves attachments when submitted", async () => {
  let editPayload: Record<string, unknown> | undefined;
  const message = createMessage();
  message.edit = async (payload) => {
    editPayload = payload;
    return { ...message, content: String(payload.content) };
  };
  const { channel, modal } = await openEditModal(message);

  assert.equal(modal.title, "Edit Message");
  assert.match(String(modal.custom_id), /^message-edit:/);
  assert.deepEqual(getModalInput(modal), {
    type: 4,
    custom_id: "message",
    label: "Message",
    style: 2,
    max_length: 2000,
    required: false,
    value: "Original message"
  });

  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string } }> }> = [];
  const interaction = {
    client: { user: { id: "bot-1" } },
    customId: modal.custom_id,
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    fields: { getTextInputValue: () => "Updated message" },
    guild: {
      id: "guild-1",
      channels: { fetch: async () => channel }
    },
    inCachedGuild: () => true,
    user: { id: "user-1" }
  } as unknown as ModalSubmitInteraction;

  assert.equal(await handleMessageModalSubmit(interaction, logger), true);
  assert.deepEqual(editPayload, {
    content: "Updated message",
    allowedMentions: { parse: ["users", "roles", "everyone"] }
  });
  assert.equal(Object.hasOwn(editPayload ?? {}, "attachments"), false);
  assert.equal(messageSummary(replies[0]), "Edited [message message-1](https://discord.com/channels/guild-1/channel-1/message-1) in <#channel-1>.");
});

test("message edit allows ordinary buttons and retains them when submitted", async () => {
  let editPayload: Record<string, unknown> | undefined;
  const components = [{
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button }]
  }];
  const message = createMessage({ components });
  message.edit = async (payload) => {
    editPayload = payload;
    return { ...message, content: String(payload.content) };
  };
  const { channel, modal } = await openEditModal(message);
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string } }> }> = [];
  const interaction = {
    client: { user: { id: "bot-1" } },
    customId: modal.custom_id,
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    fields: { getTextInputValue: () => "Updated button message" },
    guild: {
      id: "guild-1",
      channels: { fetch: async () => channel }
    },
    inCachedGuild: () => true,
    user: { id: "user-1" }
  } as unknown as ModalSubmitInteraction;

  assert.equal(await handleMessageModalSubmit(interaction, logger), true);
  assert.deepEqual(editPayload, {
    content: "Updated button message",
    allowedMentions: { parse: ["users", "roles", "everyone"] }
  });
  assert.equal(Object.hasOwn(editPayload ?? {}, "components"), false);
  assert.equal(message.components, components);
  assert.equal(messageSummary(replies[0]), "Edited [message message-1](https://discord.com/channels/guild-1/channel-1/message-1) in <#channel-1>.");
});

test("message edit rejects messages not authored by Guild Manager", async () => {
  const message = createMessage({ author: { id: "user-2" } });
  const { modal, replies } = await tryOpenEditModal(message);

  assert.equal(modal, undefined);
  assertV2Card(replies[0], {
    color: 0xeab308,
    title: "Message Cannot Be Edited",
    description: "Only Guild Manager-authored plain messages with ordinary buttons, or messages created with `/message v2`, can be edited with this command. Embeds, operational cards, polls, stickers, and other component layouts are not supported."
  });
});

test("message edit rejects unrelated Components V2 messages", async () => {
  const message = createMessage({
    components: [{ type: ComponentType.TextDisplay }],
    flags: { has: (flag) => flag === MessageFlags.IsComponentsV2 }
  });
  const { modal, replies } = await tryOpenEditModal(message);

  assert.equal(modal, undefined);
  assertV2Card(replies[0], {
    color: 0xeab308,
    title: "Message Cannot Be Edited",
    description: "Only Guild Manager-authored plain messages with ordinary buttons, or messages created with `/message v2`, can be edited with this command. Embeds, operational cards, polls, stickers, and other component layouts are not supported."
  });
});

test("message edit rejects legacy non-button components", async () => {
  const message = createMessage({
    components: [{
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.StringSelect }]
    }]
  });
  const { modal, replies } = await tryOpenEditModal(message);

  assert.equal(modal, undefined);
  assert.equal(messageSummary(replies[0]), "Message Cannot Be Edited");
});

test("message edit refuses to overwrite a message changed after the modal opened", async () => {
  let edited = false;
  const message = createMessage({ attachments: new Map() });
  message.edit = async () => {
    edited = true;
    return message;
  };
  const { channel, modal } = await openEditModal(message);
  message.content = "Changed elsewhere";
  message.editedTimestamp = 1234;

  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string } }> }> = [];
  const interaction = {
    client: { user: { id: "bot-1" } },
    customId: modal.custom_id,
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    fields: { getTextInputValue: () => "My edit" },
    guild: {
      id: "guild-1",
      channels: { fetch: async () => channel }
    },
    inCachedGuild: () => true,
    user: { id: "user-1" }
  } as unknown as ModalSubmitInteraction;

  assert.equal(await handleMessageModalSubmit(interaction, logger), true);
  assert.equal(edited, false);
  assert.equal(messageSummary(replies[0]), "Message Changed: That message changed after the editor opened. Run `/message edit` again.");
});

test("message edit cannot remove the only content from an attachment-free post", async () => {
  let edited = false;
  const message = createMessage({ attachments: new Map() });
  message.edit = async () => {
    edited = true;
    return message;
  };
  const { channel, modal } = await openEditModal(message);
  const replies: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }> }> = [];
  const interaction = {
    client: { user: { id: "bot-1" } },
    customId: modal.custom_id,
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    fields: { getTextInputValue: () => "   " },
    guild: {
      id: "guild-1",
      channels: { fetch: async () => channel }
    },
    inCachedGuild: () => true,
    user: { id: "user-1" }
  } as unknown as ModalSubmitInteraction;

  assert.equal(await handleMessageModalSubmit(interaction, logger), true);
  assert.equal(edited, false);
  assertFeedbackCard(replies[0], {
    color: 0xeab308,
    title: "Missing Message Content",
    description: "A message must have text or at least one existing attachment."
  }, true);
});

function v2Fixture(color: string | null = null) {
  const posted: any[] = [];
  const replies: any[] = [];
  const events: string[] = [];
  let modal: any;
  const channel = {
    id: "destination", isTextBased: () => true, messages: {}, toString: () => "<#destination>",
    send: async (payload: any) => { events.push("send"); posted.push(payload); return { id: "posted", url: "https://discord.com/channels/guild/destination/posted" }; }
  };
  return {
    channel, posted, replies, events,
    get modal() { return modal; },
    async open() {
      await handleMessageCommand({
        channel: { id: "invoking-channel" }, client: { user: { id: "bot-1" } },
        guild: { id: "guild" }, user: { id: "author" }, inGuild: () => true, inCachedGuild: () => true,
        options: { getSubcommand: () => "v2", getString: () => color, getChannel: () => channel },
        showModal: async (value: any) => { modal = value.toJSON(); }, reply: async (payload: any) => { replies.push(payload); }
      } as any, logger);
    },
    async submit(text: string, images: any[] = [], overrides: any = {}) {
      return handleMessageModalSubmit({
        customId: modal.custom_id, user: { id: "author" }, inCachedGuild: () => true,
        guild: { id: "guild", channels: { fetch: async (id: string) => { assert.equal(id, channel.id); return channel; } } },
        fields: { getTextInputValue: () => text, getUploadedFiles: () => new Map(images.map((image, index) => [String(index), image])) },
        deferReply: async () => { events.push("defer"); },
        reply: async (payload: any) => { replies.push(payload); }, editReply: async (payload: any) => { replies.push(payload); },
        ...overrides
      } as any, logger);
    }
  };
}

function json(value: unknown): any { return JSON.parse(JSON.stringify(value)); }

const upload = { name: "Guild poster.PNG", contentType: "image/png", url: "https://cdn.discordapp.com/ephemeral-attachments/guild/upload/poster.png" };

test("message v2 exposes the approved colour and channel options and ordered modal upload", async () => {
  const command = messageCommand.toJSON();
  assert.equal(command.default_member_permissions, "0");
  const subcommand = command.options?.find((option) => option.name === "v2") as any;
  assert.deepEqual(subcommand.options.map((option: any) => option.name), ["color", "channel"]);
  assert.equal(subcommand.options[0].autocomplete, true);
  assert.ok(subcommand.options.every((option: any) => !option.required));
  assert.deepEqual(subcommand.options[1].channel_types, [0, 5, 11, 12, 10]);
  const f = v2Fixture();
  await f.open();
  assert.equal(f.modal.title, "Post V2 Message");
  assert.deepEqual(f.modal.components.map((field: any) => field.label), ["Message", "Image"]);
  assert.equal(f.modal.components[0].component.max_length, 4000);
  assert.equal(f.modal.components[1].component.type, ComponentType.FileUpload);
  assert.equal(f.modal.components[1].component.required, false);
  assert.equal(f.modal.components[1].component.max_values, 1);
});

test("message colour autocomplete uses all twenty-two exact Tailwind v3 names without shade numbers", async () => {
  const responses: any[] = [];
  const interaction: any = {
    commandName: "message", inGuild: () => true,
    options: { getSubcommand: () => "v2", getFocused: () => ({ name: "color", value: "" }) },
    respond: async (choices: any) => { responses.push(choices); }
  };
  assert.equal(await handleMessageAutocomplete(interaction), true);
  assert.deepEqual(responses[0].map((entry: any) => entry.name), [
    "Slate", "Gray", "Zinc", "Neutral", "Stone", "Red", "Orange", "Amber", "Yellow", "Lime", "Green",
    "Emerald", "Teal", "Cyan", "Sky", "Blue", "Indigo", "Violet", "Purple", "Fuchsia", "Pink", "Rose"
  ]);
  interaction.options.getFocused = () => ({ name: "color", value: "  Gr  " });
  await handleMessageAutocomplete(interaction);
  assert.deepEqual(responses[1], [{ name: "Gray", value: "Gray" }, { name: "Green", value: "Green" }]);
  interaction.options.getFocused = () => ({ name: "color", value: "#aBcDeF" });
  await handleMessageAutocomplete(interaction);
  assert.deepEqual(responses[2], [{ name: "#ABCDEF", value: "#ABCDEF" }]);
});

test("message v2 posts complete Markdown before a bot-uploaded image in the default Slate container", async () => {
  const f = v2Fixture();
  await f.open();
  const text = "# Guild notice\n\n<@&role> " + "x".repeat(3975);
  assert.equal(text.length, 4000);
  assert.equal(await f.submit(text, [upload]), true);
  const payload = f.posted[0];
  assert.deepEqual(f.events, ["defer", "send"]);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.content, undefined);
  assert.equal(payload.embeds, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: ["users", "roles", "everyone"] });
  const [container] = json(payload.components);
  assert.equal(container.accent_color, 0x64748b);
  assert.deepEqual(container.components.map((component: any) => component.type), [ComponentType.TextDisplay, ComponentType.MediaGallery]);
  assert.equal(container.components[0].content, text);
  assert.equal(container.components[1].items[0].media.url, "attachment://message-image.png");
  assert.equal(payload.files[0].attachment, upload.url);
  assert.equal(payload.files[0].name, "message-image.png");
  assert.equal(messageSummary(json(f.replies.at(-1))), "Posted [message posted](https://discord.com/channels/guild/destination/posted) in <#destination>.");
});

for (const [color, expected] of [["Violet", 0x8b5cf6], ["Teal", 0x14b8a6], ["#000000", 0], ["e91e63", 0xe91e63]] as const) {
  test(`message v2 resolves ${color} and permits text without an image`, async () => {
    const f = v2Fixture(color);
    await f.open();
    await f.submit("Text only");
    const container = json(f.posted[0].components)[0];
    assert.equal(container.accent_color, expected);
    assert.deepEqual(container.components.map((component: any) => component.type), [ComponentType.TextDisplay]);
    assert.deepEqual(f.posted[0].files, []);
  });
}

test("message v2 permits image-only posts and rejects invalid colours before opening the modal", async () => {
  const f = v2Fixture();
  await f.open();
  await f.submit("", [upload]);
  assert.deepEqual(json(f.posted[0].components)[0].components.map((component: any) => component.type), [ComponentType.MediaGallery]);
  for (const value of ["Purple 500", "#12345", "#1000000", "unknown"]) {
    const invalid = v2Fixture(value);
    await invalid.open();
    assert.equal(invalid.modal, undefined);
    assert.equal(messageSummary(json(invalid.replies[0])), "Invalid Colour: Choose a Tailwind v3 colour by name or enter a six-digit hexadecimal colour such as #64748B.");
  }
});

for (const scenario of [
  { name: "non-image upload", text: "Message", images: [{ ...upload, contentType: "application/pdf" }], title: "Invalid Image" },
  { name: "multiple uploads", text: "Message", images: [upload, upload], title: "Invalid Image" },
  { name: "empty message", text: "  ", images: [], title: "Invalid Message Content" },
  { name: "oversized text", text: "x".repeat(4001), images: [], title: "Invalid Message Content" }
]) {
  test(`message v2 rejects ${scenario.name} without sending`, async () => {
    const f = v2Fixture();
    await f.open();
    await f.submit(scenario.text, scenario.images);
    assert.equal(f.posted.length, 0);
    assert.equal(messageSummary(json(f.replies[0])), scenario.title === "Invalid Image" ? "Invalid Image: Upload one image file, or leave Image empty." : "Invalid Message Content: Provide message text, an image, or both. Message text must be at most 4,000 characters.");
  });
}

test("message v2 drafts are actor-bound, server-bound, and consumed once", async () => {
  const f = v2Fixture();
  await f.open();
  await f.submit("Spoof", [], { user: { id: "someone-else" } });
  await f.submit("Spoof", [], { guild: { id: "another-server" } });
  assert.equal(f.posted.length, 0);
  assert.ok(f.replies.every((reply) => messageSummary(json(reply)) === "Draft Not Yours: That message draft does not belong to this interaction."));
  await f.submit("Legitimate author");
  await f.submit("Duplicate");
  assert.equal(f.posted.length, 1);
  assert.equal(messageSummary(json(f.replies.at(-1))), "Draft Expired: That message draft has expired. Run `/message v2` again.");
});

function composedPost(text = "Original message", image = true) {
  const [container] = json(buildComposedMessage(text, 0x009688, image ? "image.png" : undefined).components);
  container.components.push({ type: ComponentType.ActionRow, components: [
    { type: ComponentType.Button, style: 1, label: "Apply", custom_id: "app:open:application" },
    { type: ComponentType.Button, style: 1, label: "Ticket", custom_id: "ticket:open:ticket" }
  ] });
  return createMessage({
    content: "", flags: { has: (flag) => flag === MessageFlags.IsComponentsV2 },
    components: [new ContainerBuilder(container)], attachments: image ? new Map([["image-id", {}]]) : new Map()
  });
}

async function submitTextEdit(message: TestMessage, change: string, afterOpen?: () => void) {
  const { channel, modal } = await openEditModal(message);
  const replies: any[] = [];
  afterOpen?.();
  await handleMessageModalSubmit({
    client: { user: { id: "bot-1" } }, customId: modal.custom_id, user: { id: "user-1" },
    inCachedGuild: () => true, guild: { id: "guild-1", channels: { fetch: async () => channel } },
    deferReply: async () => undefined, fields: { getTextInputValue: () => change },
    editReply: async (payload: any) => { replies.push(payload); }
  } as any, logger);
  return { modal, replies };
}

test("message edit preserves a composed V2 image, colour, both entry buttons and message ID", async () => {
  const message = composedPost();
  const [original] = json(message.components);
  let payload: any;
  message.edit = async (value) => { payload = value; return message; };
  const { modal } = await submitTextEdit(message, "# Corrected\n\n" + "x".repeat(3987));
  assert.equal(getModalInput(modal).value, "Original message");
  assert.equal(getModalInput(modal).max_length, 4000);
  assert.equal(payload.components[0].components[0].content.length, 4000);
  assert.deepEqual(payload.components[0].components.slice(1), original.components.slice(1));
  assert.equal(payload.components[0].accent_color, original.accent_color);
  assert.equal(payload.components[0].id, original.id);
  assert.equal(payload.attachments, undefined);
  assert.equal(payload.files, undefined);
  assert.equal(payload.content, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("message edit adds and removes V2 text around a retained image but cannot leave a button-only post", async () => {
  for (const [initial, replacement] of [["", "Added text"], ["Remove this", ""]]) {
    const message = composedPost(initial);
    let payload: any;
    message.edit = async (value) => { payload = value; return message; };
    await submitTextEdit(message, replacement);
    assert.equal(payload.components[0].components[0].type, replacement ? ComponentType.TextDisplay : ComponentType.MediaGallery);
  }
  const message = composedPost("Only content", false);
  let edited = false;
  message.edit = async () => { edited = true; return message; };
  const { replies } = await submitTextEdit(message, "");
  assert.equal(edited, false);
  assert.equal(messageSummary(json(replies[0])), "Missing Message Content: A message must have text or at least one existing attachment.");
});

for (const mutation of ["text", "buttons", "image", "colour"]) {
  test(`message edit detects changed V2 ${mutation} even with the same timestamp`, async () => {
    const message = composedPost();
    let edited = false;
    message.edit = async () => { edited = true; return message; };
    const { replies } = await submitTextEdit(message, "Overwrite", () => {
      const [container] = json(message.components);
      if (mutation === "text") container.components[0].content = "Changed elsewhere";
      if (mutation === "buttons") container.components.at(-1).components[0].label = "Changed elsewhere";
      if (mutation === "image") message.attachments = new Map([["replacement-id", {}]]);
      if (mutation === "colour") container.accent_color = 0xef4444;
      message.components = [new ContainerBuilder(container)];
    });
    assert.equal(edited, false);
    assert.equal(messageSummary(json(replies[0])), "Message Changed: That message changed after the editor opened. Run `/message edit` again.");
  });
}

test("message edit does not recognise a one-text operational container as a composed message", async () => {
  const message = composedPost();
  const [container] = json(message.components);
  delete container.id;
  message.components = [new ContainerBuilder(container)];
  const { modal, replies } = await tryOpenEditModal(message);
  assert.equal(modal, undefined);
  assert.equal(messageSummary(json(replies[0])), "Message Cannot Be Edited");
});

test("message repost explicitly rejects V2 before sending its attachments without its text", async () => {
  const message = composedPost();
  const channel = createChannel(message);
  let sent = false;
  channel.send = async () => { sent = true; };
  const replies: any[] = [];
  await handleMessageCommand({
    channel, guild: { id: "guild-1" }, inCachedGuild: () => true, inGuild: () => true,
    options: { getString: () => message.id, getChannel: () => null, getSubcommand: () => "repost" },
    deferReply: async () => undefined, editReply: async (payload: any) => { replies.push(payload); }
  } as any, logger);
  assert.equal(sent, false);
  assert.equal(messageSummary(json(replies[0])), "Message Cannot Be Reposted: Components V2 messages cannot be reposted with this command yet. Use `/message v2` to compose a new message.");
});

test("message edit accepts refreshed Discord attachment signatures and retains the latest media URL", async () => {
  const message = composedPost();
  const [container] = json(message.components);
  container.components[1].items[0].media.url = "https://cdn.discordapp.com/attachments/channel/image/image.png?ex=old&hm=old";
  message.components = [new ContainerBuilder(container)];
  let payload: any;
  message.edit = async (value) => { payload = value; return message; };
  await submitTextEdit(message, "Corrected", () => {
    container.components[1].items[0].media.url = "https://cdn.discordapp.com/attachments/channel/image/image.png?ex=new&hm=new";
    message.components = [new ContainerBuilder(container)];
  });
  assert.equal(payload.components[0].components[1].items[0].media.url, container.components[1].items[0].media.url);
});

test("message edit rejects adding text when an image-only card has exhausted its component budget", async () => {
  const message = composedPost("");
  const [container] = json(message.components);
  container.components = [container.components[0], ...Array.from({ length: 7 }, (_, rowIndex) => ({
    type: ComponentType.ActionRow, components: Array.from({ length: rowIndex < 6 ? 5 : 1 }, (_, index) => ({
      type: ComponentType.Button, style: 1, label: "Open", custom_id: `app:open:${rowIndex}:${index}`
    }))
  }))];
  message.components = [new ContainerBuilder(container)];
  let edited = false;
  message.edit = async () => { edited = true; return message; };
  const { replies } = await submitTextEdit(message, "New text");
  assert.equal(edited, false);
  assert.equal(messageSummary(json(replies[0])), "Message Components Full: That message has reached Discord's component limit and cannot include another text field.");
});

test("message edit ignores JSON property order differences across Discord fetches", async () => {
  const message = composedPost();
  let edited = false;
  message.edit = async () => { edited = true; return message; };
  await submitTextEdit(message, "Corrected", () => {
    const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
    message.components = json(message.components).map((component: any) => ({ toJSON: () => reverseKeys(component) }));
  });
  assert.equal(edited, true);
});
