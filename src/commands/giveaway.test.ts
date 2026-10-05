import {
  ApplicationCommandOptionType,
  Collection,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageEditOptions
} from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { GiveawayRecord } from "../db/giveawayRepository.js";
import { activeGuildCommands } from "../discord/commands.js";
import {
  buildClosedGiveawayV2Message,
  buildDrawAnnouncement,
  buildGiveawayCreatedEmbed,
  buildGiveawayStatusEmbed,
  buildOpenGiveawayV2Message,
  buildRedrawAnnouncement
} from "../services/giveaways/rendering.js";
import {
  GIVEAWAY_ENTRY_EMOJI,
  GIVEAWAY_ENTRY_EMOJI_KEY,
  createGiveawayService,
  giveawayReactionAction,
  isGiveawayEntryEmojiKey,
  selectRandomUnique,
  shouldRemoveClosedGiveawayReaction
} from "../services/giveaways/service.js";
import { assertV2Message, messageDescription, messageRows, messageSummary } from "../testSupport/messageAssertions.js";
import {
  giveawayCommand,
  giveawaysCommand,
  handleGiveawayAutocomplete,
  handleGiveawayButton,
  handleGiveawayCommand,
  handleGiveawayModalSubmit,
  handleGiveawaysCommand
} from "./giveaway.js";

test("giveaway commands expose the approved hidden surface", () => {
  const giveaway = giveawayCommand.toJSON();
  const giveaways = giveawaysCommand.toJSON();
  assert.equal(giveaway.default_member_permissions, "0");
  assert.equal(giveaways.default_member_permissions, "0");
  assert.deepEqual(giveaway.options?.map((option) => option.name), ["create", "draw", "reroll", "cancel"]);

  const create = giveaway.options?.[0] as {
    options?: Array<{
      name: string;
      type: ApplicationCommandOptionType;
      required?: boolean;
      autocomplete?: boolean;
    }>;
  } | undefined;
  assert.deepEqual(create?.options?.map(({ name, type, required, autocomplete }) => ({
    name,
    type,
    required,
    autocomplete: autocomplete === true
  })), [
    { name: "date", type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
    { name: "time", type: ApplicationCommandOptionType.String, required: true, autocomplete: false },
    { name: "winners", type: ApplicationCommandOptionType.Integer, required: true, autocomplete: false },
    { name: "image", type: ApplicationCommandOptionType.Attachment, required: false, autocomplete: false },
    { name: "notification", type: ApplicationCommandOptionType.Role, required: false, autocomplete: false }
  ]);
  assert.equal((giveaway.options?.[0] as { description?: string }).description, "Create a scheduled giveaway in the configured channel.");
  assert.equal(activeGuildCommands.length, 50);
  assert.deepEqual(
    ["giveaway", "giveaways"].map((name) => activeGuildCommands.find((command) => command.name === name)?.name),
    ["giveaway", "giveaways"]
  );
});

test("giveaway creation confirmation uses a classic embed with all summary fields", () => {
  const embed = buildGiveawayCreatedEmbed({
    title: "Founder Pack",
    creatorDiscordUserId: "300",
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 3,
    notificationRoleId: "400",
    messageUrl: "https://discord.com/channels/1/2/3"
  }).toJSON();
  assert.equal(embed.color, 0x22c55e);
  assert.equal(embed.title, "Giveaway Created");
  assert.equal(embed.description, undefined);
  assert.deepEqual(embed.fields, [
    { name: "Giveaway", value: "[Founder Pack](https://discord.com/channels/1/2/3)" },
    { name: "Host", value: "<@300>" },
    { name: "Draws", value: "<t:1785661200:F> (<t:1785661200:R>)" },
    { name: "Winners", value: "3" },
    { name: "Notification", value: "<@&400>" }
  ]);
  assert.equal(GIVEAWAY_ENTRY_EMOJI, "🎁");
  assert.equal(GIVEAWAY_ENTRY_EMOJI_KEY, "unicode:🎁");
});

test("giveaway creation confirmation always includes an empty notification field", () => {
  const embed = buildGiveawayCreatedEmbed({
    title: "Founder Pack",
    creatorDiscordUserId: "300",
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 1,
    messageUrl: "https://discord.com/channels/1/2/3"
  }).toJSON();
  assert.deepEqual(embed.fields?.at(-1), {
    name: "Notification",
    value: "None"
  });
});

test("giveaway ephemeral responses use classic embeds", () => {
  const embed = buildGiveawayStatusEmbed(
    "Draw Giveaway Now?",
    "This will draw **Founder Pack** immediately.\nReview the giveaway before continuing.",
    0x64748b
  ).toJSON();

  assert.equal(embed.color, 0x64748b);
  assert.equal(embed.title, "Draw Giveaway Now?");
  assert.equal(
    embed.description,
    "This will draw **Founder Pack** immediately.\nReview the giveaway before continuing."
  );
});

test("draw confirmation uses an accented V2 Container with its action buttons", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): ReturnType<typeof JSON.parse> }>;
    components?: Array<{ toJSON(): ReturnType<typeof JSON.parse> }>;
    flags?: number;
  }> = [];
  const interaction = {
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "300" },
    memberPermissions: null,
    guild: managementGuild(),
    options: {
      getSubcommand: () => "draw",
      getString: () => "69"
    },
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    deferReply: async (options: { flags?: number }) => { assert.equal(options.flags, MessageFlags.Ephemeral); },
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    isHostAuthorityRevoked: async () => false, getById: async () => giveawayRecord()
  } as unknown as Parameters<typeof handleGiveawayCommand>[1];

  await handleGiveawayCommand(interaction, repository, testLogger());

  const embed = replies[0];
  const row = messageRows(replies[0])[0];
  // The deferred acknowledgement carries the ephemeral flag; editReply does not.
  assert.equal(messageSummary(embed), "Draw Giveaway");
  assert.equal(messageDescription(embed), "Draw “Founder Pack” now? This closes entries and selects the winners.");
  assert.deepEqual(row?.components.map((component: { label: string }) => component.label), [
    "Draw Now",
    "Keep Giveaway"
  ]);
});

test("reconnection cannot restore the former creator's reroll authority over a completed giveaway", async () => {
  const replies: unknown[] = [];
  const giveaway = { ...giveawayRecord(), state: "drawn" };
  await handleGiveawayCommand({
    inCachedGuild: () => true, guildId: "guild-1", guild: managementGuild(), user: { id: "300" },
    options: { getSubcommand: () => "reroll", getString: () => "69" },
    deferReply: async () => undefined,
    editReply: async (payload: unknown) => { replies.push(payload); }
  } as never, {
    getById: async () => giveaway,
    isHostAuthorityRevoked: async () => true,
    listWinners: async () => assert.fail("revoked host cannot reach the old giveaway's reroll")
  } as never, testLogger());
  assert.match(messageDescription(replies[0]), /Choose one of your giveaways/);
});

for (const [time, expected] of [
  ["9", "2099-01-01T09:00:00.000Z"],
  ["09", "2099-01-01T09:00:00.000Z"],
  ["9:05", "2099-01-01T09:05:00.000Z"],
  ["0", "2099-01-01T00:00:00.000Z"],
  ["24", "2099-01-02T00:00:00.000Z"],
  ["24:00", "2099-01-02T00:00:00.000Z"]
]) {
  test(`giveaway create ${time} persists its UTC instant through the modal with an ordinary role`, async () => {
    const sentMessages: Array<{
      allowedMentions?: { roles?: string[] };
    }> = [];
    const created: Array<{ notificationRoleId?: string; drawAt: Date }> = [];
    let modalCustomId = "";
    const channel = {
      id: "channel-1",
      isTextBased: () => true,
      messages: {},
      permissionsFor: () => ({ has: () => true }),
      send: async (message: { allowedMentions?: { roles?: string[] } }) => {
        sentMessages.push(message);
        return {
          id: "message-1",
          url: "https://discord.com/channels/guild-1/channel-1/message-1",
          react: async () => undefined,
          delete: async () => undefined
        };
      }
    };
    const notificationRole = { id: "ordinary-role", mentionable: true };
    const commandInteraction = {
      inCachedGuild: () => true,
      guildId: "guild-1",
      guild: { id: "guild-1", members: { me: {} } },
      channel: { id: "command-channel", send: () => assert.fail("Do not publish in the invoking channel") },
      user: { id: "user-1" },
      options: {
        getSubcommand: () => "create",
        getString: (name: string) => name === "date" ? "2099-01-01" : time,
        getInteger: () => 1,
        getAttachment: () => null,
        getRole: () => notificationRole
      },
      showModal: async (modal: { data: { custom_id?: string } }) => {
        modalCustomId = modal.data.custom_id ?? "";
      }
    } as unknown as ChatInputCommandInteraction;
    const repository = {
      create: async (input: { notificationRoleId?: string; drawAt: Date }) => {
        created.push(input);
        return giveawayRecord({ notificationRoleId: input.notificationRoleId, drawAt: input.drawAt }) as never;
      }
    } as unknown as Parameters<typeof handleGiveawayCommand>[1];

    await handleGiveawayCommand(commandInteraction, repository, testLogger(), giveawayEntries(channel));
    assert.match(modalCustomId, /^giveaway-create:/);

    const modalInteraction = {
      customId: modalCustomId,
      inCachedGuild: () => true,
      guildId: "guild-1",
      guild: {
        id: "guild-1",
        members: { me: {} },
        channels: { fetch: async () => channel },
        roles: {
          cache: new Map([[notificationRole.id, notificationRole]]),
          fetch: async () => notificationRole
        }
      },
      user: { id: "user-1" },
      fields: {
        getTextInputValue: (name: string) => name === "title" ? "Ordinary Role Giveaway" : "Description"
      },
      deferReply: async (options: { flags?: number }) => { assert.equal(options.flags, MessageFlags.Ephemeral); },
      editReply: async () => undefined
    } as unknown as Parameters<typeof handleGiveawayModalSubmit>[0];

    assert.equal(await handleGiveawayModalSubmit(
      modalInteraction,
      repository,
      testLogger(),
      giveawayEntries(channel)
    ), true);
    assert.equal(created[0].drawAt.toISOString(), expected);
    assert.equal(created[0].notificationRoleId, "ordinary-role");
    assert.deepEqual(sentMessages[0].allowedMentions?.roles, ["ordinary-role"]);
  });
}

test("giveaway list uses a classic embed with linked list items and hosts", async () => {
  const replies: Array<{
    embeds?: Array<{ toJSON(): ReturnType<typeof JSON.parse> }>;
    flags?: number;
  }> = [];
  const interaction = {
    inCachedGuild: () => true,
    guildId: "guild-1",
    reply: async (reply: typeof replies[number]) => {
      replies.push(reply);
    },
    deferReply: async () => undefined,
    editReply: async (reply: typeof replies[number]) => { replies.push(reply); },
    followUp: async () => undefined
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    listOpen: async () => [giveawayRecord({ title: "Founder ] Pack" })],
    listEligibleParticipantIds: async () => ["100", "200"]
  } as unknown as Parameters<typeof handleGiveawaysCommand>[1];

  await handleGiveawaysCommand(interaction, repository);

  const embed = replies[0];
  // The deferred acknowledgement carries the ephemeral flag; editReply does not.
  assert.equal(messageSummary(embed), "Giveaways");
  assert.equal(
    messageDescription(embed),
    "- [Founder \\] Pack](https://discord.com/channels/guild-1/channel-1/message-1) • <@300> • <t:1785661200:F> (<t:1785661200:R>) • 2 participants"
  );
});

test("giveaway commands acknowledge before giveaway lookup and winner autocomplete uses only cached users", async () => {
  const events: string[] = [];
  const interaction = {
    inCachedGuild: () => true,
    guildId: "guild-1",
    user: { id: "300" },
    memberPermissions: null,
    guild: managementGuild(),
    options: { getSubcommand: () => "draw", getString: () => "69" },
    deferReply: async () => { events.push("defer"); },
    editReply: async () => undefined
  } as unknown as ChatInputCommandInteraction;
  await handleGiveawayCommand(interaction, { isHostAuthorityRevoked: async () => false, getById: async () => { events.push("lookup"); return giveawayRecord(); } } as never, testLogger());
  assert.deepEqual(events, ["defer", "lookup"]);

  const responses: unknown[][] = [];
  const autocomplete = {
    commandName: "giveaway", guildId: "guild-1", user: { id: "300" },
    client: { users: { cache: new Map([["known", { username: "Known" }]]), fetch: () => { throw new Error("must not fetch"); } } },
    options: { getFocused: () => ({ name: "winner", value: "" }), getSubcommand: () => "reroll", getString: () => "69" },
    respond: async (choices: unknown[]) => responses.push(choices)
  };
  await handleGiveawayAutocomplete(autocomplete as never, { listWinners: async () => Array.from({ length: 26 }, (_, index) => ({ discordUserId: index === 0 ? "known" : `id-${index}`, status: "current" })) } as never);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].length, 25);
  assert.deepEqual(responses[0][0], { name: "@Known", value: "known" });
});

test("new public giveaway announcements use Components V2 and notify only the selected role", () => {
  const message = buildOpenGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "Founder *Pack*",
    description: "React for a chance to win.",
    imageAttachmentName: "giveaway-image.png",
    notificationRoleId: "400",
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 3
  }, ["100", "200"], true);
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();

  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal(message.content, undefined);
  assert.equal(message.embeds, undefined);
  assert.deepEqual(message.allowedMentions, { parse: [], roles: ["400"], repliedUser: false });
  assert.equal(container.type, 17);
  assert.equal(container.accent_color, 0x64748b);
  assert.equal(container.components[0].content, "# Giveaway");
  assert.equal(container.components[1].content, "## Founder \\*Pack\\*");
  assert.equal(container.components[2].content, "React for a chance to win.");
  assert.deepEqual(container.components[3], {
    type: 12,
    items: [{
      media: { url: "attachment://giveaway-image.png" },
      description: "Founder *Pack*"
    }]
  });
  assert.equal(container.components[4].content, "**Host**\n<@300>");
  assert.equal(container.components[5].content, "**Draws**\n<t:1785661200:F> (<t:1785661200:R>)");
  assert.equal(container.components[6].content, "**Winners**\n3");
  assert.equal(container.components[7].content, "**Participants (2)**\n<@100> <@200>");
  assert.equal(
    container.components.at(-1).content,
    "<@&400> React with 🎁 to enter!"
  );
  assert.match(container.components.at(-2).content, /<@100> <@200>/);
});

test("Components V2 giveaway instructions have no trailing space without a notification role", () => {
  const message = buildOpenGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "No Notification",
    description: "Text-only giveaway.",
    imageAttachmentName: undefined,
    notificationRoleId: undefined,
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 1
  }, []);
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();

  assert.equal(container.components.at(-1).content, "React with 🎁 to enter!");
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
});

test("Components V2 participant refreshes retain the role text without notifying any mention", () => {
  const message = buildOpenGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "No Image",
    description: "x".repeat(4000),
    imageAttachmentName: undefined,
    notificationRoleId: "400",
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 1
  }, Array.from({ length: 300 }, (_, index) => `${20_000_000_000_000_000n + BigInt(index)}`));
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  const textDisplays = container.components.filter((component: { type: number }) => component.type === 10);

  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(container.components.some((component: { type: number }) => component.type === 12), false);
  assertV2Message(message);
  const report = message.files![0] as import("discord.js").AttachmentBuilder;
  const full = report.attachment.toString();
  assert.match(full, new RegExp("x".repeat(4000)));
  for (let index = 0; index < 300; index++) assert.ok(full.includes(`<@${20_000_000_000_000_000n + BigInt(index)}>`));
  assert.match(full, /<@&400> React with 🎁 to enter!/);
  assert.doesNotMatch(full, /and \d+ more/);
});

test("participant refresh reuses the image URL without clearing the backing attachment", async () => {
  const edits: MessageEditOptions[] = [];
  const imageUrl = "https://cdn.discordapp.com/attachments/1/2/giveaway-image.png";
  const message = retainedImageMessage(`${imageUrl}?ex=123&is=456&hm=789`, edits);
  const repository = {
    listEligibleParticipantIds: async () => ["100", "200"]
  } as unknown as Parameters<typeof createGiveawayService>[0];
  const service = createGiveawayService(repository, testLogger());

  await service.refreshOpenMessage(testGuild(message), giveawayRecord());

  assert.equal(edits.length, 1);
  assert.equal(mediaUrl(edits[0]), imageUrl);
  assert.notEqual(mediaUrl(edits[0]), "attachment://giveaway-image.png");
  assert.equal("attachments" in edits[0], false);
});

test("closed Components V2 giveaways preserve the role without sending another notification", () => {
  const message = buildClosedGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "Founder Pack",
    description: "React for a chance to win.",
    imageAttachmentName: "giveaway-image.png",
    notificationRoleId: "400",
    winnerCount: 3
  }, ["100", "200"], {
    state: "drawn",
    at: new Date("2026-08-01T13:40:00.000Z")
  }, "https://cdn.discordapp.com/attachments/1/2/giveaway-image.png");
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();

  assert.equal(container.accent_color, 0x22c55e);
  assert.equal(
    container.components.find((component: { type: number }) => component.type === 12).items[0].media.url,
    "https://cdn.discordapp.com/attachments/1/2/giveaway-image.png"
  );
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(
    container.components.find((component: { content?: string }) => component.content?.startsWith("**Drawn**"))?.content,
    "**Drawn**\n<t:1785591600:F> (<t:1785591600:R>)"
  );
  assert.equal(
    container.components.find((component: { content?: string }) => component.content?.startsWith("**Winners**"))?.content,
    "**Winners**\n3"
  );
  assert.equal(
    container.components.find((component: { content?: string }) => component.content?.startsWith("**Host**"))?.content,
    "**Host**\n<@300>"
  );
  assert.equal(
    container.components.at(-1).content,
    "<@&400> The giveaway is closed. Entries are no longer accepted."
  );

  const cancelled = buildClosedGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "Founder Pack",
    description: "React for a chance to win.",
    imageAttachmentName: undefined,
    notificationRoleId: "400",
    winnerCount: 3
  }, ["100", "200"], {
    state: "cancelled",
    at: new Date("2026-08-01T13:40:00.000Z")
  });
  const cancelledContainer = (cancelled.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.equal(cancelledContainer.accent_color, 0x64748b);
  assert.equal(
    cancelledContainer.components.at(-1).content,
    "<@&400> The giveaway is cancelled. Entries are no longer accepted."
  );
});

test("draw closure reuses the retained Components V2 proxy URL", async () => {
  const edits: MessageEditOptions[] = [];
  const imageUrl = "https://media.discordapp.net/attachments/1/2/giveaway-image.png";
  const message = retainedImageMessage("attachment://giveaway-image.png", edits, imageUrl);
  const closedMessageIds: string[] = [];
  const repository = {
    listRecordedParticipantIds: async () => ["100", "200"],
    markOriginalMessageClosed: async (_guildId: string, messageId: string) => {
      closedMessageIds.push(messageId);
    }
  } as unknown as Parameters<typeof createGiveawayService>[0];
  const service = createGiveawayService(repository, testLogger());
  const giveaway = giveawayRecord({
    state: "drawn",
    drawnAt: new Date("2026-08-01T13:40:00.000Z"),
    announcementMessageId: "announcement-1"
  });

  await service.publishPending(testGuild(message), giveaway);

  assert.equal(edits.length, 1);
  assert.equal(mediaUrl(edits[0]), imageUrl);
  assert.notEqual(mediaUrl(edits[0]), "attachment://giveaway-image.png");
  assert.equal("attachments" in edits[0], false);
  assert.deepEqual(closedMessageIds, [giveaway.originalMessageId]);
});

test("Components V2 giveaway messages and draw announcements support no uploaded image", () => {
  const openMessage = buildOpenGiveawayV2Message({
    creatorDiscordUserId: "300",
    title: "No Image",
    description: "Text-only giveaway.",
    imageAttachmentName: undefined,
    notificationRoleId: undefined,
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 1
  }, []);
  const openContainer = (openMessage.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.equal(openContainer.components.some((component: { type: number }) => component.type === 12), false);

  const drawMessage = buildDrawAnnouncement(
    {
      creatorDiscordUserId: "300",
      title: "No Image",
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      drawnAt: new Date("2026-08-01T13:40:00.000Z")
    },
    ["100"],
    "https://discord.com/channels/1/2/3"
  );
  const drawContainer = (drawMessage.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.equal(drawContainer.components.some((component: { type: number }) => component.type === 12), false);
  assert.equal(drawMessage.flags, MessageFlags.IsComponentsV2);
});

test("only the gift reaction changes managed giveaway participation", () => {
  assert.equal(isGiveawayEntryEmojiKey("unicode:🎁"), true);
  assert.equal(isGiveawayEntryEmojiKey("unicode:✅"), false);
  assert.equal(isGiveawayEntryEmojiKey("custom:123"), false);
  assert.equal(giveawayReactionAction("unicode:🎁", true, true), "join");
  assert.equal(giveawayReactionAction("unicode:🎁", true, false), "ignore");
  assert.equal(giveawayReactionAction("unicode:🎁", false, true), "leave");
  assert.equal(giveawayReactionAction("unicode:🎁", false, false), "leave");
  assert.equal(giveawayReactionAction("unicode:✅", true, true), "ignore");
  assert.equal(giveawayReactionAction("unicode:✅", false, true), "ignore");
  assert.equal(giveawayReactionAction("custom:123", true, true), "ignore");
  assert.equal(giveawayReactionAction("custom:123", false, true), "ignore");
  assert.equal(shouldRemoveClosedGiveawayReaction("drawn", "unicode:🎁", true), true);
  assert.equal(shouldRemoveClosedGiveawayReaction("cancelled", "unicode:🎁", true), true);
  assert.equal(shouldRemoveClosedGiveawayReaction("open", "unicode:🎁", true), false);
  assert.equal(shouldRemoveClosedGiveawayReaction("drawn", "unicode:🎁", false), false);
  assert.equal(shouldRemoveClosedGiveawayReaction("drawn", "unicode:✅", true), false);
});

test("draw announcement uses Components V2 and notifies winners and host", () => {
  const message = buildDrawAnnouncement(
    {
      creatorDiscordUserId: "300",
      title: "Founder ] Pack",
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      drawnAt: new Date("2026-08-01T13:40:00.000Z")
    },
    ["100", "200", "400"],
    "https://discord.com/channels/1/2/3"
  );
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal(message.content, undefined);
  assert.equal(message.embeds, undefined);
  assert.deepEqual(container.components.map((component: { content: string }) => component.content), [
    "# Giveaway Drawn",
    "🎉 Congratulations <@100> <@200> <@400>! You are the winners of <@300>’s giveaway!",
    "**Giveaway**\n[Founder \\] Pack](https://discord.com/channels/1/2/3)",
    "**Host**\n<@300>",
    "**Drawn**\n<t:1785591600:F> (<t:1785591600:R>)",
    "**Winners**\n<@100> <@200> <@400>"
  ]);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["100", "200", "400", "300"],
    repliedUser: false
  });
});

test("single-winner draw announcement uses singular wording", () => {
  const message = buildDrawAnnouncement(
    {
      creatorDiscordUserId: "300",
      title: "Host Winner",
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      drawnAt: new Date("2026-08-01T13:40:00.000Z")
    },
    ["300"],
    "https://discord.com/channels/1/2/3"
  );
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.deepEqual(container.components.map((component: { content: string }) => component.content), [
    "# Giveaway Drawn",
    "🎉 Congratulations <@300>! You are the winner of <@300>’s giveaway!",
    "**Giveaway**\n[Host Winner](https://discord.com/channels/1/2/3)",
    "**Host**\n<@300>",
    "**Drawn**\n<t:1785591600:F> (<t:1785591600:R>)",
    "**Winner**\n<@300>"
  ]);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["300"],
    repliedUser: false
  });
});

test("no-winner draw announcement still notifies the host", () => {
  const message = buildDrawAnnouncement(
    {
      creatorDiscordUserId: "300",
      title: "No Winners",
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      drawnAt: new Date("2026-08-01T13:40:00.000Z")
    },
    [],
    "https://discord.com/channels/1/2/3"
  );
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.deepEqual(container.components.map((component: { content: string }) => component.content), [
    "# Giveaway Drawn",
    "<@300>, your giveaway has ended with no eligible winners.",
    "**Giveaway**\n[No Winners](https://discord.com/channels/1/2/3)",
    "**Host**\n<@300>",
    "**Drawn**\n<t:1785591600:F> (<t:1785591600:R>)",
    "**Winners**\nNo eligible winners."
  ]);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["300"],
    repliedUser: false
  });
});

test("public giveaway V2 fields pair colon-free titles with content and keep Markdown headings unbolded", () => {
  const messages = [
    buildOpenGiveawayV2Message({
      creatorDiscordUserId: "300",
      title: "Founder Pack",
      description: "Description",
      imageAttachmentName: undefined,
      notificationRoleId: undefined,
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      winnerCount: 1
    }, []),
    buildClosedGiveawayV2Message({
      creatorDiscordUserId: "300",
      title: "Founder Pack",
      description: "Description",
      imageAttachmentName: undefined,
      notificationRoleId: undefined,
      winnerCount: 1
    }, [], {
      state: "drawn",
      at: new Date("2026-08-01T13:40:00.000Z")
    }),
    buildDrawAnnouncement({
      creatorDiscordUserId: "300",
      title: "Founder Pack",
      drawAt: new Date("2026-08-02T09:00:00.000Z"),
      drawnAt: new Date("2026-08-01T13:40:00.000Z")
    }, ["100"], "https://discord.com/channels/1/2/3"),
    buildRedrawAnnouncement(
      { creatorDiscordUserId: "300", title: "Founder Pack" },
      "400",
      new Date("2026-08-01T14:00:00.000Z"),
      "https://discord.com/channels/1/2/3"
    )
  ];

  for (const message of messages) {
    const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
    const headingLines = container.components
      .filter((component: { type: number }) => component.type === 10)
      .flatMap((component: { content: string }) => component.content.split("\n"))
      .filter((line: string) => /^#{1,6} /.test(line));
    const textDisplays = container.components
      .filter((component: { type: number }) => component.type === 10);
    assert.ok(headingLines.length > 0);
    assert.ok(headingLines.every((line: string) => !line.includes("**")));
    assert.ok(textDisplays.every((component: { content: string }) => {
      if (!component.content.includes("\n")) return true;
      return /^\*\*[^\n:]+\*\*\n[^\n]+$/.test(component.content);
    }));
  }
});

test("redraw announcement uses the singular congratulations and notifies only the replacement and host", () => {
  const message = buildRedrawAnnouncement(
    { creatorDiscordUserId: "300", title: "Founder Pack" },
    "400",
    new Date("2026-08-01T14:00:00.000Z"),
    "https://discord.com/channels/1/2/3"
  );
  const container = (message.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  assert.equal(message.flags, MessageFlags.IsComponentsV2);
  assert.equal(message.content, undefined);
  assert.equal(message.embeds, undefined);
  assert.deepEqual(container.components.map((component: { content: string }) => component.content), [
    "# Giveaway Redrawn",
    "🎉 Congratulations <@400>! You are the winner of <@300>’s giveaway!",
    "**Giveaway**\n[Founder Pack](https://discord.com/channels/1/2/3)",
    "**Replacement Winner**\n<@400>",
    "**Host**\n<@300>",
    "**Updated**\n<t:1785592800:F> (<t:1785592800:R>)"
  ]);
  assert.deepEqual(message.allowedMentions, {
    parse: [],
    users: ["400", "300"],
    repliedUser: false
  });
});

test("winner selection is unique, bounded, and drawn from participants", () => {
  const selected = selectRandomUnique(["1", "2", "2", "3"], 5);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected).size, 3);
  assert.ok(selected.every((id) => ["1", "2", "3"].includes(id)));
});

function giveawayRecord(overrides: Partial<GiveawayRecord> = {}): GiveawayRecord {
  return {
    giveawayId: "69",
    discordGuildId: "guild-1",
    channelId: "channel-1",
    originalMessageId: "message-1",
    creatorDiscordUserId: "300",
    title: "Founder Pack",
    description: "React for a chance to win.",
    imageAttachmentName: "giveaway-image.png",
    drawAt: new Date("2026-08-02T09:00:00.000Z"),
    winnerCount: 3,
    state: "open",
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides
  };
}

function retainedImageMessage(
  url: string,
  edits: MessageEditOptions[],
  proxyUrl?: string
) {
  return {
    attachments: new Collection(),
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [{
          type: ComponentType.MediaGallery,
          items: [{
            media: {
              url,
              ...(proxyUrl ? { proxy_url: proxyUrl } : {})
            },
            description: "Founder Pack"
          }]
        }]
      })
    }],
    embeds: [],
    reactions: { cache: new Collection() },
    edit: async (options: MessageEditOptions) => {
      edits.push(options);
    }
  };
}

function testGuild(message: ReturnType<typeof retainedImageMessage>): Guild {
  const channel = {
    isTextBased: () => true,
    send: async () => undefined,
    messages: { fetch: async () => message }
  };
  return {
    id: "guild-1",
    channels: { fetch: async () => channel }
  } as unknown as Guild;
}

function testLogger() {
  return {
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined
  } as unknown as Parameters<typeof createGiveawayService>[1];
}

function mediaUrl(options: MessageEditOptions): string | undefined {
  const container = (options.components?.[0] as { toJSON(): ReturnType<typeof JSON.parse> }).toJSON();
  return container.components
    .find((component: { type: number }) => component.type === ComponentType.MediaGallery)
    ?.items[0].media.url;
}

for (const [date, time] of [
  ["2099-01-01", "24:01"],
  ["2000-01-01", "24"]
]) {
  test(`giveaway create rejects invalid or past UTC input ${date} ${time}`, async () => {
    const titles: string[] = [];
    await handleGiveawayCommand({
      inCachedGuild: () => true, guildId: "guild-1",
      channel: { isTextBased: () => true, send: async () => undefined, messages: {}, permissionsFor: () => ({ has: () => true }) },
      options: {
        getSubcommand: () => "create",
        getString: (name: string) => name === "date" ? date : time
      },
      reply: async (payload: { embeds: Array<{ toJSON(): { title?: string } }> }) => {
        titles.push(messageSummary(payload) ?? "");
      },
      showModal: async () => assert.fail("Invalid time must not open a creation modal")
    } as unknown as ChatInputCommandInteraction, {} as never, testLogger(), giveawayEntries({}));
    assert.deepEqual(titles, [date === "2000-01-01" ? "Choose a future UTC draw time." : "Invalid Draw Time"]);
  });
}

function managementGuild(timeout?: number) {
  return { id: "guild-1", members: { fetch: async () => ({ user: { id: "300", bot: false }, permissions: { has: () => false }, communicationDisabledUntilTimestamp: timeout }) } };
}

function giveawayEntries(channel: unknown) {
  return {
    checkAccess: async () => ({ channel, discordChannelId: "channel-1", configurationRevision: "revision-1" }),
    requireRole: async () => assert.fail("Giveaway hosting must not require a configured role"),
    runExclusive: async (_guild: string, operation: () => Promise<unknown>) => operation(),
    refresh: async () => undefined
  } as unknown as NonNullable<Parameters<typeof handleGiveawayCommand>[3]>;
}

test("giveaway create fails closed without configuration or current channel and registration access", async () => {
  const responses: string[] = [];
  let modalOpened = false;
  const i = {
    inCachedGuild: () => true, guildId: "guild-1", user: { id: "owner" },
    options: { getSubcommand: () => "create" },
    reply: async (payload: { embeds: Array<{ toJSON(): { title?: string } }> }) => { responses.push(messageSummary(payload) ?? ""); },
    showModal: async () => { modalOpened = true; }
  } as unknown as ChatInputCommandInteraction;
  await handleGiveawayCommand(i, {} as never, testLogger());
  assert.deepEqual(responses, ["Ask a Discord Administrator to configure this feature’s channel."]);
  let accessChecked = false;
  const entries = giveawayEntries({});
  entries.checkAccess = async () => { accessChecked = true; return undefined; };
  await handleGiveawayCommand(i, {} as never, testLogger(), entries);
  assert.equal(accessChecked, true);
  assert.equal(modalOpened, false);
});

test("timed-out hosts cannot invoke giveaway mutations and the bot checks before reading the giveaway", async () => {
  const titles: string[] = [];
  const i = {
    inCachedGuild: () => true, guildId: "guild-1", guild: managementGuild(Date.now() + 60_000), user: { id: "300" },
    options: { getSubcommand: () => "draw", getString: () => "69" },
    deferReply: async () => undefined,
    editReply: async (payload: { embeds: Array<{ toJSON(): { title?: string } }> }) => { titles.push(messageSummary(payload) ?? ""); }
  } as unknown as ChatInputCommandInteraction;
  await handleGiveawayCommand(i, { isHostAuthorityRevoked: async () => false, getById: async () => assert.fail("Timed-out callers cannot reach the mutation") } as never, testLogger());
  assert.deepEqual(titles, ["You must be a current Discord member who is not timed out to manage giveaways."]);
});

test("slash cancel confirmation is owner-bound and single-use with the approved wording", async () => {
  const payloads: Array<{ embeds?: Array<{ toJSON(): { title?: string; description?: string } }>; components?: Array<{ toJSON(): { components: Array<{ custom_id: string; label: string }> } }> }> = [];
  const i = {
    inCachedGuild: () => true, guildId: "guild-1", guild: managementGuild(), user: { id: "300" },
    options: { getSubcommand: () => "cancel", getString: () => "69" },
    deferReply: async () => undefined, editReply: async (p: typeof payloads[number]) => { payloads.push(p); }
  } as unknown as ChatInputCommandInteraction;
  const repository = { isHostAuthorityRevoked: async () => false, getById: async () => giveawayRecord() } as never;
  await handleGiveawayCommand(i, repository, testLogger());
  const confirmation = payloads[0];
  assert.equal(messageSummary(confirmation), "Cancel Giveaway");
  assert.equal(messageDescription(confirmation), "Cancel “Founder Pack”? No winners will be drawn.");
  const id = messageRows(confirmation)[0].components[1].custom_id;
  const button = (user: string) => ({ customId: id, inCachedGuild: () => true, guildId: "guild-1", user: { id: user }, reply: async (p: typeof payloads[number]) => { payloads.push(p); }, update: async (p: typeof payloads[number]) => { payloads.push(p); } });
  await handleGiveawayButton(button("other") as never, repository, testLogger());
  assert.equal(messageSummary(payloads.at(-1)), "Only the command user can use these controls.");
  await handleGiveawayButton(button("300") as never, repository, testLogger());
  assert.equal(messageSummary(payloads.at(-1)), "Giveaway Kept");
  await handleGiveawayButton(button("300") as never, repository, testLogger());
  assert.equal(messageSummary(payloads.at(-1)), "This control is no longer current. Open the latest entry panel and start again.");
});
