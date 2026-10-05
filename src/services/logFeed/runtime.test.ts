import { MessageFlags } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { messageText } from "../../testSupport/messageAssertions.js";
import type { LogChange } from "./events.js";
import { recordLogChange } from "./events.js";
import { formatLogChanges } from "./formatting.js";
import { LOG_DELIVERY_WARNING, createLogFeedRuntime } from "./runtime.js";

const character = { discordGuildId: "guild", discordUserId: "user", albionServer: "europe" as const, albionCharacterId: "character", characterName: "Alice" };
const registration: LogChange = { kind: "registration", action: "registered", character };
const profile = { memberGroupProfileId: "profile", memberGroupId: "group", discordGuildId: "guild", discordUserId: "user", albionServer: "europe" as const, albionCharacterId: "character", characterName: "Alice", groupName: "Friends", groupType: "group" as const };

function fixture() {
  let available = true;
  let configured = true;
  const sent: Array<{ guildId: string; lines: readonly string[]; options?: { channelId?: string } }> = [];
  const warnings: any[] = [];
  const guild: any = { id: "guild" };
  const repository: any = {
    get: async () => configured ? { discordGuildId: "guild", discordChannelId: "old-channel" } : undefined,
    clear: async () => { configured = false; }
  };
  const delivery: any = { send: async (guild: any, lines: string[], options?: { channelId?: string }) => {
    if (!options?.channelId && !await repository.get()) return "disabled";
    sent.push({ guildId: guild.id, lines, options });
    return available ? "sent" : "failed";
  } };
  const runtime = createLogFeedRuntime(repository, delivery, { warn() {} } as any);
  const interaction: any = { guild, guildId: "guild", user: { id: "officer" }, deferred: true, replied: true,
    isRepliable: () => true, isChatInputCommand: () => true, commandName: "register",
    followUp: async (payload: unknown) => { warnings.push(payload); } };
  return { runtime, repository, delivery, sent, warnings, guild, interaction, fail: () => { available = false; } };
}

test("committed changes survive a subsequent operation error and are combined with confirmed roles", async () => {
  const f = fixture();
  const failure = new Error("private downstream failure");
  await assert.rejects(f.runtime.run(f.guild, async () => {
    recordLogChange("guild", registration);
    recordLogChange("guild", { kind: "role", action: "add", discordUserId: "user", roleId: "role" });
    throw failure;
  }), error => error === failure);
  assert.deepEqual(f.sent[0].lines, ["Alice registered to <@user> • Europe. <@&role> added.", "Some membership changes could not be completed."]);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(f.sent), /private downstream failure/);
});

test("no-op and failure-before-mutation commands are silent; nested scopes publish once", async () => {
  const f = fixture();
  await f.runtime.run(f.guild, async () => undefined);
  await assert.rejects(f.runtime.run(f.guild, async () => { throw Error("failure"); }));
  assert.equal(f.sent.length, 0);
  await f.runtime.run(f.guild, () => f.runtime.run(f.guild, async () => { recordLogChange("guild", registration); }));
  assert.equal(f.sent.length, 1);
});

test("feed failures preserve success, warn privately, and do not run a configuration lookup before the operation", async () => {
  const f = fixture(); f.fail();
  let changed = false;
  f.repository.get = async () => { assert.equal(changed, true); throw Error("private database error"); };
  const result = await f.runtime.run(f.guild, async () => { changed = true; recordLogChange("guild", registration); return 42; }, {}, f.interaction);
  assert.equal(result, 42);
  assert.equal(f.warnings.length, 1);
  assert.equal(messageText(f.warnings[0]), LOG_DELIVERY_WARNING);
  assert.equal(f.warnings[0].content, LOG_DELIVERY_WARNING);
  assert.equal(f.warnings[0].flags, MessageFlags.SuppressEmbeds | MessageFlags.Ephemeral);
  assert.deepEqual(f.warnings[0].allowedMentions, { parse: [], repliedUser: false });
});

test("application decision buttons and character-switch selectors capture successful changes", async () => {
  for (const customId of ["app:accept:1", "app:verify:1", "cs:select:1", "albion-character:register:user:europe", "member-group-delete:1:user:123:confirm"]) {
    const f = fixture();
    f.interaction.isChatInputCommand = () => false;
    f.interaction.customId = customId;
    await f.runtime.interaction(f.interaction, async () => { recordLogChange("guild", registration); });
    assert.equal(f.sent.length, 1, customId);
  }
});

test("terminal entry uses the old destination after successful purge; failed purge emits nothing", async () => {
  const f = fixture();
  await f.runtime.terminal(f.guild, "reset", () => f.repository.clear());
  assert.deepEqual(f.sent, [{ guildId: "guild", lines: ["Guild Manager was reset for this server."], options: { channelId: "old-channel" } }]);
  const failed = fixture();
  await assert.rejects(failed.runtime.terminal(failed.guild, "deactivated", async () => { throw Error("purge failed"); }));
  assert.equal(failed.sent.length, 0);
});

test("read-only audit, role configuration and unrelated application lifecycle actions stay outside membership capture", async () => {
  for (const [commandName, subcommand] of [["audit", ""], ["character", "add"], ["member", "set"], ["application", "close"]]) {
    const f = fixture();
    f.interaction.commandName = commandName;
    f.interaction.options = { getSubcommand: () => subcommand };
    await f.runtime.interaction(f.interaction, async () => { recordLogChange("guild", registration); });
    assert.deepEqual(f.sent, []);
  }
});

test("concise formatter deduplicates role changes and omits registration inventory on departure", () => {
  const role: LogChange = { kind: "role", action: "remove", discordUserId: "user", roleId: "role" };
  const changes: LogChange[] = [{ ...registration, action: "unregistered" }, { kind: "profile", action: "orphaned", profile }, role, role];
  assert.deepEqual(formatLogChanges(changes, { kind: "departure", discordUserId: "user", discordUserDisplayName: "Server Nickname", applicationChannelIds: ["open", "open"] }), [
    "@Server Nickname left the server. <@&role> removed.", "Alice orphaned in Friends • group • Europe.", "<@user> left an application open in <#open>."
  ]);
});

test("bulk summaries count committed records, ignore raced snapshot predictions, and retain partial/role/nickname outcomes", () => {
  const summary: LogChange = { kind: "reconciliation", warningCount: 0, outcomes: [{ kind: "profile", action: "add", characterName: "Alice", groupName: "Friends", discordUserId: "user", albionServerLabel: "Europe" }] };
  assert.deepEqual(formatLogChanges([summary]), []);
  assert.deepEqual(formatLogChanges([{ kind: "profile", action: "joined", profile }, { kind: "role", action: "add", roleId: "role", discordUserId: "user" }, { ...summary, warningCount: 2 }]), [
    "Membership update changed 1 profile for 1 member. 1 role added, 0 removed. 2 operations could not be completed."
  ]);
  assert.deepEqual(formatLogChanges([{ kind: "nickname", action: "set", discordUserId: "user", nickname: "Alice" }, summary]), [
    "Membership update changed 0 profiles for 1 member. 1 nickname changed."
  ]);
});

test("switch wording stays combined and literal names cannot introduce extra lines or headings", () => {
  assert.deepEqual(formatLogChanges([{ kind: "switch", from: character, to: { ...character, characterName: "**Bob**\n# forged" } }]), [
    "Alice switched to \\*\\*Bob\\*\\* # forged for <@user> • Europe."
  ]);
});

test("manual and scheduled updates retain grace entries after later failures with actor attribution only for manual runs", async () => {
  for (const manual of [true, false]) {
    const f = fixture();
    f.interaction.commandName = "update";
    const deadline = new Date("2030-01-04T12:34:56.789Z");
    const change: LogChange = { kind: "profile", action: "left",
      profile: { ...profile, characterName: "**Alice**\n", groupName: "Guild", groupType: "guild" },
      startedDepartureGrace: { expiresAt: deadline } };
    const operation = async () => {
      recordLogChange("guild", change);
      recordLogChange("guild", change);
      throw new Error("later failure");
    };
    await assert.rejects(manual
      ? f.runtime.interaction(f.interaction, operation)
      : f.runtime.run(f.guild, operation, { kind: "reconciliation" }), /later failure/);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].lines, [
      manual
        ? "<@officer> ran a membership update: 1 profile changed for 1 member. The update could not be completed."
        : "Membership update changed 1 profile for 1 member. The update could not be completed.",
      `\\*\\*Alice\\*\\*  • Europe started a 72-hour membership grace period in Guild. Deadline: <t:${Math.floor(deadline.getTime() / 1000)}:F>.`
    ]);
  }
});

test("uncommitted departure predictions and unchanged waiting rows cannot produce grace log entries", () => {
  for (const action of ["depart", "waiting"] as const) {
    assert.deepEqual(formatLogChanges([{ kind: "reconciliation", warningCount: 0, outcomes: [{
      kind: "profile", action, characterName: "Alice", groupName: "Guild", albionServerLabel: "Europe",
      departureExpiresAt: new Date("2030-01-04T00:00:00Z")
    }] }]), []);
  }
});
