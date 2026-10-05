import { truncateChoiceName } from "./configurationHelpers.js";
import type { OperationalApplicationTarget } from "../db/applicationRepository.js";
import type { OperationalTicketTarget } from "../db/ticketRepository.js";

export type ApplicationOperationalAction = "accept" | "reject" | "search" | "verify" | "cancel" | "close" | "reopen" | "delete";
export type TicketOperationalAction = "close" | "reopen" | "delete";

export type ApplicationTarget = OperationalApplicationTarget;
export type TicketTarget = OperationalTicketTarget;
export type Actor = { userId: string; roleIds: ReadonlySet<string> };
export type Choice = { name: string; value: string };
export type TargetResolution<T> = { kind: "resolved"; target: T } | { kind: "required" } | { kind: "mismatch" } | { kind: "not_found" };

export function parseOperationalTarget(value: string): string {
  const trimmed = value.trim();
  return /^<#\d+>$/.test(trimmed) ? trimmed.slice(2, -1) : trimmed;
}

export function resolveApplicationTarget(targets: readonly ApplicationTarget[], channelId: string | undefined, supplied: string | undefined): TargetResolution<ApplicationTarget> {
  return resolveTarget(targets.filter((target) => target.channelStatus !== "deleted"), channelId, supplied, "applicationId", "ticketChannelId");
}

export function resolveTicketTarget(targets: readonly TicketTarget[], channelId: string | undefined, supplied: string | undefined): TargetResolution<TicketTarget> {
  return resolveTarget(targets.filter((target) => target.status !== "deleted"), channelId, supplied, "ticketId", "ticketChannelId");
}

function resolveTarget<T extends { ticketChannelId?: string }>(targets: readonly T[], channelId: string | undefined, supplied: string | undefined, idKey: "applicationId" | "ticketId", channelKey: "ticketChannelId"): TargetResolution<T> {
  const current = channelId ? targets.find((target) => target[channelKey] === channelId) : undefined;
  if (!supplied?.trim()) return current ? { kind: "resolved", target: current } : { kind: "required" };
  const value = parseOperationalTarget(supplied);
  const target = targets.find((candidate) => (candidate as T & Record<string, string>)[idKey] === value || candidate[channelKey] === value);
  if (!target) return { kind: "not_found" };
  return current && (current as T & Record<string, string>)[idKey] !== (target as T & Record<string, string>)[idKey] ? { kind: "mismatch" } : { kind: "resolved", target };
}

export type TargetLabels = { channel(id?: string): string; user(id: string): string };

export function createCacheLabels(channels: ReadonlyMap<string, { name: string }>, users: ReadonlyMap<string, { displayName?: string; username: string }>): TargetLabels {
  return {
    channel: (id) => id ? `#${channels.get(id)?.name ?? id}` : "#unknown",
    user: (id) => `@${users.get(id)?.displayName ?? users.get(id)?.username ?? id}`
  };
}

export function applicationChoices(action: ApplicationOperationalAction, actor: Actor, targets: readonly ApplicationTarget[], query: string, labels: TargetLabels): Choice[] {
  return targets.filter((target) => target.channelStatus !== "deleted" && canApplicationAction(action, actor, target)).map((target) => ({
    name: truncateChoiceName(`${target.targetMemberGroupName ?? target.applicationName} • ${labels.user(target.applicantDiscordUserId)} • ${target.status}/${target.channelStatus}`),
    value: target.applicationId
  })).filter((choice) => matches(choice, query)).slice(0, 25);
}

export function ticketChoices(action: TicketOperationalAction, actor: Actor, targets: readonly TicketTarget[], query: string, labels: TargetLabels): Choice[] {
  return targets.filter((target) => target.status !== "deleted" && canTicketAction(action, actor, target)).map((target) => ({
    name: truncateChoiceName(`${labels.channel(target.ticketChannelId)} • ${target.ticketName} • ${labels.user(target.openerDiscordUserId)} • ${target.status}`),
    value: target.ticketId
  })).filter((choice) => matches(choice, query)).slice(0, 25);
}

export function canApplicationAction(action: ApplicationOperationalAction, actor: Actor, target: ApplicationTarget): boolean {
  const reviewer = actor.roleIds.has(target.reviewerRoleId); const applicant = actor.userId === target.applicantDiscordUserId;
  if (target.channelStatus === "deleted") return false;
  if (action === "accept" || action === "reject") return target.status === "open" && target.channelStatus === "open" && target.characterResolutionState === "selected" && !!target.selectedAlbionCharacterId && (!target.selectedCharacterOwnerDiscordUserId || target.selectedCharacterOwnerDiscordUserId === target.applicantDiscordUserId) && reviewer;
  if (action === "search") return target.status === "open" && target.channelStatus === "open" && (applicant || reviewer);
  if (action === "verify" || action === "cancel") return target.status === "awaiting_ingame_membership" && target.channelStatus === "open" && reviewer;
  // A closed retained decision is included so `/application close` can repair a
  // legacy/missing Application Closed control without changing lifecycle state.
  if (action === "close") return ["open", "closed"].includes(target.channelStatus) && (target.status === "open" ? reviewer : ["accepted", "rejected", "withdrawn"].includes(target.status) && (applicant || reviewer));
  if (action === "reopen") return target.channelStatus === "closed" && (applicant || reviewer);
  return target.channelStatus === "closed" && reviewer;
}

export function canTicketAction(action: TicketOperationalAction, actor: Actor, target: TicketTarget): boolean {
  const reviewer = actor.roleIds.has(target.reviewerRoleId); const opener = actor.userId === target.openerDiscordUserId;
  if (target.status === "deleted") return false;
  return action === "close" ? target.status === "open" && (opener || reviewer) : action === "reopen" ? target.status === "closed" && (opener || reviewer) : target.status === "closed" && reviewer;
}

function matches(choice: Choice, query: string): boolean { const value = query.trim().toLowerCase(); return !value || `${choice.name} ${choice.value}`.toLowerCase().includes(value); }
