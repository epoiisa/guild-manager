import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { buildApplicationHistoryMessage } from "./intakePresentation.js";
import { buildApplicationInstructionsMessage, buildApplicationStandaloneText } from "./rendering.js";
import { assertV2Message, v2Text } from "../../testSupport/messageAssertions.js";

test("new copies of legacy application history use accented V2 and preserve all text", () => {
  const payload = buildApplicationHistoryMessage({ content: "Original instructions", embeds: [new EmbedBuilder().setTitle("Application").setDescription("Original answer").setColor(0x64748b)] });
  assertV2Message(payload);
  assert.equal(v2Text(payload), "Original instructions\n\n# Application\n\nOriginal answer");
});

test("an unsupported historical layout is preserved in a complete explicit archive", () => {
  const original = { embeds: [new EmbedBuilder().setDescription("Original answer").setImage("https://example.com/original.png")] };
  const payload = buildApplicationHistoryMessage(original);
  assertV2Message(payload);
  const archive = payload.files?.[0] as AttachmentBuilder;
  assert.equal(archive.name, "application-history.json");
  assert.deepEqual(JSON.parse(archive.attachment.toString()), JSON.parse(JSON.stringify(original)));
});

test("supplementary instructions and reviewer notices use Containers without altering Markdown or recipients", () => {
  const text = "**Read this**\n\nKeep the blank line. <@&123>";
  assert.equal(v2Text(buildApplicationInstructionsMessage(text)), text);
  const notice = buildApplicationStandaloneText(text, "123");
  assert.equal(v2Text(notice), text);
  assert.deepEqual(notice.allowedMentions, { parse: [], repliedUser: false, roles: ["123"] });
});
