import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "./postgres.js";
import { createLogChannelRepository } from "./logChannelRepository.js";
import { migrateDatabaseSchema, CURRENT_SCHEMA_VERSION } from "./schema.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

// Explicit disposable-database opt-in; never loads the Local or Production environment.
const url = process.env.LOG_FEED_TEST_DATABASE_URL;
test("log channel migration, replacement, clearing and guild purge are tenant-scoped", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_log_feed_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  try {
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    assert.equal((await pool.query<{ version: number }>("select max(version)::int as version from guild_manager_schema_migrations")).rows[0].version, CURRENT_SCHEMA_VERSION);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const repository = createLogChannelRepository(client);
      assert.equal(await repository.get("log-test-a"), undefined);
      await repository.set("log-test-a", "channel-one", "operator-one");
      await repository.set("log-test-b", "channel-other", "operator-other");
      const first = (await repository.get("log-test-a"))!;
      await repository.set("log-test-a", "channel-two", "operator-two");
      const replaced = (await repository.get("log-test-a"))!;
      assert.equal(replaced.discordChannelId, "channel-two");
      assert.equal(replaced.configuredByDiscordUserId, "operator-two");
      assert.deepEqual(replaced.createdAt, first.createdAt);
      await repository.clear("log-test-a");
      assert.equal(await repository.get("log-test-a"), undefined);
      assert.equal((await repository.get("log-test-b"))!.discordChannelId, "channel-other");
      await repository.set("log-test-a", "channel-three", "operator-three");
      await purgeGuildOwnedData(client, "log-test-a");
      assert.equal(await repository.get("log-test-a"), undefined);
      assert.ok(await repository.get("log-test-b"));
    } finally {
      await client.query("rollback");
      client.release();
    }
  } finally { await pool.end(); }
});
