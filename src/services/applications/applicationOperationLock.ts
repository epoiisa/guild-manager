import { AsyncLocalStorage } from "node:async_hooks";

const tails = new Map<string, Promise<void>>();
const owners = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** Serializes one application's operations in Guild Manager's single runtime. */
export async function withApplicationOperationLock<T>(
  discordGuildId: string,
  applicationId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${discordGuildId}:${applicationId}`;
  if (owners.getStore()?.get(key)?.active) return operation();
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(key, tail);
  await previous;
  const owner = { active: true };
  const context = new Map(owners.getStore());
  context.set(key, owner);
  try {
    return await owners.run(context, operation);
  } finally {
    owner.active = false;
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
