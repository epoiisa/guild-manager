import assert from "node:assert/strict";
import test from "node:test";
import { createGiveawayRepository } from "./giveawayRepository.js";
import type { PostgresPool } from "./postgres.js";

test("host history is tenant and owner scoped, uncapped, and ordered for the complete private list", async () => {
  let sql = "";
  let parameters: unknown[] = [];
  const rows = Array.from({ length: 35 }, (_, index) => ({
    giveaway_id: String(index + 1), discord_guild_id: "guild", channel_id: index > 25 ? "old-channel" : "channel", original_message_id: `message-${index}`,
    creator_discord_user_id: "owner", title: `Prize ${index}`, description: "Description", draw_at: new Date("2099-01-01T00:00:00Z"), winner_count: 1,
    state: index < 25 ? "open" : "cancelled", created_at: new Date("2098-12-01T00:00:00Z"), cancelled_at: index < 25 ? null : new Date("2098-12-02T00:00:00Z")
  }));
  const repository = createGiveawayRepository({ query: async (query: string, values: unknown[]) => { sql = query; parameters = values; return { rows }; } } as unknown as PostgresPool);
  const history = await repository.listHostHistory("guild", "owner");
  assert.deepEqual(parameters, ["guild", "owner"]);
  assert.match(sql, /where discord_guild_id = \$1 and creator_discord_user_id = \$2/);
  assert.doesNotMatch(sql, /\blimit\b|channel_id\s*=/i);
  assert.match(sql, /case when state = 'open' then 0 else 1 end/);
  assert.match(sql, /case when state = 'open' then draw_at end asc/);
  assert.match(sql, /coalesce\(cancelled_at, drawn_at, created_at\).*desc/);
  assert.equal(history.length, 35);
  assert.equal(history.at(-1)?.channelId, "old-channel");
  assert.equal(history.at(-1)?.state, "cancelled");
  assert.equal(history.at(-1)?.cancelledAt?.toISOString(), "2098-12-02T00:00:00.000Z");
});
