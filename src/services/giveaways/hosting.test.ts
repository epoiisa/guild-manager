import assert from "node:assert/strict";
import test from "node:test";
import { GiveawayPublicationError, publishGiveaway } from "./hosting.js";

for (const crossedDuring of ["role", "publication", "reaction"] as const) {
  test(`giveaway draw must still be in the future after ${crossedDuring}`, async () => {
    let now = 1000;
    let sends = 0;
    let deletes = 0;
    let saves = 0;
    const input = {
      guild: { id: "guild", members: { me: {} }, roles: { fetch: async () => { if (crossedDuring === "role") now = 2000; return { id: "role", mentionable: true }; } } },
      channel: { id: "channel", permissionsFor: () => ({ has: () => true }), send: async () => {
        sends++;
        if (crossedDuring === "publication") now = 2000;
        return { id: "message", url: "https://discord.com/channels/guild/channel/message", react: async () => { if (crossedDuring === "reaction") now = 2000; }, delete: async () => { deletes++; } };
      } },
      creatorDiscordUserId: "owner", title: "Prize", description: "Description", drawAt: new Date(2000), winnerCount: 1, notificationRoleId: "role",
      repository: { create: async () => { saves++; return {}; } }, logger: { info() {}, warn() {}, error() {} }, validate: async () => true, now: () => now
    } as unknown as Parameters<typeof publishGiveaway>[0];
    await assert.rejects(publishGiveaway(input), (error) => error instanceof GiveawayPublicationError && error.title === "Invalid Draw Time");
    assert.equal(saves, 0);
    assert.equal(sends, crossedDuring === "role" ? 0 : 1);
    assert.equal(deletes, sends);
  });
}

test("a seed-reaction failure removes the unrecorded message and never saves a giveaway", async () => {
  let deletes = 0;
  let saves = 0;
  const input = {
    guild: { id: "guild", members: { me: {} } },
    channel: { id: "channel", permissionsFor: () => ({ has: () => true }), send: async () => ({ id: "message", react: async () => { throw new Error("No Add Reactions"); }, delete: async () => { deletes++; } }) },
    creatorDiscordUserId: "owner", title: "Prize", description: "Description", drawAt: new Date(Date.now() + 60_000), winnerCount: 1,
    repository: { create: async () => { saves++; return {}; } }, logger: { info() {}, warn() {}, error() {} }, validate: async () => true
  } as unknown as Parameters<typeof publishGiveaway>[0];
  await assert.rejects(publishGiveaway(input), (error) => error instanceof GiveawayPublicationError && error.title === "Giveaway Not Created");
  assert.equal(saves, 0);
  assert.equal(deletes, 1);
});
