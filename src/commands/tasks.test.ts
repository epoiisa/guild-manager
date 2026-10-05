import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationCommandType, ComponentType, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { TaskApplication, TasksSnapshot } from "../db/tasksRepository.js";
import { buildTasksResponse, handleTasksCommand, tasksCommand } from "./tasks.js";

const opened = new Date("2026-09-01T12:00:00Z");
const footer = "### Full Reports\n- Re-gear content: `/regear content list`\n- Re-gear requests: `/regear report`\n- Weapon specialisation requests: `/specialisation requests`\n\nOpen the linked channels for application and ticket details.";
const headings = ["Applications", "General Tickets", "Open Re-Geared Content", "Pending Re-Gear Requests", "Pending Weapon Specialisation Requests"];
function snapshot(): TasksSnapshot { return { discordGuildId: "guild", applications: [], tickets: [], regearContents: [], regears: [], specialisations: [] }; }
function application(id: string, overrides: Partial<TaskApplication> = {}): TaskApplication {
  return { applicationId: id, name: `Intake ${id}`, targetMemberGroupName: `Group ${id}`, applicantDiscordUserId: "caller", ticketChannelId: "application-channel", status: "open", characterResolutionState: "selected", createdAt: opened, ...overrides };
}
function populated(): TasksSnapshot {
  return { ...snapshot(),
    applications: [application("a")],
    tickets: [{ ticketId: "ticket", name: "General Support", openerDiscordUserId: "opener", ticketChannelId: "ticket-channel", createdAt: opened }],
    regearContents: [{ regearContentId: "content", name: "Content", albionServer: "asia", contentDate: "2026-09-01", channelId: "content-channel", announcementMessageId: "announcement", createdAt: opened }],
    regears: [{ regearClaimId: "regear", characterName: "Character", contentName: "Content", contentDate: "2026-08-31", currentOwnerDiscordUserId: "owner", albionServer: "europe", requestedValue: 9007199254740993n, reviewChannelId: "review-channel", reviewMessageId: "regear-message", submittedAt: opened }],
    specialisations: [{ specialisationRequestId: "weapon", characterName: "Character", targetDisplayName: "Carrioncaller", level: 100, submittedByDiscordUserId: "original-submitter", currentOwnerDiscordUserId: "submitter", albionServer: "europe", reviewChannelId: "review-channel", reviewMessageId: "weapon-message", createdAt: opened }]
  };
}
function displays(response: ReturnType<typeof buildTasksResponse>): string[] {
  return response.components[0]!.toJSON().components.flatMap((component) => component.type === ComponentType.TextDisplay ? [component.content] : []);
}
function report(response: ReturnType<typeof buildTasksResponse>): string {
  return response.files.length ? (response.files[0]!.attachment as Buffer).toString("utf8") : displays(response).join("\n\n");
}
function validate(response: ReturnType<typeof buildTasksResponse>, overflow = false) {
  assert.equal(response.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(response.allowedMentions, { parse: [], repliedUser: false });
  for (const key of ["content", "embeds"]) assert.equal(key in response, false);
  assert.equal(response.components.length, 1);
  const container = response.components[0]!.toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, 0x3b82f6);
  assert.deepEqual(container.components.map((component) => component.type), [10, 10, 10, 10, 10, ...(overflow ? [13] : []), 10]);
  assert.ok(1 + container.components.length <= 40);
  assert.ok(displays(response).reduce((sum, text) => sum + text.length, 0) <= 4000);
  assert.equal(displays(response).at(-1), footer);
  assert.equal(response.files.length, Number(overflow));
  if (overflow) {
    assert.equal(response.files[0]!.name, "tasks.md");
    assert.deepEqual(container.components[5], { type: ComponentType.File, file: { url: "attachment://tasks.md" } });
  }
}

test("tasks exposes one optionless hidden chat command with the administrative description", () => {
  const command = tasksCommand.toJSON();
  assert.equal(command.name, "tasks");
  assert.equal(command.description, "Show open administrative tasks for this server.");
  assert.equal(command.default_member_permissions, "0");
  assert.equal(command.type, ApplicationCommandType.ChatInput);
  assert.deepEqual(command.options, []);
});

test("one Report Blue container always shows all five counted queues and exact final guidance", () => {
  const response = buildTasksResponse(snapshot());
  validate(response);
  assert.deepEqual(displays(response), [...headings.map((heading, index) => `${index === 0 ? "# Tasks\n" : ""}### ${heading} (0)\nNone`), footer]);
});

test("all queues use the concise layouts, exact persisted links, content dates and bigint precision", () => {
  const response = buildTasksResponse(populated());
  validate(response);
  assert.deepEqual(displays(response), [
    "# Tasks\n### Applications (1)\n- <@caller> • [Group a Application](https://discord.com/channels/guild/application-channel) • Waiting for reviewer decision",
    "### General Tickets (1)\n- <@opener> • [General Support](https://discord.com/channels/guild/ticket-channel)",
    "### Open Re-Geared Content (1)\n- [Content](https://discord.com/channels/guild/content-channel/announcement) • Asia • Open • 1 September 2026",
    "### Pending Re-Gear Requests (1)\n- <@owner> • Content 31 August 2026 • [Character • 9,007,199,254,740,993](https://discord.com/channels/guild/review-channel/regear-message)",
    "### Pending Weapon Specialisation Requests (1)\n- <@submitter> • [Character • Carrioncaller](https://discord.com/channels/guild/review-channel/weapon-message)", footer
  ]);
});

test("all application decisions and resolution states have the approved exact labels", () => {
  const cases: Array<[Partial<TaskApplication>, string]> = [
    [{ characterResolutionState: "selected" }, "Waiting for reviewer decision"],
    [{ characterResolutionState: "unresolved" }, "Character unresolved"],
    [{ characterResolutionState: "not_listed" }, "Character not shown"],
    [{ characterResolutionState: "registered_to_other_user" }, "Character registered to another user"],
    [{ status: "awaiting_ingame_membership" }, "Waiting for in-game membership"],
    [{ status: "accepted" }, "Accepted"],
    [{ status: "rejected" }, "Rejected"],
    [{ status: "withdrawn" }, "Withdrawn"]
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(displays(buildTasksResponse({ ...snapshot(), applications: [application("a", overrides)] }))[0],
      `# Tasks\n### Applications (1)\n- <@caller> • [Group a Application](https://discord.com/channels/guild/application-channel) • ${expected}`);
  }
});

test("registration-only applications use their class name when there is no target group", () => {
  const response = buildTasksResponse({ ...snapshot(), applications: [application("a", { name: "Character Registration", targetMemberGroupName: undefined })] });
  assert.equal(displays(response)[0], "# Tasks\n### Applications (1)\n- <@caller> • [Character Registration Application](https://discord.com/channels/guild/application-channel) • Waiting for reviewer decision");
});

test("weapon and tree requests both omit their fixed level and show the current eligible owner first", () => {
  const result = populated();
  result.specialisations.push({ ...result.specialisations[0]!, specialisationRequestId: "tree", targetDisplayName: "Axe Fighter", level: 800 });
  assert.equal(displays(buildTasksResponse(result))[4], "### Pending Weapon Specialisation Requests (2)\n- <@submitter> • [Character • Axe Fighter](https://discord.com/channels/guild/review-channel/weapon-message)\n- <@submitter> • [Character • Carrioncaller](https://discord.com/channels/guild/review-channel/weapon-message)");
});

test("missing users and persisted destinations retain every record without guessing links", () => {
  const result = populated();
  result.applications[0]!.ticketChannelId = undefined;
  result.applications[0]!.applicantDiscordUserId = undefined;
  result.tickets[0]!.ticketChannelId = undefined;
  result.tickets[0]!.openerDiscordUserId = undefined;
  result.regearContents[0]!.announcementMessageId = undefined;
  result.regears[0]!.reviewChannelId = undefined;
  result.regears[0]!.currentOwnerDiscordUserId = undefined;
  result.specialisations[0]!.reviewMessageId = undefined;
  result.specialisations[0]!.currentOwnerDiscordUserId = undefined;
  result.specialisations[0]!.level = 800;
  const text = report(buildTasksResponse(result));
  for (const expected of ["- None • Group a Application • Channel unavailable", "- None • General Support • Channel unavailable", "- No current owner • Content 31 August 2026", "Content • Announcement message unavailable", "- No current owner • Character • Carrioncaller • Review message unavailable"]) assert.ok(text.includes(expected), expected);
  assert.equal(text.match(/Review message unavailable/g)?.length, 2);
  assert.equal(text.match(/Channel unavailable/g)?.length, 2);
  assert.doesNotMatch(text, /<@undefined>|<#undefined>|https:\/\/|Applicant:|Opener:|Owner:|Submitter:/);
});

test("content dates omit absent times and optional times are compact explicit UTC in both re-gear queues", () => {
  const result = populated();
  const dateOnly = displays(buildTasksResponse(result));
  assert.ok(dateOnly[2]!.endsWith(" • 1 September 2026"));
  assert.ok(dateOnly[3]!.includes(" • Content 31 August 2026 • [Character"));
  assert.doesNotMatch(dateOnly.join("\n"), /<t:| UTC|Content date:|Time:|Opened |Submitted /);
  for (const [instant, expected] of [
    ["2026-09-01T08:00:00+08:00", "0 UTC"],
    ["2026-09-01T16:00:00+08:00", "8 UTC"],
    ["2026-09-01T18:00:00Z", "18 UTC"],
    ["2026-09-01T08:05:00Z", "08:05 UTC"],
    ["2026-09-01T18:30:00Z", "18:30 UTC"]
  ]) {
    result.regearContents[0]!.contentAt = new Date(instant!);
    result.regears[0]!.contentDate = "2026-09-01";
    result.regears[0]!.contentAt = new Date(instant!);
    const text = displays(buildTasksResponse(result));
    assert.ok(text[2]!.endsWith(` • 1 September 2026 • ${expected}`));
    assert.ok(text[3]!.includes(` • Content 1 September 2026 ${expected} • [Character`));
  }
});

test("all queues sort oldest first with stable IDs, content date/time/creation ties, without mutation", () => {
  const result = populated();
  const earlier = new Date(opened.getTime() - 60000);
  result.applications = [application("z"), application("a"), application("old", { createdAt: earlier })];
  const ticket = result.tickets[0]!;
  result.tickets = ["z", "a", "old"].map((id) => ({ ...ticket, ticketId: id, name: `Ticket ${id}`, createdAt: id === "old" ? earlier : opened }));
  const regear = result.regears[0]!;
  result.regears = ["z", "a", "old"].map((id) => ({ ...regear, regearClaimId: id, characterName: `Regear ${id}`, submittedAt: id === "old" ? earlier : opened }));
  const specialisation = result.specialisations[0]!;
  result.specialisations = ["z", "a", "old"].map((id) => ({ ...specialisation, specialisationRequestId: id, characterName: `Weapon ${id}`, createdAt: id === "old" ? earlier : opened }));
  const content = result.regearContents[0]!;
  result.regearContents = [
    { ...content, regearContentId: "laterday", name: "Later day", contentDate: "2026-09-02" },
    { ...content, regearContentId: "timedlate", name: "Timed late", contentAt: opened },
    { ...content, regearContentId: "timedearly", name: "Timed early", contentAt: earlier },
    { ...content, regearContentId: "z", name: "Untimed Z" },
    { ...content, regearContentId: "a", name: "Untimed A" },
    { ...content, regearContentId: "old", name: "Untimed old", createdAt: earlier },
    { ...content, regearContentId: "olderday", name: "Older day", contentDate: "2026-08-31", contentAt: opened }
  ];
  const before = structuredClone(result);
  const text = report(buildTasksResponse(result));
  for (const ordered of [["Group old", "Group a", "Group z"], ["Ticket old", "Ticket a", "Ticket z"], ["Regear old", "Regear a", "Regear z"], ["Weapon old", "Weapon a", "Weapon z"], ["Older day", "Untimed old", "Untimed A", "Untimed Z", "Timed early", "Timed late", "Later day"]]) {
    const positions = ordered.map((name) => text.indexOf(name));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!)), ordered.join(", "));
  }
  assert.deepEqual(result, before);
});

test("overflow attaches every ordered queue and complete item, with concise pointers and final guidance", () => {
  const result = populated();
  result.applications = Array.from({ length: 130 }, (_, index) => application(String(index).padStart(3, "0")));
  const response = buildTasksResponse(result);
  validate(response, true);
  const full = report(response);
  assert.equal(full.split("\n").filter((line) => line.startsWith("- ")).length, 137); // 134 records plus three report references.
  for (const item of result.applications) assert.equal(full.split(`[${item.targetMemberGroupName} Application](`).length, 2);
  assert.ok(full.endsWith(footer));
  assert.ok(full.includes("[Group 000 Application](https://discord.com/channels/guild/application-channel)"));
  assert.ok(full.includes("[General Support](https://discord.com/channels/guild/ticket-channel)"));
  assert.doesNotMatch(full, /<t:|<#|Opened |Submitted |Awaiting review|conversation open/);
  for (const section of displays(buildTasksResponse(populated())).slice(1)) assert.ok(full.includes(section));
  for (let i = 0; i < 5; i++) assert.ok(displays(response)[i]!.endsWith("See tasks.md for all items in this queue."));
  assert.ok(full.indexOf("Group 000") < full.indexOf("Group 129"));
  result.regearContents[0]!.contentAt = opened;
  result.regears[0]!.contentAt = new Date("2026-08-31T08:30:00Z");
  const timedReport = report(buildTasksResponse(result));
  assert.ok(timedReport.includes(" • Open • 1 September 2026 • 12 UTC"));
  assert.ok(timedReport.includes("Content 31 August 2026 08:30 UTC • [Character"));
  result.applications[0]!.ticketChannelId = undefined;
  result.tickets[0]!.ticketChannelId = undefined;
  assert.equal(report(buildTasksResponse(result)).match(/Channel unavailable/g)?.length, 2);
  result.tickets = [];
  assert.equal(displays(buildTasksResponse(result))[1], "### General Tickets (0)\nNone");
});

test("hostile oversized free text is normalized, escaped and bounded while item links remain whole", () => {
  const result = populated();
  const hostile = "[link](https://evil.invalid)\n**heading** <@123> @everyone " + "[".repeat(2000);
  const regear = result.regears[0]!;
  result.regears = Array.from({ length: 31 }, (_, index) => ({ ...regear, regearClaimId: String(index), characterName: hostile, contentName: hostile }));
  const response = buildTasksResponse(result);
  validate(response, true);
  const text = report(response);
  assert.doesNotMatch(text, /\n\*\*heading\*\*|<@123>|@everyone/);
  assert.ok(text.includes("\\[link\\]\\(https://evil\\.invalid\\)"));
  const lines = text.split("\n").filter((line) => line.includes("/regear-message)"));
  assert.equal(lines.length, 31);
  for (const line of lines) {
    assert.ok(line.endsWith("(https://discord.com/channels/guild/review-channel/regear-message)"));
    assert.ok(line.includes("…"));
    assert.ok(line.length < 1000);
  }
});

test("the complete message fits at exactly 4000 characters and attaches at 4001", () => {
  const result = snapshot();
  // Each bounded label contributes independent padding without exceeding 160 characters.
  result.applications = Array.from({ length: 15 }, (_, index) => application(String(index), { targetMemberGroupName: "x" }));
  let response = buildTasksResponse(result);
  const base = displays(response).reduce((sum, text) => sum + text.length, 0);
  assert.equal(response.files.length, 0);
  let needed = 4000 - base;
  for (const item of result.applications) {
    const extra = Math.min(needed, 158);
    item.targetMemberGroupName += "x".repeat(extra);
    needed -= extra;
  }
  assert.equal(needed, 0);
  response = buildTasksResponse(result);
  validate(response);
  assert.equal(displays(response).reduce((sum, text) => sum + text.length, 0), 4000);
  result.applications.find((item) => item.targetMemberGroupName!.length < 160)!.targetMemberGroupName += "x";
  validate(buildTasksResponse(result), true);
});

test("handler defers ephemerally then reads only the guild snapshot and edits once, including overflow", async () => {
  for (const result of [populated(), { ...snapshot(), applications: Array.from({ length: 130 }, (_, index) => application(String(index))) }]) {
    const events: string[] = [];
    const forbidden = () => { throw new Error("must not read caller roles, Discord objects, or send followups"); };
    const interaction = {
      inGuild: () => true, guildId: "guild",
      get guild() { return forbidden(); }, get user() { return forbidden(); }, get member() { return forbidden(); }, get memberPermissions() { return forbidden(); },
      deferReply: async (payload: unknown) => { assert.deepEqual(payload, { flags: MessageFlags.Ephemeral }); events.push("defer"); },
      editReply: async (payload: ReturnType<typeof buildTasksResponse>) => { validate(payload, result.applications.length > 100); events.push("edit"); },
      followUp: forbidden
    } as unknown as ChatInputCommandInteraction;
    await handleTasksCommand(interaction, { getSnapshot: async (...args) => { assert.deepEqual(args, ["guild"]); events.push("snapshot"); return result; } });
    assert.deepEqual(events, ["defer", "snapshot", "edit"]);
  }
});

test("non-guild invocation does not read dependencies or respond", async () => {
  const forbidden = new Proxy({}, { get() { throw new Error("must not access dependencies"); } });
  await handleTasksCommand({ inGuild: () => false } as ChatInputCommandInteraction, forbidden as never);
});
