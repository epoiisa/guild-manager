import assert from "node:assert/strict";
import test from "node:test";
import { AlbionApiError } from "./client.js";
import { getGuildLookupDetails } from "./guildLookup.js";
import { ALBION_SERVER_VALUES } from "./servers.js";
import type { AlbionAlliance, AlbionGuild } from "./types.js";

const baseGuild: AlbionGuild = {
  id: "guild-id",
  name: "Guild",
  founderName: "Founder",
  founded: "2025-08-06T23:59:13.841368Z",
  memberCount: 60,
  allianceId: "alliance-id"
};
const alliance: AlbionAlliance = { id: "alliance-id", name: "Alliance", tag: "TAG", guilds: [] };

test("lookup fills only missing Albion Online alliance metadata using the same server and exact ID", async () => {
  for (const server of ALBION_SERVER_VALUES) {
    for (const supplied of [{}, { allianceName: "Existing Name" }, { allianceTag: "OLD" }]) {
      const guild = Object.freeze({ ...baseGuild, ...supplied });
      const calls: string[][] = [];
      const result = await getGuildLookupDetails({
        getGuild: async (...args) => { calls.push(["guild", ...args]); return guild; },
        getAlliance: async (...args) => { calls.push(["alliance", ...args]); return alliance; }
      }, server, guild.id);

      assert.deepEqual(calls, [["guild", server, guild.id], ["alliance", server, alliance.id]]);
      assert.deepEqual(result, {
        ...guild,
        allianceName: supplied.allianceName ?? "Alliance",
        allianceTag: supplied.allianceTag ?? "TAG"
      });
    }
  }
});

test("lookup treats empty and whitespace-only Albion Online alliance names and tags as missing", async () => {
  for (const missing of ["", " \t\n"]) {
    const guild = { ...baseGuild, allianceName: missing, allianceTag: missing };
    const result = await getGuildLookupDetails({
      getGuild: async () => guild,
      getAlliance: async () => alliance
    }, "asia", guild.id);

    assert.deepEqual(result, { ...guild, allianceName: "Alliance", allianceTag: "TAG" });
  }
});

test("lookup skips optional requests for complete metadata or an absent Albion Online alliance ID", async () => {
  const guilds: AlbionGuild[] = [
    { ...baseGuild, allianceName: "Alliance", allianceTag: "TAG" },
    { id: "guild-id", name: "Guild" },
    { ...baseGuild, allianceId: undefined, allianceTag: "TAG" },
    { ...baseGuild, allianceId: "", allianceName: "Alliance" },
    { ...baseGuild, allianceId: " \t", allianceTag: "TAG" }
  ];
  for (const guild of guilds) {
    let allianceCalls = 0;
    const result = await getGuildLookupDetails({
      getGuild: async () => guild,
      getAlliance: async () => { allianceCalls += 1; return alliance; }
    }, "asia", guild.id);

    assert.equal(allianceCalls, 0);
    assert.deepEqual(result, guild);
  }
});

test("lookup retains available metadata when the Albion Online alliance response still has no tag", async () => {
  const guild = { ...baseGuild, allianceName: "Existing Name" };
  const result = await getGuildLookupDetails({
    getGuild: async () => guild,
    getAlliance: async () => ({ ...alliance, tag: undefined })
  }, "asia", guild.id);

  assert.deepEqual(result, { ...guild, allianceTag: undefined });
});

test("optional Albion Online alliance failures preserve the valid Albion Online guild details", async () => {
  const failures = [
    new AlbionApiError("Timed out", "timeout"),
    new AlbionApiError("Not found", "client", 404),
    new AlbionApiError("Rate limited", "rate_limited", 429),
    new AlbionApiError("Unavailable", "server", 503),
    new AlbionApiError("Malformed response", "invalid_response", 200),
    new TypeError("Network failure")
  ];
  const guild = { ...baseGuild, allianceTag: "TAG" };
  for (const error of failures) {
    const result = await getGuildLookupDetails({
      getGuild: async () => guild,
      getAlliance: async () => { throw error; }
    }, "asia", guild.id);

    assert.deepEqual(result, guild);
  }
});

test("lookup ignores a different Albion Online alliance ID even when its tag matches", async () => {
  const guild = { ...baseGuild, allianceTag: "TAG" };
  const result = await getGuildLookupDetails({
    getGuild: async () => guild,
    getAlliance: async () => ({ ...alliance, id: "other-alliance-id" })
  }, "asia", guild.id);

  assert.deepEqual(result, guild);
});

test("primary Albion Online guild failures remain visible to the caller", async () => {
  const error = new AlbionApiError("Not found", "client", 404);
  await assert.rejects(getGuildLookupDetails({
    getGuild: async () => { throw error; },
    getAlliance: async () => assert.fail("A failed primary lookup must not fetch optional metadata.")
  }, "asia", baseGuild.id), (actual) => actual === error);
});

test("lookup rejects a different Albion Online guild ID even when its name matches", async () => {
  await assert.rejects(getGuildLookupDetails({
    getGuild: async () => ({ ...baseGuild, id: "other-guild-id" }),
    getAlliance: async () => assert.fail("A mismatched primary lookup must not fetch optional metadata.")
  }, "asia", baseGuild.id), (error: unknown) => {
    assert.ok(error instanceof AlbionApiError);
    assert.equal(error.kind, "invalid_response");
    return true;
  });
});
