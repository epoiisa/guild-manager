import assert from "node:assert/strict";
import test from "node:test";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, EmbedBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";
import { boundedV2Container, OperationalMessageLayoutError, v2Edit, v2Message, v2Reply } from "./operationalMessages.js";
import { assertV2Message, messageNodes, v2Text, v2Texts, v2Rows } from "../testSupport/messageAssertions.js";

const controls = () => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("confirm:owner:1").setLabel("Confirm").setStyle(ButtonStyle.Danger));

test("operational cards preserve wording, fields, footer, timestamp and control identity without notifying", () => {
  const message = v2Reply({ cards: [new EmbedBuilder().setTitle("Report").setDescription("<@123> @everyone")
    .setColor(0x3b82f6).addFields({ name: "Character:", value: "Example • Asia", inline: true })
    .setFooter({ text: "Recorded result." }).setTimestamp(new Date("2026-09-13T00:00:00Z"))],
    actionRows: [controls()], flags: MessageFlags.Ephemeral });
  assert.deepEqual(v2Texts(message), ["# Report", "<@123> @everyone", "**Character**\nExample • Asia", "Recorded result.", "<t:1789257600:F>"]);
  assert.equal(message.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(v2Rows(message)[0].components.map((button: any) => [button.custom_id, button.label, button.style]), [["confirm:owner:1", "Confirm", ButtonStyle.Danger]]);
});

test("the complete response survives the combined text limit, Unicode and filename collisions", () => {
  assert.equal(v2Text(v2Reply({ text: "x".repeat(4000) })).length, 4000);
  const body = `# Long Report\n${"🙂".repeat(2500)}\nLast record`;
  const prior = new AttachmentBuilder(Buffer.from("existing export"), { name: "response.md" });
  const payload = v2Reply({ text: body, files: [prior], flags: MessageFlags.Ephemeral });
  assertV2Message(payload);
  assert.equal(payload.files?.length, 2);
  assert.equal((payload.files?.[1] as AttachmentBuilder).name, "response-2.md");
  assert.equal((payload.files?.[1] as AttachmentBuilder).attachment.toString(), body);
  assert.deepEqual(messageNodes(payload, 13).map(node => node.file.url), ["attachment://response.md", "attachment://response-2.md"]);
  assert.match(v2Text(payload), /# Long Report/);
});

test("overflow summaries preserve only deliberate recipients that occur in the original message", () => {
  const payload = v2Message({ text: `# Party\n<@123> <@456> <@&789>\n${"x".repeat(4000)}`,
    allowedMentions: { parse: [], users: ["123", "999"], roles: ["789"] } });
  assert.match(v2Text(payload), /<@123> <@&789>/);
  assert.doesNotMatch(v2Text(payload), /<@456>|<@999>/);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false, users: ["123", "999"], roles: ["789"] });
});

test("edits clear legacy content and old report attachments while keeping the message V2", () => {
  const long = v2Edit({ text: "x".repeat(5000), actionRows: [controls()] });
  assertV2Message(long);
  assert.equal(long.content, null);
  assert.deepEqual(long.embeds, []);
  assert.deepEqual(long.attachments, []);
  assert.equal(long.flags, MessageFlags.IsComponentsV2);
  const finished = v2Edit({ text: "Finished." });
  assert.equal(v2Text(finished), "Finished.");
  assert.deepEqual(v2Rows(finished), []);
  assert.deepEqual(finished.attachments, []);
});

test("unsupported operational media models and impossible component layouts fail explicitly", () => {
  assert.throws(() => v2Message({ cards: [new EmbedBuilder().setImage("https://example.com/image.png")] }), OperationalMessageLayoutError);
  assert.throws(() => v2Message({ text: "Controls", actionRows: Array.from({ length: 20 }, controls) }), OperationalMessageLayoutError);
  assert.throws(() => v2Message({ files: [Buffer.from("unnamed")] }), OperationalMessageLayoutError);
});

test("oversized authored cards preserve their image, controls, complete text and versioned report identity", () => {
  const make = (ending: string) => boundedV2Container(new ContainerBuilder().setAccentColor(0x64748b)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Giveaway"), new TextDisplayBuilder().setContent("x".repeat(3900)), new TextDisplayBuilder().setContent(`${"y".repeat(200)} ${ending}`))
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL("attachment://prize.png")))
    .addActionRowComponents(controls()), { overflowName: "giveaway.md", versioned: true });
  const first = make("First"), second = make("Second");
  assertV2Message(first);
  assert.notEqual(first.files?.[0].name, second.files?.[0].name);
  assert.match(first.files![0].attachment.toString(), /First$/);
  assert.equal(messageNodes(first, 12)[0].items[0].media.url, "attachment://prize.png");
  assert.equal(v2Rows(first)[0].components[0].custom_id, "confirm:owner:1");
});
