export type ReactionSubscriptionAction = "subscribe" | "unsubscribe" | "preserve_dormant";

export function reactionSubscriptionAction(
  reactionAdded: boolean,
  isManagedUser: boolean
): ReactionSubscriptionAction {
  if (reactionAdded) {
    return isManagedUser ? "subscribe" : "preserve_dormant";
  }
  return isManagedUser ? "unsubscribe" : "preserve_dormant";
}

export function createReactionRemovalSuppressor(ttlMilliseconds = 30_000) {
  const pending = new Map<string, NodeJS.Timeout>();

  return {
    mark(key: string): void {
      const existing = pending.get(key);
      if (existing) clearTimeout(existing);
      const timeout = setTimeout(() => pending.delete(key), ttlMilliseconds);
      timeout.unref();
      pending.set(key, timeout);
    },

    consume(key: string): boolean {
      const timeout = pending.get(key);
      if (!timeout) return false;
      clearTimeout(timeout);
      pending.delete(key);
      return true;
    },

    cancel(key: string): void {
      const timeout = pending.get(key);
      if (timeout) clearTimeout(timeout);
      pending.delete(key);
    }
  };
}

export const botReactionRemovalSuppressor = createReactionRemovalSuppressor();

export function reactionChangeKey(
  discordGuildId: string,
  messageId: string,
  emojiKey: string,
  discordUserId: string
): string {
  return [discordGuildId, messageId, emojiKey, discordUserId].join(":");
}

export function reactionRoleConfigChangeKey(
  discordGuildId: string,
  reactionRoleConfigId: string
): string {
  return [discordGuildId, "reaction-role-config", reactionRoleConfigId].join(":");
}
