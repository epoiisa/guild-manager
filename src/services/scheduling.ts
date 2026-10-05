export const UTC_TIME_OPTION_DESCRIPTION = "UTC time: H, HH, H:MM or HH:MM. 24 or 24:00 is midnight at the end of the selected day.";
export const UTC_TIME_INPUT_HELP = "Use H, HH, H:MM or HH:MM for UTC time, e.g. `9`, `09`, `9:30` or `09:30`. `0`/`00:00` is midnight at the start of the selected day; `24`/`24:00` is midnight at its end. Hour 24 only accepts zero minutes.";

export function parseUtcTime(value: string): { hour: number; minute: number; dayOffset: 0 | 1 } | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return undefined;

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "00");
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) return undefined;

  return { hour: hour === 24 ? 0 : hour, minute, dayOffset: hour === 24 ? 1 : 0 };
}

export function parseUtcDateTime(dateValue: string, timeValue: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
  const time = parseUtcTime(timeValue);
  if (!time) return undefined;

  // Validate the selected calendar date before applying any midnight rollover.
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateValue) return undefined;
  date.setUTCDate(date.getUTCDate() + time.dayOffset);
  date.setUTCHours(time.hour, time.minute, 0, 0);
  return date;
}

export function buildNextUtcDateChoices(now = new Date()): Array<{ name: string; value: string }> {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const formatter = new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start + index * 24 * 60 * 60 * 1000);
    return {
      name: formatter.format(date),
      value: date.toISOString().slice(0, 10)
    };
  });
}
