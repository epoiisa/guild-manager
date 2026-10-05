import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContentPanelMessage,
  buildContentPanelListPage,
  renderContentPanelRows,
  parseContentPanelId,
  PANEL_ALLOWED_MENTIONS,
} from "./panelRendering.js";
import type { ContentPanelEntry } from "../../db/contentPanelRepository.js";
const now = new Date("2026-09-10T00:00:00Z");
function entry(id: string, overrides = {}): ContentPanelEntry {
  return {
    filledRoles: 2,
    totalRoles: 5,
    content: {
      contentId: id,
      discordGuildId: "1",
      sourceChannelId: "2",
      threadChannelId: "3",
      controlMessageId: "4",
      title: "Raid",
      state: "unscheduled",
      createdAt: now,
      startedAt: null,
      scheduledStartAt: null,
      hostDiscordUserId: "5",
      ...overrides,
    },
  } as ContentPanelEntry;
}
const json = (
  payload: ReturnType<typeof buildContentPanelMessage>["payload"],
) => JSON.stringify(payload.components);
test("public empty panel has exact heading, ordered primary controls and silent mentions", () => {
  const result = buildContentPanelMessage([], "generation", now);
  const body = json(result.payload);
  assert.match(body, /# Content/);
  assert.match(body, /No content is open for signups\./);
  assert.ok(body.indexOf("Host Unscheduled") < body.indexOf("Host Scheduled"));
  assert.ok(!body.includes("View All Content"));
  assert.deepEqual(result.payload.allowedMentions, PANEL_ALLOWED_MENTIONS);
});
test("time categories, actual early start, counts, links, ordering and expiry", () => {
  const rows = renderContentPanelRows(
    [
      entry("future", {
        state: "scheduled",
        scheduledStartAt: new Date(now.getTime() + 86400001),
      }),
      entry("boundary", {
        state: "scheduled",
        scheduledStartAt: new Date(now.getTime() + 86400000),
      }),
      entry("active", { state: "active", startedAt: now }),
      entry("unscheduled"),
      entry("ended", { state: "ended" }),
      entry("expired", { createdAt: new Date(now.getTime() - 43200000) }),
    ],
    now,
  );
  assert.equal(rows.length, 4);
  assert.match(rows[0]!, /unscheduled • 2\/5/);
  assert.match(rows[1]!, /started <t:1788998400:R>/);
  assert.match(rows[2]!, /:R> • 2\/5/);
  assert.match(rows[3]!, /:d> • <t:.*:t> • <@5>/);
  assert.match(rows[0]!, /channels\/1\/3\/4/);
  assert.match(
    renderContentPanelRows(
      [entry("missing", { state: "active", controlMessageId: null })],
      now,
    )[0]!,
    /channels\/1\/3\).*started • time unavailable/,
  );
});
test("overflow preserves all rows in private pages and suppresses mentions", () => {
  const entries = Array.from({ length: 60 }, (_, i) =>
    entry(String(i), { title: `Party ${i} ${"x".repeat(80)}` }),
  );
  const result = buildContentPanelMessage(entries, "generation", now);
  assert.ok(result.overflow > 0);
  assert.match(json(result.payload), /View All Content/);
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const payload = buildContentPanelListPage(entries, "generation", page, now);
    const body = JSON.stringify(payload.components);
    for (const match of body.matchAll(/Party (\d+) /g)) seen.add(match[1]!);
    assert.deepEqual(payload.allowedMentions, PANEL_ALLOWED_MENTIONS);
  }
  assert.equal(seen.size, 60);
  assert.equal(parseContentPanelId("content-panel:g:page:2")?.page, 2);
  assert.equal(parseContentPanelId("content-panel:g:page"), undefined);
});

test("title labels escape brackets and original backslashes exactly once", () => {
  const row = renderContentPanelRows(
    [entry("title", { title: "[raid](url) \\ *bold*" })],
    now,
  )[0]!;
  assert.ok(row.startsWith("- [\\[raid\\]\\(url\\) \\\\ \\*bold\\*]"));
});

test("Multi-signup counts people on both panel surfaces and still omits distant scheduled counts", () => {
  const current = { ...entry("multi", { multiSignupEnabled: true }), signedUpUsers: 6 };
  const distant = { ...entry("future-multi", { multiSignupEnabled: true, state: "scheduled", scheduledStartAt: new Date(now.getTime() + 86400001) }), signedUpUsers: 9 };
  assert.match(renderContentPanelRows([current], now)[0], /6 signed up/);
  assert.doesNotMatch(renderContentPanelRows([current], now)[0], /2\/5/);
  assert.doesNotMatch(renderContentPanelRows([distant], now)[0], /signed up/);
  assert.match(JSON.stringify(buildContentPanelMessage([current], "g", now).payload.components), /6 signed up/);
  assert.match(JSON.stringify(buildContentPanelListPage([current], "g", 0, now).components), /6 signed up/);
});
