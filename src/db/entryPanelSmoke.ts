import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PostgresPool } from "./postgres.js";
import { createEntryPanelRepository } from "./entryPanelRepository.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

// Database-only checks: use disposable guild identities and remove only those identities.
export async function runEntryPanelSmoke(pool: PostgresPool): Promise<void> {
  const repository = createEntryPanelRepository(pool);
  const guildA = `entry-a-${randomUUID()}`, guildB = `entry-b-${randomUUID()}`;
  try {
    assert.equal((await pool.query<{ version: number }>("select max(version)::int as version from guild_manager_schema_migrations")).rows[0].version, CURRENT_SCHEMA_VERSION);
    for (const guild of [guildA, guildB]) for (const feature of ["accounts", "giveaways"] as const) await repository.setChannel(guild, feature, "shared");
    const original = (await repository.getChannel(guildA, "accounts"))!;
    await repository.setChannel(guildA, "accounts", "shared");
    assert.deepEqual(await repository.getChannel(guildA, "accounts"), original);
    assert.equal(await repository.addRole(guildA, "accounts_manager", "staff"), true);
    assert.equal(await repository.addRole(guildA, "accounts_manager", "staff"), false);
    assert.deepEqual(await repository.listRoles(guildB, "accounts_manager"), []);
    assert.equal(await repository.removeRole(guildB, "accounts_manager", "staff"), false);
    const panels = repository.publications("accounts");
    const begin = (generation: string, previousGeneration: string | null = null, config = original) => panels.beginPublication({ discordGuildId: guildA, ...config, generation, previousGeneration, renderHash: "hash", now: new Date() });
    const results = await Promise.all([begin("first"), begin("second")]);
    assert.equal(results.filter(Boolean).length, 1);
    const generation = results.find(Boolean)!.generation;
    assert.equal(await panels.commitPublication(guildA, generation, "100"), true);
    assert.deepEqual(await repository.publications("giveaways").listPublications(guildA), []);
    assert.deepEqual(await panels.listPublications(guildB), []);
    const revision = randomUUID();
    assert.equal(await repository.prepareChannel(guildA, "accounts", "new", revision, "newconfig", "hash"), true);
    assert.deepEqual(await repository.getChannel(guildA, "accounts"), original, "preparing/sending cannot replace working config");
    assert.equal(await repository.commitChannel(guildA, "accounts", "newconfig", "200", "stale"), false);
    assert.equal(await repository.commitChannel(guildA, "accounts", "newconfig", "200", original.configurationRevision), true);
    assert.deepEqual(await repository.getChannel(guildA, "accounts"), { discordChannelId: "new", configurationRevision: revision });
    assert.equal((await panels.listPublications(guildA)).find(p => p.generation === generation)?.state, "retired");
    assert.equal((await repository.getChannel(guildA, "giveaways"))!.discordChannelId, "shared");
    assert.equal(await begin("stale-start", "newconfig"), undefined);
    await repository.clearChannel(guildA, "accounts");
    await repository.setChannel(guildA, "accounts", "new");
    const config = (await repository.getChannel(guildA, "accounts"))!;
    assert.notEqual(config.configurationRevision, revision);
    await panels.retirePublication(guildA, "newconfig");
    assert.ok(await begin("purged", null, config));
    const client = await pool.connect();
    try { await client.query("begin"); await purgeGuildOwnedData(client, guildA); await client.query("commit"); } finally { client.release(); }
    assert.equal(await panels.commitPublication(guildA, "purged", "300"), false);
    assert.equal(await begin("resurrect", null, config), undefined);
    assert.deepEqual(await repository.listRoles(guildA, "accounts_manager"), []);
    assert.deepEqual(await panels.listPublications(guildA), []);
    assert.ok(await repository.getChannel(guildB, "accounts"));
  } finally {
    for (const guild of [guildA, guildB]) {
      const client = await pool.connect();
      try { await client.query("begin"); await purgeGuildOwnedData(client, guild); await client.query("commit"); } catch { await client.query("rollback"); } finally { client.release(); }
    }
  }
}
