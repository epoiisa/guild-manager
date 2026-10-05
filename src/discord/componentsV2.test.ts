import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags
} from "discord.js";
import {
  asComponentsV2Edit,
  buildComponentsV2Card,
  findNestedComponentCustomIds,
  hasNestedComponentCustomId,
  messageHasNestedComponentCustomId
} from "./componentsV2.js";

test("Components V2 cards use one accented container with nested action rows", () => {
  const payload = buildComponentsV2Card({
    accentColor: 0x64748b,
    title: "Application Opened",
    leadingText: ["<@applicant-1> <@&reviewer-1> A new application has been opened."],
    text: ["Read this before continuing."],
    fields: [{ label: "Applicant:", value: "<@applicant-1>" }],
    footer: "Reviewers can accept or reject this application.",
    actionRows: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("application:accept:1").setLabel("Accept").setStyle(ButtonStyle.Success)
    )],
    allowedMentions: { parse: [], users: ["applicant-1"], roles: ["reviewer-1"], repliedUser: false }
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  assert.equal("embeds" in payload, false);
  assert.deepEqual(payload.allowedMentions, {
    parse: [], users: ["applicant-1"], roles: ["reviewer-1"], repliedUser: false
  });

  const container = (payload.components?.[0] as { toJSON(): {
    type: number;
    accent_color?: number;
    components?: Array<{ type: number; content?: string; components?: Array<{ custom_id?: string }> }>;
  } } | undefined)?.toJSON();
  assert.equal(container?.type, ComponentType.Container);
  assert.equal(container?.accent_color, 0x64748b);
  assert.deepEqual(container?.components?.map((component: { type: number }) => component.type), [
    ComponentType.TextDisplay,
    ComponentType.TextDisplay,
    ComponentType.TextDisplay,
    ComponentType.TextDisplay,
    ComponentType.TextDisplay,
    ComponentType.ActionRow
  ]);
  assert.equal(container?.components?.[0]?.content, "<@applicant-1> <@&reviewer-1> A new application has been opened.");
  assert.equal(container?.components?.[3]?.content, "**Applicant**\n<@applicant-1>");
  assert.equal(container?.components?.[5]?.components?.[0]?.custom_id, "application:accept:1");
});

test("Components V2 cards can be ephemeral and default to non-notifying mentions", () => {
  const payload = buildComponentsV2Card({ accentColor: 1, title: "Result", ephemeral: true });
  assert.equal(payload.flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("Components V2 edits clear classic content and embeds", () => {
  const edit = asComponentsV2Edit(buildComponentsV2Card({ accentColor: 1, title: "Updated" }));
  assert.equal(edit.content, null);
  assert.deepEqual(edit.embeds, []);
  assert.equal(edit.flags, MessageFlags.IsComponentsV2);
});

test("nested custom ID inspection supports API, received, and builder components", () => {
  const builderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("builder-control").setLabel("Builder").setStyle(ButtonStyle.Primary)
  );
  const components = [{
    type: ComponentType.Container,
    components: [{
      type: ComponentType.ActionRow,
      components: [{ custom_id: "api-control" }, { customId: "received-control" }]
    }]
  }, builderRow];

  assert.deepEqual(findNestedComponentCustomIds(components), new Set([
    "api-control", "received-control", "builder-control"
  ]));
  assert.equal(hasNestedComponentCustomId(components, "api-control"), true);
  assert.equal(hasNestedComponentCustomId(components, "missing-control"), false);
  assert.equal(messageHasNestedComponentCustomId({ components }, "received-control"), true);
});
