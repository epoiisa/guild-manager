import assert from "node:assert/strict";
import test from "node:test";
import { reconcileManagedRole } from "./managedRoleReconciliation.js";

test("recovered members cannot regain former authority automatically, while an explicit later Discord grant remains", async () => {
  for (const held of [false, true]) {
    const roles = new Set(held ? ["manager"] : []);
    const calls: string[] = [];
    const member: any = { roles: { cache: roles, add: async () => calls.push("add"), remove: async () => calls.push("remove") } };
    const guild: any = { id: "guild", members: { fetch: async () => member } };
    const entitlements = { getMemberAccess: async () => ({ blocked: false, revokedRoleIds: ["manager"] }), listQualifiedRoleIdsForUser: async () => [] };
    const result = await reconcileManagedRole(guild, entitlements, "user", "manager", "Reconcile");
    assert.deepEqual(calls, []); assert.deepEqual(result.warnings, []);
    assert.equal(roles.has("manager"), held);
  }
});

test("a blocked member's retained role is removed instead of treated as a new grant", async () => {
  const roles = new Set(["manager"]);
  const member: any = { roles: { cache: roles, add: async () => assert.fail("blocked users cannot gain roles"), remove: async (id: string) => roles.delete(id) } };
  const guild: any = { id: "guild", members: { fetch: async () => member } };
  await reconcileManagedRole(guild, { getMemberAccess: async () => ({ blocked: true, revokedRoleIds: ["manager"] }), listQualifiedRoleIdsForUser: async () => [] }, "user", "manager", "Reconcile");
  assert.equal(roles.has("manager"), false);
});
