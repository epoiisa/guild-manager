import { escapeMarkdown } from "discord.js";
import { getAlbionServerLabel } from "../albion/servers.js";
import type { LogChange } from "./events.js";

export interface LogOperation {
  kind?: "membership" | "kick" | "reconciliation" | "departure";
  actorDiscordUserId?: string;
  discordUserId?: string;
  discordUserDisplayName?: string;
  applicationChannelIds?: string[];
  incomplete?: boolean;
}

const name = (value: string | undefined, fallback: string) => escapeMarkdown((value || fallback).replace(/[\r\n\t]+/g, " "));
const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
const unique = <T>(values: T[], key: (value: T) => string): T[] => [...new Map(values.map(value => [key(value), value])).values()];

export function formatLogChanges(changes: readonly LogChange[], operation: LogOperation = {}): string[] {
  const actor = operation.actorDiscordUserId ? `<@${operation.actorDiscordUserId}>` : undefined;
  const roles = unique(changes.filter(change => change.kind === "role"), role => `${role.discordUserId}:${role.action}:${role.roleId}`);
  const incomplete = operation.incomplete || changes.some(change => change.kind === "incomplete");
  const summary = [...changes].reverse().find(change => change.kind === "reconciliation");
  if (summary || operation.kind === "reconciliation") {
    // The reconciler's initial snapshot can race with another operation. Only this
    // scope's committed rows and successful Discord mutations prove a change.
    const outcomes = changes.filter(change => change.kind === "role" || change.kind === "nickname");
    const profiles = unique(changes.filter(change => change.kind === "profile"), change => change.profile.memberGroupProfileId);
    const members = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.discordUserId) members.add(outcome.discordUserId);
    }
    for (const change of profiles) {
      if (change.profile.discordUserId) members.add(change.profile.discordUserId);
    }
    const roleOutcomes = roles;
    const nicknames = outcomes.filter(change => change.kind === "nickname").length;
    const warningCount = summary?.warningCount ?? 0;
    if (profiles.length === 0 && roleOutcomes.length === 0 && nicknames === 0 && !warningCount && !incomplete) return [];
    const line = [actor
      ? `${actor} ran a membership update: ${count(profiles.length, "profile")} changed for ${count(members.size, "member")}.`
      : `Membership update changed ${count(profiles.length, "profile")} for ${count(members.size, "member")}.`];
    if (roleOutcomes.length) line.push(`${count(roleOutcomes.filter(role => role.action === "add").length, "role")} added, ${roleOutcomes.filter(role => role.action === "remove").length} removed.`);
    if (nicknames) line.push(`${count(nicknames, "nickname")} changed.`);
    if (warningCount) line.push(`${count(warningCount, "operation")} could not be completed.`);
    else if (incomplete) line.push("The update could not be completed.");
    // Keep the committed event metadata even if later work fails before a summary
    // can be recorded. Waiting rows and preview outcomes cannot start an entry.
    const departures = unique(changes.filter(change => change.kind === "profile").filter(change => change.startedDepartureGrace),
      change => change.profile.memberGroupProfileId);
    return [line.join(" "), ...departures.map(change => {
      const { profile, startedDepartureGrace: grace } = change;
      const deadline = `<t:${Math.floor(grace!.expiresAt.getTime() / 1000)}:F>`;
      const registration = grace!.registrationExpiresAt
        ? ` Discord registration recovery deadline: <t:${Math.floor(grace!.registrationExpiresAt.getTime() / 1000)}:F>.` : "";
      return `${name(profile.characterName, "Character")} • ${getAlbionServerLabel(profile.albionServer)} started a 72-hour membership grace period in ${name(profile.groupName, "Member group")}. Deadline: ${deadline}.${registration}`;
    })];
  }

  const usedRoleActions = new Set<string>();
  function suffix(userId?: string, actions: readonly ("remove" | "add")[] = ["remove", "add"]): string {
    if (!userId) return "";
    const result: string[] = [];
    for (const action of actions) {
      const key = `${userId}:${action}`;
      if (usedRoleActions.has(key)) continue;
      usedRoleActions.add(key);
      const selected = roles.filter(role => role.discordUserId === userId && role.action === action);
      if (selected.length) result.push(`${selected.map(role => `<@&${role.roleId}>`).join(" ")} ${action === "add" ? "added" : "removed"}.`);
    }
    return result.length ? ` ${result.join(" ")}` : "";
  }
  const lines: string[] = [];
  const lifecycle = unique(changes.filter(change => change.kind === "membershipLifecycle"),
    change => `${change.action}:${change.albionServer}:${change.characterName}:${change.groupName ?? ""}:${change.discordUserId ?? ""}`);
  const registrations = changes.filter(change => change.kind === "registration");
  const profiles = unique(changes.filter(change => change.kind === "profile"), change => `${change.profile.memberGroupProfileId}:${change.action}`);
  if (operation.kind === "kick") {
    const removed = registrations.filter(change => change.action === "unregistered");
    const blocked = changes.find(change => change.kind === "memberBlocked");
    if (removed.length || blocked) {
      const userId = operation.discordUserId ?? blocked?.discordUserId ?? removed[0].character.discordUserId;
      const removal = actor ? `${actor} removed <@${userId}>` : `<@${userId}> was removed`;
      lines.push(`${removal} from Guild Manager. ${count(removed.length, "character")} unregistered and ${count(profiles.filter(change => change.action === "removed").length, "profile")} removed.${blocked ? " Access blocked until officer reconnection." : ""}${suffix(userId)}`);
    }
  } else if (operation.kind === "departure") {
    lines.push(`@${name(operation.discordUserDisplayName, operation.discordUserId ?? "Unknown user")} left the server.${suffix(operation.discordUserId)}`);
    for (const { action, profile } of profiles) {
      if (action === "orphaned") lines.push(profileLine(action, profile));
    }
    for (const channelId of [...new Set(operation.applicationChannelIds ?? [])]) lines.push(`<@${operation.discordUserId}> left an application open in <#${channelId}>.`);
  } else {
    const groupRemoval = changes.find(change => change.kind === "groupRemoved");
    if (groupRemoval) {
      const { memberGroup: group, totalMembershipProfiles, affectedDiscordUserIds } = groupRemoval.result;
      const label = `${name(group.groupName, "Member group")} • ${group.groupType} • ${getAlbionServerLabel(group.albionServer)}`;
      const verb = group.groupType === "group" ? "deleted" : "removed";
      const removal = actor ? `${actor} ${verb} ${label}` : `${label} ${verb}`;
      lines.push(`${removal}. ${count(totalMembershipProfiles, "profile")} removed and ${count(new Set(affectedDiscordUserIds).size, "member")} updated.`);
      // Whole-group removal deliberately reports one aggregate instead of role inventories.
      for (const role of roles) usedRoleActions.add(`${role.discordUserId}:${role.action}`);
    } else {
      const switched = changes.find(change => change.kind === "switch");
      const userIds = new Set([
        ...(switched ? [switched.to.discordUserId] : registrations.map(change => change.character.discordUserId)),
        ...profiles.map(change => change.profile.discordUserId)
      ]);
      for (const userId of userIds) {
        const memberProfiles = profiles.filter(change => change.profile.discordUserId === userId);
        if (!userId) {
          for (const { action, profile } of memberProfiles) lines.push(profileLine(action, profile, actor));
          continue;
        }
        const statements: string[] = [];
        if (switched?.to.discordUserId === userId) {
          const from = name(switched.from.characterName, "Character");
          const switching = actor ? `${actor} switched ${from}` : `${from} switched`;
          statements.push(`${switching} to ${name(switched.to.characterName, "Character")} for <@${userId}> • ${getAlbionServerLabel(switched.to.albionServer)}.`);
        } else if (!switched) {
          for (const { action, character } of registrations.filter(change => change.character.discordUserId === userId)) {
            const characterName = name(character.characterName, "Character");
            const registration = actor ? `${actor} ${action} ${characterName}` : `${characterName} ${action}`;
            statements.push(`${registration} ${action === "registered" ? "to" : "from"} <@${userId}> • ${getAlbionServerLabel(character.albionServer)}.`);
          }
        }
        for (const { action, profile } of memberProfiles) if (action !== "joined") statements.push(profileLine(action, profile, actor));
        // Describe registration and membership loss before removals, then joins
        // before additions. Role outcomes belong to the user's combined entry.
        const beforeJoins = [...new Set(statements)].join(" ");
        const joined = memberProfiles.filter(change => change.action === "joined").map(change => profileLine(change.action, change.profile, actor));
        lines.push([
          ...(beforeJoins ? [`${beforeJoins}${suffix(userId, ["remove"])}`] : []),
          ...joined
        ].join(" ") + suffix(userId));
      }
    }
  }
  for (const role of roles) {
    const remaining = suffix(role.discordUserId);
    if (remaining) lines.push(actor
      ? `${actor} updated roles for <@${role.discordUserId}>.${remaining}`
      : `<@${role.discordUserId}>:${remaining}`);
  }
  for (const change of lifecycle) {
    const character = `${name(change.characterName, "Character")} • ${getAlbionServerLabel(change.albionServer)}`;
    const group = change.groupName ? ` in ${name(change.groupName, "Member group")}` : "";
    const owner = change.discordUserId ? ` for <@${change.discordUserId}>` : "";
    if (change.action === "hold") lines.push(`${character} entered a registration hold${owner}.`);
    else if (change.action === "abandoned") lines.push(`${character} registration abandoned; retained membership entitlements expired.`);
    else if (change.action === "departed") lines.push(`${character} departed${group}; membership entitlements retained during grace.`);
    else if (change.action === "expired") lines.push(`${character} membership${group} expired.`);
    else lines.push(actor
      ? `${actor} restored membership${group} for ${character}${owner}.`
      : `${character} membership${group} restored${owner}.`);
  }
  if (incomplete && (lines.length || operation.kind === "departure")) lines.push("Some membership changes could not be completed.");
  return [...new Set(lines)];
}

function profileLine(action: "joined" | "left" | "orphaned" | "removed", profile: Extract<LogChange, { kind: "profile" }>["profile"], actor?: string): string {
  const character = name(profile.characterName, "Character");
  const group = `${name(profile.groupName, "Member group")} • ${profile.groupType ?? "group"} • ${getAlbionServerLabel(profile.albionServer)}`;
  if (actor && action !== "orphaned") return action === "joined"
    ? `${actor} added ${character} to ${group}.`
    : `${actor} removed ${character} from ${group}.`;
  const verb = action === "orphaned" ? "orphaned in" : action === "removed" ? "removed from" : action;
  return `${character} ${verb} ${group}.`;
}
