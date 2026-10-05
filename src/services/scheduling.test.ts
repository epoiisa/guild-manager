import assert from "node:assert/strict";
import test from "node:test";
import { parseUtcDateTime, parseUtcTime } from "./scheduling.js";

test("UTC time inputs accept hour shorthand and one- or two-digit hours with minutes", () => {
  for (const [values, expectedTime] of [
    [["0", "00", "0:00", "00:00"], "00:00"],
    [["9", "09", "9:00", "09:00"], "09:00"],
    [["9:05", "09:05"], "09:05"],
    [["9:30", "09:30", " 09:30 "], "09:30"],
    [["12", "12:00"], "12:00"],
    [["12:30"], "12:30"],
    [["23", "23:00"], "23:00"],
    [["23:59"], "23:59"]
  ] as const) {
    for (const value of values) {
      assert.equal(parseUtcDateTime("2026-09-09", value)?.toISOString(), `2026-09-09T${expectedTime}:00.000Z`, value);
    }
  }
});

test("end-of-day midnight advances the selected UTC date across calendar boundaries", () => {
  for (const [selectedDate, nextDate] of [
    ["2026-09-09", "2026-09-10"],
    ["2026-09-30", "2026-10-01"],
    ["2026-12-31", "2027-01-01"],
    ["2026-02-28", "2026-03-01"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"]
  ]) {
    for (const value of ["24", "24:00"]) {
      assert.equal(parseUtcDateTime(selectedDate, value)?.toISOString(), `${nextDate}T00:00:00.000Z`);
    }
  }
  assert.deepEqual(parseUtcTime("24"), { hour: 0, minute: 0, dayOffset: 1 });
  assert.deepEqual(parseUtcTime("00"), { hour: 0, minute: 0, dayOffset: 0 });
});

test("UTC date-time parsing rejects malformed or out-of-range times", () => {
  for (const value of [
    "", " ", "24:01", "24:30", "25", "25:00", "9:5", "9:", "009", "009:00",
    "-1:00", "+9", "12:60", "9.30", "930", "2400", "9utc", "9 UTC", "9pm", "09:00:00"
  ]) {
    assert.equal(parseUtcDateTime("2026-09-09", value), undefined, value);
    assert.equal(parseUtcTime(value), undefined, value);
  }
});

test("UTC date validation rejects invalid calendar dates before midnight rollover", () => {
  for (const date of ["2026-02-29", "2026-02-31", "2026-04-31", "2026-13-01", "2026-09-00", "2026-9-9"]) {
    for (const time of ["0", "9:30", "24", "24:00"]) {
      assert.equal(parseUtcDateTime(date, time), undefined, `${date} ${time}`);
    }
  }
});
