import { AsyncLocalStorage } from "node:async_hooks";
import type { AlbionServer } from "../albion/servers.js";
import type { MemberGroupProfile, MemberGroupRemovalResult, RegisteredCharacter } from "../../db/membershipRepository.js";
import type { MembershipReconciliationOutcome } from "../membership/reconciliation.js";

export type LogChange =
  | { kind: "memberBlocked"; discordUserId: string }
  | { kind: "membershipLifecycle"; action: "hold" | "abandoned" | "departed" | "expired" | "restored"; characterName: string;
      albionServer: AlbionServer; discordUserId?: string; groupName?: string }
  | { kind: "registration"; action: "registered" | "unregistered"; character: RegisteredCharacter }
  | { kind: "profile"; action: "joined" | "left" | "orphaned" | "removed"; profile: MemberGroupProfile;
      startedDepartureGrace?: { expiresAt: Date; registrationExpiresAt?: Date } }
  | { kind: "switch"; from: RegisteredCharacter; to: RegisteredCharacter }
  | { kind: "groupRemoved"; result: MemberGroupRemovalResult }
  | { kind: "role"; action: "add" | "remove"; discordUserId: string; roleId: string }
  | { kind: "nickname"; action: "set" | "clear"; discordUserId: string; nickname?: string }
  | { kind: "reconciliation"; outcomes: MembershipReconciliationOutcome[]; warningCount: number }
  | { kind: "incomplete"; area: "membership" };

interface LogScope { guildId: string; changes: LogChange[]; active: boolean }
const scopes = new AsyncLocalStorage<LogScope>();

/** The callback can publish in finally, preserving changes committed before a later failure. */
export async function withLogChanges<T>(guildId: string, operation: (changes: LogChange[]) => Promise<T>): Promise<T> {
  const parent = scopes.getStore();
  if (parent?.active && parent.guildId === guildId) return operation(parent.changes);
  const scope: LogScope = { guildId, changes: [], active: true };
  return scopes.run(scope, async () => {
    try { return await operation(scope.changes); }
    finally { scope.active = false; }
  });
}

export function isLogCaptureActive(guildId: string): boolean {
  const scope = scopes.getStore();
  return scope?.active === true && scope.guildId === guildId;
}

export function recordLogChange(guildId: string, change: LogChange): void {
  const scope = scopes.getStore();
  if (scope?.active && scope.guildId === guildId) scope.changes.push(change);
}
