import { AsyncLocalStorage } from "node:async_hooks";

export interface MemberAccessReader {
  isMemberBlocked(discordGuildId: string, discordUserId: string): Promise<boolean>;
  getMemberAccess(discordGuildId: string, discordUserId: string): Promise<{ lastKickedAt: Date | null } | undefined>;
}

interface Lease { guildId: string; exclusive: boolean; active: boolean; }
interface Waiter { exclusive: boolean; grant(release: () => void): void; }
interface GuildQueue { readers: number; writer: boolean; waiting: Waiter[]; }

export type MemberActionResult<T> = { allowed: false } | { allowed: true; value: T };
export type MemberActionGuard = ReturnType<typeof createMemberActionGuard>;

/** The runtime ownership lock excludes another bot runtime. This barrier drains
 * awaited work in this runtime before kick cleanup, then checks durable access
 * again for every queued actor. It does not fence external database clients.
 */
export function createMemberActionGuard(access: MemberAccessReader) {
  const context = new AsyncLocalStorage<Lease>();
  const queues = new Map<string, GuildQueue>();
  let stopped = false;

  function acquire(guildId: string, exclusive: boolean): Promise<() => void> {
    return new Promise(resolve => {
      let queue = queues.get(guildId);
      if (!queue) {
        queue = { readers: 0, writer: false, waiting: [] };
        queues.set(guildId, queue);
      }
      queue.waiting.push({ exclusive, grant: resolve });
      drain(guildId, queue);
    });
  }

  function drain(guildId: string, queue: GuildQueue): void {
    if (queue.writer) return;
    while (queue.waiting.length) {
      const next = queue.waiting[0]!;
      if (next.exclusive && queue.readers > 0) return;
      queue.waiting.shift();
      if (next.exclusive) queue.writer = true;
      else queue.readers++;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        if (next.exclusive) queue.writer = false;
        else queue.readers--;
        drain(guildId, queue);
      });
      if (next.exclusive) return;
    }
    if (!queue.writer && queue.readers === 0) queues.delete(guildId);
  }

  async function runSystem<T>(guildId: string, work: () => Promise<T>, exclusive = false): Promise<T> {
    if (stopped) throw new Error("Guild Manager is stopping.");
    const held = context.getStore();
    if (held?.active && held.guildId === guildId) {
      if (exclusive && !held.exclusive) throw new Error("Cannot upgrade an active Guild Manager action to exclusive access.");
      return work();
    }
    const release = await acquire(guildId, exclusive);
    const lease: Lease = { guildId, exclusive, active: true };
    try {
      if (stopped) throw new Error("Guild Manager is stopping.");
      return await context.run(lease, work);
    } finally {
      lease.active = false;
      release();
    }
  }

  async function run<T>(guildId: string, userId: string, work: () => Promise<T>, exclusive = false): Promise<MemberActionResult<T>> {
    return runSystem(guildId, async () => {
      if (await access.isMemberBlocked(guildId, userId)) return { allowed: false };
      return { allowed: true, value: await work() };
    }, exclusive);
  }

  return {
    run, runSystem,
    lastKickedAt: async (guildId: string, userId: string) => (await access.getMemberAccess(guildId, userId))?.lastKickedAt ?? null,
    isExclusivePending: (guildId: string) => {
      const queue = queues.get(guildId);
      return Boolean(queue?.writer || queue?.waiting.some(waiter => waiter.exclusive));
    },
    stop: () => { stopped = true; }
  };
}
