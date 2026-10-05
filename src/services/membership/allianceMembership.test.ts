import assert from "node:assert/strict";
import test from "node:test";
import { checkPlayerAllianceMembership, createGuildLookupCache } from "./allianceMembership.js";

test("alliance membership uses exact player IDs before guild fallback and never authorizes names", async () => {
  let guildLookups = 0;
  const client = {
    searchCharacters: async () => ({ players: [{ id: "character", name: "Character" }], guilds: [] }),
    getGuild: async () => {
      guildLookups++;
      return { id: "guild", name: "Different name", allianceId: "alliance" };
    }
  };

  assert.deepEqual(
    await checkPlayerAllianceMembership(client as any, "asia", { id: "character", name: "Character", allianceId: "alliance", guildId: "guild" }, "alliance"),
    { kind: "verified", source: "player" }
  );
  assert.equal(guildLookups, 0);
  assert.deepEqual(
    await checkPlayerAllianceMembership(client as any, "asia", { id: "character", name: "Character", guildId: "guild", allianceId: "other", allianceName: "Alliance" }, "alliance"),
    { kind: "verified", source: "guild", guildName: "Different name" }
  );
  assert.deepEqual(
    await checkPlayerAllianceMembership(client as any, "asia", { id: "character", name: "Character" }, "alliance"),
    { kind: "not_member" }
  );

  const mismatchedResponse = await checkPlayerAllianceMembership(
    { searchCharacters: async () => ({ players: [{ id: "character", name: "Character", guildId: "guild" }], guilds: [] }), getGuild: async () => ({ id: "other-guild", name: "Guild", allianceId: "alliance" }) } as any,
    "asia",
    { id: "character", name: "Character", guildId: "guild" },
    "alliance"
  );
  assert.equal(mismatchedResponse.kind, "unavailable");
  assert.equal(mismatchedResponse.kind === "unavailable" && mismatchedResponse.error instanceof Error && mismatchedResponse.error.message, "Guild lookup returned an unexpected guild ID.");
});

test("a reconciliation cache shares one guild request and reports lookup failures as unavailable", async () => {
  let guildLookups = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    getGuild: async () => {
      guildLookups++;
      await pending;
      return { id: "guild", name: "Guild", allianceId: "alliance" };
    }
  };
  const cache = createGuildLookupCache();
  const player = { id: "character", name: "Character", guildId: "guild" };
  const checks = [
    checkPlayerAllianceMembership(client as any, "asia", player, "alliance", cache),
    checkPlayerAllianceMembership(client as any, "asia", player, "other", cache)
  ];
  release();
  assert.deepEqual(await Promise.all(checks), [{ kind: "verified", source: "guild", guildName: "Guild" }, { kind: "not_member" }]);
  assert.equal(guildLookups, 1);

  const unavailable = await checkPlayerAllianceMembership(
    { getGuild: async () => { throw new Error("unavailable"); } } as any,
    "asia",
    player,
    "alliance"
  );
  assert.equal(unavailable.kind, "unavailable");
});
