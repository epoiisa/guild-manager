import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationCommandPermissionType as Kind, ApplicationCommandType, Collection, type ApplicationCommandPermissions } from "discord.js";
import { inspectKickCommandPermissions } from "./kickCommandPermissions.js";
import { activeGuildCommands } from "../../discord/commands.js";

const role = (id: string, permission = true): ApplicationCommandPermissions => ({ type: Kind.Role, id, permission });
const user = (id: string, permission = true): ApplicationCommandPermissions => ({ type: Kind.User, id, permission });
const channel = (id: string, permission = true): ApplicationCommandPermissions => ({ type: Kind.Channel, id, permission });
function fixture(names = ["message"], overrides: Array<[string, ApplicationCommandPermissions[]]> = []) {
  const commands = new Collection(names.map((name, index) => [`cmd-${index}`, { id: `cmd-${index}`, name, type: ApplicationCommandType.ChatInput }]));
  const permissions = new Collection(overrides);
  const calls: unknown[] = [];
  const guild = { id: "guild", client: { application: { id: "app" } }, commands: {
    fetch: async () => { calls.push("commands"); return commands; },
    permissions: { fetch: async (options: unknown) => { calls.push(options); return permissions; } }
  } };
  return { guild, commands, permissions, calls, inspect: (roles: string[] = ["officer"]) => inspectKickCommandPermissions(guild as never, "target", roles) };
}

test("reads both live command lists and Integration permissions without mutating them", async () => {
  const f = fixture(["message"], [["cmd-0", [role("officer"), role("unheld"), role("denied", false), user("other")]]]);
  assert.deepEqual(await f.inspect(), { roleIds: ["officer"], requiresManualRemoval: false });
  assert.deepEqual(f.calls, ["commands", {}]);
});

test("app-wide everyone, member-role and user grants never bypass current default zero", async () => {
  assert.ok(activeGuildCommands.every(command => command.default_member_permissions === "0"));
  for (const specific of [undefined, [], [channel("guild")]]) {
    const f = fixture(["message"], [["app", [role("guild"), role("officer"), user("target")]], ...(specific ? [["cmd-0", specific] as [string, ApplicationCommandPermissions[]]] : [])]);
    assert.deepEqual(await f.inspect(), { roleIds: [], requiresManualRemoval: false });
  }
});

test("command role allows bypass inherited role/everyone denies but inherited user deny still blocks", async () => {
  const f = fixture(["message"], [["app", [role("officer", false), role("guild", false), user("target", false)]], ["cmd-0", [role("officer")]]]);
  assert.deepEqual(await f.inspect(), { roleIds: [], requiresManualRemoval: false });
  f.permissions.set("app", [role("officer", false), role("guild", false)]);
  assert.deepEqual(await f.inspect(), { roleIds: ["officer"], requiresManualRemoval: false });
});

test("command-specific user deny blocks every grant and inherited allows never become bypass candidates", async () => {
  const f = fixture(["message"], [["app", [role("officer"), role("inherited"), user("target")]], ["cmd-0", [role("officer", false), role("new-officer"), user("target", false)]]]);
  assert.deepEqual(await f.inspect(["officer", "inherited", "new-officer"]), { roleIds: [], requiresManualRemoval: false });
  f.permissions.set("cmd-0", [role("officer", false), role("new-officer")]);
  assert.deepEqual(await f.inspect(["officer", "inherited", "new-officer"]), { roleIds: ["new-officer"], requiresManualRemoval: false });
});

test("a command-specific direct allow overrides inherited user denial, while other-user grants do nothing", async () => {
  const f = fixture(["message"], [["app", [user("target", false)]], ["cmd-0", [user("target"), user("other")]]]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: true });
  f.permissions.set("cmd-0", [user("other")]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: false });
});

test("everyone grants require manual removal even when not listed among held roles; channel grants alone do not", async () => {
  const f = fixture(["message"], [["cmd-0", [channel("guild"), channel("other")]]]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: false });
  f.permissions.set("app", [role("guild")]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: false });
  f.permissions.set("cmd-0", [role("guild"), channel("guild")]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: true });
  f.permissions.set("cmd-0", [role("guild", false), channel("guild")]);
  assert.deepEqual(await f.inspect([]), { roleIds: [], requiresManualRemoval: false });
});

test("ordinary current roots do not remove self-service access grants", async () => {
  const ordinary = ["ping", "register", "unregister", "balance", "give", "join", "leave", "standby", "party", "giveaway", "giveaways", "regearme", "regears", "membership", "statement", "roles", "weapon", "weapons"];
  assert.ok(ordinary.every(name => activeGuildCommands.some(command => command.name === name)));
  const f = fixture(ordinary, ordinary.map((_name, index) => [`cmd-${index}`, [role("officer"), role("guild"), user("target")]]));
  assert.deepEqual(await f.inspect(), { roleIds: [], requiresManualRemoval: false });
});

test("reviewer/mixed configuration roots and unknown future commands remain conservative", async () => {
  for (const root of ["specialisation", "application", "applications", "ticket", "tickets", "tasks", "status", "transfer", "regear", "future-command"]) {
    const f = fixture([root], [["cmd-0", [role("officer")]]]);
    assert.deepEqual(await f.inspect(), { roleIds: ["officer"], requiresManualRemoval: false }, root);
  }
});

test("role results deduplicate across administrative commands and deny on one command does not hide another grant", async () => {
  const f = fixture(["message", "kick", "reset"], [["app", [role("officer")]], ["cmd-0", [role("officer"), user("target", false)]], ["cmd-1", [role("officer")]], ["cmd-2", [role("officer")]]]);
  assert.deepEqual(await f.inspect(), { roleIds: ["officer"], requiresManualRemoval: false });
});

test("API failures and missing app identity propagate instead of approving cleanup", async () => {
  const first = fixture(); first.guild.commands.fetch = async () => { throw Error("commands unavailable"); };
  await assert.rejects(first.inspect(), /commands unavailable/);
  const second = fixture(); second.guild.commands.permissions.fetch = async () => { throw Error("permissions unavailable"); };
  await assert.rejects(second.inspect(), /permissions unavailable/);
  const third = fixture(); third.guild.client.application.id = "";
  await assert.rejects(third.inspect(), /identity is unavailable/);
});
