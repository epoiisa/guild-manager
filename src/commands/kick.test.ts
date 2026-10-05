import assert from "node:assert/strict";
import test from "node:test";
import { handleKickCommand, kickCommand } from "./kick.js";
import { messageTexts } from "../testSupport/messageAssertions.js";

test("kick retains its existing hidden user-only command surface", () => {
  const command = kickCommand.toJSON();
  assert.equal(command.name, "kick"); assert.equal(command.default_member_permissions, "0");
  assert.deepEqual(command.options?.map(option => option.name), ["user"]);
});

test("kick acknowledges once and reports a durable block even without registrations", async () => {
  for (const deferred of [false, true]) {
    const messages: unknown[] = []; let deferrals = 0, kicks = 0;
    const i: any = { inGuild: () => true, guildId: "guild", guild: { id: "guild", client: { user: { id: "bot" } } },
      user: { id: "officer" }, deferred, replied: false,
      options: { getUser: () => ({ id: "target", toString: () => "<@target>" }) },
      deferReply: async () => { deferrals++; i.deferred = true; }, editReply: async (payload: unknown) => messages.push(payload)
    };
    await handleKickCommand(i, {} as any, { kickMember: async (guild, user, actor) => {
      assert.equal(guild.id, "guild"); assert.equal(user, "target"); assert.equal(actor, "officer"); kicks++;
      return { characters: [], warnings: [] };
    } });
    assert.equal(deferrals, deferred ? 0 : 1); assert.equal(kicks, 1);
    const text = messages.flatMap(message => messageTexts(message)).join(" ");
    assert.match(text, /blocked from Guild Manager/); assert.match(text, /0 character registrations were removed/);
    assert.doesNotMatch(text, /No Registrations|left orphaned/);
  }
});
