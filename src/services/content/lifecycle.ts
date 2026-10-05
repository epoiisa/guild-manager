import type { ContentItem } from "../../db/contentRepository.js";

export const CONTENT_ACTIVE_DURATION_MS = 6 * 60 * 60 * 1000;
export const UNSCHEDULED_WAITING_DURATION_MS = 12 * 60 * 60 * 1000;

export function getContentCleanupAt(content: Pick<ContentItem, "scheduledStartAt" | "startedAt" | "firstStartedAt" | "createdAt">): Date {
  const start = content.scheduledStartAt ?? content.firstStartedAt ?? content.startedAt;
  return new Date(start
    ? start.getTime() + CONTENT_ACTIVE_DURATION_MS
    : content.createdAt.getTime() + UNSCHEDULED_WAITING_DURATION_MS);
}

export function canUnstartContent(content: ContentItem, now = new Date()): boolean {
  return content.state === "active" && Boolean(content.startRevision)
    && (!content.scheduledStartAt || content.scheduledStartAt > now)
    && getContentCleanupAt(content) > now;
}
