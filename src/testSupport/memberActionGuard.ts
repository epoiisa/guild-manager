import { createMemberActionGuard } from "../runtime/memberActionGuard.js";

export function createUnblockedMemberActionGuard() {
  return createMemberActionGuard({ isMemberBlocked: async () => false, getMemberAccess: async () => undefined });
}

/** Isolate existing routing tests from modal-session validation, tested separately. */
export function passThroughModalSessions() {
  return {
    issue: (_guild: string, _user: string, customId: string) => customId,
    take: (customId: string) => ({ customId }),
    stop() {}
  };
}
