import assert from "node:assert/strict";
import test from "node:test";
import { Client, Collection, ComponentType, ContainerBuilder, ContainerComponent, MessageFlags, MessageFlagsBitField, MessagePayload, type Guild, type MessageCreateOptions, type RESTPatchAPIChannelMessageJSONBody } from "discord.js";
import type { ContentSnapshot } from "../../db/contentRepository.js";
import { refreshContentMessages } from "./messages.js";
import { buildContentActionRows, buildContentAnnouncementV2Message, buildContentControlV2Message, buildContentDetailsV2Message } from "./rendering.js";
import { createContentScheduler } from "./scheduler.js";

function fixture(unscheduled = false) {
  let snapshot: ContentSnapshot = {
    content: {
      contentId: "content-1", discordGuildId: "guild-1", sourceChannelId: "source-1", threadChannelId: "thread-1",
      hostDiscordUserId: "123", title: "Avalonian Dungeon", description: "Bring swaps and food.",
      scheduledStartAt: unscheduled ? null : new Date("2026-08-10T12:00:00Z"), state: unscheduled ? "unscheduled" : "scheduled",
      announcementMessageId: "announcement-1", detailsMessageId: "details-1", controlMessageId: "roles-1",
      startNotificationMessageId: null, lastRenderedAt: null, startedAt: null, endedAt: null,
      cancelledAt: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date(), renderRevision: "1"
    },
    slots: [{ contentRoleSlotId: "slot-1", contentId: "content-1", discordGuildId: "guild-1", slotIndex: 1, label: "Tank" }],
    signups: []
  };
  const edits: Array<{ id: string; payload: any }> = [], sends: any[] = [], saved: string[] = [], rendered: Array<string | undefined> = [];
  const messages = new Collection<string, any>();
  const client = { user: { id: "bot" } };
  let failure: string | undefined;
  let beforeEdit: (id: string, payload: any) => Promise<void> = async () => undefined;
  const makeMessage = (id: string, payload?: MessageCreateOptions) => {
    const message = {
      id, author: client.user, pinned: id === "roles-1", nonce: undefined as string | undefined,
      content: payload?.content ?? "", embeds: payload?.embeds ?? [], flags: new MessageFlagsBitField(Number(payload?.flags ?? 0)),
      attachments: new Collection<string, { id?: string; name: string; url: string; proxyURL?: string }>(), components: payload?.components ?? [],
      edit: async (update: any) => {
        edits.push({ id, payload: update });
        await beforeEdit(id, update);
        message.components = update.components ?? [];
        message.content = update.content ?? "";
        message.embeds = update.embeds ?? [];
        if (update.flags !== undefined) message.flags = new MessageFlagsBitField(update.flags);
        if (update.attachments?.length === 0) message.attachments.clear();
      },
      pin: async () => { message.pinned = true; }, unpin: async () => { message.pinned = false; }
    };
    messages.set(id, message);
    return message;
  };
  const details = makeMessage("details-1", buildContentDetailsV2Message(snapshot.content));
  const roles = makeMessage("roles-1", buildContentControlV2Message(snapshot));
  const announcement = makeMessage("announcement-1", buildContentAnnouncementV2Message(snapshot.content));
  const thread = {
    client, isThread: () => true,
    messages: { fetch: async (options: string | { message?: string }) => {
      const id = typeof options === "string" ? options : options.message;
      if (!id) return messages.filter(message => message.id !== "announcement-1");
      if (failure === id) throw new Error("temporary message lookup");
      if (!messages.has(id)) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      return messages.get(id);
    } },
    send: async (payload: any) => {
      sends.push(payload);
      const message = makeMessage("sent-" + sends.length, payload);
      message.nonce = payload.nonce;
      return message;
    }
  };
  const guild = {
    id: "guild-1", client, channels: { fetch: async (id: string) => {
      if (id !== "source-1") {
        if (failure === "thread") throw new Error("temporary thread lookup");
        return thread;
      }
      return { messages: { fetch: async () => {
        if (failure?.startsWith("parent")) throw Object.assign(new Error("parent lookup failure"), { code: failure === "parent-missing" ? 10008 : 50013 });
        return announcement;
      } } };
    } }
  } as unknown as Guild;
  const repository = {
    getContentSnapshot: async () => snapshot,
    setDetailsMessage: async (_g: string, _c: string, id: string) => { saved.push(id); snapshot.content.detailsMessageId = id; },
    setControlMessage: async (_g: string, _c: string, id: string) => { saved.push(id); snapshot.content.controlMessageId = id; },
    markRendered: async (_g: string, _c: string, revision?: string) => {
      rendered.push(revision);
      if (revision === snapshot.content.renderRevision) snapshot.content.renderedRevision = revision;
    },
    reconcileSignupRequestClosure: async () => undefined, listSignupRequests: async () => [],
    listContentNeedingSignupApprovalReconciliation: async () => [], listContentForThreadTitleReconciliation: async () => [],
    listContentNeedingControlMessage: async (includeRendered = false) => includeRendered || snapshot.content.renderedRevision !== snapshot.content.renderRevision ? [snapshot.content] : []
  } as unknown as Parameters<typeof refreshContentMessages>[1];
  return {
    guild, repository, messages, announcement, details, roles, edits, sends, saved, rendered,
    snapshot: () => snapshot, replace: (value: ContentSnapshot) => { snapshot = value; },
    fail: (value: typeof failure) => { failure = value; },
    onEdit: (callback: typeof beforeEdit) => { beforeEdit = callback; },
    refresh: (graphic?: string) => refreshContentMessages(guild, repository, snapshot, graphic, "controls")
  };
}

function resolveGalleryGraphic(message: { components: NonNullable<MessageCreateOptions["components"]> }, idField: "attachment_id" | "id", id = "image", url = "https://cdn.example/builds.png?current-signature") {
  const components = JSON.parse(JSON.stringify(message.components));
  const gallery = components[0].components.find((child: any) => child.type === ComponentType.MediaGallery);
  assert.ok(gallery, "the graphic must still be present before the Discord round trip");
  gallery.items[0].media = { [idField]: id, url, content_type: "image/png", width: 800, height: 600 };
  // Hydrate received Discord components through the SDK's internal constructor.
  message.components = components.map((component: any) => Reflect.construct(ContainerComponent, [component]));
}

function galleryGraphicFixture(unscheduled = false, idField: "attachment_id" | "id" = "attachment_id") {
  const f = fixture(unscheduled);
  f.snapshot().content.graphicAttachmentName = "builds.png";
  f.details.components = buildContentDetailsV2Message(f.snapshot().content).components!;
  resolveGalleryGraphic(f.details, idField);
  assert.equal(f.details.attachments.size, 0, "Discord may expose the image only in gallery metadata");
  return f;
}

for (const unscheduled of [false, true]) {
  test("refresh repairs the three-message layout, unscheduled=" + unscheduled, async () => {
    const f = fixture(unscheduled);
    f.announcement.components = [];
    f.announcement.content = "Legacy announcement";
    f.announcement.flags = new MessageFlagsBitField();
    f.messages.delete("details-1"); f.messages.delete("roles-1");
    await f.refresh();
    assert.equal(f.sends.length, 2);
    assert.match(JSON.stringify(f.sends[0]), /Bring swaps.*Host.*content:start:/);
    assert.doesNotMatch(JSON.stringify(f.sends[0]), /# Roles|Host approval|content:(join|standby|leave):/);
    assert.match(JSON.stringify(f.sends[1]), /# Roles.*Host approval/);
    assert.doesNotMatch(JSON.stringify(f.sends[1]), /Bring swaps|\*\*Host\*\*|content:(start|edit|cancel):/);
    assert.match(JSON.stringify(f.sends[1]), /content:join:.*content:standby:.*content:leave:/);
    const announcement = f.edits[0].payload;
    assert.equal(announcement.flags, MessageFlags.IsComponentsV2);
    assert.equal(announcement.content, null); assert.deepEqual(announcement.embeds, []);
    assert.doesNotMatch(JSON.stringify(announcement), /Bring swaps|content:|\*\*Host/);
    assert.equal(JSON.stringify(announcement).includes("<t:"), !unscheduled);
    assert.deepEqual(f.saved, ["sent-1", "sent-2"]);
    assert.equal(f.messages.get("sent-2").pinned, true);
    assert.deepEqual(f.edits.map(edit => edit.id), ["announcement-1"]);
    assert.deepEqual(f.rendered, ["1"]);
  });
}

for (const unscheduled of [false, true]) {
  for (const graphic of [false, true]) {
    test(`unchanged party messages are not edited, unscheduled=${unscheduled}, graphic=${graphic}`, async () => {
      const f = fixture(unscheduled);
      if (graphic) {
        f.snapshot().content.graphicAttachmentName = "builds.png";
        f.details.attachments.set("image", {
          id: "image", name: "builds.png", url: "https://cdn.example/builds.png?current-signature",
          proxyURL: "https://media.example/builds.png?current-signature"
        });
      }
      const details = JSON.parse(JSON.stringify(buildContentDetailsV2Message(f.snapshot().content))).components[0];
      details.id = 1;
      details.spoiler = false;
      for (const [index, child] of details.components.entries()) {
        child.id = index + 2;
        if (child.type === ComponentType.ActionRow) {
          for (const button of child.components) button.disabled = false;
        }
        if (child.type === ComponentType.MediaGallery) {
          child.items[0].spoiler = false;
          child.items[0].description = null;
          child.items[0].media = {
            url: "https://cdn.example/builds.png?earlier-signature", attachment_id: "image",
            proxy_url: "https://media.example/builds.png", width: 800, height: 600,
            content_type: "image/png", loading_state: 2
          };
        }
      }
      f.details.components = [{ toJSON: () => details }];
      await f.refresh();
      await f.refresh();
      assert.deepEqual(f.edits, []);
      assert.deepEqual(f.sends, []);
      assert.deepEqual(f.rendered, ["1", "1"]);
    });
  }

  for (const idField of [undefined, "attachment_id", "id"] as const) {
    test(`signup changes edit only roles, unscheduled=${unscheduled}, gallery=${idField ?? "none"}`, async () => {
      const f = idField ? galleryGraphicFixture(unscheduled, idField) : fixture(unscheduled);
      f.snapshot().signups.push({
        contentSignupId: "signup", contentId: "content-1", contentRoleSlotId: "slot-1", discordGuildId: "guild-1",
        discordUserId: "member", signupType: "role", state: "active", removedAt: null, removedByDiscordUserId: null
      });
      await f.refresh();
      f.snapshot().signups[0].signupType = "standby";
      f.snapshot().signups[0].contentRoleSlotId = null;
      await f.refresh();
      f.snapshot().signups = [];
      await f.refresh();
      await f.refresh();
      assert.deepEqual(f.edits.map(edit => edit.id), ["roles-1", "roles-1", "roles-1"]);
      assert.match(JSON.stringify(f.edits[0]), /Tank — <@member>/);
      assert.match(JSON.stringify(f.edits[1]), /Standby.*<@member>/);
      assert.doesNotMatch(JSON.stringify(f.edits[2]), /member/);
    });
  }

  test("unchanged announcements avoid edits during reconciliation and party changes, unscheduled=" + unscheduled, async () => {
    const f = fixture(unscheduled);
    // Discord supplies component IDs and default values and need not preserve
    // the builder's property order. Compare the fetched presentation, not IDs.
    const payload = JSON.parse(JSON.stringify(buildContentAnnouncementV2Message(f.snapshot().content)));
    const container = payload.components[0];
    f.announcement.components = [new ContainerBuilder({
      id: 1, spoiler: false,
      components: container.components.map((child: { type: ComponentType.TextDisplay; content: string }, index: number) => ({
        id: index + 2, content: child.content, type: child.type
      })),
      accent_color: container.accent_color, type: ComponentType.Container
    })];
    f.announcement.flags.add(MessageFlags.HasThread);
    await createContentScheduler(f.repository, { info() {}, warn() {}, error() {} } as never).runContentReconciliation([f.guild]);
    f.snapshot().content.hostDiscordUserId = "456";
    f.snapshot().content.description = "Updated description";
    f.snapshot().signups.push({
      contentSignupId: "signup", contentId: "content-1", contentRoleSlotId: "slot-1", discordGuildId: "guild-1",
      discordUserId: "member", signupType: "role", state: "active", removedAt: null, removedByDiscordUserId: null
    });
    await f.refresh();
    f.snapshot().content.state = "active";
    await f.refresh();
    assert.equal(f.edits.some(edit => edit.id === "announcement-1"), false);
    assert.match(JSON.stringify(f.edits.filter(edit => edit.id === "roles-1").at(-1)), /member/);
    assert.match(JSON.stringify(f.edits.filter(edit => edit.id === "details-1").at(-1)), /content:end:/);
    assert.equal(f.rendered.length, 3);
  });

  test("a changed announcement title is edited once, unscheduled=" + unscheduled, async () => {
    const f = fixture(unscheduled);
    f.snapshot().content.title = "Updated Party";
    await f.refresh();
    await f.refresh();
    const edits = f.edits.filter(edit => edit.id === "announcement-1");
    assert.equal(edits.length, 1);
    assert.match(JSON.stringify(edits[0]), /# Updated Party/);
    assert.deepEqual(edits[0].payload.allowedMentions, { parse: [], repliedUser: false });
  });
}

for (const change of ["description", "host", "start", "end", "roles", "combined"] as const) {
  test(`a real ${change} change edits only the affected party messages`, async () => {
    const f = fixture();
    if (change === "description" || change === "combined") f.snapshot().content.description = "Changed description";
    if (change === "host") f.snapshot().content.hostDiscordUserId = "456";
    if (change === "start") f.snapshot().content.state = "active";
    if (change === "end") f.snapshot().content.state = "ended";
    if (change === "roles" || change === "combined") f.snapshot().slots[0].label = "Healer";
    if (change === "combined") f.snapshot().content.title = "Changed title";
    await f.refresh();
    await f.refresh();
    const expected = change === "combined" ? ["announcement-1", "details-1", "roles-1"]
      : change === "roles" ? ["roles-1"] : change === "end" ? ["details-1", "roles-1"] : ["details-1"];
    assert.deepEqual(f.edits.map(edit => edit.id), expected);
    for (const edit of f.edits) assert.deepEqual(edit.payload.allowedMentions, { parse: [], repliedUser: false });
  });
}

test("a changed scheduled time still updates the announcement", async () => {
  const f = fixture();
  f.snapshot().content.scheduledStartAt = new Date("2026-08-11T14:00:00Z");
  await f.refresh();
  await f.refresh();
  const edits = f.edits.filter(edit => edit.id === "announcement-1");
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].payload.components, buildContentAnnouncementV2Message(f.snapshot().content).components);
});

for (const failFirst of [false, true]) {
  test("startup adopts the prior button placement on already rendered parties, failed first attempt=" + failFirst, async () => {
    const f = fixture(true);
    f.snapshot().content.renderedRevision = f.snapshot().content.renderRevision;
    const details = JSON.parse(JSON.stringify(buildContentDetailsV2Message(f.snapshot().content))).components[0];
    details.components.push(...buildContentActionRows(f.snapshot()).map(row => row.toJSON()));
    f.details.components = [new ContainerBuilder(details)];
    const roles = JSON.parse(JSON.stringify(buildContentControlV2Message(f.snapshot()))).components[0];
    roles.components = roles.components.filter((child: { type: number }) => child.type !== ComponentType.ActionRow);
    f.roles.components = [new ContainerBuilder(roles)];
    const scheduler = createContentScheduler(f.repository, { info() {}, warn() {}, error() {} } as never);
    if (failFirst) {
      f.onEdit(async id => { if (id === "roles-1") throw new Error("temporary edit failure"); });
      await scheduler.runContentReconciliation([f.guild]);
      assert.equal(f.rendered.length, 0);
      f.onEdit(async () => undefined);
      f.edits.length = 0;
    }
    await scheduler.runContentReconciliation([f.guild]);
    assert.deepEqual(f.edits.map(edit => edit.id), failFirst ? ["roles-1"] : ["details-1", "roles-1"]);
    assert.doesNotMatch(JSON.stringify(f.details.components), /content:(join|standby|leave):/);
    assert.match(JSON.stringify(f.roles.components), /content:join:.*content:standby:.*content:leave:/);
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.sends, []);
    assert.equal(f.roles.pinned, true);
    f.edits.length = 0;
    await scheduler.runContentReconciliation([f.guild]);
    assert.deepEqual(f.edits, []);
  });
}

test("legacy roles become details in place, retaining the graphic and moving the pin", async () => {
  const f = fixture();
  f.snapshot().content.graphicAttachmentName = "builds.png";
  f.snapshot().content.controlMessageId = null;
  f.messages.delete("roles-1");
  f.details.components = buildContentControlV2Message(f.snapshot()).components!;
  f.details.attachments.set("image", { id: "image", name: "builds.png", url: "https://cdn.example/builds.png" });
  f.details.pinned = true;
  await f.refresh();
  assert.equal(f.details.pinned, false);
  const update = f.edits.find(e => e.id === "details-1")!.payload;
  assert.match(JSON.stringify(update), /https:\/\/cdn.example\/builds.png/);
  assert.doesNotMatch(JSON.stringify(update), /# Roles|Host approval/);
  assert.deepEqual(update.attachments, [{ id: "image" }]);
  assert.equal(f.sends.length, 1);
  assert.match(JSON.stringify(f.sends[0]), /# Roles/);
  assert.equal(f.messages.get(f.snapshot().content.controlMessageId!).pinned, true);
});

test("graphic replacement uploads only to details and later refresh retains its attachment", async () => {
  const f = fixture(); f.snapshot().content.graphicAttachmentName = "builds.png";
  await f.refresh("https://cdn.example/replacement.png");
  const detailEdit = f.edits.find(e => e.id === "details-1")!.payload;
  assert.deepEqual(detailEdit.attachments, []);
  assert.equal(detailEdit.files[0].name, "builds.png");
  assert.equal(detailEdit.files[0].attachment, "https://cdn.example/replacement.png");
  assert.deepEqual(f.edits.map(edit => edit.id), ["details-1"]);
  f.details.attachments.set("image", { id: "image", name: "builds.png", url: "https://cdn.example/retained.png" });
  f.edits.length = 0; await f.refresh();
  assert.equal(f.edits.length, 0);
  f.snapshot().content.description = "Changed instructions";
  await f.refresh();
  const retained = f.edits.find(e => e.id === "details-1")!.payload;
  assert.match(JSON.stringify(retained), /retained.png/);
  assert.deepEqual(retained.attachments, [{ id: "image" }]); assert.equal(retained.files, undefined);
  f.edits.length = 0;
  await f.refresh("https://cdn.example/retained.png");
  assert.deepEqual(f.edits.map(edit => edit.id), ["details-1"]);
  assert.equal(f.edits[0].payload.files[0].name, "builds.png");
  assert.deepEqual(f.edits[0].payload.attachments, []);
});

for (const idField of ["attachment_id", "id"] as const) {
  test(`gallery and ordinary metadata for the same graphic avoid edits and duplicate retained IDs (${idField})`, async () => {
    const f = galleryGraphicFixture(false, idField);
    f.details.attachments.set("image", { id: "image", name: "builds.png", url: "https://cdn.example/builds.png?new-signature" });
    await f.refresh();
    assert.equal(f.edits.length, 0);
    f.snapshot().content.description = "Changed description";
    await f.refresh();
    const edit = f.edits.find(e => e.id === "details-1")!.payload;
    assert.match(JSON.stringify(edit.components), /builds.png\?new-signature/);
    assert.deepEqual(edit.attachments, [{ id: "image" }]);
  });

  test(`description and lifecycle edits retain only uploaded attachment IDs (${idField})`, async () => {
    const f = galleryGraphicFixture(false, idField);
    f.snapshot().content.description = "Changed instructions";
    await f.refresh();
    const edit = f.edits.find(e => e.id === "details-1")!.payload;
    assert.match(JSON.stringify(edit.components), /builds.png\?current-signature/);
    assert.deepEqual(edit.attachments, idField === "attachment_id" ? [{ id: "image" }] : []);
    assert.equal(edit.files, undefined);
    assert.deepEqual(edit.allowedMentions, { parse: [], repliedUser: false });
    resolveGalleryGraphic(f.details, idField, "image", "https://cdn.example/builds.png?refreshed-signature");
    f.edits.length = 0;
    await f.refresh();
    assert.equal(f.edits.length, 0, "refreshed image signatures must not cause another edit");
    f.snapshot().content.state = "active";
    await f.refresh();
    const started = f.edits.find(e => e.id === "details-1")!.payload;
    assert.match(JSON.stringify(started.components), /builds.png\?refreshed-signature/);
    assert.match(JSON.stringify(started.components), /content:end:/);
    assert.deepEqual(started.attachments, idField === "attachment_id" ? [{ id: "image" }] : []);
    assert.equal(started.files, undefined);
  });
}

test("resolved gallery media IDs are never serialized as retained attachment IDs", async () => {
  const f = galleryGraphicFixture(false, "id");
  resolveGalleryGraphic(f.details, "id", "1555418900148260917", "https://cdn.discordapp.com/attachments/1555417585099604119/1555417602862354532/content-builds-graphic.png");
  f.snapshot().content.state = "active";
  f.onEdit(async (_id, update) => {
    if (update.attachments?.some((attachment: { id: string }) => attachment.id === "1555418900148260917")) {
      throw new Error("ATTACHMENT_NOT_FOUND");
    }
  });
  await f.refresh();
  const edit = f.edits.find(e => e.id === "details-1")!.payload;
  assert.deepEqual(edit.attachments, []);
  assert.match(JSON.stringify(edit.components), /1555417602862354532.*content:end:/);
  const client = new Client({ intents: [] });
  const wire = MessagePayload.create({ client } as never, edit).resolveBody().body as RESTPatchAPIChannelMessageJSONBody;
  assert.deepEqual(wire.attachments, []);
  await f.refresh();
  assert.equal(f.edits.length, 1, "a successful recovery does not repeatedly edit the card");
});

for (const unscheduled of [false, true]) {
  test(`scheduler retries an unclaimed start after a card-edit failure without resetting time, unscheduled=${unscheduled}`, async () => {
    const f = galleryGraphicFixture(unscheduled, "id");
    const startedAt = new Date("2026-08-10T12:00:00Z");
    const content = f.snapshot().content;
    const errors: string[] = [];
    let starts = 0, claims = 0, failEdit = true;
    Object.assign(f.repository, {
      listContentDueStart: async () => content.startNotificationClaimedAt ? [] : [content],
      listContentDueCleanup: async () => [],
      markStarted: async () => {
        starts++;
        Object.assign(content, { state: "active", startedAt, firstStartedAt: startedAt, startRevision: "revision-1" });
        return content;
      },
      claimStartNotification: async () => {
        claims++; content.startNotificationClaimedAt = new Date(); return true;
      },
      setStartNotificationMessage: async (_guild: string, _content: string, id: string) => {
        content.startNotificationMessageId = id; return true;
      }
    });
    if (unscheduled) {
      Object.assign(content, { state: "active", startedAt, firstStartedAt: startedAt, startRevision: "revision-1" });
    }
    f.onEdit(async () => { if (failEdit) { failEdit = false; throw new Error("temporary card edit failure"); } });
    const scheduler = createContentScheduler(f.repository, { info() {}, warn() {}, error(message: string) { errors.push(message); } } as never);
    await scheduler.runDueContent([f.guild], startedAt);
    assert.equal(content.state, "active");
    assert.equal(claims, 0, "presentation failure must happen before delivery is claimed");
    assert.equal(f.sends.length, 0);
    await scheduler.runDueContent([f.guild], new Date("2026-08-10T12:01:00Z"));
    assert.equal(starts, unscheduled ? 0 : 1);
    assert.equal(content.startedAt, startedAt);
    assert.equal(content.firstStartedAt, startedAt);
    assert.equal(claims, 1);
    assert.equal(f.sends.length, 1);
    assert.ok(content.startNotificationMessageId);
    await scheduler.runDueContent([f.guild], new Date("2026-08-10T12:02:00Z"));
    assert.equal(f.sends.length, 1, "claimed delivery is never replayed");
    assert.deepEqual(errors, ["content auto-start failed"]);
  });
}

test("optional content-type metadata does not make an uploaded gallery image disappear", async () => {
  for (const contentType of [undefined, null]) {
    const f = galleryGraphicFixture();
    const components = JSON.parse(JSON.stringify(f.details.components));
    components[0].components.find((child: any) => child.type === ComponentType.MediaGallery).items[0].media.content_type = contentType;
    f.details.components = components.map((component: any) => Reflect.construct(ContainerComponent, [component]));
    await f.refresh();
    assert.equal(f.edits.length, 0);
    f.snapshot().content.description = "Changed instructions";
    await f.refresh();
    assert.deepEqual(f.edits[0].payload.attachments, [{ id: "image" }]);
    assert.match(JSON.stringify(f.edits[0].payload.components), /builds.png\?current-signature/);
  }
});

test("explicit replacement removes the old gallery graphic and retains the newly uploaded one", async () => {
  const f = galleryGraphicFixture();
  await f.refresh("https://cdn.example/replacement.png");
  const edit = f.edits.find(e => e.id === "details-1")!.payload;
  assert.deepEqual(edit.attachments, []);
  assert.equal(edit.files[0].name, "builds.png");
  assert.equal(edit.files[0].attachment, "https://cdn.example/replacement.png");
  resolveGalleryGraphic(f.details, "attachment_id", "replacement", "https://cdn.example/builds.png?replacement");
  f.edits.length = 0;
  await f.refresh();
  assert.equal(f.edits.length, 0);
  f.snapshot().content.description = "Updated with replacement image";
  await f.refresh();
  assert.deepEqual(f.edits[0].payload.attachments, [{ id: "replacement" }]);
  assert.match(JSON.stringify(f.edits[0].payload.components), /builds.png\?replacement/);
});

test("repair removes a lost graphic without repeatedly editing the description", async () => {
  const f = fixture();
  f.snapshot().content.graphicAttachmentName = "builds.png";
  f.details.components = buildContentDetailsV2Message(f.snapshot().content).components!;
  await f.refresh();
  await f.refresh();
  assert.deepEqual(f.edits.map(edit => edit.id), ["details-1"]);
  assert.doesNotMatch(JSON.stringify(f.details.components), /builds.png|attachment:\/\//);
});

test("roles refresh retains unrelated attachments and repairs its pin without an edit", async () => {
  const f = fixture();
  f.roles.attachments.set("legacy", { id: "legacy", name: "legacy.png", url: "https://cdn.example/legacy.png" });
  f.roles.pinned = false;
  await f.refresh();
  await f.refresh();
  assert.deepEqual(f.edits, []);
  assert.equal(f.roles.attachments.has("legacy"), true);
  assert.equal(f.roles.pinned, true);
  f.roles.pinned = false;
  f.edits.length = 0;
  await f.refresh();
  assert.deepEqual(f.edits, []);
  assert.equal(f.roles.pinned, true);
});

test("a changed roster removes only its generated report attachment", async () => {
  const f = fixture();
  f.roles.attachments.set("report", { id: "report", name: "party-aaaaaaaaaaaa.md", url: "https://cdn.example/report.md" });
  f.roles.attachments.set("notes", { id: "notes", name: "notes.txt", url: "https://cdn.example/notes.txt" });
  f.snapshot().slots[0].label = "Healer";
  await f.refresh();
  assert.deepEqual(f.edits.map(edit => edit.id), ["roles-1"]);
  assert.deepEqual(f.edits[0].payload.attachments, [{ id: "notes" }]);
});

for (const kind of ["details", "roles"] as const) {
  test("a failed " + kind + " ID save recovers the sent card without duplicate publication", async () => {
    const f = fixture(); f.messages.delete(kind + "-1");
    const method = kind === "details" ? "setDetailsMessage" : "setControlMessage";
    const save = f.repository[method];
    f.repository[method] = async () => { throw new Error("save failed"); };
    await assert.rejects(f.refresh(), /save failed/);
    assert.equal(f.rendered.length, 0); assert.equal(f.sends.length, 1);
    f.messages.get("sent-1").nonce = undefined;
    f.repository[method] = save; await f.refresh();
    assert.equal(f.sends.length, 1); assert.equal(f.rendered.length, 1);
  });
}

for (const failure of ["thread", "details-1", "roles-1", "parent-transient"]) {
  test("transient " + failure + " lookup failure retains retry eligibility", async () => {
    const f = fixture(); f.fail(failure);
    await assert.rejects(f.refresh(), /lookup/);
    assert.equal(f.rendered.length, 0); assert.equal(f.sends.length, 0);
  });
}

test("a deleted parent does not block refresh of either thread message", async () => {
  const f = fixture();
  f.snapshot().content.description = "Changed instructions";
  f.snapshot().slots[0].label = "Changed role";
  f.fail("parent-missing"); await f.refresh();
  assert.deepEqual(f.edits.map(e => e.id), ["details-1", "roles-1"]);
  assert.equal(f.rendered.length, 1);
});

test("repair of a deleted details card never references a lost attachment", async () => {
  const f = fixture(); f.snapshot().content.graphicAttachmentName = "builds.png";
  f.messages.delete("details-1"); await f.refresh();
  assert.doesNotMatch(JSON.stringify(f.sends), /attachment:\/\/|builds.png/);
  assert.match(JSON.stringify(f.sends), /content:edit:/);
});

test("queued older callers reload the latest roster instead of overwriting a newer presentation", async () => {
  const f = fixture();
  f.snapshot().signups.push({
    contentSignupId: "signup", contentId: "content-1", contentRoleSlotId: "slot-1", discordGuildId: "guild-1",
    discordUserId: "initial-member", signupType: "role", state: "active", removedAt: null, removedByDiscordUserId: null
  });
  const initial = f.snapshot();
  let started!: () => void, release!: () => void;
  const firstEdit = new Promise<void>(resolve => { started = resolve; });
  let waited = false;
  f.onEdit(async id => {
    if (id === "roles-1" && !waited) { waited = true; started(); await new Promise<void>(resolve => { release = resolve; }); }
  });
  const first = f.refresh(); await firstEdit;
  f.replace({ ...initial, content: { ...initial.content, renderRevision: "2" }, signups: [{
    contentSignupId: "signup", contentId: "content-1", contentRoleSlotId: "slot-1", discordGuildId: "guild-1",
    discordUserId: "new-member", signupType: "role", state: "active", removedAt: null, removedByDiscordUserId: null
  }] });
  const queued = refreshContentMessages(f.guild, f.repository, initial);
  release(); await Promise.all([first, queued]);
  const roles = f.edits.filter(e => e.id === "roles-1");
  assert.equal(roles.length, 2); assert.doesNotMatch(JSON.stringify(roles[0]), /new-member/); assert.match(JSON.stringify(roles[1]), /new-member/);
  assert.deepEqual(f.rendered, ["1", "2"]);
});

test("a mutation during a Discord edit cannot be marked rendered by the older snapshot", async () => {
  const f = fixture(); const initial = f.snapshot();
  initial.content.description = "First change";
  f.onEdit(async () => {
    if (f.snapshot().content.renderRevision === "1") f.replace({ ...initial, content: { ...initial.content, description: "Second change", renderRevision: "2" } });
  });
  await f.refresh(); assert.notEqual(f.snapshot().content.renderedRevision, "2");
  await f.refresh(); assert.equal(f.snapshot().content.renderedRevision, "2");
  assert.deepEqual(f.rendered, ["1", "2"]);
});

test("scheduler repairs a failed roster edit after the accepted request outcome is complete", async () => {
  const f = fixture(); f.snapshot().content.approvalRequired = true;
  f.onEdit(async id => { if (id === "roles-1") throw new Error("roster edit failed"); });
  await assert.rejects(f.refresh(), /roster edit failed/); assert.equal(f.rendered.length, 0);
  f.onEdit(async () => undefined);
  await createContentScheduler(f.repository, { info() {}, warn() {}, error() {} } as never).runContentReconciliation([f.guild]);
  assert.equal(f.rendered.length, 1); assert.equal(f.sends.length, 0);
});

test("large party reports refresh by content and replace only their generated attachment", async () => {
  const f = fixture();
  f.snapshot().content.description = "x".repeat(4000);
  f.snapshot().content.graphicAttachmentName = "builds.png";
  f.details.attachments.set("image", { id: "image", name: "builds.png", url: "https://cdn.example/builds.png" });
  await f.refresh();
  const first = f.edits.find(edit => edit.id === "details-1")!.payload;
  const report = first.files[0];
  assert.ok(report.attachment.toString().includes("x".repeat(4000)));
  assert.deepEqual(first.attachments, [{ id: "image" }], "the existing image is retained");
  f.details.attachments.set("report", { id: "report", name: report.name, url: "https://cdn.example/report.md" });
  const components = JSON.parse(JSON.stringify(first.components));
  components[0].components.find((node: any) => node.type === 13).file = { url: "https://cdn.example/report.md", attachment_id: "report", content_type: "text/markdown" };
  f.details.components = components;
  f.edits.length = 0;
  await f.refresh();
  assert.equal(f.edits.length, 0, "Discord's resolved file metadata does not cause repeated refreshes");
  f.snapshot().content.description = `${"x".repeat(3999)}y`;
  await f.refresh();
  const changed = f.edits.find(edit => edit.id === "details-1")!.payload;
  assert.notEqual(changed.files[0].name, report.name, "changed report content invalidates the presentation fingerprint");
  assert.deepEqual(changed.attachments, [{ id: "image" }]);
  f.edits.length = 0;
  f.snapshot().content.description = "Short again.";
  await f.refresh();
  const short = f.edits.find(edit => edit.id === "details-1")!.payload;
  assert.deepEqual(short.attachments, [{ id: "image" }]);
  assert.equal(short.files, undefined);
});

test("report uploads and removal retain a gallery-only image in the serialized Discord edit", async () => {
  const f = galleryGraphicFixture();
  const client = new Client({ intents: [] });
  for (const description of ["x".repeat(4000), "y".repeat(4000), "Short again."]) {
    f.edits.length = 0;
    f.snapshot().content.description = description;
    await f.refresh();
    const edit = f.edits.find(e => e.id === "details-1")!.payload;
    assert.match(JSON.stringify(edit.components), /builds.png\?current-signature/);
    assert.deepEqual(edit.attachments, [{ id: "image" }], "remove only the old report");
    const wire = MessagePayload.create({ client } as never, { ...edit, attachments: [...edit.attachments] }).resolveBody().body as RESTPatchAPIChannelMessageJSONBody;
    assert.deepEqual(wire.attachments?.map(attachment => attachment.id), description.length === 4000 ? ["image", "0"] : ["image"]);
    assert.deepEqual(wire.allowed_mentions, { parse: [], replied_user: false });
    resolveGalleryGraphic(f.details, "attachment_id");
    f.details.attachments.clear();
    if (edit.files?.length) {
      const report = edit.files[0];
      assert.equal(report.attachment.toString(), `${description}\n\n**Host** <@123>`);
      f.details.attachments.set("report", { id: "report", name: report.name, url: "https://cdn.example/report.md" });
    } else assert.equal(edit.files, undefined);
  }
});

test("large role lists preserve every role and keep signup controls accessible", () => {
  const f = fixture();
  f.snapshot().slots = Array.from({ length: 25 }, (_, index) => ({ ...f.snapshot().slots[0], contentRoleSlotId: `slot-${index}`, slotIndex: index + 1, label: `${index} ${"x".repeat(1800)}` }));
  const response = buildContentControlV2Message(f.snapshot());
  const json = JSON.parse(JSON.stringify(response));
  const report = response.files![0] as import("discord.js").AttachmentBuilder;
  for (const slot of f.snapshot().slots) assert.ok(report.attachment.toString().includes(slot.label));
  assert.equal(json.components.length, 1);
  assert.equal(json.components[0].type, 17);
  const controls = json.components[0].components.find((node: any) => node.type === 1);
  assert.deepEqual(controls.components.map((button: any) => button.label), ["Join", "Standby", "Leave"]);
});
