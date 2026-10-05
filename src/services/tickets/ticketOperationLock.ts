const tails = new Map<string, Promise<void>>();

/** Serializes one ticket's operations in Guild Manager's single runtime. */
export async function withTicketOperationLock<T>(
  discordGuildId: string,
  ticketId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${discordGuildId}:${ticketId}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
