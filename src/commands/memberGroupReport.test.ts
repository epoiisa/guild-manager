import assert from "node:assert/strict";
import test from "node:test";
import {
  AttachmentBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions
} from "discord.js";
import type { MemberGroup, MemberGroupProfile } from "../db/membershipRepository.js";
import { assertStandardMessage } from "../testSupport/messageAssertions.js";
import { replyWithMemberGroupReport } from "./memberGroupReport.js";

const generatedAt = "2026-09-29T00:30:00.000Z";
const generatedAtLabel = "29/09/2026 • 00:30 UTC";
const generatedAtSeconds = 1790641800;
const reportTypes = [
  { groupType: "guild", title: "Guild Report", name: "Frostborn Exiles", slug: "frostborn-exiles" },
  { groupType: "alliance", title: "Alliance Report", name: "The Alliance", slug: "the-alliance" },
  { groupType: "group", title: "Group Report", name: "Friends", slug: "friends" }
] as const;

function fixture(options: { count?: number; groupType?: MemberGroup["groupType"]; groupName?: string; uploadFails?: boolean; schedule?: "daily" | "weekly"; scheduleFails?: boolean } = {}) {
  const group: MemberGroup = {
    memberGroupId: "group-1", discordGuildId: "discord-1", albionServer: "asia",
    groupType: options.groupType ?? "guild", groupName: options.groupName ?? "Frostborn Exiles"
  };
  const profiles: MemberGroupProfile[] = Array.from({ length: options.count ?? 85 }, (_, index) => ({
    memberGroupProfileId: `profile-${index}`, memberGroupId: group.memberGroupId,
    discordGuildId: group.discordGuildId, albionServer: group.albionServer,
    albionCharacterId: `character-${index}`, characterName: `Character${index}`,
    ...(index === 0 ? { discordUserId: "member-1" } : {})
  }));
  const replies: InteractionReplyOptions[] = [];
  const acknowledgements: InteractionDeferReplyOptions[] = [];
  const edits: InteractionEditReplyOptions[] = [];
  const interaction = {
    guildId: group.discordGuildId,
    guild: null,
    deferReply: async (payload: InteractionDeferReplyOptions) => {
      acknowledgements.push(payload);
    },
    reply: async (payload: InteractionReplyOptions) => {
      replies.push(payload);
    },
    editReply: async (payload: InteractionEditReplyOptions) => {
      edits.push(payload);
      if (options.uploadFails) throw new Error("upload timed out");
    }
  } as unknown as ChatInputCommandInteraction;
  const repository = {
    listProfilesForGroupReport: async (discordGuildId: string, memberGroupId: string) => {
      assert.deepEqual(acknowledgements, [{ flags: MessageFlags.Ephemeral }], "acknowledge privately before querying or fetching members");
      assert.equal(discordGuildId, group.discordGuildId);
      assert.equal(memberGroupId, group.memberGroupId);
      return profiles;
    }
  } as unknown as Parameters<typeof replyWithMemberGroupReport>[1];
  const scheduleRepository = {
    getSchedule: async (discordGuildId: string) => {
      assert.deepEqual(acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
      assert.equal(discordGuildId, group.discordGuildId, "read only the invoking Discord server's schedule");
      if (options.scheduleFails) throw new Error("schedule read failed");
      return options.schedule ? {
        discordGuildId, cadence: options.schedule, weekday: options.schedule === "weekly" ? 1 : null,
        hourUtc: 12, minuteUtc: 0, lastRunKey: null, lastRunAt: null, lastSuccessAt: null, lastError: null,
        createdByDiscordUserId: "admin-1", createdAt: new Date(generatedAt), updatedAt: new Date(generatedAt)
      } : undefined;
    }
  };
  return { group, profiles, replies, edits, acknowledgements, run: () => replyWithMemberGroupReport(interaction, repository, group, scheduleRepository) };
}

function assertReportMessage(payload: InteractionEditReplyOptions, title: string, name: string, timestamp = generatedAtSeconds) {
  const reply = assertStandardMessage(payload);
  assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(reply.content, `${title.replace(" Report", "")} report for ${name} at <t:${timestamp}:F>.`);
  assert.equal(reply.components, undefined);
  return reply;
}

function assertReportFile(payload: InteractionEditReplyOptions, filename: string) {
  assert.equal(payload.files?.length, 1);
  const file = payload.files?.[0];
  assert.ok(file instanceof AttachmentBuilder);
  assert.equal(file.name, filename);
  assert.ok(Buffer.isBuffer(file.attachment));
  assert.equal(payload.components, undefined);
  return file.attachment.toString("utf8");
}

test("reports use the exact private sentence and normal complete attachment in one reply", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  for (const { groupType, title, name, slug } of reportTypes) {
    const f = fixture({ groupType, groupName: name });
    Object.assign(f.profiles[0], { lifecycleState: "current", entitlementPreserved: true });
    await f.run();
    assert.equal(f.edits.length, 1);
    assert.equal(f.replies.length, 0);
    assertReportMessage(f.edits[0], title, name);
    const report = assertReportFile(f.edits[0], `${groupType}-report-${slug}-20260929T0030Z.txt`);
    assert.deepEqual(report.split("\n"), [
      title, `${name} • Asia`, generatedAtLabel, "", "85 profiles", "1 registered • 84 orphaned", "",
      ...Array.from({ length: 85 }, (_, index) => `Character${index} • ${index === 0 ? "@member-1" : "orphaned"}`)
    ]);
  }
});

test("an uncertain report upload is not retried or replaced by another response", async () => {
  const f = fixture({ uploadFails: true });
  await assert.rejects(f.run(), /upload timed out/);
  assert.equal(f.edits.length, 1);
  assert.equal(f.replies.length, 0);
});

test("empty and short reports use the same sentence with all counts and rows in the attachment", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  for (const { groupType, title, name, slug } of reportTypes) {
    for (const count of [0, 1, 40]) {
      const f = fixture({ count, groupType, groupName: name });
      await f.run();
      assert.equal(f.edits.length, 1);
      assertReportMessage(f.edits[0], title, name);
      const report = assertReportFile(f.edits[0], `${groupType}-report-${slug}-20260929T0030Z.txt`);
      assert.deepEqual(report.split("\n"), [
        title, `${name} • Asia`, generatedAtLabel, "", `${count} profile${count === 1 ? "" : "s"}`, "",
        ...(count === 0 ? ["No member profiles were found for this group."] : Array.from({ length: count }, (_, index) =>
          `Character${index} • ${index === 0 ? "@member-1" : "orphaned"}`))
      ]);
      assert.equal(f.replies.length, 0);
    }
  }
});

test("larger reports retain every profile in the attachment", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  const f = fixture({ count: 41 });
  await f.run();
  const report = assertReportFile(f.edits[0], "guild-report-frostborn-exiles-20260929T0030Z.txt");
  assert.match(report, /\n41 profiles\n/);
  assert.equal(report.split("\n").filter(line => line.startsWith("Character")).length, 41);
  assert.match(report, /Character40 • orphaned$/);
});

test("long profile text stays in the attachment without losing records", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  const f = fixture({ count: 40 });
  f.profiles.forEach((profile, index) => { profile.characterName = `${"Character".repeat(12)}${index}`; });
  await f.run();
  assertReportMessage(f.edits[0], "Guild Report", "Frostborn Exiles");
  const report = assertReportFile(f.edits[0], "guild-report-frostborn-exiles-20260929T0030Z.txt");
  assert.deepEqual(report.split("\n").slice(6), f.profiles.map((profile, index) =>
    `${profile.characterName} • ${index === 0 ? "@member-1" : "orphaned"}`));
  assert.equal(f.replies.length, 0);
});

test("report filenames normalize case, whitespace, punctuation and accents with a fallback for empty slugs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  for (const [groupName, slug] of [
    ["  FROSTBÖRN _ Éxiles... & Friends! ", "frostbörn-éxiles-friends"],
    ["Guild   Name\tHere", "guild-name-here"],
    ["朋友", "朋友"],
    ["!!! ☃️", "unnamed"]
  ]) {
    const f = fixture({ groupName });
    await f.run();
    const report = assertReportFile(f.edits[0], `guild-report-${slug}-20260929T0030Z.txt`);
    assert.equal(report.split("\n")[1], `${groupName} • Asia`, "the download header retains the original name");
  }
});

test("Discord timestamps, file headers and filenames share one instant across day and year boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  for (const [instant, label, filenameTimestamp] of [
    ["2026-09-29T00:00:00+08:00", "28/09/2026 • 16:00 UTC", "20260928T1600Z"],
    ["2026-12-31T23:59:59.999Z", "31/12/2026 • 23:59 UTC", "20261231T2359Z"],
    ["2027-01-01T00:00:00.000Z", "01/01/2027 • 00:00 UTC", "20270101T0000Z"]
  ]) {
    t.mock.timers.setTime(new Date(instant).getTime());
    const f = fixture();
    await f.run();
    assertReportMessage(f.edits[0], "Guild Report", "Frostborn Exiles", Math.floor(new Date(instant).getTime() / 1000));
    const report = assertReportFile(f.edits[0], `guild-report-frostborn-exiles-${filenameTimestamp}.txt`);
    assert.deepEqual(report.split("\n").slice(0, 3), ["Guild Report", "Frostborn Exiles • Asia", label]);
  }
});

test("reports distinguish roster observations, recovery states and independent departure deadlines", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  const f = fixture({ count: 6 });
  const deadline = new Date("2099-01-04T12:00:00Z");
  Object.assign(f.profiles[0], { lifecycleState: "current", entitlementPreserved: true });
  Object.assign(f.profiles[1], { lifecycleState: "unregistered", entitlementPreserved: false });
  Object.assign(f.profiles[2], { lifecycleState: "departed", departureExpiresAt: deadline, lifecycleWarning: true });
  Object.assign(f.profiles[3], { lifecycleState: "departed", registrationState: "hold", registrationExpiresAt: deadline, departureExpiresAt: new Date("2099-01-03T12:00:00Z") });
  Object.assign(f.profiles[4], { lifecycleState: "unregistered", registrationState: "abandoned", entitlementPreserved: false });
  Object.assign(f.profiles[5], { lifecycleState: "manual", entitlementPreserved: true });
  await f.run();
  const file = f.edits[0].files?.[0];
  assert.ok(file instanceof AttachmentBuilder && Buffer.isBuffer(file.attachment));
  const text = file.attachment.toString("utf8");
  assert.match(text, /Character1 • unregistered/);
  assert.match(text, /Character2 • departed • grace period ends 04\/01\/2099 12:00 UTC/);
  assert.match(text, /last lifecycle check failed/);
  assert.match(text, /Character3 • departed • grace period ends 03\/01\/2099 12:00 UTC • Discord registration hold until 04\/01\/2099 12:00 UTC/);
  assert.match(text, /Character4 • Discord registration abandoned • \/character register required/);
  assert.match(text, /Character5 • orphaned/);
  assert.match(text, /1 registered • 1 unregistered • 1 departed • 1 hold • 1 abandoned • 1 orphaned/);
});

test("downloaded lifecycle reports retain UTC dates and every record", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(generatedAt) });
  const f = fixture();
  Object.assign(f.profiles[1], { lifecycleState: "departed", departureExpiresAt: new Date("2000-01-01T00:00:00Z"), lifecycleWarning: true });
  await f.run();
  const file = f.edits[0].files?.[0];
  assert.ok(file instanceof AttachmentBuilder && Buffer.isBuffer(file.attachment));
  const report = file.attachment.toString("utf8");
  assert.match(report, /grace period expired • awaiting manual \/update; no update scheduled • last lifecycle check failed/);
  assert.match(report, /Character84/);
  assert.doesNotMatch(report, /<t:/);
});

test("departure grace changes at the saved boundary and uses the current daily, weekly or absent schedule", async (t) => {
  const now = new Date("2026-09-30T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const groupType of ["guild", "alliance"] as const) {
    for (const schedule of [undefined, "daily", "weekly"] as const) {
      for (const offset of [-1, 0, 1]) {
        const f = fixture({ count: 1, groupType, schedule });
        Object.assign(f.profiles[0], { characterName: "Thorn", discordUserId: undefined,
          lifecycleState: "departed", departureExpiresAt: new Date(now.getTime() + offset) });
        await f.run();
        const report = assertReportFile(f.edits[0], `${groupType}-report-frostborn-exiles-20260930T1200Z.txt`);
        const expected = offset > 0 ? "grace period ends 30/09/2026 12:00 UTC"
          : `grace period expired • ${schedule ? "awaiting scheduled update or manual /update" : "awaiting manual /update; no update scheduled"}`;
        assert.equal(report.split("\n").at(-1), `Thorn • departed • ${expected}`);
        assert.doesNotMatch(report, /overdue|Albion Online membership ended/);
      }
    }
  }
});

test("all report types show the accepted registration hold, abandonment and warning wording", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  for (const { groupType } of reportTypes) {
    const f = fixture({ count: 4, groupType });
    const future = new Date("2026-10-03T20:00:00+08:00");
    const expired = new Date("2026-09-29T12:00:00Z");
    f.profiles.forEach(profile => Object.assign(profile, { discordUserId: undefined,
      lifecycleState: "current", registrationState: "hold", registrationSource: "discord_departure", registrationExpiresAt: future }));
    Object.assign(f.profiles[0], { characterName: "Willow" });
    Object.assign(f.profiles[1], { characterName: "Overdue", registrationExpiresAt: expired });
    Object.assign(f.profiles[2], { characterName: "Boundary", registrationExpiresAt: new Date("2026-09-30T12:00:00Z"), lifecycleWarning: true });
    Object.assign(f.profiles[3], { characterName: "Ember", registrationState: "abandoned" });
    await f.run();
    const report = assertReportFile(f.edits[0], `${groupType}-report-frostborn-exiles-20260930T1200Z.txt`);
    assert.deepEqual(report.split("\n").slice(-4), [
      "Willow • registration held after Discord departure • recover with /character register before 03/10/2026 12:00 UTC",
      "Overdue • Discord registration hold overdue since 29/09/2026 12:00 UTC • awaiting automatic cleanup",
      "Boundary • Discord registration hold overdue since 30/09/2026 12:00 UTC • awaiting automatic cleanup • last lifecycle check failed",
      "Ember • Discord registration abandoned • /character register required"
    ]);
    assert.match(report, /30\/09\/2026 • 12:00 UTC/);
  }
});

test("roster observations keep the purged label without suggesting retained entitlements or a timer", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  for (const { groupType } of reportTypes) {
    const f = fixture({ count: 1, groupType });
    Object.assign(f.profiles[0], { characterName: "Purged", discordUserId: undefined,
      lifecycleState: "unregistered", entitlementPreserved: false, registrationState: "purged", registrationSource: "purge" });
    await f.run();
    const report = assertReportFile(f.edits[0], `${groupType}-report-frostborn-exiles-20260930T1200Z.txt`);
    assert.match(report, /1 purged/);
    assert.equal(report.split("\n").at(-1), "Purged • purged • no retained entitlements • /character register required");
    assert.doesNotMatch(report, /deadline|grace|hold|abandoned/);
  }
});

test("combined departures keep both independent timers without the long processing instructions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T12:00:00Z") });
  const future = new Date("2026-10-03T12:00:00Z"), past = new Date("2026-09-29T12:00:00Z");
  for (const departureExpired of [false, true]) {
    for (const holdExpired of [false, true]) {
      const f = fixture({ count: 1, schedule: "daily" });
      Object.assign(f.profiles[0], { characterName: "Willow", discordUserId: undefined, lifecycleState: "departed",
        departureExpiresAt: departureExpired ? past : future, registrationState: "hold", registrationSource: "discord_departure",
        registrationExpiresAt: holdExpired ? past : future });
      await f.run();
      const report = assertReportFile(f.edits[0], "guild-report-frostborn-exiles-20260930T1200Z.txt");
      const membership = departureExpired ? "departed; grace expired" : "departed • grace period ends 03/10/2026 12:00 UTC";
      const registration = holdExpired ? "Discord registration hold overdue since 29/09/2026 12:00 UTC • awaiting automatic cleanup"
        : "Discord registration hold until 03/10/2026 12:00 UTC";
      assert.equal(report.split("\n").at(-1), `Willow • ${membership} • ${registration}`);
      assert.match(report, /\n1 hold\n/, "combined state still contributes to only one summary category");
    }
  }
});

test("a failed schedule read cannot claim no update is scheduled", async () => {
  const f = fixture({ scheduleFails: true });
  await assert.rejects(f.run(), /schedule read failed/);
  assert.deepEqual(f.edits, []);
});
