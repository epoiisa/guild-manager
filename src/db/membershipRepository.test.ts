import assert from "node:assert/strict";
import test from "node:test";
import {
  CharacterAlreadyRegisteredError,
  CharacterRegistrationLimitError,
  createMembershipRepository
} from "./membershipRepository.js";

test("application acceptance translates only the one-owner character index conflict", async () => {
  for (const scenario of [
    { name: "owner index", error: { code: "23505", constraint: "discord_user_characters_one_owner_per_guild_character" }, expected: CharacterAlreadyRegisteredError },
    { name: "unrelated unique constraint", error: { code: "23505", constraint: "another_unique_constraint" }, expected: undefined },
    { name: "missing constraint identity", error: { code: "23505" }, expected: undefined }
  ]) {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "0" }], rowCount: 1 };
        if (normalized.startsWith("insert into discord_user_characters")) throw scenario.error;
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];
    const acceptance = createMembershipRepository(pool).completeApplicationAcceptance({
      applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open",
      discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", player: { id: "character-1", name: "One" }
    });
    if (scenario.expected) await assert.rejects(acceptance, scenario.expected, scenario.name);
    else await assert.rejects(acceptance, (error) => error === scenario.error, scenario.name);
    assert.equal(calls.at(-1), "rollback", scenario.name);
  }
});

test("character registration capacity is serialized and soft-fails before a twenty-sixth insert", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
      if (sql.includes("registration_count")) {
        return { rows: [{ already_registered: false, registration_count: "25" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  await assert.rejects(
    createMembershipRepository(pool).registerCharacter({
      discordGuildId: "guild-1",
      discordUserId: "user-1",
      albionServer: "asia",
      player: { id: "character-26", name: "TwentySix" }
    }),
    CharacterRegistrationLimitError
  );
  assert.ok(calls.some((sql) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(calls.some((sql) => sql.startsWith("insert into discord_user_characters")), false);
  assert.equal(calls.at(-1), "rollback");
});

test("application acceptance permits an applicant's exact existing registration at capacity", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select 1 from member_groups") || normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("registration_count")) return { rows: [{ already_registered: true, registration_count: "25" }], rowCount: 1 };
      if (normalized.startsWith("insert into discord_user_characters")) {
        return { rows: [{ discord_guild_id: "guild-1", discord_user_id: "user-1", albion_server: "europe", albion_character_id: "character-25" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  const result = await createMembershipRepository(pool).completeApplicationAcceptance({
    applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open", memberGroupId: "group-1",
    discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", player: { id: "character-25", name: "Twenty Five" }
  });

  assert.equal(result?.characterName, "Twenty Five");
  assert.ok(calls.some((sql) => sql.startsWith("insert into discord_user_characters")));
  assert.ok(calls.some((sql) => sql.startsWith("update open_applications")));
  assert.equal(calls.at(-1), "commit");
});

test("application acceptance leaves its decision unresolved for a new twenty-sixth registration", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select 1 from member_groups") || normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "25" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  await assert.rejects(
    createMembershipRepository(pool).completeApplicationAcceptance({
      applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open", memberGroupId: "group-1",
      discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", player: { id: "character-26", name: "Twenty Six" }
    }),
    CharacterRegistrationLimitError
  );

  assert.equal(calls.some((sql) => sql.startsWith("update open_applications")), false);
  assert.equal(calls.at(-1), "rollback");
});

test("application acceptance rolls back registration and leaves its decision untouched when a required membership write fails", async () => {
  for (const failure of ["registration", "profile"] as const) {
    const calls: string[] = [];
    const client = {
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
        calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
        if (normalized.startsWith("select 1 from member_groups") || normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "24" }], rowCount: 1 };
        if (failure === "registration" && normalized.startsWith("insert into discord_user_characters")) throw new Error("registration write failed");
        if (failure === "profile" && normalized.startsWith("insert into member_group_profiles")) throw new Error("profile write failed");
        return { rows: [{ discord_guild_id: "guild-1", discord_user_id: "user-1", albion_server: "europe", albion_character_id: "character-25" }], rowCount: 1 };
      },
      release: () => undefined
    };
    const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

    await assert.rejects(
      createMembershipRepository(pool).completeApplicationAcceptance({
        applicationId: "application-1",
        reviewerDiscordUserId: "reviewer-1",
        expectedApplicationStatus: "open",
        memberGroupId: "group-1",
        discordGuildId: "guild-1",
        discordUserId: "user-1",
        albionServer: "europe",
        player: { id: "character-25", name: "Twenty Five" }
      }),
      /write failed/
    );
    assert.equal(calls.some((sql) => sql.startsWith("update open_applications")), false, failure);
    assert.equal(calls.at(-1), "rollback", failure);
  }
});

test("application acceptance performs profile registration before its exact accepted compare-and-set", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push(normalized);
      if ((normalized.startsWith("select 1 from member_registration_lifecycle") || normalized.startsWith("select 1 from guild_member_access") || normalized.startsWith("select 1 from character_kick_recovery"))) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select 1 from member_groups") || normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "24" }], rowCount: 1 };
      if (normalized.startsWith("insert into discord_user_characters")) return { rows: [{ discord_guild_id: "guild-1", discord_user_id: "user-1", albion_server: "europe", albion_character_id: "character-25" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  const result = await createMembershipRepository(pool).completeApplicationAcceptance({
    applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open", memberGroupId: "group-1",
    discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe", player: { id: "character-25", name: "Twenty Five" }
  });

  assert.equal(result?.characterName, "Twenty Five");
  const profile = calls.findIndex((sql) => sql.startsWith("insert into member_group_profiles"));
  const accepted = calls.findIndex((sql) => sql.startsWith("update open_applications"));
  assert.ok(profile >= 0 && accepted > profile);
  assert.equal(calls.at(-1), "commit");
});

test("application acceptance locks and rechecks the exact live class and member-group target before writes", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ sql: normalized, values });
      if (normalized.includes("guild-manager-member-access:") || normalized.startsWith("select 1 from guild_member_access")) return { rows: [], rowCount: 0 };
      if (normalized.includes("membership-lifecycle-tenant:")) return { rows: [], rowCount: 0 };
      if (normalized === "begin" || normalized === "commit") return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select 1 from member_groups")) return { rows: [{}], rowCount: 1 };
      if (normalized.startsWith("select 1 from open_applications open_application")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  const result = await createMembershipRepository(pool).completeApplicationAcceptance({
    applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open",
    memberGroupId: "group-1", discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe",
    player: { id: "character-1", name: "One" }
  });

  assert.equal(result, undefined);
  assert.match(calls[1].sql, /guild-manager-member-access:/);
  assert.match(calls[2].sql, /select 1 from guild_member_access/);
  assert.match(calls[3].sql, /membership-lifecycle-tenant:/);
  assert.match(calls[4].sql, /for update/);
  assert.deepEqual(calls[4].values, ["guild-1", "group-1", "europe"]);
  assert.match(calls[5].sql, /application_class\.archived_at is null/);
  assert.match(calls[5].sql, /for update of application_class, open_application/);
  assert.deepEqual(calls[5].values, ["guild-1", "application-1", "open", "group-1", "europe"]);
  assert.equal(calls.some((call) => call.sql.startsWith("insert into discord_user_characters")), false);
  assert.equal(calls.at(-1)?.sql, "commit");
});

test("register-character application acceptance validates a live class without requiring a member group", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ sql: normalized, values });
      if (normalized.includes("guild-manager-member-access:") || normalized.startsWith("select 1 from guild_member_access")) return { rows: [], rowCount: 0 };
      if (normalized.includes("membership-lifecycle-tenant:")) return { rows: [], rowCount: 0 };
      if (normalized === "begin" || normalized === "commit") return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select 1 from open_applications open_application")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  const result = await createMembershipRepository(pool).completeApplicationAcceptance({
    applicationId: "application-1", reviewerDiscordUserId: "reviewer-1", expectedApplicationStatus: "open",
    discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe",
    player: { id: "character-1", name: "One" }
  });

  assert.equal(result, undefined);
  assert.match(calls[1].sql, /guild-manager-member-access:/);
  assert.match(calls[2].sql, /select 1 from guild_member_access/);
  assert.match(calls[3].sql, /membership-lifecycle-tenant:/);
  assert.equal(calls.some((call) => call.sql.startsWith("select 1 from member_groups")), false);
  assert.deepEqual(calls[4].values, ["guild-1", "application-1", "open", null, "europe"]);
  assert.match(calls[4].sql, /application_class\.outcome_type = 'register_character'/);
  assert.equal(calls.at(-1)?.sql, "commit");
});

test("setting a main character serializes the hierarchy move and main selection in one transaction", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim().toLowerCase(), values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  await createMembershipRepository(pool).setMainCharacter({
    discordGuildId: "guild-1",
    discordUserId: "user-1",
    albionServer: "europe",
    albionCharacterId: "character-2"
  });

  assert.equal(calls[0].sql, "begin");
  assert.match(calls[1].sql, /guild-manager-member-access:/);
  assert.match(calls[2].sql, /select 1 from guild_member_access/);
  assert.match(calls[3].sql, /membership-lifecycle-tenant/);
  assert.match(calls[4].sql, /pg_advisory_xact_lock/);
  assert.match(calls[5].sql, /set registration_order = hierarchy\.first_order - 1/);
  assert.match(calls[6].sql, /insert into discord_user_main_characters/);
  assert.equal(calls[7].sql, "commit");
  assert.deepEqual(calls[5].values, ["guild-1", "user-1", "europe", "character-2"]);
  assert.deepEqual(calls[6].values, ["guild-1", "user-1", "europe", "character-2"]);
});

test("member group removal previews membership and retired role impact", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ sql: normalized, values });
      if (normalized.includes("from member_groups mg")) {
        return { rows: [{
          member_group_id: "42", discord_guild_id: "guild-1", albion_server: "europe",
          group_type: "alliance", group_name: "Alliance One", albion_guild_id: null,
          albion_alliance_id: "alliance-1", albion_alliance_tag: "ONE"
        }], rowCount: 1 };
      }
      if (normalized.includes("count(*)::text as total_membership_profiles")) {
        return { rows: [{
          total_membership_profiles: "4", owned_membership_profiles: "3",
          orphaned_membership_profiles: "1", affected_discord_user_ids: ["user-1", "user-2"]
        }], rowCount: 1 };
      }
      if (normalized.includes("as retired_role_ids")) {
        return { rows: [{ retired_role_ids: ["membership-role", "position-role"] }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    }
  } as unknown as Parameters<typeof createMembershipRepository>[0];

  const preview = await createMembershipRepository(pool).previewMemberGroupRemoval("guild-1", "42");

  assert.deepEqual(preview, {
    memberGroup: {
      memberGroupId: "42", discordGuildId: "guild-1", albionServer: "europe",
      groupType: "alliance", groupName: "Alliance One"
    },
    displayName: "Alliance One [ONE]",
    albionEntityId: "alliance-1",
    albionAllianceTag: "ONE",
    totalMembershipProfiles: 4,
    ownedMembershipProfiles: 3,
    orphanedMembershipProfiles: 1,
    affectedDiscordUserIds: ["user-1", "user-2"],
    retiredRoleIds: ["membership-role", "position-role"]
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].sql.includes("for update"), false);
  assert.deepEqual(calls[0].values, ["guild-1", "42"]);
});

test("member group removal atomically archives retained applications and deletes empty classes", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ sql: normalized, values });
      if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes("from member_groups mg")) {
        return { rows: [{
          member_group_id: "42", discord_guild_id: "guild-1", albion_server: "europe",
          group_type: "alliance", group_name: "Alliance One", albion_guild_id: null,
          albion_alliance_id: "alliance-1", albion_alliance_tag: "ONE"
        }], rowCount: 1 };
      }
      if (normalized.includes("count(*)::text as total_membership_profiles")) {
        return { rows: [{
          total_membership_profiles: "3", owned_membership_profiles: "2",
          orphaned_membership_profiles: "1", affected_discord_user_ids: ["user-1", "user-2"]
        }], rowCount: 1 };
      }
      if (normalized.includes("as retired_role_ids")) {
        return { rows: [{ retired_role_ids: ["membership-role", "position-role"] }], rowCount: 1 };
      }
      if (normalized.includes("from application_classes c") && normalized.includes("for update of c")) {
        return { rows: [
          {
            application_class_id: "10", source_channel_id: "source-1", source_message_id: "message-1",
            reviewer_role_id: "reviewer-1", active_role_id: "active-1"
          },
          {
            application_class_id: "11", source_channel_id: "source-2", source_message_id: "message-2",
            reviewer_role_id: "reviewer-2", active_role_id: null
          }
        ], rowCount: 2 };
      }
      if (normalized.startsWith("select distinct application_class_id from open_applications")) {
        return { rows: [{ application_class_id: "10" }], rowCount: 1 };
      }
      if (normalized.startsWith("with targets as materialized")) {
        return { rows: [
          {
            application_id: "100", application_class_id: "10", applicant_discord_user_id: "user-1",
            ticket_channel_id: "ticket-1", reviewer_role_id: "reviewer-1", active_role_id: "active-1",
            channel_status: "open", channel_closed_by_removal: true
          },
          {
            application_id: "101", application_class_id: "10", applicant_discord_user_id: "user-2",
            ticket_channel_id: "ticket-2", reviewer_role_id: "reviewer-1", active_role_id: "active-1",
            channel_status: "deleted", channel_closed_by_removal: false
          }
        ], rowCount: 2 };
      }
      if (normalized.startsWith("update application_classes")) return { rows: [], rowCount: 1 };
      if (normalized.startsWith("delete from application_classes")) return { rows: [], rowCount: 1 };
      if (normalized.startsWith("delete from member_groups")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];

  const result = await createMembershipRepository(pool).removeMemberGroup({
    discordGuildId: "guild-1",
    memberGroupId: "42",
    archivedByDiscordUserId: "admin-1"
  });

  assert.equal(result?.displayName, "Alliance One [ONE]");
  assert.equal(result?.archivedApplicationClassCount, 1);
  assert.equal(result?.deletedApplicationClassCount, 1);
  assert.deepEqual(result?.archivedApplicationClassIds, ["10"]);
  assert.deepEqual(result?.deletedApplicationClassIds, ["11"]);
  assert.deepEqual(result?.archivedApplicationIds, ["100", "101"]);
  assert.deepEqual(result?.archivedApplicationClasses, [{
    applicationClassId: "10", sourceChannelId: "source-1", sourceMessageId: "message-1"
  }]);
  assert.deepEqual(result?.deletedApplicationClasses, [{
    applicationClassId: "11", sourceChannelId: "source-2", sourceMessageId: "message-2"
  }]);
  assert.deepEqual(result?.archivedApplications?.map((application) => application.channelClosedByRemoval), [true, false]);
  assert.deepEqual(result?.archivedApplications?.map((application) => application.channelStatus), ["open", "deleted"]);
  assert.equal(calls[0].sql, "begin");
  assert.match(calls[1].sql, /for update of mg/);
  const classLock = calls.findIndex((call) => call.sql.includes("from application_classes c") && call.sql.includes("for update of c"));
  const retainedCheck = calls.findIndex((call) => call.sql.startsWith("select distinct application_class_id from open_applications"));
  assert.ok(classLock >= 0 && retainedCheck > classLock);
  assert.match(calls.find((call) => call.sql.startsWith("with targets"))!.sql, /targets\.channel_status = 'open'/);
  const archive = calls.find((call) => call.sql.startsWith("update application_classes"))!;
  assert.match(archive.sql, /archived_member_group_type = \$4/);
  assert.match(archive.sql, /source_channel_id = null/);
  assert.deepEqual(archive.values, ["guild-1", "42", "admin-1", "alliance", "Alliance One", "alliance-1", "ONE", ["10"]]);
  assert.equal(calls.at(-1)?.sql, "commit");
});

test("active member-group lookup is bounded to the exact guild, group, and owning user", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [{
          member_group_id: "group-1",
          discord_guild_id: "guild-1",
          albion_server: "europe",
          group_type: "guild",
          group_name: "Guild One"
        }]
      };
    }
  } as unknown as Parameters<typeof createMembershipRepository>[0];
  const repository = createMembershipRepository(pool);

  assert.deepEqual(
    await repository.getActiveMemberGroupForUser("guild-1", "group-1", "user-1"),
    {
      memberGroupId: "group-1",
      discordGuildId: "guild-1",
      albionServer: "europe",
      groupType: "guild",
      groupName: "Guild One"
    }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["guild-1", "group-1", "user-1"]);
  assert.match(calls[0].sql, /mg\.discord_guild_id = \$1/);
  assert.match(calls[0].sql, /mg\.member_group_id = \$2/);
  assert.match(calls[0].sql, /mgp\.discord_user_id = \$3/);
});

test("self-service membership reads are bounded to one guild and user and preserve role sources", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("from discord_user_characters registered")) {
        return {
          rows: [
            {
              albion_server: "europe",
              albion_character_id: "character-1",
              character_name: "Example",
              discord_role_id: "character-role-2"
            },
            {
              albion_server: "europe",
              albion_character_id: "character-1",
              character_name: "Example",
              discord_role_id: "character-role-1"
            }
          ]
        };
      }
      if (sql.includes("left join member_group_role_configs role_config")) {
        return {
          rows: [
            {
              member_group_profile_id: "profile-1",
              member_group_id: "group-1",
              albion_server: "europe",
              albion_character_id: "character-1",
              character_name: "Example",
              group_type: "guild",
              group_name: "Example Guild",
              discord_role_id: "group-role-1"
            }
          ]
        };
      }
      if (sql.includes("position.name as position_name")) {
        return {
          rows: [
            {
              member_group_position_appointment_id: "appointment-1",
              albion_server: "europe",
              albion_character_id: "character-1",
              character_name: "Example",
              group_type: "guild",
              group_name: "Example Guild",
              position_name: "Leader",
              discord_role_id: "position-role-1"
            }
          ]
        };
      }
      if (sql.includes("from reaction_role_subscriptions subscription")) {
        return {
          rows: [
            {
              reaction_role_config_id: "reaction-1",
              discord_role_id: "reaction-role-1",
              active: false
            }
          ]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  } as unknown as Parameters<typeof createMembershipRepository>[0];
  const repository = createMembershipRepository(pool);

  assert.deepEqual(
    await repository.listSelfServiceCharacters("guild-1", "user-1"),
    [{
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example",
      discordRoleIds: ["character-role-2", "character-role-1"]
    }]
  );
  assert.deepEqual(
    await repository.listSelfServiceMemberships("guild-1", "user-1"),
    [{
      memberGroupProfileId: "profile-1",
      memberGroupId: "group-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example",
      groupType: "guild",
      groupName: "Example Guild",
      discordRoleIds: ["group-role-1"]
    }]
  );
  assert.deepEqual(
    await repository.listSelfServicePositions("guild-1", "user-1"),
    [{
      memberGroupPositionAppointmentId: "appointment-1",
      albionServer: "europe",
      albionCharacterId: "character-1",
      characterName: "Example",
      groupType: "guild",
      groupName: "Example Guild",
      positionName: "Leader",
      discordRoleId: "position-role-1"
    }]
  );
  assert.deepEqual(
    await repository.listSelfServiceReactionRoles("guild-1", "user-1"),
    [{
      reactionRoleConfigId: "reaction-1",
      discordRoleId: "reaction-role-1",
      dormant: true
    }]
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.sql.includes("$1") && call.sql.includes("$2")));
  assert.ok(calls.every((call) => call.sql.includes("discord_user_id")));
  assert.deepEqual(calls.map((call) => call.values), [
    ["guild-1", "user-1"],
    ["guild-1", "user-1"],
    ["guild-1", "user-1"],
    ["guild-1", "user-1"]
  ]);
});

test("self-service membership role lookup excludes reaction-role subscriptions", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [
          { discord_role_id: "character-role-1" },
          { discord_role_id: "group-role-1" },
          { discord_role_id: "position-role-1" }
        ]
      };
    }
  } as unknown as Parameters<typeof createMembershipRepository>[0];
  const repository = createMembershipRepository(pool);

  assert.deepEqual(
    await repository.listMembershipRoleIdsForUser("guild-1", "user-1"),
    ["character-role-1", "group-role-1", "position-role-1"]
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["guild-1", "user-1"]);
  assert.match(calls[0].sql, /character_role_configs/);
  assert.match(calls[0].sql, /member_group_role_configs/);
  assert.match(calls[0].sql, /member_group_position_appointments/);
  assert.doesNotMatch(calls[0].sql, /reaction_role_subscriptions/);
});

// Capture belongs to the confirmed mutation, including transaction commit.
import { withLogChanges, type LogChange } from "../services/logFeed/events.js";
const logRegistrationInput = {
  discordGuildId: "guild-1", discordUserId: "user-1", albionServer: "europe" as const,
  player: { id: "character-1", name: "Character One" }
};
const logCharacterRow = { discord_guild_id: "guild-1", discord_user_id: "user-1", albion_server: "europe", albion_character_id: "character-1" };
const logProfileRow = { ...logCharacterRow, member_group_id: "group-1", member_group_profile_id: "profile-1", group_name: "Group One", group_type: "group", character_name: "Character One" };

test("registration capture records insertion only after commit and ignores repeat registration", async () => {
  for (const inserted of [true, false]) {
    let committed = false;
    const client = { query: async (sql: string) => {
      if (sql.includes("registration_count")) return { rows: [{ already_registered: !inserted, registration_count: "1" }], rowCount: 1 };
      if (sql.includes("insert into discord_user_characters")) {
        assert.match(sql, /xmax = 0/);
        return { rows: [{ ...logCharacterRow, log_inserted: inserted }], rowCount: 1 };
      }
      if (sql === "commit") committed = true;
      return { rows: [], rowCount: 0 };
    }, release: () => undefined };
    const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];
    await withLogChanges("guild-1", async changes => {
      await createMembershipRepository(pool).registerCharacter(logRegistrationInput);
      assert.equal(committed, true);
      assert.equal(changes.length, inserted ? 1 : 0);
      if (inserted) assert.equal(changes[0].kind, "registration");
    });
  }
});

test("application rollback discards registration, orphan adoption, and profile additions", async () => {
  let accepted = false;
  for (const commit of [false, true]) {
    const client = { query: async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("select 1 from member_groups") || normalized.startsWith("select 1 from open_applications open_application")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "0" }], rowCount: 1 };
      if (sql.includes("insert into discord_user_characters")) return { rows: [{ ...logCharacterRow, log_inserted: true }], rowCount: 1 };
      if (sql.includes("with changed as (update member_group_profiles")) return { rows: [logProfileRow], rowCount: 1 };
      if (sql.includes("with changed as (") && sql.includes("insert into member_group_profiles")) return { rows: [{ ...logProfileRow, member_group_profile_id: "profile-2" }], rowCount: 1 };
      if (sql.includes("update open_applications")) { accepted = commit; return { rows: [], rowCount: commit ? 1 : 0 }; }
      return { rows: [], rowCount: 0 };
    }, release: () => undefined };
    const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];
    await withLogChanges("guild-1", async changes => {
      await createMembershipRepository(pool).completeApplicationAcceptance({ ...logRegistrationInput,
        applicationId: "application-1", reviewerDiscordUserId: "reviewer", expectedApplicationStatus: "open", memberGroupId: "group-2" });
      assert.equal(accepted, commit);
      assert.equal(changes.length, commit ? 3 : 0);
      if (commit) assert.deepEqual(changes.map(change => change.kind), ["registration", "profile", "profile"]);
    });
  }
});

test("profile insertion uses locked conflict evidence and returns no-op profiles without capture", async () => {
  for (const changed of [true, false]) {
    const client = { query: async (sql: string) => {
      if (sql.includes("insert into member_group_profiles")) {
        assert.match(sql, /member_group_profiles.discord_user_id is distinct from excluded.discord_user_id/);
        return { rows: changed ? [logProfileRow] : [], rowCount: changed ? 1 : 0 };
      }
      return { rows: [logProfileRow], rowCount: 1 };
    }, release: () => undefined };
    const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];
    await withLogChanges("guild-1", async changes => {
      const profile = await createMembershipRepository(pool).addRegisteredProfile({ ...logRegistrationInput,
        memberGroupId: "group-1", albionCharacterId: "character-1" });
      assert.equal(profile?.characterName, "Character One");
      assert.equal(changes.length, changed ? 1 : 0);
    });
  }
});

test("failed commit emits no membership evidence", async () => {
  const client = { query: async (sql: string) => {
    if (sql.includes("registration_count")) return { rows: [{ already_registered: false, registration_count: "0" }], rowCount: 1 };
    if (sql.includes("insert into discord_user_characters")) return { rows: [{ ...logCharacterRow, log_inserted: true }], rowCount: 1 };
    if (sql === "commit") throw new Error("commit failed");
    return { rows: [], rowCount: 0 };
  }, release: () => undefined };
  const pool = { connect: async () => client } as unknown as Parameters<typeof createMembershipRepository>[0];
  let retained!: LogChange[];
  await assert.rejects(withLogChanges("guild-1", async changes => {
    retained = changes;
    await createMembershipRepository(pool).registerCharacter(logRegistrationInput);
  }), /commit failed/);
  assert.deepEqual(retained, []);
});
