import { MessageFlags, type EmbedBuilder } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { UpsertMemberUpdateScheduleInput } from "../db/memberUpdateScheduleRepository.js";
import { messageDescription } from "../testSupport/messageAssertions.js";
import { formatSchedule, handleScheduleCommand, parseScheduleRequest } from "./schedule.js";

test("member update schedules accept all UTC clock entry formats", () => {
  for (const [values, hour, minute] of [
    [["9", "09", "9:00", "09:00"], 9, 0],
    [["9:30", "09:30"], 9, 30],
    [["12", "12:00"], 12, 0],
    [["0", "00", "0:00", "00:00"], 0, 0],
    [["23:59"], 23, 59]
  ] as const) {
    for (const value of values) {
      assert.deepEqual(parseScheduleRequest("monday", value), {
        cadence: "weekly", weekday: 1, hourUtc: hour, minuteUtc: minute
      });
    }
  }
});

test("end-of-day schedules advance the weekday and preserve Daily cadence", () => {
  for (const value of ["24", "24:00"]) {
    for (const [day, weekday] of [["monday", 2], ["saturday", 0], ["sunday", 1]] as const) {
      assert.deepEqual(parseScheduleRequest(day, value), {
        cadence: "weekly", weekday, hourUtc: 0, minuteUtc: 0
      });
    }
    assert.deepEqual(parseScheduleRequest("Daily", value), {
      cadence: "daily", weekday: null, hourUtc: 0, minuteUtc: 0
    });
  }
  assert.equal(formatSchedule(parseScheduleRequest("monday", "24")!), "Tuesday at 00:00 UTC");
  assert.equal(formatSchedule(parseScheduleRequest("daily", "24")!), "Daily at 00:00 UTC");
});

test("member update schedules reject invalid times and weekdays", () => {
  for (const time of ["24:01", "24:30", "25", "9:5", "12:60", "9utc", ""]) {
    assert.equal(parseScheduleRequest("monday", time), undefined);
  }
  assert.equal(parseScheduleRequest("tomorrow", "9"), undefined);
});

test("schedule set stores and confirms the normalized UTC weekday and time", async () => {
  const inputs: UpsertMemberUpdateScheduleInput[] = [];
  const replies: Array<{ embeds: EmbedBuilder[]; flags: number }> = [];
  const interaction = {
    inGuild: () => true,
    guildId: "guild-1",
    user: { id: "operator-1" },
    options: {
      getSubcommand: () => "set",
      getString: (name: string) => name === "day" ? "monday" : "24:00"
    },
    reply: async (payload: typeof replies[number]) => { replies.push(payload); }
  } as unknown as Parameters<typeof handleScheduleCommand>[0];
  const repository = {
    upsertSchedule: async (input: UpsertMemberUpdateScheduleInput) => {
      inputs.push(input);
      return input;
    }
  } as unknown as Parameters<typeof handleScheduleCommand>[1];

  await handleScheduleCommand(interaction, repository);

  assert.deepEqual(inputs, [{
    discordGuildId: "guild-1", cadence: "weekly", weekday: 2, hourUtc: 0, minuteUtc: 0,
    createdByDiscordUserId: "operator-1"
  }]);
  assert.equal(replies[0].flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
  assert.equal(messageDescription(replies[0]), "Automatic member updates will run Tuesday at 00:00 UTC.");
});
