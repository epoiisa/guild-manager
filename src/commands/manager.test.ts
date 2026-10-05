import { MessageFlags, PermissionFlagsBits } from "discord.js";
import assert from "node:assert/strict";
import test from "node:test";
import { messageDescription, messageSummary } from "../testSupport/messageAssertions.js";
import { handleManagerCommand, managerCommand } from "./manager.js";

function fixture(system: string | null = "account", action = "add") {
  let administrator = true, live = true, changed = true, deleted = 0;
  const replies: any[] = [], calls: unknown[][] = [];
  const member = { user: { bot: false }, permissions: { has: (flag: bigint) => flag === PermissionFlagsBits.Administrator && administrator } };
  const interaction: any = {
    guildId: "guild-1", guild: { members: { fetch: async () => member } }, user: { id: "admin-1", bot: false },
    deferred: false,
    options: { getSubcommand: () => action, getString: () => system, getRole: () => ({ id: "role-1" }) },
    async deferReply(payload: any) { assert.equal(payload.flags, MessageFlags.Ephemeral); this.deferred = true; },
    async reply(payload: any) { replies.push(payload); },
    async editReply(payload: any) { replies.push(payload); },
    async deleteReply() { deleted++; }
  };
  const reviewers: any = {
    addBinding: async (...args: unknown[]) => { calls.push(["reviewer-add", ...args]); return {}; },
    removeBinding: async (...args: unknown[]) => { calls.push(["reviewer-remove", ...args]); return changed; },
    listBindings: async (...args: unknown[]) => { calls.push(["reviewer-list", ...args]); return [{ discordRoleId: "reviewer-role" }]; }
  };
  const entryPanels: any = {
    captureFence: () => () => live,
    runExclusive: async (_guildId: string, task: () => Promise<unknown>) => task(),
    context: { repository: {
      addRole: async (...args: unknown[]) => { calls.push(["account-add", ...args]); return changed; },
      removeRole: async (...args: unknown[]) => { calls.push(["account-remove", ...args]); return changed; },
      listRoles: async (...args: unknown[]) => { calls.push(["account-list", ...args]); return ["account-role"]; }
    } }
  };
  return { interaction, reviewers, entryPanels, replies, calls, member,
    run: () => handleManagerCommand(interaction, reviewers, entryPanels),
    deny: () => { administrator = false; }, invalidate: () => { live = false; }, noChange: () => { changed = false; }, deleted: () => deleted };
}

test("manager command has only the approved leaves and options, and defaults hidden", () => {
  const data = managerCommand.toJSON();
  assert.equal(data.name, "manager");
  assert.equal(data.default_member_permissions, "0");
  assert.deepEqual(data.options?.map(option => option.name), ["add", "remove", "list"]);
  for (const command of data.options! as any[]) {
    assert.deepEqual(command.options.map((option: any) => [option.name, option.required]), command.name === "list" ? [["system", false]] : [["system", true], ["role", true]]);
    assert.deepEqual(command.options[0].choices.map((choice: any) => choice.value), ["account", "regear", "specialisation"]);
  }
});

for (const system of ["account", "regear", "specialisation"]) {
  for (const action of ["add", "remove"]) {
    test(`${action} ${system} managers touches only the selected system with no Albion Online server argument`, async () => {
      const f = fixture(system, action); await f.run();
      assert.deepEqual(f.calls, [system === "account"
        ? [`account-${action}`, "guild-1", "accounts_manager", "role-1"]
        : [`reviewer-${action}`, "guild-1", system === "regear" ? "regears" : "specialisation", "role-1", "admin-1"]]);
      if (system === "regear") {
        assert.equal(f.deleted(), 1); assert.deepEqual(f.replies, []);
      } else {
        const label = system === "account" ? "Accounts" : "Weapon Specialisation";
        assert.equal(messageSummary(f.replies[0]), action === "add" ? `<@&role-1> can manage ${label} across all Albion Online servers.` : `The ${label} manager role setting for <@&role-1> has been removed.`);
        assert.deepEqual(f.replies[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
      }
    });
  }
  test(`listing ${system} managers reads only that system`, async () => {
    const f = fixture(system, "list"); await f.run();
    assert.deepEqual(f.calls, [system === "account" ? ["account-list", "guild-1", "accounts_manager"] : ["reviewer-list", "guild-1", system === "regear" ? "regears" : "specialisation"]]);
    const label = system === "account" ? "Accounts" : system === "regear" ? "Re-gears" : "Weapon Specialisation";
    const roleId = system === "account" ? "account-role" : "reviewer-role";
    assert.equal(messageDescription(f.replies[0]), `<@&${roleId}> is configured as a manager for ${label}.`);
  });
}

test("unfiltered manager list reports every system in command-choice order", async () => {
  const f = fixture(null, "list"); await f.run();
  assert.equal(f.calls.length, 3);
  assert.equal(messageDescription(f.replies[0]), "**Accounts**\n<@&account-role>\n\n**Re-gears**\n<@&reviewer-role>\n\n**Weapon Specialisation**\n<@&reviewer-role>");
});

test("all manager leaves require a current Discord Administrator, including list", async () => {
  for (const action of ["add", "remove", "list"]) {
    const f = fixture("specialisation", action); f.deny(); await f.run();
    assert.deepEqual(f.calls, []); assert.equal(messageSummary(f.replies[0]), "Only a Discord Administrator can configure or list system manager roles.");
  }
});

test("invalid systems cannot reach either repository", async () => {
  for (const system of ["giveaway", "regears", "", null]) {
    const f = fixture(system); await f.run();
    assert.deepEqual(f.calls, []); assert.equal(messageSummary(f.replies[0]), "Choose Accounts, Re-gears, or Weapon Specialisation.");
  }
});

test("reset during member lookup or while waiting for a write cannot recreate manager roles", async () => {
  for (const system of ["account", "regear", "specialisation"]) {
    for (const stage of ["lookup", "queue"]) {
      const f = fixture(system);
      if (stage === "lookup") f.interaction.guild.members.fetch = async () => { f.invalidate(); return f.member; };
      else f.entryPanels.runExclusive = async (_: string, task: () => Promise<unknown>) => { f.invalidate(); return task(); };
      await f.run();
      assert.deepEqual(f.calls, []); assert.equal(messageSummary(f.replies[0]), "Configuration changed while this command was running. Run the command again.");
    }
  }
});

test("missing re-gear role retains its private explanation", async () => {
  const f = fixture("regear", "remove"); f.noChange(); await f.run();
  assert.equal(f.deleted(), 0); assert.equal(messageSummary(f.replies[0]), "<@&role-1> is not configured as a Re-gears manager role.");
});

test("large manager lists are returned completely as an attachment", async () => {
  const f = fixture("account", "list");
  f.entryPanels.context.repository.listRoles = async () => Array.from({ length: 250 }, (_, index) => `10000000000000000${index}`);
  await f.run();
  assert.equal(f.replies[0].files[0].name, "manager-roles.txt");
  const report = f.replies[0].files[0].attachment.toString("utf8");
  assert.match(report, /<@&10000000000000000249>$/);
});
