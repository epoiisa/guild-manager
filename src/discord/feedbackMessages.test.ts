import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { assertStandardMessage, assertV2Message, messageJson, messageRows, v2Text } from "../testSupport/messageAssertions.js";
import { completeFeedbackPrompt, editFeedback, feedbackEdit, feedbackMessage, feedbackReply } from "./feedbackMessages.js";

test("reviewed receipts are complete ordinary private text with silent mentions and no previews", () => {
  const payload = assertStandardMessage(feedbackReply({ text: "Credited Epoiisa's account; its balance is now 1,000.", flags: MessageFlags.Ephemeral }));
  assert.equal(payload.content, "Credited Epoiisa's account; its balance is now 1,000.");
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});

test("context feedback retains the unchanged outcome and reason", () => {
  const payload = assertStandardMessage(feedbackReply({ cards: [new EmbedBuilder().setTitle("Account Unchanged").setDescription("That account is frozen.")] }, "context"));
  assert.equal(payload.content, "Account Unchanged: That account is frozen.");
});

test("ordinary 2000-character boundary is lossless for Unicode, Markdown, links and mentions", () => {
  const text = "[View Request](https://discord.com/channels/1/2/3) <@123> @everyone "+"🦊".repeat(1000);
  const boundary = text.slice(0, 2000);
  assert.equal(assertStandardMessage(feedbackMessage({ text: boundary })).content, boundary);
  assert.equal(v2Text(feedbackMessage({ text })), text);
  const multiline = "**name**\n@everyone\n<@123>";
  const fallback = assertV2Message(feedbackMessage({ text: multiline }));
  assert.equal(v2Text(fallback), multiline);
  assert.deepEqual(fallback.allowedMentions, { parse: [], repliedUser: false });
});

test("reports, multiple consequences and controls keep their explicitly selected structure", () => {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("archive:123").setLabel("Archive").setStyle(ButtonStyle.Secondary));
  assertV2Message(feedbackMessage({ text: "Confirm removal?", actionRows: [row] }));
  assertV2Message(feedbackMessage({ text: "One report item.", structured: true }));
  const card = new EmbedBuilder().setTitle("Position Deleted").setDescription("Removed Tank.").addFields({ name: "Warnings", value: "The role could not be removed from <@123>." });
  assert.match(v2Text(feedbackMessage({ cards: [card] })), /Warnings[\s\S]*<@123>/u);
  const plain = assertStandardMessage(feedbackMessage({ text: "Content ended.", actionRows: [row], allowActionRows: true, allowedMentions: { users: ["123"], parse: [] } }));
  assert.equal(plain.flags, MessageFlags.SuppressEmbeds);
  assert.deepEqual(plain.allowedMentions, { users: ["123"], parse: [], repliedUser: false });
  assert.equal(messageRows(plain)[0].components[0].custom_id, "archive:123");
});

test("standard-to-V2 edits clear incompatible content and obsolete response files", () => {
  const payload = feedbackEdit({ text: "Saved.\n\nThe role update failed." });
  assertV2Message(payload);
  assert.equal(payload.content, null);
  assert.deepEqual(payload.attachments, []);
});

function prompt(deferred: boolean, failure?: "retire" | "receipt" | "cleanup", v2 = true) {
  const calls: Array<{ method: string; payload?: unknown }> = [];
  const deliver = async (method: string, payload?: unknown) => {
    calls.push({ method, payload });
    if ((method === "update" || method === "editReply") && failure === "retire") throw new Error("timeout");
    if (method === "followUp" && failure === "receipt") throw new Error("timeout after possible delivery");
    if (method === "deleteReply" && failure === "cleanup") throw new Error("message unavailable");
    return {} as never;
  };
  return { calls, interaction: {
    deferred, replied: false, ephemeral: null,
    message: { flags: { has: (bit: number) => bit === MessageFlags.Ephemeral || (v2 && bit === MessageFlags.IsComponentsV2) } },
    update: (payload: unknown) => deliver("update", payload),
    editReply: (payload: unknown) => deliver("editReply", payload),
    followUp: (payload: unknown) => deliver("followUp", payload),
    deleteReply: () => deliver("deleteReply")
  } };
}

for (const deferred of [false, true]) {
  test(`V2 prompt completion ${deferred ? "after deferUpdate" : "via update"} retires, sends once, then deletes`, async () => {
    const { calls, interaction } = prompt(deferred);
    await completeFeedbackPrompt(interaction, { text: "Reset cancelled. Nothing was changed." });
    assert.deepEqual(calls.map(call => call.method), [deferred ? "editReply" : "update", "followUp", "deleteReply"]);
    assert.equal(v2Text(calls[0].payload), "Reset cancelled. Nothing was changed.");
    assert.deepEqual(messageRows(calls[0].payload), []);
    assert.equal(assertStandardMessage(calls[1].payload).flags, MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds);
  });
}
for (const failure of ["retire", "receipt", "cleanup"] as const) {
  test(`prompt ${failure} failure preserves truthful completion without blind delivery retries`, async () => {
    const { calls, interaction } = prompt(true, failure);
    await completeFeedbackPrompt(interaction, { text: "The account was credited." });
    assert.equal(v2Text(calls[0].payload), "The account was credited.");
    assert.equal(calls.filter(call => call.method === "followUp").length, failure === "retire" ? 0 : 1);
    assert.equal(calls.filter(call => call.method === "deleteReply").length, failure === "cleanup" ? 1 : 0);
  });
}
test("ordinary prompts can edit in place and empty private deferReply never replaces the invoking public V2 card", async () => {
  const ordinary = prompt(true, undefined, false);
  await completeFeedbackPrompt(ordinary.interaction, { text: "Cancelled. No changes were made." });
  assert.deepEqual(ordinary.calls.map(call => call.method), ["editReply"]);
  assertStandardMessage(ordinary.calls[0].payload);
  const deferred = prompt(true);
  await editFeedback({ ...deferred.interaction, ephemeral: true }, { text: "The signup was saved." });
  assert.deepEqual(deferred.calls.map(call => call.method), ["editReply"]);
  assert.equal(messageJson(deferred.calls[0].payload).content, "The signup was saved.");
});
