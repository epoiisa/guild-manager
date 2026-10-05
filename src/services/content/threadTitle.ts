const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const;

export function buildThreadTitle(title: string, scheduledStartAt: Date | null, now = new Date()): string {
  if (!scheduledStartAt) return title.trim().slice(0, 100);
  const suffix = formatThreadTitleSuffix(scheduledStartAt, now);
  const maxTitleLength = Math.max(1, 100 - suffix.length - 1);
  return `${title.slice(0, maxTitleLength).trim()} ${suffix}`.slice(0, 100);
}

function formatThreadTitleSuffix(scheduledStartAt: Date, now: Date): string {
  const time = formatThreadTimeSuffix(scheduledStartAt);
  if (!isFutureUtcDate(scheduledStartAt, now)) return time;
  return `${WEEKDAYS[scheduledStartAt.getUTCDay()]} ${time}`;
}

function formatThreadTimeSuffix(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return minutes === "00" ? `${hours} UTC` : `${hours}${minutes} UTC`;
}

function isFutureUtcDate(date: Date, now: Date): boolean {
  return utcDateStart(date).getTime() > utcDateStart(now).getTime();
}

function utcDateStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
