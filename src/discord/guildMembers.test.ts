import assert from "node:assert/strict";
import test from "node:test";
import type { Guild } from "discord.js";
import { fetchGuildMemberIfPresent } from "./guildMembers.js";

test("guild member lookup forces a current Discord membership check", async () => {
  const member = { id: "member-id" };
  const requests: unknown[] = [];
  const guild = {
    members: {
      fetch: async (options: unknown) => {
        requests.push(options);
        return member;
      }
    }
  } as unknown as Guild;

  assert.equal(await fetchGuildMemberIfPresent(guild, "member-id"), member);
  assert.deepEqual(requests, [{ user: "member-id", force: true }]);
});

test("guild member lookup treats Discord Unknown Member as a departed user", async () => {
  const guild = {
    members: {
      fetch: async () => Promise.reject({ code: 10_007 })
    }
  } as unknown as Guild;

  assert.equal(await fetchGuildMemberIfPresent(guild, "departed-member-id"), undefined);
});

test("guild member lookup preserves unexpected Discord failures", async () => {
  const expected = new Error("Discord unavailable");
  const guild = {
    members: {
      fetch: async () => Promise.reject(expected)
    }
  } as unknown as Guild;

  await assert.rejects(fetchGuildMemberIfPresent(guild, "member-id"), expected);
});
