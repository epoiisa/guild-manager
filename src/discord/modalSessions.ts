import { randomUUID } from "node:crypto";

const MODAL_SESSION_PREFIX = "gm-modal:";
const MODAL_SESSION_LIFETIME_MS = 15 * 60 * 1000;
// Bound retained forms even when many are opened without being submitted.
const MAX_MODAL_SESSIONS = 10_000;
interface ModalSession { guildId: string; userId: string; customId: string; issuedAt: number; }

/** Bind temporary forms to their issuance, rather than their later submission.
 * Losing this process-local store safely expires already open forms on restart.
 */
export function createModalSessions(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, ModalSession>();
  let stopped = false;

  function removeExpired(): void {
    const cutoff = now() - MODAL_SESSION_LIFETIME_MS;
    for (const [token, session] of sessions) if (session.issuedAt <= cutoff) sessions.delete(token);
  }

  return {
    issue(guildId: string, userId: string, originalCustomId: string, issuedAt = now()): string {
      if (stopped) throw new Error("Modal sessions are stopped.");
      if (!guildId || !userId || !originalCustomId || originalCustomId.length > 100 || !Number.isFinite(issuedAt)) {
        throw new Error("Invalid modal session.");
      }
      removeExpired();
      while (sessions.size >= MAX_MODAL_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const token = MODAL_SESSION_PREFIX + randomUUID();
      sessions.set(token, { guildId, userId, customId: originalCustomId, issuedAt });
      return token;
    },

    take(token: string, guildId: string, userId: string, lastKickedAt: Date | null | undefined): { customId: string } | undefined {
      if (stopped || !token.startsWith(MODAL_SESSION_PREFIX)) return undefined;
      removeExpired();
      const session = sessions.get(token);
      if (!session || session.guildId !== guildId || session.userId !== userId) return undefined;
      sessions.delete(token);
      if (lastKickedAt && session.issuedAt <= lastKickedAt.getTime()) return undefined;
      return { customId: session.customId };
    },

    stop(): void { stopped = true; sessions.clear(); }
  };
}
