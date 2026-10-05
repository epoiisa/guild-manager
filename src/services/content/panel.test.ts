import test from "node:test";
import assert from "node:assert/strict";
import { Collection, type Guild } from "discord.js";
import { createContentPanelService } from "./panel.js";
import type {
  ContentPanelPublication,
  createContentPanelRepository,
} from "../../db/contentPanelRepository.js";
const now = new Date("2026-09-10T00:00:00Z");
function fixture() {
  let rows: ContentPanelPublication[] = [],
    sends = 0,
    edits = 0,
    deletes = 0,
    failCommit = false,
    failFetch = false,
    failSend = false,
    permissions = true;
  let next = 1000000000000000000n;
  const messages = new Collection<string, any>();
  const config = {
    discordGuildId: "g",
    discordChannelId: "c",
    configurationRevision: "r",
  };
  const committed: string[] = [];
  const repo = {
    listPublications: async () => rows,
    listPanelContent: async () => [],
    beginPublication: async (input: any) => {
      const row = {
        ...input,
        createdAt: input.now,
        updatedAt: input.now,
        state: "pending",
        messageId: null,
        publishedAt: null,
        scanBeforeMessageId: null,
      };
      rows.push(row);
      return row;
    },
    commitPublication: async (_: string, generation: string, id: string) => {
      if (failCommit) throw Error("commit");
      committed.push(generation);
      for (const row of rows)
        if (row.state === "current") row.state = "retired";
      const row = rows.find((r) => r.generation === generation)!;
      row.state = "current";
      row.messageId = id;
      row.publishedAt = now;
      return true;
    },
    retirePublication: async (_: string, generation: string, id?: string) => {
      const row = rows.find((r) => r.generation === generation)!;
      row.state = "retired";
      if (id) row.messageId = id;
    },
    removePublication: async (_: string, generation: string) => {
      rows = rows.filter((r) => r.generation !== generation);
    },
    markRendered: async (_: string, generation: string, hash: string) => {
      rows.find((r) => r.generation === generation)!.renderHash = hash;
    },
    updateRecoveryCursor: async (
      _: string,
      generation: string,
      cursor: string | null,
    ) => {
      rows.find((r) => r.generation === generation)!.scanBeforeMessageId =
        cursor;
    },
  } as unknown as ReturnType<typeof createContentPanelRepository>;
  const channel = {
    id: "c",
    type: 0,
    permissionsFor: () => ({ has: () => permissions }),
    messages: {
      fetch: async (options: any) => {
        if (failFetch) throw { code: 50013 };
        if (options.message) {
          const m = messages.get(options.message);
          if (!m) throw { code: 10008 };
          return m;
        }
        return new Collection(
          [...messages]
            .filter(
              ([id]) => !options.before || BigInt(id) < BigInt(options.before),
            )
            .reverse()
            .slice(0, options.limit),
        );
      },
    },
    send: async (payload: any) => {
      if (failSend) throw { status: 403, code: 50013 };
      sends++;
      const id = String(++next);
      const m = {
        id,
        author: { id: "bot" },
        components: payload.components,
        createdTimestamp: now.getTime(),
        delete: async () => {
          deletes++;
          messages.delete(id);
        },
        edit: async () => {
          edits++;
        },
      };
      messages.set(id, m);
      return m;
    },
  };
  const guild = {
    id: "g",
    members: { me: null },
    client: { user: { id: "bot" } },
    channels: { fetch: async () => channel },
  } as unknown as Guild;
  const service = createContentPanelService(
    { getContentChannel: async () => config },
    repo,
    { warn() {}, info() {}, error() {}, debug() {} },
  );
  return {
    service,
    committed,
    guild,
    config,
    setPermissions: (v: boolean) => {
      permissions = v;
    },
    setFailSend: (v: boolean) => {
      failSend = v;
    },
    rows: () => rows,
    messages,
    stats: () => ({ sends, edits, deletes }),
    setFailCommit: (v: boolean) => {
      failCommit = v;
    },
    setFailFetch: (v: boolean) => {
      failFetch = v;
    },
    human: () => {
      const id = String(++next);
      messages.set(id, {
        id,
        author: { id: "human" },
        components: [],
        createdTimestamp: now.getTime(),
      });
    },
  };
}
test("first publication, quiet no-op, precision-safe bottom bump and burst coalescing", async () => {
  const f = fixture();
  await f.service.runGuild(f.guild, now);
  await f.service.runGuild(f.guild, now);
  assert.equal(f.stats().sends, 1);
  f.human();
  await f.service.runGuild(f.guild, new Date(now.getTime() + 30000));
  assert.equal(f.stats().sends, 1);
  await f.service.runGuild(f.guild, new Date(now.getTime() + 60000));
  assert.deepEqual(f.stats(), { sends: 2, edits: 0, deletes: 1 });
});
test("restart discovers send-before-save generation without duplicating", async () => {
  const f = fixture();
  f.setFailCommit(true);
  await f.service.runGuild(f.guild, now);
  assert.equal(f.rows()[0]?.state, "pending");
  f.setFailCommit(false);
  f.service.stop();
  f.service.start();
  await f.service.runGuild(f.guild, new Date(now.getTime() + 60000));
  assert.equal(f.stats().sends, 1);
  assert.equal(f.rows()[0]?.state, "current");
});
test("indeterminate fetch preserves canonical and no replacement; invalidation fences queued passes", async () => {
  const f = fixture();
  await f.service.runGuild(f.guild, now);
  f.setFailFetch(true);
  await f.service.runGuild(f.guild, new Date(now.getTime() + 60000));
  assert.equal(f.stats().sends, 1);
  assert.equal(f.rows()[0]?.state, "current");
  const queued = f.service.runGuild(f.guild, new Date(now.getTime() + 120000));
  f.service.invalidateGuild("g");
  await queued;
  assert.equal(f.stats().sends, 1);
});

test("definitively rejected send clears known-unsent record and later repairs", async () => {
  const f = fixture();
  f.setFailSend(true);
  await f.service.runGuild(f.guild, now);
  assert.equal(f.rows().length, 0);
  assert.ok(f.service.getLastWarning("g"));
  f.setFailSend(false);
  await f.service.runGuild(f.guild, new Date(now.getTime() + 60000));
  assert.equal(f.stats().sends, 1);
});
test("missing required history permission returns actionable diagnostic without sending", async () => {
  const f = fixture();
  f.setPermissions(false);
  await f.service.runGuild(f.guild, now);
  assert.equal(f.stats().sends, 0);
  assert.match(f.service.getLastWarning("g")!, /Read Message History/);
});

test("durable scan handles more than 100 messages and finds late message above cursor", async () => {
  const f = fixture();
  f.setFailCommit(true);
  await f.service.runGuild(f.guild, now);
  f.setFailCommit(false);
  const sent = [...f.messages.values()][0];
  f.messages.clear();
  for (let i = 0; i < 150; i++) f.human();
  await f.service.runGuild(f.guild, new Date(now.getTime() + 180000));
  assert.ok(f.rows()[0]?.scanBeforeMessageId);
  assert.match(f.service.getLastWarning("g")!, /scanning/);
  const latest = String(BigInt([...f.messages.keys()].at(-1)!) + 1n);
  f.messages.set(latest, { ...sent, id: latest });
  await f.service.runGuild(f.guild, new Date(now.getTime() + 240000));
  assert.equal(f.rows()[0]?.state, "current");
  assert.equal(f.rows()[0]?.messageId, latest);
  assert.equal(f.stats().sends, 1);
});
test("expired nonce with verified complete absence permits automatic publication recovery", async () => {
  const f = fixture();
  f.setFailCommit(true);
  await f.service.runGuild(f.guild, now);
  f.setFailCommit(false);
  f.messages.clear();
  await f.service.runGuild(f.guild, new Date(now.getTime() + 180000));
  assert.equal(f.stats().sends, 1);
  assert.match(f.service.getLastWarning("g")!, /awaiting recovery/);
  await f.service.runGuild(f.guild, new Date(now.getTime() + 300000));
  assert.equal(f.stats().sends, 2);
  assert.equal(f.rows()[0]?.state, "current");
  assert.equal(f.service.getLastWarning("g"), undefined);
});

test("verified absence finishes with 1200 newer nonmatching messages", async () => {
  const f = fixture();
  f.setFailCommit(true);
  await f.service.runGuild(f.guild, now);
  f.setFailCommit(false);
  f.messages.clear();
  for (let i = 0; i < 1200; i++) f.human();
  for (let pass = 0; pass < 15 && f.rows()[0]?.state === "pending"; pass++)
    await f.service.runGuild(
      f.guild,
      new Date(now.getTime() + 300000 + pass * 60000),
    );
  assert.equal(f.rows()[0]?.state, "current");
  assert.equal(f.stats().sends, 2);
});
test("exact generation more than 600 messages behind newest is eventually recovered", async () => {
  const f = fixture();
  f.setFailCommit(true);
  await f.service.runGuild(f.guild, now);
  f.setFailCommit(false);
  const original = f.rows()[0]!.generation;
  for (let i = 0; i < 1200; i++) f.human();
  for (let pass = 0; pass < 15 && f.rows()[0]?.state === "pending"; pass++)
    await f.service.runGuild(
      f.guild,
      new Date(now.getTime() + 300000 + pass * 60000),
    );
  assert.ok(f.committed.includes(original));
  // The recovered canonical may be bumped immediately because parent conversation
  // followed it. Either way its publication was adopted, never blindly resent.
  assert.ok(f.rows().some((p) => p.state === "current"));
  assert.ok(f.stats().sends <= 2);
  assert.ok(f.rows().every((p) => p.state !== "pending"));
});
