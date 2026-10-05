import assert from "node:assert/strict";
import test from "node:test";
import { Collection, MessageFlags } from "discord.js";
import type { ContentSnapshot } from "../db/contentRepository.js";
import { handleContentButton } from "./content.js";
import { buildContentButtonId, buildStartNotification, buildContentUnstartedMessage, parseContentButtonId } from "../services/content/rendering.js";
import { canUnstartContent, getContentCleanupAt } from "../services/content/lifecycle.js";
import type { Logger } from "../logging/logger.js";

const revision = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
function snapshot(scheduled = false): ContentSnapshot {
  const now = new Date();
  return {
    content: {
      contentId: "content", discordGuildId: "guild", sourceChannelId: "source", threadChannelId: "thread",
      hostDiscordUserId: "host", title: "Party", description: "Retained description", state: "active",
      scheduledStartAt: scheduled ? new Date(now.getTime() + 3600000) : null,
      startedAt: now, firstStartedAt: now, startedByDiscordUserId: "original-host", startRevision: revision,
      startNotificationClaimedAt: now, startNotificationMessageId: "start", announcementMessageId: "announcement",
      detailsMessageId: "details", controlMessageId: "roles", lastRenderedAt: null,
      endedAt: null, cancelledAt: null, archivedAt: null, createdAt: now, updatedAt: now
    },
    slots: [{ contentRoleSlotId: "slot", contentId: "content", discordGuildId: "guild", slotIndex: 1, label: "Tank" }],
    signups: [{ contentSignupId: "signup", contentId: "content", discordGuildId: "guild", discordUserId: "member",
      contentRoleSlotId: "slot", signupType: "role", state: "active", removedAt: null, removedByDiscordUserId: null }]
  };
}
function text(payload: unknown): string {
  const json = JSON.parse(JSON.stringify(payload));
  return json.content ?? json.components.flatMap((c: any) => c.components ?? []).map((c: any) => c.content ?? "").filter(Boolean).join("\n");
}

for (const scheduled of [false, true]) test(`start wording and linked roster, scheduled=${scheduled}`, () => {
  const data = snapshot(scheduled);
  const message = buildStartNotification(data);
  const timestamp = Math.floor(data.content.startedAt!.getTime() / 1000);
  assert.equal(text(message), `# Party\n<@original-host> started the content at <t:${timestamp}:t> (<t:${timestamp}:R>).\n`
    + "[Details](https://discord.com/channels/guild/thread/details) • [Signups](https://discord.com/channels/guild/thread/roles)\n"
    + "1. Tank <@member>\n*Sign-ups are still active in the [pinned message](https://discord.com/channels/guild/thread/roles).*" );
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false, users: ["member"] });
  const buttons = JSON.parse(JSON.stringify(message)).components[0].components.flatMap((c: any) => c.components ?? []);
  assert.deepEqual(buttons.map((b: any) => b.label), ["Unstart"]);
  assert.equal(buttons[0].custom_id, `content:unstart:content:${revision}`);
  assert.ok(canUnstartContent(data.content));
});

test("scheduled automatic or late manual starts omit host attribution and Unstart", () => {
  for (const actor of [null, "host"]) {
    const data = snapshot(true);
    data.content.scheduledStartAt = new Date(data.content.startedAt!.getTime() - 1000);
    data.content.startedByDiscordUserId = actor;
    const message = buildStartNotification(data);
    assert.match(text(message), /Content started at <t:\d+:t> \(<t:\d+:R>\)\./);
    assert.doesNotMatch(text(message), /<@host>/);
    assert.doesNotMatch(JSON.stringify(message), /"label":"Unstart"/);
    assert.equal(canUnstartContent(data.content), false);
  }
});

test("Unstart ID binds one start and fits Discord's custom-ID limit", () => {
  const id = buildContentButtonId("unstart", revision, revision);
  assert.ok(id.length <= 100);
  assert.deepEqual(parseContentButtonId(id), { action: "unstart", contentId: revision, startRevision: revision });
  for (const invalid of ["content:unstart:content", "content:unstart:content:bad", `${id}:extra`]) {
    assert.equal(parseContentButtonId(invalid), undefined);
  }
});

for (const scheduled of [false, true]) test(`Unstart notice is silent, scheduled=${scheduled}`, () => {
  const message = buildContentUnstartedMessage(snapshot(scheduled).content);
  assert.equal(message.content, `<@host> has unstarted the content. ${scheduled
    ? "Content will start again at the scheduled time." : "Content is waiting for the host to start it again."}`);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
  assert.ok(Number(message.flags) & MessageFlags.SuppressNotifications);
});

function harness(options: { scheduled?: boolean; deleteFails?: boolean; sendFails?: boolean; refreshFails?: boolean } = {}) {
  const data = snapshot(options.scheduled);
  const replies: unknown[] = [], notices: unknown[] = [], edits: unknown[] = [];
  let deletes = 0, updates = 0, defers = 0;
  const message = { pinned: true, author: { id: "bot" }, attachments: new Collection(), edit: async (p: unknown) => {
    if (options.refreshFails) throw new Error("temporary edit failure");
    edits.push(p);
  } };
  const channel = { client: { user: { id: "bot" } }, isThread: () => true,
    messages: { fetch: async ({ message: id }: { message: string }) => ({ ...message, id }) },
    send: async (p: unknown) => { notices.push(p); if (options.sendFails) throw new Error("uncertain send"); return { id: "notice" }; } };
  const interaction = {
    customId: `content:unstart:content:${revision}`, inCachedGuild: () => true,
    guildId: "guild", channelId: "thread", user: { id: "host" }, channel,
    message: { id: "start", delete: async () => { deletes++; if (options.deleteFails) throw new Error("Unknown Message"); } },
    guild: { client: { user: { id: "bot" } }, channels: { fetch: async () => channel } },
    reply: async (p: unknown) => { replies.push(p); }, deferUpdate: async () => { defers++; }
  };
  const repository = {
    isHostAuthorityRevoked: async () => false,
    getContentSnapshot: async () => data,
    markUnstarted: async (_guild: string, _id: string, host: string, token: string, messageId: string) => {
      if (!canUnstartContent(data.content) || host !== data.content.hostDiscordUserId
        || token !== data.content.startRevision || messageId !== data.content.startNotificationMessageId) return undefined;
      updates++;
      data.content = { ...data.content, state: data.content.scheduledStartAt ? "scheduled" : "unscheduled",
        startedAt: null, startedByDiscordUserId: null, startRevision: null,
        startNotificationMessageId: null, startNotificationClaimedAt: null };
      return data.content;
    },
    markRendered: async () => undefined
  };
  return { data, interaction, repository, replies, notices, edits, counts: () => ({ deletes, updates, defers }),
    run: () => handleContentButton(interaction as never, repository as never, logger) };
}

for (const scheduled of [false, true]) for (const deleteFails of [false, true]) {
  test(`Unstart is consumed once, restores Start and tolerates deletion failure, scheduled=${scheduled}, failure=${deleteFails}`, async () => {
    const h = harness({ scheduled, deleteFails });
    const signups = structuredClone(h.data.signups), deadline = getContentCleanupAt(h.data.content);
    await Promise.all([h.run(), h.run()]);
    assert.equal(h.counts().updates, 1);
    assert.equal(h.counts().deletes, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.replies.length, 0);
    assert.equal(h.data.content.state, scheduled ? "scheduled" : "unscheduled");
    assert.deepEqual(h.data.signups, signups);
    assert.deepEqual(getContentCleanupAt(h.data.content), deadline);
    assert.match(JSON.stringify(h.edits), /"label":"Start"/);
  });
}

for (const failure of ["sendFails", "refreshFails"] as const) test(`Unstart remains saved after ${failure}`, async () => {
  const h = harness({ [failure]: true });
  await h.run();
  assert.equal(h.data.content.state, "unscheduled");
  assert.equal(h.counts().updates, 1);
  assert.equal(h.notices.length, 1);
  assert.equal(h.replies.length, 0);
});

for (const invalid of ["host", "message", "revision", "deadline", "schedule", "closed"] as const) {
  test(`Unstart rejects invalid ${invalid} without changing state or deleting messages`, async () => {
    const h = harness();
    if (invalid === "host") h.interaction.user.id = "former-host";
    if (invalid === "message") h.interaction.message.id = "old-start";
    if (invalid === "revision") h.data.content.startRevision = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    if (invalid === "deadline") h.data.content.firstStartedAt = new Date(Date.now() - 7 * 3600000);
    if (invalid === "schedule") h.data.content.scheduledStartAt = new Date(Date.now() - 1000);
    if (invalid === "closed") h.data.content.state = "ended";
    await h.run();
    assert.equal(h.counts().updates, 0);
    assert.equal(h.counts().deletes, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.replies.length, 1);
  });
}
