import assert from "node:assert/strict";
import test from "node:test";
import { verifyConfiguredCharacterMemberships } from "./departureVerification.js";

test("officer recovery separates positive, negative and unknown membership evidence without writes", async () => {
  const groups = ["current", "former", "unknown"].map(id => ({
    memberGroupId: id, albionServer: "europe", albionGuildId: id, groupName: id
  }));
  const result = await verifyConfiguredCharacterMemberships("discord", {
    searchCharacters: async () => ({ players: [{ id: "character", guildId: "current" }] }),
    getGuildMembers: async (_server: string, id: string) => {
      if (id === "unknown") throw Error("unavailable");
      return [];
    }
  } as any, {
    listConfiguredAlbionGuilds: async () => groups,
    listConfiguredAlbionAlliances: async () => []
  } as any, "europe", { id: "character", name: "Character", guildId: "current" });
  assert.deepEqual(result.qualifiedGroupIds, ["current"]);
  assert.deepEqual(result.rejectedGroupIds, ["former"]);
  assert.deepEqual(result.unavailableGroupIds, ["unknown"]);
  assert.equal(result.warnings.length, 1);
});

test("recovery verifies alliance membership and ignores other Albion Online servers", async () => {
  const result = await verifyConfiguredCharacterMemberships("discord", {} as any, {
    listConfiguredAlbionGuilds: async () => [{ memberGroupId: "other", albionServer: "asia" }],
    listConfiguredAlbionAlliances: async () => [{
      memberGroupId: "alliance", albionServer: "europe", albionAllianceId: "alliance", groupName: "Alliance"
    }]
  } as any, "europe", { id: "character", name: "Character", allianceId: "alliance" });
  assert.deepEqual(result.qualifiedGroupIds, ["alliance"]);
  assert.deepEqual(result.rejectedGroupIds, []);
  assert.deepEqual(result.unavailableGroupIds, []);
});
