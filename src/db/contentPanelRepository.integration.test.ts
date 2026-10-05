import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresPool } from "./postgres.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabaseSchema } from "./schema.js";
import { createContentRepository } from "./contentRepository.js";
import { createContentPanelRepository } from "./contentPanelRepository.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

// Explicit opt-in only: point at a disposable database named guild_manager_panel_test.
// This never loads .env or the configured Local/Production database.
const url = process.env.CONTENT_PANEL_TEST_DATABASE_URL;
test("isolated PostgreSQL migration, aggregate counts, revision/CAS fencing and tenant purge", { skip: !url }, async () => {
  const target = new URL(url!);
  assert.equal(target.pathname, "/guild_manager_panel_test");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  const pool = createPostgresPool(url!);
  try {
    await migrateDatabaseSchema(pool);
    await migrateDatabaseSchema(pool);
    const migrationVersion = await pool.query<{ version: number }>("select max(version)::int as version from guild_manager_schema_migrations");
    assert.equal(migrationVersion.rows[0].version, CURRENT_SCHEMA_VERSION);
    const content = createContentRepository(pool), panels = createContentPanelRepository(pool);
    for (const guild of ["panel-test-a", "panel-test-b"]) {
      await pool.query("insert into discord_guild_lifecycle(discord_guild_id,status,guild_name,activated_at) values($1,'active',$1,now())", [guild]);
      await content.setContentChannel(guild, "source");
    }
    const guild = "panel-test-a", now = new Date();
    const first = (await content.getContentChannel(guild))!;
    await content.setContentChannel(guild, "source");
    assert.equal((await content.getContentChannel(guild))!.configurationRevision, first.configurationRevision);
    const make = (g: string, channel: string, title: string, date: Date | null = null, postedAt = now) => content.createContent({
      discordGuildId: g, sourceChannelId: channel, threadChannelId: title, hostDiscordUserId: "host", title, description: "", scheduledStartAt: date, roleLabels: ["DPS", "DPS", "Heal"], postedAt
    });
    const party = await make(guild, "source", "included");
    await content.upsertSignup(guild, party.content.contentId, party.slots[0].contentRoleSlotId, "one");
    await content.upsertSignup(guild, party.content.contentId, party.slots[1].contentRoleSlotId, "two");
    await content.upsertSignup(guild, party.content.contentId, null, "standby");
    await make(guild, "elsewhere", "other-channel");
    await make("panel-test-b", "source", "other-guild");
    await make(guild, "source", "expired", null, new Date(now.getTime() - 12 * 3600000));
    const terminal = await make(guild, "source", "ended");
    await content.markEnded(guild, terminal.content.contentId);
    let rows = await panels.listPanelContent(guild, "source", now);
    assert.deepEqual(rows.map(r => [r.content.title,r.filledRoles,r.totalRoles]), [["included",2,3]]);
    await content.removeSignup(guild, party.content.contentId, "two", "host");
    rows = await panels.listPanelContent(guild, "source", now);
    assert.equal(rows[0].filledRoles, 1);
    await content.updateContentDetails({ discordGuildId:guild,contentId:party.content.contentId,title:"included",description:"",roleLabels:["DPS"] });
    rows = await panels.listPanelContent(guild,"source",now);
    assert.deepEqual([rows[0].filledRoles,rows[0].totalRoles],[1,1]);
    const begin = (generation: string, previousGeneration: string | null, configurationRevision = first.configurationRevision, discordChannelId = "source") => panels.beginPublication({ discordGuildId:guild,discordChannelId,configurationRevision,generation,previousGeneration,renderHash:"hash",now });
    assert.ok(await begin("one",null));
    assert.equal(await begin("duplicate",null),undefined);
    assert.equal(await panels.commitPublication(guild,"one","100"),true);
    assert.equal(await begin("wrong",null),undefined);
    assert.ok(await begin("two","one"));
    assert.equal(await panels.commitPublication(guild,"two","200"),true);
    assert.deepEqual((await panels.listPublications(guild)).map(p=>[p.generation,p.state]),[["one","retired"],["two","current"]]);
    assert.ok(await begin("three","two"));
    await content.clearContentChannel(guild);
    await content.setContentChannel(guild,"source");
    assert.notEqual((await content.getContentChannel(guild))!.configurationRevision,first.configurationRevision);
    assert.equal(await panels.commitPublication(guild,"three","300"),false);
    assert.equal((await panels.listPublications(guild)).length,3);
    await panels.retirePublication(guild,"three","300");
    await panels.retirePublication(guild,"two");
    const revision = (await content.getContentChannel(guild))!.configurationRevision;
    assert.ok(await begin("purged",null,revision));
    const client = await pool.connect();
    try { await client.query("begin"); await purgeGuildOwnedData(client,guild); await client.query("commit"); }
    finally { client.release(); }
    assert.equal(await panels.commitPublication(guild,"purged","400"),false);
    assert.equal(await begin("resurrect",null,revision),undefined);
    assert.deepEqual(await panels.listPublications(guild),[]);
    assert.ok(await content.getContentChannel("panel-test-b"));
  } finally { await pool.end(); }
});
