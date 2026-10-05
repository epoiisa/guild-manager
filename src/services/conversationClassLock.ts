import type { ConversationKind } from "../db/conversationClassRemovalRepository.js";

const tails = new Map<string, Promise<void>>();

/** Prevents confirmed removal from racing channel provisioning in the single runtime. */
export async function withConversationClassLock<T>(kind: ConversationKind, guildId: string, classId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${kind}:${guildId}:${classId}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}
