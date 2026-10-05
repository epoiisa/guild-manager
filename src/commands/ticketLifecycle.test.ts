import { ChannelType, EmbedBuilder, MessageFlags, type ButtonInteraction } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { Ticket, TicketClass } from "../db/ticketRepository.js";
import { handleTicketButton } from "./ticket.js";

test("ticket lifecycle controls acknowledge before reading or changing remote state", async () => {
  const harness = createHarness();
  harness.interaction.customId = "ticket:close:1";

  await runButton(harness);

  assert.deepEqual(harness.events.slice(0, 2), ["deferUpdate", "getTicket"]);
  assert.equal(harness.ticket.status, "closed");
  assert.deepEqual(harness.permissionValues, [false, false]);
  assert.equal((harness.editedReplies[0] as { flags?: MessageFlags }).flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(componentLabels(harness.editedReplies[0]), []);
  assert.equal(cardTitle(harness.followUps[0]), "Ticket closed by <@opener>.");
  assert.deepEqual(componentLabels(harness.followUps[0]), ["Reopen", "Delete"]);
  assert.equal(harness.ticket.controlMessageId, "follow-up-1");
});

test("closed and reopened cards preserve exact copy, controls, and suppressed notifications without guidance", async () => {
  const harness = createHarness({ controlMessageId: "control-message" });
  harness.ticketClass.closedMessage = "Please keep this channel for reference.";
  harness.interaction.customId = "ticket:close:1";

  await runButton(harness);

  assert.deepEqual(cardText(harness.followUps[0]), [
    "# Ticket Closed",
    "Ticket closed by <@opener>.\n\nPlease keep this channel for reference."
  ]);
  assert.deepEqual(componentLabels(harness.followUps[0]), ["Reopen", "Delete"]);
  assert.deepEqual((harness.followUps[0] as { allowedMentions?: unknown }).allowedMentions, { parse: [], repliedUser: false });

  harness.interaction.message = harness.followUpMessages[0];
  harness.interaction.customId = "ticket:reopen:1";
  await runButton(harness);

  assert.deepEqual(cardText(harness.followUps[1]), [
    "Ticket reopened by <@opener>."
  ]);
  assert.deepEqual(componentLabels(harness.followUps[1]), ["Close"]);
  assert.deepEqual((harness.followUps[1] as { allowedMentions?: unknown }).allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(cardText(harness.editedReplies.at(-1)), [
    "# Ticket Closed",
    "Ticket closed by <@opener>.\n\nPlease keep this channel for reference."
  ]);
  assert.deepEqual(componentLabels(harness.editedReplies.at(-1)), []);
});

test("opening a ticket persists the initial lifecycle control message id", async () => {
  const harness = createHarness();
  harness.interaction.customId = "ticket:open:class-1";
  await runButton(harness);
  assert.equal(harness.ticket.controlMessageId, "initial-control-message");
  assert.deepEqual(harness.ticketControlMessageIdUpdates, ["initial-control-message"]);
  const initialMessage = harness.sentMessages[0] as { content?: string; embeds?: unknown; flags?: MessageFlags; allowedMentions?: unknown };
  assert.equal(initialMessage.flags, MessageFlags.IsComponentsV2);
  assert.equal(initialMessage.content, undefined);
  assert.equal(initialMessage.embeds, undefined);
  assert.deepEqual(cardText(initialMessage), [
    "# General Ticket",
    "<@opener>, this is your private ticket channel.",
    "Attn: <@&reviewer-role>"
  ]);
  assert.deepEqual(initialMessage.allowedMentions, { parse: [], users: ["opener"], roles: ["reviewer-role"], repliedUser: false });
  assert.deepEqual(componentLabels(initialMessage), ["Close"]);
});

test("close and reopen advance the canonical ticket control message id", async () => {
  const harness = createHarness({ controlMessageId: "control-message" });
  harness.interaction.customId = "ticket:close:1";
  await runButton(harness);
  assert.equal(harness.ticket.controlMessageId, "follow-up-1");
  harness.interaction.message = harness.followUpMessages[0];
  harness.interaction.customId = "ticket:reopen:1";
  await runButton(harness);
  assert.equal(harness.ticket.controlMessageId, "follow-up-2");
  assert.equal(cardTitle(harness.followUps[1]), "Ticket reopened by <@opener>.");
  assert.deepEqual(componentLabels(harness.followUps[1]), ["Close"]);
});

for (const [state, footer] of [
  ["open", "The ticket opener or reviewers can close this ticket."],
  ["closed", "The ticket opener or reviewers can reopen this ticket. Reviewers can delete it."],
  ["open", "Keep this channel for reference."]
] as const) {
  const informational = footer === "Keep this channel for reference.";
  for (const format of ["V2", "classic"] as const) {
    test(`retiring a legacy ${format} ${state} ticket ${informational ? "preserves informational footers" : "removes guidance while preserving configured text"}`, async () => {
      const harness = createHarness({ status: state });
      const action = state === "open" ? "close" : "reopen";
      const controls = { type: 1, components: [{ type: 2, custom_id: `ticket:${action}:1`, label: state === "open" ? "Close" : "Reopen" }] };
      // Identical wording in the body is configured content, not a footer.
      if (format === "V2") {
        harness.interaction.message.components = [{ type: 17, components: [
          { type: 10, content: "# General Ticket" },
          { type: 10, content: footer },
          { type: 10, content: `*${footer}*` },
          controls
        ] }];
      } else {
        harness.interaction.message.components = [controls];
        harness.interaction.message.embeds = [new EmbedBuilder()
          .setTitle("General Ticket").setDescription(footer).setFooter({ text: footer })];
      }
      harness.interaction.customId = `ticket:${action}:1`;

      await runButton(harness);

      assert.equal(harness.ticket.controlMessageId, "follow-up-1");
      assert.equal((harness.editedReplies[0] as { flags?: MessageFlags }).flags, MessageFlags.IsComponentsV2);
      assert.deepEqual(cardText(harness.editedReplies[0]), [
        "# General Ticket", footer, ...(informational ? [`*${footer}*`] : [])
      ]);
      assert.deepEqual(componentLabels(harness.editedReplies[0]), []);
      assert.deepEqual((harness.editedReplies[0] as { allowedMentions?: unknown }).allowedMentions, { parse: [], repliedUser: false });
    });
  }
}

test("a mismatched canonical ticket control id is stale without mutation", async () => {
  const harness = createHarness({ controlMessageId: "other" });
  harness.interaction.customId = "ticket:close:1";
  await runButton(harness);
  assert.equal(embedTitle(harness.followUps[0] ?? harness.replies[0]), "Use the controls on the current matching ticket message.");
  assert.deepEqual(harness.permissionValues, []);
  assert.equal(harness.closedBy, undefined);
  assert.deepEqual(harness.editedReplies, []);
});

test("an already-closed ticket repairs its stale Close control", async () => {
  const harness = createHarness({ status: "closed" });
  harness.interaction.customId = "ticket:close:1";

  await runButton(harness);

  assert.equal(harness.closedBy, undefined);
  assert.deepEqual(harness.permissionValues, [false, false]);
  assert.deepEqual(componentLabels(harness.editedReplies[0]), []);
  assert.deepEqual(componentLabels(harness.followUps[0]), ["Reopen", "Delete"]);
  assert.equal(cardText(harness.followUps[0]).at(0), "This ticket is closed.");
});

test("a concurrent ticket close transition is treated idempotently", async () => {
  const harness = createHarness();
  harness.interaction.customId = "ticket:close:1";
  (harness.repository as unknown as Parameters<typeof handleTicketButton>[1]).markTicketClosed = async (_guildId: string, _ticketId: string, actorId: string) => {
    harness.closedBy = actorId;
    harness.ticket.status = "closed";
    return undefined;
  };

  await runButton(harness);

  assert.equal(harness.closedBy, "opener");
  assert.equal(harness.ticket.status, "closed");
  assert.deepEqual(componentLabels(harness.followUps[0]), ["Reopen", "Delete"]);
});

test("a ticket presentation failure after closing is recoverable from the stale control", async () => {
  const harness = createHarness();
  harness.interaction.customId = "ticket:close:1";
  let failPresentation = true;
  harness.interaction.followUp = async (payload: unknown) => {
    if (failPresentation) {
      failPresentation = false;
      throw new Error("Unknown interaction");
    }
    return harness.recordFollowUp(payload);
  };

  await assert.rejects(runButton(harness), /Unknown interaction/);
  assert.equal(harness.ticket.status, "closed");

  await runButton(harness);

  assert.deepEqual(componentLabels(harness.followUps.at(-1)), ["Reopen", "Delete"]);
  assert.equal(cardText(harness.followUps.at(-1)).at(0), "This ticket is closed.");
});

test("ticket deletion failure leaves the lifecycle closed and retryable", async () => {
  const harness = createHarness({ status: "closed" }, { actorId: "reviewer", reviewer: true });
  harness.interaction.customId = "ticket:delete:1";
  harness.channel.delete = async () => { throw new Error("Missing Permissions"); };

  await assert.rejects(runButton(harness), /Missing Permissions/);

  assert.equal(harness.ticket.status, "closed");
  assert.equal(harness.deletedBy, undefined);
});

test("successful ticket deletion records the actor after Discord removes the channel", async () => {
  const harness = createHarness({ status: "closed" }, { actorId: "reviewer", reviewer: true });
  harness.interaction.customId = "ticket:delete:1";

  await runButton(harness);

  assert.equal(harness.channelDeleted, true);
  assert.equal(harness.ticket.status, "deleted");
  assert.equal(harness.deletedBy, "reviewer");
});

type HarnessOptions = {
  actorId?: string;
  reviewer?: boolean;
};

function createHarness(ticketOverrides: Partial<Ticket> = {}, options: HarnessOptions = {}) {
  const ticketClass: TicketClass = {
    ticketClassId: "class-1",
    discordGuildId: "guild-1",
    name: "General Ticket",
    ticketCategoryId: "category-1",
    reviewerRoleId: "reviewer-role",
    enabled: true,
    createdByDiscordUserId: "creator"
  };
  const ticket: Ticket = {
    ticketId: "1",
    ticketClassId: ticketClass.ticketClassId,
    discordGuildId: ticketClass.discordGuildId,
    openerDiscordUserId: "opener",
    ticketChannelId: "channel-1",
    status: "open",
    ...ticketOverrides
  };
  const events: string[] = [];
  const replies: unknown[] = [];
  const followUps: unknown[] = [];
  const editedReplies: unknown[] = [];
  const permissionValues: boolean[] = [];
  const sentMessages: unknown[] = [];
  const followUpMessages: any[] = [];
  const channelMessages = new Map<string, any>();
  let channel: {
    type: ChannelType;
    guild: unknown;
    permissionOverwrites: { edit(id: string, permissions: { SendMessages: boolean }): Promise<void> };
    delete(reason: string): Promise<void>;
    send(payload: unknown): Promise<{ id: string }>;
    messages: { fetch(id: string): Promise<any> };
    client: { user: { id: string } };
    id: string;
  };
  const guild = {
    channels: { cache: { get: () => channel }, create: async () => channel },
    roles: { everyone: { id: "everyone" } },
    members: {
      fetch: async ({ user }: { user?: string } = {}) => ({ id: user ?? ticket.openerDiscordUserId })
    }
  };
  channel = {
    id: "channel-1",
    type: ChannelType.GuildText,
    guild,
    client: { user: { id: "bot" } },
    messages: { fetch: async (id: string) => channelMessages.get(id) },
    permissionOverwrites: {
      edit: async (_id: string, permissions: { SendMessages: boolean }) => {
        permissionValues.push(permissions.SendMessages);
      }
    },
    delete: async () => { harness.channelDeleted = true; },
    send: async (payload: unknown) => { sentMessages.push(payload); return { id: "initial-control-message" }; }
  };
  const interaction: any = {
    customId: "",
    guildId: "guild-1",
    channelId: "channel-1",
    guild,
    user: {
      id: options.actorId ?? "opener",
      username: "opener",
      toString: () => `<@${options.actorId ?? "opener"}>`
    },
    member: { roles: { cache: { has: () => options.reviewer ?? false } } },
    client: { user: { id: "bot" } },
    message: { id: "control-message", author: { id: "bot" }, components: [{ type: 17, components: [{ type: 10, content: "# General Ticket" }, { type: 1, components: [{ type: 2, custom_id: "ticket:close:1", label: "Close" }] }] }], embeds: [] },
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    deferReply: async () => undefined,
    deferUpdate: async () => {
      interaction.deferred = true;
      events.push("deferUpdate");
    },
    reply: async (payload: unknown) => {
      interaction.replied = true;
      replies.push(payload);
    },
    followUp: async (payload: unknown) => harness.recordFollowUp(payload),
    editReply: async (payload: unknown) => { editedReplies.push(payload); }
  };
  const harness = {
    ticketClass,
    ticket,
    channel,
    interaction,
    events,
    replies,
    followUps,
    editedReplies,
    sentMessages,
    followUpMessages,
    permissionValues,
    closedBy: undefined as string | undefined,
    reopenedBy: undefined as string | undefined,
    deletedBy: undefined as string | undefined,
    channelDeleted: false,
    ticketControlMessageIdUpdates: [] as Array<string | undefined>,
    recordFollowUp: async (payload: unknown) => {
      followUps.push(payload);
      const id = `follow-up-${followUps.length}`;
      const message: any = {
        id,
        author: { id: "bot" },
        components: (payload as { components?: unknown[] }).components ?? [],
        embeds: [],
        edit: async (editPayload: unknown) => {
          editedReplies.push(editPayload);
          message.components = (editPayload as { components?: unknown[] }).components ?? message.components;
          return message;
        }
      };
      followUpMessages.push(message);
      channelMessages.set(id, message);
      return message;
    },
    repository: {
      getTicket: async () => { events.push("getTicket"); return ticket; },
      getTicketClass: async () => ticketClass,
      createTicket: async () => ticket,
      setTicketChannel: async () => undefined,
      setTicketControlMessageId: async (_guildId: string, _ticketId: string, messageId: string | undefined) => {
        harness.ticketControlMessageIdUpdates.push(messageId);
        ticket.controlMessageId = messageId;
        return ticket;
      },
      claimTicketControlMessageId: async (_guildId: string, _ticketId: string, expectedMessageId: string | undefined, candidateMessageId: string) => {
        if (ticket.controlMessageId !== expectedMessageId) return false;
        harness.ticketControlMessageIdUpdates.push(candidateMessageId);
        ticket.controlMessageId = candidateMessageId;
        return true;
      },
      markTicketClosed: async (_guildId: string, _ticketId: string, actorId: string) => {
        harness.closedBy = actorId;
        ticket.status = "closed";
        return ticket;
      },
      markTicketReopened: async (_guildId: string, _ticketId: string, actorId: string) => {
        harness.reopenedBy = actorId;
        ticket.status = "open";
        return ticket;
      },
      markTicketDeleted: async (_guildId: string, _ticketId: string, actorId: string) => {
        harness.deletedBy = actorId;
        ticket.status = "deleted";
        return ticket;
      }
    }
  };
  return harness;
}

function componentLabels(payload: unknown): Array<string | undefined> {
  return componentData(payload).flatMap((component) => component.label ? [component.label] : component.components?.flatMap((child) => child.label ? [child.label] : []) ?? []);
}

function componentData(payload: unknown): Array<{ type?: number; content?: string; label?: string; custom_id?: string; components?: Array<{ label?: string; custom_id?: string }> }> {
  const components = (payload as any)?.components ?? [];
  return components.flatMap((component: any) => component.toJSON?.().components ?? component.components ?? []);
}

function cardText(payload: unknown): string[] {
  if (typeof (payload as { content?: unknown })?.content === "string") return [(payload as { content: string }).content]; return componentData(payload).flatMap((component) => component.content ? [component.content] : []); }
function cardTitle(payload: unknown): string | undefined {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content; return cardText(payload).at(0)?.slice(2); }

function embedTitle(payload: unknown): string | undefined {
  const embed = (payload as { embeds?: Array<{ toJSON(): { title?: string } }> }).embeds?.[0];
  return embed?.toJSON().title ?? cardTitle(payload);
}

function embedDescription(payload: unknown): string | undefined {
  if (typeof (payload as { content?: unknown })?.content === "string") return (payload as { content: string }).content;
  const embed = (payload as { embeds?: Array<{ toJSON(): { description?: string } }> }).embeds?.[0];
  return embed?.toJSON().description ?? cardText(payload).find((text, index) => index > 0 && !text.startsWith("**"));
}

async function runButton(harness: ReturnType<typeof createHarness>): Promise<void> {
  await handleTicketButton(
    harness.interaction as unknown as ButtonInteraction,
    harness.repository as unknown as Parameters<typeof handleTicketButton>[1]
  );
}
