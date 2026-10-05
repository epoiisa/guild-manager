import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { reconcileArchivedMemberGroupApplicationPresentation } from "./application.js";

for (const scenario of [
  { name: "preserves a shared active role required by another open application", stillRequired: true, qualified: false, removed: false },
  { name: "preserves an active role still qualified through membership", stillRequired: false, qualified: true, removed: false },
  { name: "removes an active role with no remaining source", stillRequired: false, qualified: false, removed: true }
]) {
  test(scenario.name, async () => {
    const removedRoles: string[] = [];
    const roleChecks: unknown[][] = [];
    const member = {
      id: "applicant",
      roles: {
        cache: { has: (roleId: string) => roleId === "active-role" },
        remove: async (roleId: string) => { removedRoles.push(roleId); }
      }
    };
    const sent: unknown[] = [];
    const guild: any = {
      id: "guild",
      members: { fetch: async () => member },
      channels: { fetch: async () => channel }
    };
    const channel: any = {
      type: ChannelType.GuildText,
      guild,
      permissionOverwrites: { edit: async () => undefined },
      messages: { fetch: async () => undefined },
      send: async (payload: unknown) => { sent.push(payload); return { id: "closed-control" }; }
    };
    const repository: any = {
      getOpenApplication: async () => ({ applicationId: "application", channelStatus: "closed" }),
      listQualifiedRoleIdsForUser: async (...args: unknown[]) => {
        roleChecks.push(args);
        return scenario.stillRequired || scenario.qualified ? ["active-role"] : [];
      },
      setClosedControlMessageId: async () => undefined
    };

    const warnings = await reconcileArchivedMemberGroupApplicationPresentation(
      guild,
      repository,
      { listQualifiedRoleIdsForUser: async () => scenario.qualified ? ["active-role"] : [] } as any,
      removalResult()
    );

    assert.deepEqual(warnings, []);
    assert.deepEqual(roleChecks, [["guild", "applicant"]]);
    assert.deepEqual(removedRoles, scenario.removed ? ["active-role"] : []);
    assert.equal(sent.length, 1);
  });
}

test("active-role lookup failure preserves the role without blocking channel closure presentation", async () => {
  const removedRoles: string[] = [];
  const sent: unknown[] = [];
  const member = {
    id: "applicant",
    roles: {
      cache: { has: () => true },
      remove: async (roleId: string) => { removedRoles.push(roleId); }
    }
  };
  const guild: any = {
    id: "guild",
    members: { fetch: async () => member },
    channels: { fetch: async () => channel }
  };
  const channel: any = {
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { edit: async () => undefined },
    messages: { fetch: async () => undefined },
    send: async (payload: unknown) => { sent.push(payload); return { id: "closed-control" }; }
  };
  const repository: any = {
    getOpenApplication: async () => ({ applicationId: "application", channelStatus: "closed" }),
    listQualifiedRoleIdsForUser: async () => { throw new Error("database unavailable"); },
    setClosedControlMessageId: async () => undefined
  };

  const warnings = await reconcileArchivedMemberGroupApplicationPresentation(
    guild,
    repository,
    { listQualifiedRoleIdsForUser: async () => [] } as any,
    removalResult()
  );

  assert.deepEqual(removedRoles, []);
  assert.equal(sent.length, 1);
  assert.deepEqual(warnings, [{
    message: "Application active-role cleanup failed for application application: Role update failed for <@applicant>: database unavailable"
  }].map((warning) => warning.message));
});

function removalResult(): any {
  return {
    archivedApplicationClasses: [],
    deletedApplicationClasses: [],
    archivedApplications: [{
      applicationId: "application",
      applicationClassId: "archived-class",
      applicantDiscordUserId: "applicant",
      ticketChannelId: "ticket",
      reviewerRoleId: "reviewer-role",
      activeRoleId: "active-role",
      channelStatus: "open",
      channelClosedByRemoval: true
    }]
  };
}
