import assert from "node:assert/strict";
import test from "node:test";
import { createTemporaryVoiceRepository } from "./temporaryVoiceRepository.js";

test("temporary voice configuration reads and changes the guild-scoped base channel without prefix state", async () => {
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  const repository = createTemporaryVoiceRepository({
    query: async (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      return { rows: [{ discord_guild_id: "guild", base_channel_id: "base" }], rowCount: 1 };
    }
  } as never);
  assert.deepEqual(await repository.getConfig("guild"), { discordGuildId: "guild", baseChannelId: "base" });
  await repository.setBaseChannel("guild", "replacement");
  assert.equal(await repository.clearConfig("guild"), true);
  assert.deepEqual(queries.map(query => query.parameters), [["guild"], ["guild", "replacement"], ["guild"]]);
  for (const { sql } of queries) {
    assert.match(sql, /temporary_voice_configs/);
    assert.doesNotMatch(sql, /prefix|temporary_voice_channels/);
  }
  assert.equal("setPrefix" in repository, false);
});
