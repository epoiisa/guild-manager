import assert from "node:assert/strict";
import test from "node:test";
import { checkPlayerGuildMembership, createGuildMembershipCache } from "./guildMembership.js";

const player = { id: "melony69-id", name: "melony69" };

test("guild membership fast path trusts a matching player-detail guild without fallbacks", async () => {
  let searches = 0;
  let rosters = 0;
  const result = await checkPlayerGuildMembership({
    searchCharacters: async () => { searches++; return { players: [], guilds: [] }; },
    getGuildMembers: async () => { rosters++; return []; }
  } as any, "europe", { ...player, guildId: "dreamweavers" }, "dreamweavers");
  assert.deepEqual(result, { kind: "verified", source: "player" });
  assert.equal(searches, 0);
  assert.equal(rosters, 0);
});

test("guild membership repairs a blank player detail through exact-ID search or roster", async () => {
  const search = await checkPlayerGuildMembership({
    searchCharacters: async () => ({ players: [{ ...player, guildId: "dreamweavers" }], guilds: [] }),
    getGuildMembers: async () => []
  } as any, "europe", player, "dreamweavers");
  assert.deepEqual(search, { kind: "verified", source: "search" });

  const roster = await checkPlayerGuildMembership({
    searchCharacters: async () => ({ players: [{ ...player }], guilds: [] }),
    getGuildMembers: async () => [{ ...player, guildId: "dreamweavers" }]
  } as any, "europe", player, "dreamweavers");
  assert.deepEqual(roster, { kind: "verified", source: "roster" });
});

test("guild membership handles contradictory detail and never authorizes a name-only search match", async () => {
  const repaired = await checkPlayerGuildMembership({
    searchCharacters: async () => ({ players: [{ ...player, guildId: "dreamweavers" }], guilds: [] }),
    getGuildMembers: async () => []
  } as any, "europe", { ...player, guildId: "other-guild" }, "dreamweavers");
  assert.deepEqual(repaired, { kind: "verified", source: "search" });

  const unsafe = await checkPlayerGuildMembership({
    searchCharacters: async () => ({ players: [{ id: "different-id", name: "melony69", guildId: "dreamweavers" }], guilds: [] }),
    getGuildMembers: async () => []
  } as any, "europe", player, "dreamweavers");
  assert.equal(unsafe.kind, "unavailable");
});

test("guild membership distinguishes verified non-membership from unavailable fallback evidence", async () => {
  const absent = await checkPlayerGuildMembership({
    searchCharacters: async () => ({ players: [{ ...player, guildId: "other-guild" }], guilds: [] }),
    getGuildMembers: async () => []
  } as any, "europe", player, "dreamweavers");
  assert.deepEqual(absent, { kind: "not_member" });

  const unavailable = await checkPlayerGuildMembership({
    searchCharacters: async () => { throw new Error("search unavailable"); },
    getGuildMembers: async () => { throw new Error("roster unavailable"); }
  } as any, "europe", player, "dreamweavers");
  assert.equal(unavailable.kind, "unavailable");

});

test("guild membership caches duplicate search and roster checks within one reconciliation", async () => {
  let searches = 0;
  let rosters = 0;
  const cache = createGuildMembershipCache();
  const client = {
    searchCharacters: async () => { searches++; return { players: [{ ...player, guildId: "other-guild" }], guilds: [] }; },
    getGuildMembers: async () => { rosters++; return []; }
  };
  const results = await Promise.all([
    checkPlayerGuildMembership(client as any, "europe", player, "dreamweavers", cache),
    checkPlayerGuildMembership(client as any, "europe", player, "dreamweavers", cache)
  ]);
  assert.deepEqual(results, [{ kind: "not_member" }, { kind: "not_member" }]);
  assert.equal(searches, 1);
  assert.equal(rosters, 1);
});
