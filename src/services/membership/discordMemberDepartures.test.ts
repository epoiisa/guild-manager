import assert from "node:assert/strict";
import test from "node:test";
import { handleDiscordMemberDeparture } from "./discordMemberDepartures.js";
import { createLogFeedRuntime } from "../logFeed/runtime.js";

function fixture() {
  const sent: string[][] = [];
  const logger: any = { debug() {}, info() {}, warn() {} };
  const guild: any = { id: "guild", name: "Guild" };
  const member: any = { id: "user", guild, displayName: "Server Nickname" };
  const lifecycle: any = { isGuildActive: async () => true };
  const membership: any = { getDiscordRegistrationSnapshot: async () => ({}), beginDiscordDeparture: async () => ({ characters: [], holds: [] }) };
  const reactions: any = { deleteUserSubscriptions: async () => undefined };
  const repository: any = { get: async () => ({ discordChannelId: "log" }) };
  const runtime = createLogFeedRuntime(repository, { send: async (_guild: any, lines: string[]) => { sent.push(lines); return "sent"; } } as any, logger);
  const applicationRepository: any = { listOperationalApplicationTargets: async (guildId: string, includeArchived: boolean) => {
    assert.equal(guildId, "guild"); assert.equal(includeArchived, true);
    return [
      { applicantDiscordUserId: "user", status: "accepted", channelStatus: "open", ticketChannelId: "accepted-open" },
      { applicantDiscordUserId: "user", status: "awaiting_ingame_membership", channelStatus: "open", ticketChannelId: "waiting-open" },
      { applicantDiscordUserId: "user", status: "rejected", channelStatus: "closed", ticketChannelId: "closed" },
      { applicantDiscordUserId: "other", status: "open", channelStatus: "open", ticketChannelId: "other-user" }
    ];
  } };
  return { sent, membership, reactions, applicationRepository, lifecycle, run: () => handleDiscordMemberDeparture(member, lifecycle, membership, reactions, logger, { runtime, applicationRepository }) };
}

test("unregistered departure includes all open conversations regardless of retained decision, without changing applications", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.sent, [["@Server Nickname left the server.", "<@user> left an application open in <#accepted-open>.", "<@user> left an application open in <#waiting-open>."]]);
});

test("real departure remains reportable when cleanup fails; inactive tenants remain silent", async () => {
  const f = fixture(); f.membership.beginDiscordDeparture = async () => { throw Error("private cleanup failure"); };
  await assert.rejects(f.run());
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].at(-1), "Some membership changes could not be completed.");
  assert.doesNotMatch(JSON.stringify(f.sent), /private cleanup failure/);
  const inactive = fixture(); inactive.lifecycle.isGuildActive = async () => false; await inactive.run();
  assert.deepEqual(inactive.sent, []);
});

test("application reference lookup failure does not stop membership cleanup", async () => {
  const f = fixture(); let cleaned = false;
  f.applicationRepository.listOperationalApplicationTargets = async () => { throw Error("private query"); };
  f.membership.beginDiscordDeparture = async () => { cleaned = true; return { characters: [], holds: [] }; };
  await f.run(); assert.equal(cleaned, true);
  assert.deepEqual(f.sent, [["@Server Nickname left the server.", "Some membership changes could not be completed."]]);
});

test("a gateway departure records the new hold only after its transaction succeeds", async () => {
  const f = fixture();
  f.membership.getDiscordRegistrationSnapshot = async () => ({ "europe:character": "42" });
  f.membership.listConfiguredRoleIdsForGuild = async () => [];
  f.membership.beginDiscordDeparture = async (_guild: string, _user: string, _now: Date, snapshot: unknown) => {
    assert.deepEqual(snapshot, { "europe:character": "42" });
    return { characters: [{ albionServer: "europe", albionCharacterId: "character", characterName: "Character" }],
      holds: [{ albionServer: "europe", albionCharacterId: "character" }] };
  };
  await f.run();
  assert.ok(f.sent[0].includes("Character • Europe entered a registration hold for <@user>."));
});
