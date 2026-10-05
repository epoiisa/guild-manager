import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresPool } from "./postgres.js";
import { migrateDatabaseSchema } from "./schema.js";
import { runEntryPanelSmoke } from "./entryPanelSmoke.js";

const url = process.env.ENTRY_PANEL_TEST_DATABASE_URL;
test("feature migration, tenant and feature isolation, atomic config adoption, concurrent publication and purge", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_panel_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  try { await migrateDatabaseSchema(pool); await migrateDatabaseSchema(pool); await runEntryPanelSmoke(pool); }
  finally { await pool.end(); }
});
