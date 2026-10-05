import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { createEntryPanelContext, panelPermissions } from "./access.js";

function fixture() {
  let config: any = { discordChannelId: "configured", configurationRevision: "one" }, current = true, timedOut = false, view = true, permissions = true, exists = true, registered = true;
  const replies: any[] = [];
  const member: any = { user: { bot: false }, roles: { cache: new Map() }, permissions: { has: () => false }, get communicationDisabledUntilTimestamp() { return timedOut ? Date.now()+60000 : 0; } };
  const channel: any = { type: 0, permissionsFor: (target: any) => ({ has: () => target === member ? view : permissions }) };
  const i: any = { guildId: "guild", channelId: "invocation", user: { id: "user", bot: false }, message: { id: "message" },
    guild: { id: "guild", client: { user: { id: "bot" } }, members: { me: "bot", fetch: async () => exists ? member : undefined }, channels: { fetch: async () => channel } },
    reply: async (payload: any) => { replies.push(payload); } };
  const context = createEntryPanelContext({ repository: { getChannel: async () => config, listRoles: async () => ["manager"] } as any,
    hasRegisteredCharacter: async (guildId, userId) => { assert.equal(guildId, "guild"); assert.equal(userId, "user"); return registered; },
    isGuildActive: async () => true, captureFence: () => () => true, isCurrentPanel: async () => current,
    runExclusive: async (_: string, task: () => Promise<any>) => task(), refresh: async () => {} });
  return { context, i, member, replies, config, clear() { config = undefined; current = false; }, stale() { current = false; }, timeout() { timedOut = true; }, hide() { view = false; }, denyBot() { permissions = false; }, depart() { exists = false; }, unregister() { registered = false; }, text() { return JSON.stringify(replies.at(-1)); } };
}

test("panel movement preserves setup revision but retired controls and cleared-config drafts reject", async () => {
  const f = fixture(); assert.ok(await f.context.checkAccess(f.i, "accounts", { expected: f.config }));
  f.stale(); assert.ok(await f.context.checkAccess(f.i, "accounts", { expected: f.config }));
  assert.equal(await f.context.checkAccess(f.i, "accounts", { generation: "old" }), undefined);
  assert.match(f.text(), /Start Again/);
  f.clear(); await f.context.checkAccess(f.i, "accounts", { generation: "old" }); assert.match(f.text(), /Start Again/);
  await f.context.checkAccess(f.i, "accounts"); assert.match(f.text(), /Accounts Channel Not Configured/);
});

test("timeouts block mutations and allow private reads without Send Messages permission", async () => {
  const f = fixture(); f.timeout();
  assert.ok(await f.context.checkAccess(f.i, "accounts"));
  assert.equal(await f.context.checkAccess(f.i, "accounts", { mutation: true }), undefined); assert.match(f.text(), /timed out/);
});

test("departed users, hidden channels, missing bot permissions and stale revisions cannot act", async () => {
  for (const change of ["depart", "hide", "denyBot"] as const) {
    const f = fixture(); f[change](); assert.equal(await f.context.checkAccess(f.i, "regears", { mutation: true }), undefined);
  }
  const f = fixture(); await f.context.checkAccess(f.i, "accounts", { expected: { ...f.config, configurationRevision: "old" } }); assert.match(f.text(), /Start Again/);
});

test("manager authority reads live roles and retains Administrator recovery", async () => {
  const f = fixture(); assert.equal(await f.context.requireRole(f.i, "accounts_manager"), false); assert.match(f.text(), /Accounts Manager Required/);
  f.member.roles.cache.set("manager", {}); assert.equal(await f.context.requireRole(f.i, "accounts_manager"), true);
  f.member.roles.cache.clear(); f.member.permissions.has = () => true; assert.equal(await f.context.requireRole(f.i, "accounts_manager"), true);
  assert.ok(panelPermissions("giveaways").includes(PermissionFlagsBits.ManageMessages));
});

test("giveaway controls accept registered channel viewers without manager roles and recheck registration", async () => {
  const f = fixture();
  assert.equal(f.member.roles.cache.size, 0);
  assert.ok(await f.context.checkAccess(f.i, "giveaways", { mutation: true }));
  f.unregister();
  assert.equal(await f.context.checkAccess(f.i, "giveaways", { mutation: true }), undefined);
  assert.match(f.text(), /Registration Required/);
  assert.equal(await f.context.checkAccess(f.i, "giveaways"), undefined);
  assert.ok(await f.context.checkAccess(f.i, "accounts"));
});

test("giveaway registration does not bypass channel access or timeouts", async () => {
  for (const change of ["depart", "hide", "timeout"] as const) {
    const f = fixture(); f[change]();
    assert.equal(await f.context.checkAccess(f.i, "giveaways", { mutation: true }), undefined);
  }
});
