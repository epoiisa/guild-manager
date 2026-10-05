import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { formatLogChanges } from "../logFeed/formatting.js";
import { withLogChanges, type LogChange } from "../logFeed/events.js";
import { botReactionRemovalSuppressor } from "../reactionRoles/subscriptions.js";
import {
  cleanupConfiguredRolesForMember,
  planEffectiveNicknameUpdate,
  planConfiguredRoleChangesForGuild,
  reconcileConfiguredRoles,
  reconcileConfiguredRolesForGuild,
  reconcileEffectiveNickname
} from "./discordMemberUpdates.js";

test("departure role cleanup ignores Discord Unknown Member after the member has left", async () => {
  const warnings = await cleanupConfiguredRolesForMember(
    {
      id: "user-1",
      guild: { id: "guild-1" },
      roles: {
        cache: { has: () => true },
        remove: async () => {
          const error = new Error("Unknown Member") as Error & { code: number };
          error.code = 10007;
          throw error;
        }
      }
    } as any,
    { listConfiguredRoleIdsForGuild: async () => ["role-1"] } as any
  );

  assert.deepEqual(warnings, []);
});

test("departure role cleanup retains non-Unknown-Member failures as warnings", async () => {
  const warnings = await cleanupConfiguredRolesForMember(
    {
      id: "user-1",
      guild: { id: "guild-1" },
      roles: {
        cache: { has: () => true },
        remove: async () => { throw new Error("Missing permissions"); }
      }
    } as any,
    { listConfiguredRoleIdsForGuild: async () => ["role-1"] } as any
  );

  assert.deepEqual(warnings, [{
    message: "Role cleanup failed: Missing permissions"
  }]);
});

test("final membership loss removes the mapped reaction and role but preserves the subscription", async () => {
  const removedReactions: string[] = [];
  const removedRoles: string[] = [];
  let dormantLookups = 0;
  const reaction = {
    emoji: { id: null, name: "✅" },
    users: {
      remove: async (discordUserId: string) => {
        removedReactions.push(discordUserId);
      }
    }
  };
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: (roleId: string) => roleId === "reaction-role-1" },
      add: async () => undefined,
      remove: async (roleId: string) => {
        removedRoles.push(roleId);
      }
    }
  };
  const guild = {
    id: "guild-1",
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        messages: {
          fetch: async () => ({
            reactions: {
              cache: {
                find: (predicate: (candidate: typeof reaction) => boolean) =>
                  predicate(reaction) ? reaction : undefined
              }
            }
          })
        }
      })
    },
    members: { fetch: async () => member }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => {
      dormantLookups++;
      return [{
        reactionRoleConfigId: "config-1",
        channelId: "channel-1",
        messageId: "message-1",
        emojiKey: "unicode:✅",
        emojiDisplayValue: "✅"
      }];
    },
    listConfiguredRoleIdsForGuild: async () => ["reaction-role-1"],
    listQualifiedRoleIdsForUser: async () => []
  };

  const warnings = await reconcileConfiguredRoles(
    guild as any,
    membershipRepository as any,
    "user-1"
  );

  assert.deepEqual(warnings, []);
  assert.equal(dormantLookups, 1);
  assert.deepEqual(removedReactions, ["user-1"]);
  assert.deepEqual(removedRoles, ["reaction-role-1"]);
  assert.equal("unsubscribe" in membershipRepository, false);
  assert.equal(
    botReactionRemovalSuppressor.consume("guild-1:message-1:unicode:✅:user-1"),
    true
  );
});

test("regaining any active membership restores a subscribed role without recreating a reaction", async () => {
  const addedRoles: string[] = [];
  let channelFetches = 0;
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: () => false },
      add: async (roleId: string) => {
        addedRoles.push(roleId);
      },
      remove: async () => undefined
    }
  };
  const guild = {
    id: "guild-1",
    channels: {
      fetch: async () => {
        channelFetches++;
        return undefined;
      }
    },
    members: { fetch: async () => member }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => ["reaction-role-1"],
    listQualifiedRoleIdsForUser: async () => ["reaction-role-1"]
  };

  const warnings = await reconcileConfiguredRoles(
    guild as any,
    membershipRepository as any,
    "user-1"
  );

  assert.deepEqual(warnings, []);
  assert.deepEqual(addedRoles, ["reaction-role-1"]);
  assert.equal(channelFetches, 0);
});

test("reconciliation preserves an existing valid managed-subscriber role assignment", async () => {
  let roleMutations = 0;
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: (roleId: string) => roleId === "reaction-role-1" },
      add: async () => {
        roleMutations++;
      },
      remove: async () => {
        roleMutations++;
      }
    }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => undefined },
    members: { fetch: async () => member }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => ["reaction-role-1"],
    listQualifiedRoleIdsForUser: async () => ["reaction-role-1"]
  };

  const warnings = await reconcileConfiguredRoles(
    guild as any,
    membershipRepository as any,
    "user-1"
  );

  assert.deepEqual(warnings, []);
  assert.equal(roleMutations, 0);
});

test("targeted reconciliation considers retired group roles without removing roles still qualified elsewhere", async () => {
  const removedRoles: string[] = [];
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: (roleId: string) => ["configured", "retired", "shared"].includes(roleId) },
      add: async () => undefined,
      remove: async (roleId: string) => {
        removedRoles.push(roleId);
      }
    }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => undefined },
    members: { fetch: async () => member }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => ["configured", "shared"],
    listQualifiedRoleIdsForUser: async () => ["configured", "shared"]
  };

  const warnings = await reconcileConfiguredRoles(
    guild as any,
    membershipRepository as any,
    "user-1",
    ["retired", "shared"]
  );

  assert.deepEqual(warnings, []);
  assert.deepEqual(removedRoles, ["retired"]);
});

test("guild role reconciliation confirms successful operations independently from failures", async () => {
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: {
        has: (roleId: string) => roleId.startsWith("remove-")
      },
      add: async (roleId: string) => {
        if (roleId === "add-fail") throw new Error("cannot add");
      },
      remove: async (roleId: string) => {
        if (roleId === "remove-fail") throw new Error("cannot remove");
      }
    }
  };
  const guild = {
    id: "guild-1",
    channels: { fetch: async () => undefined },
    members: {
      fetch: async (discordUserId?: string) => discordUserId
        ? member
        : new Map([["user-1", member]])
    }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => [],
    listConfiguredRoleIdsForGuild: async () => [
      "add-success",
      "add-fail",
      "remove-success",
      "remove-fail"
    ],
    listQualifiedRoleIdsForUser: async () => ["add-success", "add-fail"]
  };

  const changes: LogChange[] = [];
  const result = await withLogChanges("guild-1", async (recorded) => {
    const result = await reconcileConfiguredRolesForGuild(guild as any, membershipRepository as any);
    changes.push(...recorded);
    return result;
  });

  assert.deepEqual(result.outcomes, [
    {
      kind: "role",
      action: "add",
      discordUserId: "user-1",
      roleId: "add-success"
    },
    {
      kind: "role",
      action: "remove",
      discordUserId: "user-1",
      roleId: "remove-success"
    }
  ]);
  assert.deepEqual(result.warnings, [
    { message: "Role update failed for <@user-1>: cannot add" },
    { message: "Role update failed for <@user-1>: cannot remove" }
  ]);
  assert.deepEqual(changes, [...result.outcomes, { kind: "incomplete", area: "membership" }]);
});

test("refetched role state suppresses stale planned mutations and log claims", async () => {
  const member = (roles: string[]) => ({
    id: "user-1", guild: { id: "guild-1" },
    roles: {
      cache: new Set(roles),
      add: async () => assert.fail("role already present"),
      remove: async () => assert.fail("role already absent")
    }
  });
  const guild = {
    id: "guild-1",
    members: { fetch: async (userId?: string) => userId
      ? member(["added"])
      : new Map([["user-1", member(["removed"])]]) }
  };
  await withLogChanges("guild-1", async (changes) => {
    const result = await reconcileConfiguredRolesForGuild(guild as any, {
      listDormantReactionRoleSubscriptions: async () => [],
      listConfiguredRoleIdsForGuild: async () => ["added", "removed"],
      listQualifiedRoleIdsForUser: async () => ["added"]
    } as any);
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(changes, []);
  });
});

test("departure logs only successful removals and never unknown or failed member operations", async () => {
  for (const errorCode of [undefined, 10007, 50013]) {
    await withLogChanges("guild-1", async (changes) => {
      await cleanupConfiguredRolesForMember({
        id: "user-1", guild: { id: "guild-1" },
        roles: {
          cache: new Set(["role-1"]),
          remove: async () => { if (errorCode) throw { code: errorCode }; }
        }
      } as any, { listConfiguredRoleIdsForGuild: async () => ["role-1", "unheld"] } as any);
      assert.deepEqual(changes, errorCode === 10007 ? [] : errorCode ? [{ kind: "incomplete", area: "membership" }] : [{
        kind: "role", action: "remove", discordUserId: "user-1", roleId: "role-1"
      }]);
    });
  }
});

test("nickname log capture excludes audit, unchanged values, and failed writes", async () => {
  let fails = false;
  const member = {
    nickname: "old",
    roles: { highest: { position: 1 } },
    setNickname: async () => { if (fails) throw new Error("missing permission"); }
  };
  const guild = { id: "guild-1", members: { me: nicknameBotMember(), fetch: async () => member } };
  const repository = { getEffectiveNickname: async () => "new" };
  await withLogChanges("guild-1", async (changes) => {
    await planEffectiveNicknameUpdate(guild as any, repository as any, "user-1");
    assert.deepEqual(changes, []);
    fails = true;
    await reconcileEffectiveNickname(guild as any, repository as any, "user-1");
    assert.deepEqual(changes, [{ kind: "incomplete", area: "membership" }]);
    fails = false;
    await reconcileEffectiveNickname(guild as any, repository as any, "user-1");
    member.nickname = "new";
    await reconcileEffectiveNickname(guild as any, repository as any, "user-1");
    assert.deepEqual(changes, [{ kind: "incomplete", area: "membership" }, { kind: "nickname", action: "set", discordUserId: "user-1", nickname: "new" }]);
  });
});

test("nickname planning is non-mutating and nickname updates report only confirmed changes", async () => {
  const appliedNicknames: Array<string | null> = [];
  const member = {
    id: "user-1",
    nickname: "Old Nickname",
    roles: { highest: { position: 1 } },
    setNickname: async (nickname: string | null) => {
      appliedNicknames.push(nickname);
    }
  };
  const guild = {
    id: "guild-1",
    members: { me: nicknameBotMember(), fetch: async () => member }
  };
  let effectiveNickname: string | undefined = "New Nickname";
  const membershipRepository = {
    getEffectiveNickname: async () => effectiveNickname
  };

  const planned = await planEffectiveNicknameUpdate(
    guild as any,
    membershipRepository as any,
    "user-1"
  );
  assert.deepEqual(planned, {
    outcomes: [{
      kind: "nickname",
      action: "set",
      discordUserId: "user-1",
      nickname: "New Nickname"
    }],
    warnings: []
  });
  assert.deepEqual(appliedNicknames, []);

  const applied = await reconcileEffectiveNickname(
    guild as any,
    membershipRepository as any,
    "user-1"
  );
  assert.deepEqual(applied.outcomes, planned.outcomes);
  assert.deepEqual(appliedNicknames, ["New Nickname"]);

  member.nickname = "New Nickname";
  const unchanged = await reconcileEffectiveNickname(
    guild as any,
    membershipRepository as any,
    "user-1"
  );
  assert.deepEqual(unchanged, { outcomes: [], warnings: [] });
  assert.deepEqual(appliedNicknames, ["New Nickname"]);

  effectiveNickname = undefined;
  const cleared = await reconcileEffectiveNickname(
    guild as any,
    membershipRepository as any,
    "user-1"
  );
  assert.deepEqual(cleared.outcomes, [{
    kind: "nickname",
    action: "clear",
    discordUserId: "user-1"
  }]);
  assert.deepEqual(appliedNicknames, ["New Nickname", null]);
});

test("failed nickname mutations are warnings and never confirmed outcomes", async () => {
  const guild = {
    id: "guild-1",
    members: {
      me: nicknameBotMember(),
      fetch: async () => ({
        id: "user-1",
        nickname: "Old Nickname",
        roles: { highest: { position: 1 } },
        setNickname: async () => {
          throw new Error("Missing permissions");
        }
      })
    }
  };
  const membershipRepository = {
    getEffectiveNickname: async () => "New Nickname"
  };

  const result = await reconcileEffectiveNickname(
    guild as any,
    membershipRepository as any,
    "user-1"
  );

  assert.deepEqual(result, {
    outcomes: [],
    warnings: [{
      message: "Nickname update failed for <@user-1>: Missing permissions"
    }]
  });
});

test("audit role planning uses neutral Discord member check wording", async () => {
  const result = await planConfiguredRoleChangesForGuild(
    {
      id: "guild-1",
      members: {
        fetch: async () => {
          throw new Error("Members intent unavailable");
        }
      }
    } as any,
    {} as any
  );

  assert.deepEqual(result, {
    plans: [],
    warnings: [{
      message: "Discord member check failed: Members intent unavailable"
    }]
  });
});

test("dormant subscription read failures use neutral check wording", async () => {
  const member = {
    id: "user-1",
    guild: { id: "guild-1" },
    roles: {
      cache: { has: () => false },
      add: async () => undefined,
      remove: async () => undefined
    }
  };
  const guild = {
    id: "guild-1",
    members: { fetch: async () => member }
  };
  const membershipRepository = {
    listDormantReactionRoleSubscriptions: async () => {
      throw new Error("database unavailable");
    },
    listConfiguredRoleIdsForGuild: async () => [],
    listQualifiedRoleIdsForUser: async () => []
  };

  const warnings = await reconcileConfiguredRoles(
    guild as any,
    membershipRepository as any,
    "user-1"
  );

  assert.deepEqual(warnings, [{
    message: "Dormant reaction-role check failed for <@user-1>: database unavailable"
  }]);
});

function nicknameBotMember(canManageNicknames = true) {
  return {
    roles: { highest: { comparePositionTo: (role: { position: number }) => 2 - role.position } },
    permissions: new PermissionsBitField(canManageNicknames ? PermissionFlagsBits.ManageNicknames : 0n)
  };
}

test("server owner nickname checks skip all nickname work and produce no failed-operation log", async () => {
  const guild = { id: "guild-1", ownerId: "user-1", members: {
    fetch: async () => assert.fail("owner nickname must not be fetched")
  } };
  const repository = { getEffectiveNickname: async () => assert.fail("owner nickname must not be checked") };
  await withLogChanges(guild.id, async (changes) => {
    for (const operation of [planEffectiveNicknameUpdate, reconcileEffectiveNickname]) {
      assert.deepEqual(await operation(guild as any, repository as any, "user-1"), { outcomes: [], warnings: [] });
    }
    assert.deepEqual(changes, []);
    assert.deepEqual(formatLogChanges(changes, { kind: "reconciliation" }), []);
  });
});

test("nickname exception follows current server ownership rather than a fixed user", async () => {
  const f = nicknamePermissionFixture();
  f.guild.ownerId = "user-1";
  assert.deepEqual(await reconcileEffectiveNickname(f.guild as any, f.repository as any, "user-1"), { outcomes: [], warnings: [] });
  f.guild.ownerId = "user-2";
  const result = await reconcileEffectiveNickname(f.guild as any, f.repository as any, "user-1");
  assert.equal(result.outcomes.length, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(f.writes, ["New Nickname"]);
});

for (const position of [2, 3]) {
  for (const desired of ["New Nickname", null]) {
    test(`nickname ${desired ? "set" : "clear"} warns for a non-owner with ${position === 2 ? "equal" : "higher"} role in audit and update`, async () => {
      const f = nicknamePermissionFixture(position, true, desired);
      const expected = { outcomes: [], warnings: [{
        message: "Could not update <@user-1>'s nickname: their highest role is equal to or above Guild Manager's highest role."
      }] };
      await withLogChanges(f.guild.id, async (changes) => {
        assert.deepEqual(await planEffectiveNicknameUpdate(f.guild as any, f.repository as any, "user-1"), expected);
        assert.deepEqual(changes, []);
        const result = await reconcileEffectiveNickname(f.guild as any, f.repository as any, "user-1");
        assert.deepEqual(result, expected);
        assert.deepEqual(f.writes, []);
        assert.deepEqual(changes, [{ kind: "incomplete", area: "membership" }]);
        assert.deepEqual(formatLogChanges([...changes, { kind: "reconciliation", outcomes: [], warningCount: result.warnings.length }]), [
          "Membership update changed 0 profiles for 0 members. 1 operation could not be completed."
        ]);
      });
    });
  }
}

test("missing Manage Nicknames permission warns in audit and update without attempting a write", async () => {
  const f = nicknamePermissionFixture(1, false);
  for (const operation of [planEffectiveNicknameUpdate, reconcileEffectiveNickname]) {
    assert.deepEqual(await operation(f.guild as any, f.repository as any, "user-1"), {
      outcomes: [], warnings: [{ message: "Could not update <@user-1>'s nickname: Guild Manager lacks the Manage Nicknames permission." }]
    });
  }
  assert.deepEqual(f.writes, []);
});

test("matching nickname produces no hierarchy or permission warning", async () => {
  const f = nicknamePermissionFixture(3, false);
  f.member.nickname = "New Nickname";
  for (const operation of [planEffectiveNicknameUpdate, reconcileEffectiveNickname]) {
    assert.deepEqual(await operation(f.guild as any, f.repository as any, "user-1"), { outcomes: [], warnings: [] });
  }
  assert.deepEqual(f.writes, []);
});

test("nickname preflight fetches an uncached bot member and preserves fetch failures as warnings", async () => {
  const f = nicknamePermissionFixture();
  const botMember = f.guild.members.me;
  let fetched = 0;
  const guild = { ...f.guild, members: { ...f.guild.members, me: null, fetchMe: async () => {
    fetched += 1;
    return botMember;
  } } };
  assert.equal((await planEffectiveNicknameUpdate(guild as any, f.repository as any, "user-1")).outcomes.length, 1);
  assert.equal(fetched, 1);
  guild.members.fetchMe = async () => { throw new Error("Discord unavailable"); };
  for (const operation of [planEffectiveNicknameUpdate, reconcileEffectiveNickname]) {
    const result = await operation(guild as any, f.repository as any, "user-1");
    assert.deepEqual(result.outcomes, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!.message, /Discord unavailable/);
  }
  assert.deepEqual(f.writes, []);
});

function nicknamePermissionFixture(position = 1, canManageNicknames = true, desired: string | null = "New Nickname") {
  const writes: Array<string | null> = [];
  const member = {
    nickname: "Old Nickname" as string | null,
    roles: { highest: { position } },
    setNickname: async (value: string | null) => { writes.push(value); member.nickname = value; }
  };
  return {
    member, writes,
    guild: { id: "guild-1", ownerId: "owner", members: { me: nicknameBotMember(canManageNicknames), fetch: async () => member } },
    repository: { getEffectiveNickname: async () => desired ?? undefined }
  };
}
