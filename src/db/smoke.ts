import "dotenv/config";
import { runConfigurationMigrationSmoke } from "./configurationSmoke.js";
import { runEntryPanelSmoke } from "./entryPanelSmoke.js";
import assert from "node:assert/strict";
import type { Guild } from "discord.js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { purgeGuildOwnedData } from "./guildDataPurge.js";
import { createGuildLifecycleRepository } from "./guildLifecycleRepository.js";
import { createGiveawayRepository } from "./giveawayRepository.js";
import {
  CharacterAlreadyRegisteredError,
  CharacterRegistrationLimitError,
  createMembershipRepository
} from "./membershipRepository.js";
import { AccountOperationError, createAccountRepository } from "./accountRepository.js";
import { createApplicationRepository } from "./applicationRepository.js";
import { runContentLifecycleSmoke } from "./contentLifecycleSmoke.js";
import { createContentRepository } from "./contentRepository.js";
import { createPostgresPool } from "./postgres.js";
import type { PostgresPool } from "./postgres.js";
import { createResetRepository } from "./resetRepository.js";
import { createRegearRepository, RegearOperationError } from "./regearRepository.js";
import type { RegearContent } from "./regearRepository.js";
import {
  ReactionRolePlacementConflictError,
  createReactionRoleRepository
} from "./reactionRoleRepository.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabaseSchema } from "./schema.js";
import { createTicketRepository } from "./ticketRepository.js";
import { runConversationClassRemovalSmoke } from "./conversationClassRemovalSmoke.js";
import { createSpecialisationRepository, SpecialisationOperationError } from "./specialisationRepository.js";
import { createReviewerRepository } from "./reviewerRepository.js";
import { createStatusRepository } from "./statusRepository.js";
import { createTasksRepository } from "./tasksRepository.js";
import { catalogueByKey } from "../services/specialisations/catalogue.js";
import type { AlbionClient } from "../services/albion/client.js";
import type { AlbionPlayer } from "../services/albion/types.js";
import { formatAuditUpdateResponse } from "../commands/update.js";
import { cleanupDiscordUserDeparture } from "../services/membership/discordMemberDepartures.js";
import {
  auditMembershipForGuild,
  reconcileMembershipForGuild,
  reconcileRegisteredCharacterMembership
} from "../services/membership/reconciliation.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");

const postgres = createPostgresPool(databaseUrl);

const RESET_DIRECT_GUILD_TABLES = [
  "guild_member_access",
  "character_kick_recovery",
  "member_kick_activity_revocations",
  "member_kick_activity_cleanup",
  "member_registration_lifecycle",
  "membership_evidence_cleanup",
  "character_specialisations",
  "specialisation_requests",
  "specialisation_catalogue_exclusions",
  "specialisation_reviewer_configs",
  "discord_user_characters",
  "character_registration_history",
  "member_groups",
  "configured_albion_guilds",
  "configured_albion_alliances",
  "member_group_profiles",
  "discord_user_main_characters",
  "discord_user_custom_nicknames",
  "character_role_configs",
  "temporary_voice_configs",
  "temporary_voice_channels",
  "utc_voice_channels",
  "log_channel_configs",
  "discord_guild_defaults",
  "member_update_schedules",
  "application_classes",
  "open_applications",
  "member_group_positions",
  "member_group_position_appointments",
  "content_channel_configs",
  "content_templates",
  "content_items",
  "content_role_slots",
  "content_signups",
  "giveaways",
  "giveaway_entries",
  "giveaway_reactions",
  "giveaway_winners",
  "giveaway_notification_roles",
  "reaction_role_configs",
  "reaction_role_emoji_placements",
  "reaction_role_subscriptions",
  "regear_contents",
  "regear_claims",
  "character_accounts",
  "account_transactions",
  "account_status_events",
  "ticket_classes",
  "tickets"
] as const;

try {
  await migrateDatabaseSchema(postgres);
  await runConfigurationMigrationSmoke(databaseUrl, postgres);
  await runEntryPanelSmoke(postgres);
  await runCustomGroupProfileRemovalSmoke(postgres);
  await runApplicationPublicationSchemaTransitionSmoke(databaseUrl, postgres);
  await runPositionSchemaTransitionSmoke(databaseUrl, postgres);
  await runCharacterHierarchySchemaTransitionSmoke(databaseUrl, postgres);
  await runReactionSchemaTransitionSmoke(postgres);
  await runCharacterHierarchySmoke(postgres);
  await runContentRoleReductionSmoke(postgres);
  await runContentLifecycleSmoke(databaseUrl, postgres);
  const client = await postgres.connect();

  try {
    await client.query("begin");

    const reactionSchema = await client.query<{
      schema_version: number;
      legacy_buttons: string | null;
      legacy_preferences: string | null;
      legacy_mode: boolean;
      obsolete_group_connections: string | null;
      content_control_message: boolean;
      content_builds_graphic: boolean;
      content_signup_type: boolean;
      legacy_regear_grants: string | null;
      legacy_reviewer_scope_migrations: string | null;
      regear_contents: string | null;
      regear_claims: string | null;
      regear_transaction_link: boolean;
    }>(
      `
      select
        (select max(version) from guild_manager_schema_migrations) schema_version,
        to_regclass('reaction_role_buttons')::text legacy_buttons,
        to_regclass('reaction_role_member_preferences')::text legacy_preferences,
        to_regclass('reaction_role_member_groups')::text obsolete_group_connections,
        exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'reaction_role_configs'
            and column_name = 'mode'
        ) legacy_mode,
        exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'content_items'
            and column_name = 'control_message_id'
        ) content_control_message,
        exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'content_items'
            and column_name = 'graphic_attachment_name'
        ) content_builds_graphic,
        exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'content_signups'
            and column_name = 'signup_type'
        ) content_signup_type,
        to_regclass('regear_admin_grants')::text legacy_regear_grants,
        to_regclass('reviewer_scope_migrations')::text legacy_reviewer_scope_migrations,
        to_regclass('regear_contents')::text regear_contents,
        to_regclass('regear_claims')::text regear_claims,
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'account_transactions'
            and column_name = 'regear_claim_id'
        ) regear_transaction_link
      `
    );
    if (reactionSchema.rows[0]?.schema_version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`Expected schema version ${CURRENT_SCHEMA_VERSION}.`);
    }
    if (!reactionSchema.rows[0].content_control_message) {
      throw new Error("Expected content items to store canonical thread control-message IDs.");
    }
    if (!reactionSchema.rows[0].content_builds_graphic) {
      throw new Error("Expected content items to store normalized builds-graphic attachment names.");
    }
    if (!reactionSchema.rows[0].content_signup_type) {
      throw new Error("Expected content signups to distinguish role and standby entries.");
    }
    if (
      !reactionSchema.rows[0].regear_contents
      || !reactionSchema.rows[0].regear_claims
      || !reactionSchema.rows[0].regear_transaction_link
    ) {
      throw new Error("Expected the current schema to include re-gear content, claims, account-credit links, and builds graphics.");
    }
    if (
      reactionSchema.rows[0].legacy_buttons
      || reactionSchema.rows[0].legacy_preferences
      || reactionSchema.rows[0].legacy_mode
      || reactionSchema.rows[0].obsolete_group_connections
      || reactionSchema.rows[0].legacy_regear_grants
      || reactionSchema.rows[0].legacy_reviewer_scope_migrations
    ) {
      throw new Error("Expected the current schema to remove legacy and group-connection storage.");
    }

    const runId = `${Date.now()}`;
    const discordGuildId = `smoke-guild-${runId}`;
    const otherDiscordGuildId = `smoke-other-guild-${runId}`;
    const discordUserId = `smoke-user-${runId}`;
    const otherDiscordUserId = `smoke-other-user-${runId}`;
    const albionServer = "asia";
    const albionCharacterId = `smoke-character-${runId}`;
    const orphanCharacterId = `smoke-orphan-character-${runId}`;
    const closureAccountCharacterId = `smoke-closure-account-character-${runId}`;
    const transferCounterpartyCharacterId = `smoke-transfer-counterparty-character-${runId}`;
    const switchCharacterId = `smoke-switch-character-${runId}`;
    const conflictCharacterId = `smoke-conflict-character-${runId}`;
    const immediateDiscordUserId = `smoke-immediate-user-${runId}`;
    const immediateCharacterId = `smoke-immediate-character-${runId}`;
    const immediateGuildId = `smoke-immediate-guild-${runId}`;
    const immediateAllianceId = `smoke-immediate-alliance-${runId}`;
    const utcDiscordGuildId = `smoke-utc-guild-${runId}`;
    const defaultDiscordGuildId = `smoke-default-guild-${runId}`;
    const defaultAlbionGuildId = `smoke-default-albion-guild-${runId}`;

    await client.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1, 'active', 'Smoke Membership Guild', now())`,
      [discordGuildId]
    );

    const standbyContent = await client.query<{ content_id: string }>(
      `
      insert into content_items (
        discord_guild_id,
        source_channel_id,
        thread_channel_id,
        leader_discord_user_id,
        title,
        description,
        scheduled_start_at
      )
      values ($1, $2, $3, $4, 'Standby Smoke', '', now() + interval '1 day')
      returning content_id
      `,
      [discordGuildId, `standby-source-${runId}`, `standby-thread-${runId}`, discordUserId]
    );
    const standbyContentId = standbyContent.rows[0].content_id;
    const standbyRoleSlot = await client.query<{ content_role_slot_id: string }>(
      `
      insert into content_role_slots (content_id, discord_guild_id, slot_index, label)
      values ($1, $2, 1, 'Tank')
      returning content_role_slot_id
      `,
      [standbyContentId, discordGuildId]
    );
    await client.query(
      `
      insert into content_signups (
        content_id,
        content_role_slot_id,
        discord_guild_id,
        discord_user_id,
        signup_type
      )
      values
        ($1, null, $2, $3, 'standby'),
        ($1, null, $2, $4, 'standby')
      `,
      [standbyContentId, discordGuildId, discordUserId, otherDiscordUserId]
    );
    const standbySignupCount = await client.query<{ count: string }>(
      `
      select count(*)::text as count
      from content_signups
      where content_id = $1 and signup_type = 'standby' and state = 'active'
      `,
      [standbyContentId]
    );
    if (standbySignupCount.rows[0]?.count !== "2") {
      throw new Error("Expected one content signup to allow multiple standby users.");
    }
    await expectDatabaseFailure(client, "standby signup with a role slot", () =>
      client.query(
        `
        insert into content_signups (
          content_id,
          content_role_slot_id,
          discord_guild_id,
          discord_user_id,
          signup_type
        )
        values ($1, $2, $3, 'invalid-standby-user', 'standby')
        `,
        [standbyContentId, standbyRoleSlot.rows[0].content_role_slot_id, discordGuildId]
      )
    );

    await client.query(
      `
      insert into albion_characters (albion_server, albion_character_id, character_name)
      values ($1, $2, $3), ($1, $4, $5)
      `,
      [albionServer, albionCharacterId, "Smoke Character", orphanCharacterId, "Smoke Orphan"]
    );

    await expectDatabaseFailure(client, "UTC channel without guild lifecycle row", () =>
      client.query(
        `
        insert into utc_voice_channels (discord_guild_id, discord_channel_id)
        values ($1, $2)
        `,
        [utcDiscordGuildId, "smoke-utc-channel"]
      )
    );

    await client.query(
      `
      insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
      values ($1, 'active', $2, now())
      `,
      [utcDiscordGuildId, "Smoke UTC Guild"]
    );
    await client.query(
      `
      insert into utc_voice_channels (discord_guild_id, discord_channel_id)
      values ($1, $2)
      `,
      [utcDiscordGuildId, "smoke-utc-channel"]
    );
    await client.query(
      `
      insert into temporary_voice_configs (discord_guild_id, base_channel_id)
      values ($1, $2)
      `,
      [utcDiscordGuildId, "smoke-voice-base"]
    );
    await client.query(
      `
      insert into temporary_voice_channels (
        discord_guild_id,
        discord_channel_id,
        owner_discord_user_id,
        base_channel_id
      )
      values ($1, $2, $3, $4)
      `,
      [utcDiscordGuildId, "smoke-temporary-voice", "smoke-voice-owner", "smoke-voice-base"]
    );
    await client.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [utcDiscordGuildId]);
    const utcRowsAfterLifecycleDelete = await client.query(
      `
      select 1
      from utc_voice_channels
      where discord_guild_id = $1
      `,
      [utcDiscordGuildId]
    );
    if ((utcRowsAfterLifecycleDelete.rowCount ?? 0) !== 0) {
      throw new Error("Expected UTC channel records to cascade when guild lifecycle rows are deleted.");
    }
    const temporaryVoiceRowsAfterLifecycleDelete = await client.query(
      `
      select 1 from temporary_voice_configs where discord_guild_id = $1
      union all
      select 1 from temporary_voice_channels where discord_guild_id = $1
      `,
      [utcDiscordGuildId]
    );
    if ((temporaryVoiceRowsAfterLifecycleDelete.rowCount ?? 0) !== 0) {
      throw new Error("Expected temporary voice records to cascade when guild lifecycle rows are deleted.");
    }

    await client.query(
      `
      insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
      values ($1, 'active', $2, now())
      `,
      [defaultDiscordGuildId, "Smoke Default Guild"]
    );
    const defaultGroupResult = await client.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'guild', $3)
      returning member_group_id
      `,
      [defaultDiscordGuildId, albionServer, "Smoke Default Albion Guild"]
    );
    const defaultMemberGroupId = defaultGroupResult.rows[0].member_group_id;
    await client.query(
      `
      insert into configured_albion_guilds (
        member_group_id,
        discord_guild_id,
        albion_server,
        albion_guild_id,
        albion_guild_name,
        managed
      )
      values ($1, $2, $3, $4, $5, false)
      `,
      [
        defaultMemberGroupId,
        defaultDiscordGuildId,
        albionServer,
        defaultAlbionGuildId,
        "Smoke Default Albion Guild"
      ]
    );
    await client.query(
      `
      insert into discord_guild_defaults (
        discord_guild_id,
        default_albion_guild_member_group_id,
        default_albion_server
      )
      values ($1, $2, $3)
      `,
      [defaultDiscordGuildId, defaultMemberGroupId, albionServer]
    );
    await client.query("delete from member_groups where member_group_id = $1", [defaultMemberGroupId]);
    const defaultRowsAfterGroupDelete = await client.query(
      `
      select 1
      from discord_guild_defaults
      where discord_guild_id = $1
      `,
      [defaultDiscordGuildId]
    );
    if ((defaultRowsAfterGroupDelete.rowCount ?? 0) !== 0) {
      throw new Error("Expected default Albion Online guild records to cascade when configured guilds are deleted.");
    }

    await client.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4)
      `,
      [discordGuildId, discordUserId, albionServer, albionCharacterId]
    );

    await expectDatabaseFailure(client, "duplicate character ownership in one Discord guild", () =>
      client.query(
        `
        insert into discord_user_characters (
          discord_guild_id,
          discord_user_id,
          albion_server,
          albion_character_id
        )
        values ($1, $2, $3, $4)
        `,
        [discordGuildId, otherDiscordUserId, albionServer, albionCharacterId]
      )
    );

    await client.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4)
      `,
      [otherDiscordGuildId, otherDiscordUserId, albionServer, albionCharacterId]
    );

    const groupResult = await client.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'group', $3)
      returning member_group_id
      `,
      [discordGuildId, albionServer, "Smoke Group"]
    );
    const memberGroupId = groupResult.rows[0].member_group_id;

    await client.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4, $5)
      `,
      [memberGroupId, discordGuildId, discordUserId, albionServer, albionCharacterId]
    );

    await expectDatabaseFailure(client, "active profile without matching user-character registration", () =>
      client.query(
        `
        insert into member_group_profiles (
          member_group_id,
          discord_guild_id,
          discord_user_id,
          albion_server,
          albion_character_id
        )
        values ($1, $2, $3, $4, $5)
        `,
        [memberGroupId, discordGuildId, otherDiscordUserId, albionServer, orphanCharacterId]
      )
    );

    await client.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, null, $3, $4)
      `,
      [memberGroupId, discordGuildId, albionServer, orphanCharacterId]
    );

    await expectDatabaseFailure(client, "same character twice in one member group", () =>
      client.query(
        `
        insert into member_group_profiles (
          member_group_id,
          discord_guild_id,
          discord_user_id,
          albion_server,
          albion_character_id
        )
        values ($1, $2, null, $3, $4)
        `,
        [memberGroupId, discordGuildId, albionServer, albionCharacterId]
      )
    );

    await client.query(
      `
      insert into character_role_configs (discord_guild_id, albion_server, discord_role_id)
      values ($1, null, $2), ($1, $3, $2)
      `,
      [discordGuildId, "smoke-role", albionServer]
    );

    await client.query(
      `
      insert into member_group_role_configs (member_group_id, discord_role_id)
      values ($1, $2), ($1, $3)
      `,
      [memberGroupId, "smoke-group-role", "smoke-reaction-role"]
    );

    const requiredProfileRoles = await client.query<{ discord_role_id: string }>(
      `
      select mgrc.discord_role_id
      from member_group_profiles mgp
      join member_group_role_configs mgrc
        on mgrc.member_group_id = mgp.member_group_id
      where mgp.discord_guild_id = $1
        and mgp.discord_user_id = $2
      order by mgrc.discord_role_id asc
      `,
      [discordGuildId, discordUserId]
    );
    const requiredProfileRoleIds = requiredProfileRoles.rows.map((row) => row.discord_role_id);
    if (!requiredProfileRoleIds.includes("smoke-reaction-role")) {
      throw new Error("Expected member-group role configs to qualify an active profile owner.");
    }
    if (!requiredProfileRoleIds.includes("smoke-group-role")) {
      throw new Error("Expected required group role config to qualify active profile owner.");
    }

    const membershipRepository = createMembershipRepository(createQueuedTransactionPool(client));
    const reactionRoleRepository = createReactionRoleRepository(createQueuedTransactionPool(client));
    const accountRepository = createAccountRepository(createQueuedTransactionPool(client));
    const regearRepository = createRegearRepository(createQueuedTransactionPool(client));
    const applicationRepository = createApplicationRepository(createQueuedTransactionPool(client));
    const activeApplicationGroup = await membershipRepository.getActiveMemberGroupForUser(
      discordGuildId,
      memberGroupId,
      discordUserId
    );
    if (activeApplicationGroup?.memberGroupId !== memberGroupId) {
      throw new Error("Expected the active target-group owner to be identified for application entry.");
    }
    if (await membershipRepository.getActiveMemberGroupForUser(discordGuildId, memberGroupId, otherDiscordUserId)) {
      throw new Error("Expected an orphaned target-group profile not to identify another user as registered.");
    }
    if (await membershipRepository.getActiveMemberGroupForUser(otherDiscordGuildId, memberGroupId, discordUserId)) {
      throw new Error("Expected application-entry membership lookup to remain tenant scoped.");
    }
    const operationalApplicationClass = await applicationRepository.createApplicationClass({
      discordGuildId,
      name: `Operational Application ${runId}`,
      outcomeType: "member_group",
      memberGroupId,
      albionServer,
      ticketCategoryId: `operational-application-category-${runId}`,
      reviewerRoleId: `operational-application-reviewer-${runId}`,
      createdByDiscordUserId: discordUserId
    });
    const operationalApplication = await applicationRepository.createOpenApplication({
      applicationClassId: operationalApplicationClass.applicationClassId,
      discordGuildId,
      applicantDiscordUserId: discordUserId,
      ticketChannelId: `operational-application-channel-${runId}`,
      submittedCharacterName: `Operational Applicant ${runId}`,
      modalAnswers: [],
      albionServer
    });
    const operationalApplicationTarget = (await applicationRepository.listOperationalApplicationTargets(discordGuildId)).find(
      (target) => target.applicationId === operationalApplication.applicationId
    );
    if (
      !operationalApplicationTarget
      || operationalApplicationTarget.targetMemberGroupName !== "Smoke Group"
    ) {
      throw new Error("Expected operational application targets to return the mapped member-group name.");
    }
    const selfServiceProfile = await client.query<{ member_group_profile_id: string }>(
      `
      select member_group_profile_id
      from member_group_profiles
      where discord_guild_id = $1
        and member_group_id = $2
        and discord_user_id = $3
        and albion_character_id = $4
      `,
      [discordGuildId, memberGroupId, discordUserId, albionCharacterId]
    );
    const selfServicePosition = await client.query<{ member_group_position_id: string }>(
      `
      insert into member_group_positions (
        discord_guild_id,
        member_group_id,
        name,
        discord_role_id
      )
      values ($1, $2, 'Smoke Leader', 'smoke-position-role')
      returning member_group_position_id
      `,
      [discordGuildId, memberGroupId]
    );
    await client.query(
      `
      insert into member_group_position_appointments (
        member_group_position_id,
        member_group_profile_id,
        discord_guild_id
      )
      values ($1, $2, $3)
      `,
      [
        selfServicePosition.rows[0].member_group_position_id,
        selfServiceProfile.rows[0].member_group_profile_id,
        discordGuildId
      ]
    );
    const initialAccounts = await accountRepository.listAccounts(discordGuildId);
    if (!initialAccounts.some((account) => account.albionCharacterId === albionCharacterId && account.status === "open")) {
      throw new Error("Expected a registered member-group profile to create an open character account.");
    }
    if (!initialAccounts.some((account) => account.albionCharacterId === orphanCharacterId && account.status === "open" && !account.discordUserId)) {
      throw new Error("Expected a retained manual member-group profile to preserve an open character account.");
    }
    const accountRef = { discordGuildId, albionServer, albionCharacterId } as const;
    const creditedAccount = await accountRepository.adjust(accountRef, "credit", 100n, discordUserId, "Smoke credit");
    if (creditedAccount.balance !== 100n) throw new Error("Expected account credit to update the balance.");
    await accountRepository.setFrozen(accountRef, true, discordUserId, "Smoke freeze");
    try {
      await accountRepository.adjust(accountRef, "debit", -1n, discordUserId, "Blocked smoke debit");
      throw new Error("Expected a frozen account to reject balance changes.");
    } catch (error) {
      if (!(error instanceof AccountOperationError) || error.code !== "frozen") throw error;
    }
    await accountRepository.setFrozen(accountRef, false, discordUserId, "Smoke unfreeze");
    const regearReviewerRoleId = `smoke-regear-reviewer-${runId}`;
    await client.query(
      `insert into reviewer_role_bindings (
        discord_guild_id, domain, discord_role_id, created_by_discord_user_id
      ) values ($1, 'regears', $2, $3)`,
      [discordGuildId, regearReviewerRoleId, discordUserId]
    );
    const regearContent = await regearRepository.createContent({
      discordGuildId,
      albionServer,
      name: "Smoke Re-Gear",
      contentDate: "2026-08-12",
      contentAt: new Date("2026-08-12T12:00:00.000Z"),
      channelId: "smoke-regear-channel",
      actorDiscordUserId: discordUserId,
      actorDiscordRoleIds: [regearReviewerRoleId]
    });
    const regearClaim = await regearRepository.createPendingClaim({
      regearClaimId: randomUUID(),
      discordGuildId,
      regearContentId: regearContent.regearContentId,
      albionServer,
      albionCharacterId,
      expectedOwnerDiscordUserId: discordUserId,
      requestedValue: 1_250_000n,
      reviewChannelId: "smoke-regear-channel",
      reviewMessageId: "smoke-regear-review"
    });
    await accountRepository.setFrozen(accountRef, true, discordUserId, "Re-gear freeze smoke");
    try {
      await regearRepository.acceptPendingClaim(
        discordGuildId,
        regearClaim.regearClaimId,
        discordUserId,
        [regearReviewerRoleId]
      );
      throw new Error("Expected a frozen character account to block re-gear acceptance.");
    } catch (error) {
      if (!(error instanceof RegearOperationError) || error.code !== "account_frozen") throw error;
    }
    if ((await regearRepository.getClaim(discordGuildId, regearClaim.regearClaimId))?.status !== "pending") {
      throw new Error("Expected blocked re-gear acceptance to preserve the Pending claim.");
    }
    await accountRepository.setFrozen(accountRef, false, discordUserId, "Re-gear unfreeze smoke");
    const accepted = await regearRepository.acceptPendingClaim(
      discordGuildId,
      regearClaim.regearClaimId,
      discordUserId,
      [regearReviewerRoleId],
      1_100_000n,
      "Smoke adjustment"
    );
    if (accepted.claim.status !== "accepted" || accepted.claim.acceptedValue !== 1_100_000n) {
      throw new Error("Expected re-gear acceptance to retain the adjusted Accepted value.");
    }
    const duplicateAcceptance = await regearRepository.acceptPendingClaim(
      discordGuildId,
      regearClaim.regearClaimId,
      discordUserId,
      [regearReviewerRoleId]
    );
    if (!duplicateAcceptance.alreadyAccepted) {
      throw new Error("Expected duplicate re-gear acceptance to be idempotent.");
    }
    const regearCredits = await client.query<{ count: string; amount: string }>(
      `select count(*)::text as count, max(amount)::text as amount
       from account_transactions where regear_claim_id = $1`,
      [regearClaim.regearClaimId]
    );
    if (regearCredits.rows[0]?.count !== "1" || regearCredits.rows[0]?.amount !== "1100000") {
      throw new Error("Expected exactly one account credit linked to the Accepted re-gear claim.");
    }
    await client.query("savepoint invalid_regear_account_link");
    let invalidAccountLinkRejected = false;
    try {
      await client.query(
        `update account_transactions set account_id = (
           select account_id from character_accounts
           where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3
         ) where regear_claim_id = $4`,
        [discordGuildId, albionServer, orphanCharacterId, regearClaim.regearClaimId]
      );
      await client.query("set constraints all immediate");
    } catch {
      invalidAccountLinkRejected = true;
      await client.query("rollback to savepoint invalid_regear_account_link");
    }
    if (!invalidAccountLinkRejected) {
      throw new Error("Expected a re-gear credit linked to the wrong character account to violate the deferred invariant.");
    }
    await client.query("set constraints all deferred");
    const withdrawClaim = await regearRepository.createPendingClaim({
      regearClaimId: randomUUID(),
      discordGuildId,
      regearContentId: regearContent.regearContentId,
      albionServer,
      albionCharacterId,
      expectedOwnerDiscordUserId: discordUserId,
      requestedValue: 200_000n,
      reviewChannelId: "smoke-regear-channel",
      reviewMessageId: "smoke-regear-withdraw-review"
    });
    await regearRepository.withdrawPendingClaim(discordGuildId, withdrawClaim.regearClaimId, discordUserId);
    if (await regearRepository.getClaim(discordGuildId, withdrawClaim.regearClaimId)) {
      throw new Error("Expected withdrawal to delete the Pending re-gear claim.");
    }
    const rejectClaim = await regearRepository.createPendingClaim({
      regearClaimId: randomUUID(),
      discordGuildId,
      regearContentId: regearContent.regearContentId,
      albionServer,
      albionCharacterId,
      expectedOwnerDiscordUserId: discordUserId,
      requestedValue: 300_000n,
      reviewChannelId: "smoke-regear-channel",
      reviewMessageId: "smoke-regear-reject-review"
    });
    await regearRepository.rejectPendingClaim(discordGuildId, rejectClaim.regearClaimId, discordUserId, [regearReviewerRoleId]);
    if (await regearRepository.getClaim(discordGuildId, rejectClaim.regearClaimId)) {
      throw new Error("Expected rejection to delete the Pending re-gear claim.");
    }
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");
    for (let index = 1; index < 25; index += 1) {
      await regearRepository.createContent({
        discordGuildId,
        albionServer,
        name: `Smoke Re-Gear ${index + 1}`,
        contentDate: "2026-08-12",
        channelId: "smoke-regear-channel",
        actorDiscordUserId: discordUserId,
        actorDiscordRoleIds: [regearReviewerRoleId]
      });
    }
    try {
      await regearRepository.createContent({
        discordGuildId,
        albionServer,
        name: "Smoke Re-Gear 26",
        contentDate: "2026-08-12",
        channelId: "smoke-regear-channel",
        actorDiscordUserId: discordUserId,
        actorDiscordRoleIds: [regearReviewerRoleId]
      });
      throw new Error("Expected the twenty-sixth Open re-gear content record to be rejected.");
    } catch (error) {
      if (!(error instanceof RegearOperationError) || error.code !== "content_limit") throw error;
    }
    const registrationLimitUserId = `smoke-registration-limit-user-${runId}`;
    for (let index = 1; index <= 25; index += 1) {
      await membershipRepository.registerCharacter({
        discordGuildId,
        discordUserId: registrationLimitUserId,
        albionServer,
        player: { id: `smoke-registration-limit-character-${runId}-${index}`, name: `Smoke Limit ${index}` }
      });
    }
    try {
      await membershipRepository.registerCharacter({
        discordGuildId,
        discordUserId: registrationLimitUserId,
        albionServer,
        player: { id: `smoke-registration-limit-character-${runId}-26`, name: "Smoke Limit 26" }
      });
      throw new Error("Expected the twenty-sixth character registration to be rejected.");
    } catch (error) {
      if (!(error instanceof CharacterRegistrationLimitError)) throw error;
    }
    const registeredAtLimit = await membershipRepository.listRegisteredCharacters(discordGuildId, registrationLimitUserId);
    if (registeredAtLimit.length !== 25) {
      throw new Error("Expected the character-registration capacity failure to preserve the existing 25 registrations.");
    }
    await client.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
       values ($1, 'active', 'Smoke Membership Guild', now()) on conflict (discord_guild_id) do nothing`,
      [discordGuildId]
    );
    const reactionConfig = await client.query<{ reaction_role_config_id: string }>(
      `insert into reaction_role_configs (discord_guild_id, discord_role_id, created_by_discord_user_id)
       values ($1, 'smoke-subscribed-role', $2) returning reaction_role_config_id`,
      [discordGuildId, discordUserId]
    );
    if (!await reactionRoleRepository.isManagedUser(discordGuildId, discordUserId)) {
      throw new Error("Expected an active member-group profile owner to be a managed user.");
    }
    const unsubscribedQualifiedRoles = await membershipRepository.listQualifiedRoleIdsForUser(discordGuildId, discordUserId);
    if (unsubscribedQualifiedRoles.includes("smoke-subscribed-role")) {
      throw new Error("Expected a managed user to require an explicit reaction-role subscription.");
    }
    if (!await reactionRoleRepository.subscribe(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id,
      discordUserId
    )) {
      throw new Error("Expected the first reaction-role subscription to be created.");
    }
    if (await reactionRoleRepository.subscribe(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id,
      discordUserId
    )) {
      throw new Error("Expected duplicate reaction-role subscription to be idempotent.");
    }
    const subscribedQualifiedRoles = await membershipRepository.listQualifiedRoleIdsForUser(discordGuildId, discordUserId);
    if (!subscribedQualifiedRoles.includes("smoke-subscribed-role")) {
      throw new Error("Expected a subscription plus managed-user status to qualify the reaction role.");
    }
    const [
      selfServiceCharacters,
      selfServiceMemberships,
      selfServicePositions,
      selfServiceReactionRoles,
      selfServiceAccounts
    ] = await Promise.all([
      membershipRepository.listSelfServiceCharacters(discordGuildId, discordUserId),
      membershipRepository.listSelfServiceMemberships(discordGuildId, discordUserId),
      membershipRepository.listSelfServicePositions(discordGuildId, discordUserId),
      membershipRepository.listSelfServiceReactionRoles(discordGuildId, discordUserId),
      accountRepository.listAccountsForUser(discordGuildId, discordUserId)
    ]);
    if (
      selfServiceCharacters.length !== 1
      || selfServiceCharacters[0].characterName !== "Smoke Character"
      || selfServiceCharacters[0].discordRoleIds.join(",") !== "smoke-role"
    ) {
      throw new Error("Expected self-service characters to include only the caller and applicable configured roles.");
    }
    if (
      selfServiceMemberships.length !== 1
      || selfServiceMemberships[0].groupType !== "group"
      || !selfServiceMemberships[0].discordRoleIds.includes("smoke-group-role")
      || !selfServiceMemberships[0].discordRoleIds.includes("smoke-reaction-role")
    ) {
      throw new Error("Expected self-service memberships to include active owned profiles and exact group-role sources.");
    }
    if (
      selfServicePositions.length !== 1
      || selfServicePositions[0].positionName !== "Smoke Leader"
      || selfServicePositions[0].discordRoleId !== "smoke-position-role"
    ) {
      throw new Error("Expected self-service positions to include the caller's active profile appointment.");
    }
    if (
      selfServiceReactionRoles.length !== 1
      || selfServiceReactionRoles[0].discordRoleId !== "smoke-subscribed-role"
      || selfServiceReactionRoles[0].dormant
    ) {
      throw new Error("Expected self-service reaction roles to identify an active managed-user subscription.");
    }
    if (
      selfServiceAccounts.length !== 1
      || selfServiceAccounts[0].albionCharacterId !== albionCharacterId
      || selfServiceAccounts[0].discordUserId !== discordUserId
    ) {
      throw new Error("Expected self-service accounts to include only the caller's current registered account.");
    }
    if (!await reactionRoleRepository.unsubscribe(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id,
      discordUserId
    )) {
      throw new Error("Expected the first reaction-role unsubscribe to remove the subscription.");
    }
    if (await reactionRoleRepository.unsubscribe(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id,
      discordUserId
    )) {
      throw new Error("Expected duplicate reaction-role unsubscribe to be idempotent.");
    }
    await reactionRoleRepository.subscribe(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id,
      discordUserId
    );

    await reactionRoleRepository.addPlacement({
      reactionRoleConfigId: reactionConfig.rows[0].reaction_role_config_id,
      discordGuildId,
      channelId: "smoke-reaction-channel",
      messageId: "smoke-reaction-message",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: discordUserId
    });
    await assertPlacementConflict(
      reactionRoleRepository.addPlacement({
        reactionRoleConfigId: reactionConfig.rows[0].reaction_role_config_id,
        discordGuildId,
        channelId: "smoke-reaction-channel",
        messageId: "smoke-other-reaction-message",
        emojiKey: "unicode:🟢",
        emojiDisplayValue: "🟢",
        createdByDiscordUserId: discordUserId
      }),
      "role_has_placement"
    );
    const secondReactionConfig = await reactionRoleRepository.addConfig(
      discordGuildId,
      "smoke-second-reaction-role",
      discordUserId
    );
    await assertPlacementConflict(
      reactionRoleRepository.addPlacement({
        reactionRoleConfigId: secondReactionConfig.reactionRoleConfigId,
        discordGuildId,
        channelId: "smoke-reaction-channel",
        messageId: "smoke-reaction-message",
        emojiKey: "unicode:✅",
        emojiDisplayValue: "✅",
        createdByDiscordUserId: discordUserId
      }),
      "message_emoji_in_use"
    );
    await client.query(
      `
      insert into discord_guild_lifecycle (
        discord_guild_id,
        status,
        guild_name,
        activated_at
      )
      values ($1, 'active', 'Other Smoke Guild', now())
      on conflict (discord_guild_id) do nothing
      `,
      [otherDiscordGuildId]
    );
    const otherReactionConfig = await reactionRoleRepository.addConfig(
      otherDiscordGuildId,
      "smoke-other-guild-reaction-role",
      otherDiscordUserId
    );
    await reactionRoleRepository.addPlacement({
      reactionRoleConfigId: otherReactionConfig.reactionRoleConfigId,
      discordGuildId: otherDiscordGuildId,
      channelId: "smoke-reaction-channel",
      messageId: "smoke-reaction-message",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: otherDiscordUserId
    });
    if (await reactionRoleRepository.removePlacementsForMessage(
      discordGuildId,
      "smoke-reaction-message"
    ) !== 1) {
      throw new Error("Expected deleted-message cleanup to remove the guild's placement.");
    }
    if (!await reactionRoleRepository.getPlacementForConfig(
      otherDiscordGuildId,
      otherReactionConfig.reactionRoleConfigId
    )) {
      throw new Error("Expected deleted-message cleanup to preserve another guild's placement.");
    }
    await reactionRoleRepository.addPlacement({
      reactionRoleConfigId: reactionConfig.rows[0].reaction_role_config_id,
      discordGuildId,
      channelId: "smoke-replacement-reaction-channel",
      messageId: "smoke-replacement-reaction-message",
      emojiKey: "unicode:✅",
      emojiDisplayValue: "✅",
      createdByDiscordUserId: discordUserId
    });
    const secondMembershipGroup = await client.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'group', 'Smoke Second Membership')
      returning member_group_id
      `,
      [discordGuildId, albionServer]
    );
    await client.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4, $5)
      `,
      [
        secondMembershipGroup.rows[0].member_group_id,
        discordGuildId,
        discordUserId,
        albionServer,
        albionCharacterId
      ]
    );
    await client.query(
      `update member_group_profiles set discord_user_id = null where member_group_id = $1 and albion_character_id = $2`,
      [memberGroupId, albionCharacterId]
    );
    const oneMembershipRoles = await membershipRepository.listQualifiedRoleIdsForUser(
      discordGuildId,
      discordUserId
    );
    if (!oneMembershipRoles.includes("smoke-subscribed-role")) {
      throw new Error("Expected any remaining active membership to keep a subscribed reaction role active.");
    }
    await client.query(
      `update member_group_profiles set discord_user_id = null where member_group_id = $1 and albion_character_id = $2`,
      [secondMembershipGroup.rows[0].member_group_id, albionCharacterId]
    );
    if (await reactionRoleRepository.isManagedUser(discordGuildId, discordUserId)) {
      throw new Error("Expected loss of final active membership to make the subscriber unmanaged.");
    }
    const dormantRoles = await membershipRepository.listQualifiedRoleIdsForUser(
      discordGuildId,
      discordUserId
    );
    if (dormantRoles.includes("smoke-subscribed-role")) {
      throw new Error("Expected a dormant subscription not to qualify its Discord role.");
    }
    const dormantSubscriptions = await membershipRepository.listDormantReactionRoleSubscriptions(
      discordGuildId,
      discordUserId
    );
    if (
      dormantSubscriptions.length !== 1
      || dormantSubscriptions[0].reactionRoleConfigId !== reactionConfig.rows[0].reaction_role_config_id
      || dormantSubscriptions[0].messageId !== "smoke-replacement-reaction-message"
    ) {
      throw new Error("Expected final membership loss to preserve a dormant subscription and its placement.");
    }
    const dormantSelfServiceRoles = await membershipRepository.listSelfServiceReactionRoles(
      discordGuildId,
      discordUserId
    );
    if (dormantSelfServiceRoles.length !== 1 || !dormantSelfServiceRoles[0].dormant) {
      throw new Error("Expected self-service reaction roles to identify the preserved dormant subscription.");
    }
    if (await reactionRoleRepository.countSubscriptions(
      discordGuildId,
      reactionConfig.rows[0].reaction_role_config_id
    ) !== 1) {
      throw new Error("Expected final membership loss to preserve the positive subscription.");
    }
    await client.query(
      `update member_group_profiles set discord_user_id = $1 where member_group_id = $2 and albion_character_id = $3`,
      [discordUserId, memberGroupId, albionCharacterId]
    );
    const restoredRoles = await membershipRepository.listQualifiedRoleIdsForUser(
      discordGuildId,
      discordUserId
    );
    if (!restoredRoles.includes("smoke-subscribed-role")) {
      throw new Error("Expected restored active membership to reactivate the subscribed role.");
    }
    if ((await membershipRepository.listDormantReactionRoleSubscriptions(
      discordGuildId,
      discordUserId
    )).length !== 0) {
      throw new Error("Expected restored membership to end the subscription's dormant state.");
    }
    await client.query(
      "delete from member_groups where member_group_id = $1",
      [secondMembershipGroup.rows[0].member_group_id]
    );
    const reportProfiles = await membershipRepository.listProfilesForGroupReport(discordGuildId, memberGroupId);
    if (reportProfiles.length !== 2) {
      throw new Error("Expected member group report to include active and orphaned profiles.");
    }
    if (reportProfiles[0].characterName !== "Smoke Character" || reportProfiles[0].discordUserId !== discordUserId) {
      throw new Error("Expected member group report to include the active owned profile first.");
    }
    if (reportProfiles[1].characterName !== "Smoke Orphan" || reportProfiles[1].discordUserId !== undefined) {
      throw new Error("Expected member group report to include orphaned profiles.");
    }

    await client.query(
      `
      insert into albion_characters (albion_server, albion_character_id, character_name)
      values ($1, $2, $3), ($1, $4, $5)
      `,
      [albionServer, switchCharacterId, "Smoke Switched", conflictCharacterId, "Smoke Conflict"]
    );
    await client.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, null, $3, $4)
      `,
      [memberGroupId, discordGuildId, albionServer, switchCharacterId]
    );

    const switchResult = await membershipRepository.switchRegisteredCharacter({
      discordGuildId,
      discordUserId,
      fromAlbionServer: albionServer,
      fromAlbionCharacterId: albionCharacterId,
      toAlbionServer: albionServer,
      player: {
        id: switchCharacterId,
        name: "Smoke Switched"
      }
    });
    if (!switchResult.from || !switchResult.to || switchResult.to.albionCharacterId !== switchCharacterId) {
      throw new Error("Expected switch to return old and new registered characters.");
    }
    if (switchResult.switchedProfiles !== 1 || switchResult.mergedOrphanProfiles !== 1) {
      throw new Error("Expected switch to move one active profile and merge one duplicate orphan profile.");
    }

    const switchedRows = await client.query<{ row_count: string }>(
      `
      select count(*)::text as row_count
      from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
        and albion_server = $3
        and albion_character_id = $4
      `,
      [discordGuildId, discordUserId, albionServer, switchCharacterId]
    );
    if (switchedRows.rows[0]?.row_count !== "1") {
      throw new Error("Expected switch to update the registered character row.");
    }

    const switchedProfiles = await client.query<{ discord_user_id: string | null; profile_count: string }>(
      `
      select max(discord_user_id) as discord_user_id, count(*)::text as profile_count
      from member_group_profiles
      where member_group_id = $1
        and albion_server = $2
        and albion_character_id = $3
      `,
      [memberGroupId, albionServer, switchCharacterId]
    );
    if (switchedProfiles.rows[0]?.discord_user_id !== discordUserId || switchedProfiles.rows[0]?.profile_count !== "1") {
      throw new Error("Expected switch to preserve active profile ownership and remove duplicate orphan profile.");
    }

    const switchedMain = await client.query<{ albion_character_id: string }>(
      `
      select albion_character_id
      from discord_user_main_characters
      where discord_guild_id = $1
        and discord_user_id = $2
      `,
      [discordGuildId, discordUserId]
    );
    if (switchedMain.rows[0]?.albion_character_id !== switchCharacterId) {
      throw new Error("Expected switch to cascade the main character selection.");
    }

    await client.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4)
      `,
      [discordGuildId, otherDiscordUserId, albionServer, conflictCharacterId]
    );
    const conflictSwitch = await membershipRepository.switchRegisteredCharacter({
      discordGuildId,
      discordUserId,
      fromAlbionServer: albionServer,
      fromAlbionCharacterId: switchCharacterId,
      toAlbionServer: albionServer,
      player: {
        id: conflictCharacterId,
        name: "Smoke Conflict"
      }
    });
    if (!conflictSwitch.existing || conflictSwitch.existing.discordUserId !== otherDiscordUserId) {
      throw new Error("Expected switch to refuse a replacement already registered in the Discord guild.");
    }

    const immediatePlayer: AlbionPlayer = {
      id: immediateCharacterId,
      name: "Smoke Immediate",
      guildId: immediateGuildId,
      guildName: "Smoke Immediate Guild",
      allianceId: immediateAllianceId,
      allianceName: "Smoke Immediate Alliance",
      allianceTag: "SMK"
    };
    await client.query(
      `
      insert into albion_characters (
        albion_server,
        albion_character_id,
        character_name,
        guild_id,
        guild_name,
        alliance_id,
        alliance_name,
        alliance_tag
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        albionServer,
        immediateCharacterId,
        immediatePlayer.name,
        immediatePlayer.guildId,
        immediatePlayer.guildName,
        immediatePlayer.allianceId,
        immediatePlayer.allianceName,
        immediatePlayer.allianceTag
      ]
    );
    await client.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4)
      `,
      [discordGuildId, immediateDiscordUserId, albionServer, immediateCharacterId]
    );
    const autoGroupResult = await client.query<{ member_group_id: string; group_type: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values
        ($1, $2, 'guild', $3),
        ($1, $2, 'alliance', $4)
      returning member_group_id, group_type
      `,
      [discordGuildId, albionServer, immediatePlayer.guildName, immediatePlayer.allianceName]
    );
    const immediateGuildGroupId = autoGroupResult.rows.find((row) => row.group_type === "guild")?.member_group_id;
    const immediateAllianceGroupId = autoGroupResult.rows.find((row) => row.group_type === "alliance")?.member_group_id;
    if (!immediateGuildGroupId || !immediateAllianceGroupId) {
      throw new Error("Expected immediate reconciliation groups to be created.");
    }
    await client.query(
      `
      insert into configured_albion_guilds (
        member_group_id,
        discord_guild_id,
        albion_server,
        albion_guild_id,
        albion_guild_name,
        managed
      )
      values ($1, $2, $3, $4, $5, true)
      `,
      [immediateGuildGroupId, discordGuildId, albionServer, immediateGuildId, immediatePlayer.guildName]
    );
    await client.query(
      `
      insert into configured_albion_alliances (
        member_group_id,
        discord_guild_id,
        albion_server,
        albion_alliance_id,
        albion_alliance_name,
        albion_alliance_tag
      )
      values ($1, $2, $3, $4, $5, $6)
      `,
      [
        immediateAllianceGroupId,
        discordGuildId,
        albionServer,
        immediateAllianceId,
        immediatePlayer.allianceName,
        immediatePlayer.allianceTag
      ]
    );
    await client.query(
      `
      insert into character_role_configs (discord_guild_id, albion_server, discord_role_id)
      values ($1, null, $2), ($1, $3, $4), ($1, 'europe', $5)
      `,
      [
        discordGuildId,
        "smoke-immediate-character-role",
        albionServer,
        "smoke-immediate-server-role",
        "smoke-stale-reaction-role"
      ]
    );
    await client.query(
      `
      insert into member_group_role_configs (member_group_id, discord_role_id)
      values
        ($1, $3),
        ($1, $4),
        ($2, $5)
      `,
      [
        immediateGuildGroupId,
        immediateAllianceGroupId,
        "smoke-immediate-guild-role",
        "smoke-immediate-reaction-role",
        "smoke-immediate-alliance-role"
      ]
    );

    const addedRoleIds: string[] = [];
    const removedRoleIds: string[] = [];
    const immediateGuild = createSmokeGuild(discordGuildId, immediateDiscordUserId, {
      initialRoleIds: ["smoke-stale-reaction-role"],
      onAdd: (roleIds) => addedRoleIds.push(...roleIds),
      onRemove: (roleIds) => removedRoleIds.push(...roleIds)
    });
    const immediateWarnings = await reconcileRegisteredCharacterMembership(
      immediateGuild,
      {} as AlbionClient,
      membershipRepository,
      immediateDiscordUserId,
      immediatePlayer,
      albionServer
    );
    if (immediateWarnings.length > 0) {
      throw new Error(`Expected immediate reconciliation to complete without warnings: ${immediateWarnings[0].message}`);
    }
    const immediateProfiles = await client.query<{ group_type: string; discord_user_id: string | null }>(
      `
      select mg.group_type, mgp.discord_user_id
      from member_group_profiles mgp
      join member_groups mg on mg.member_group_id = mgp.member_group_id
      where mgp.discord_guild_id = $1
        and mgp.albion_server = $2
        and mgp.albion_character_id = $3
      order by mg.group_type asc
      `,
      [discordGuildId, albionServer, immediateCharacterId]
    );
    const immediateProfileTypes = immediateProfiles.rows.map((row) => row.group_type);
    if (!immediateProfileTypes.includes("guild") || !immediateProfileTypes.includes("alliance")) {
      throw new Error("Expected immediate reconciliation to apply qualifying guild and alliance profiles.");
    }
    if (immediateProfiles.rows.some((row) => row.discord_user_id !== immediateDiscordUserId)) {
      throw new Error("Expected immediate reconciliation profiles to be active for the registered user.");
    }
    const expectedAddedRoleIds = [
      "smoke-immediate-alliance-role",
      "smoke-immediate-character-role",
      "smoke-immediate-guild-role",
      "smoke-immediate-reaction-role",
      "smoke-immediate-server-role"
    ];
    for (const roleId of expectedAddedRoleIds) {
      if (!addedRoleIds.includes(roleId)) {
        throw new Error(`Expected immediate reconciliation to add role ${roleId}.`);
      }
    }
    if (!removedRoleIds.includes("smoke-stale-reaction-role")) {
      throw new Error("Expected immediate reconciliation to remove stale reaction role configs.");
    }
    const warningGuild = createSmokeGuild(discordGuildId, immediateDiscordUserId, {
      failRoleUpdate: true
    });
    const warningResult = await reconcileRegisteredCharacterMembership(
      warningGuild,
      {} as AlbionClient,
      membershipRepository,
      immediateDiscordUserId,
      immediatePlayer,
      albionServer
    );
    if (!warningResult.some((warning) => warning.message.includes("Role update failed"))) {
      throw new Error("Expected immediate registration reconciliation warnings to surface Discord role failures.");
    }

    const fullGuildManagedRoleId = `smoke-full-managed-role-${runId}`;
    const fullGuildUnmanagedRoleId = `smoke-full-unmanaged-role-${runId}`;
    const fullGuildUnmanagedUserId = `smoke-full-unmanaged-user-${runId}`;
    await client.query(
      `
      insert into character_role_configs (discord_guild_id, albion_server, discord_role_id)
      values ($1, null, $2)
      `,
      [discordGuildId, fullGuildManagedRoleId]
    );

    const auditRemovedRoleIds: string[] = [];
    const auditGuild = createSmokeGuild(discordGuildId, immediateDiscordUserId, {
      members: {
        [immediateDiscordUserId]: [],
        [fullGuildUnmanagedUserId]: [fullGuildManagedRoleId, fullGuildUnmanagedRoleId]
      },
      onRemove: (roleIds) => auditRemovedRoleIds.push(...roleIds)
    });
    const auditResult = await auditMembershipForGuild(auditGuild, {} as AlbionClient, membershipRepository);
    const auditResponse = formatAuditUpdateResponse("audit", auditResult, "Smoke Server", new Date());
    if (!(auditResponse.files[0].attachment as Buffer).toString("utf8").includes(`<@&${fullGuildManagedRoleId}> will be removed from <@${fullGuildUnmanagedUserId}>.`)) {
      throw new Error("Expected full-guild audit to report managed-role cleanup for unmanaged Discord users.");
    }
    if (auditRemovedRoleIds.length > 0) {
      throw new Error("Expected full-guild audit not to remove Discord roles.");
    }

    const updateRemovedRoleIds: string[] = [];
    const updateGuild = createSmokeGuild(discordGuildId, immediateDiscordUserId, {
      members: {
        [immediateDiscordUserId]: [],
        [fullGuildUnmanagedUserId]: [fullGuildManagedRoleId, fullGuildUnmanagedRoleId]
      },
      onRemove: (roleIds) => updateRemovedRoleIds.push(...roleIds)
    });
    const updateResult = await reconcileMembershipForGuild(updateGuild, {} as AlbionClient, membershipRepository);
    const updateResponse = formatAuditUpdateResponse("update", updateResult, "Smoke Server", new Date());
    if (!(updateResponse.files[0].attachment as Buffer).toString("utf8").includes(`<@&${fullGuildManagedRoleId}> removed from <@${fullGuildUnmanagedUserId}>.`)) {
      throw new Error("Expected full-guild update to report managed-role cleanup for unmanaged Discord users.");
    }
    if (!updateRemovedRoleIds.includes(fullGuildManagedRoleId)) {
      throw new Error("Expected full-guild update to remove managed roles from unmanaged Discord users.");
    }
    if (updateRemovedRoleIds.includes(fullGuildUnmanagedRoleId)) {
      throw new Error("Expected full-guild update to preserve unmanaged Discord roles.");
    }

    await client.query(
      `
      delete from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
        and albion_server = $3
        and albion_character_id = $4
      `,
      [discordGuildId, discordUserId, albionServer, switchCharacterId]
    );

    const orphanedProfile = await client.query<{ discord_user_id: string | null }>(
      `
      select discord_user_id
      from member_group_profiles
      where member_group_id = $1
        and albion_server = $2
        and albion_character_id = $3
      `,
      [memberGroupId, albionServer, switchCharacterId]
    );
    if (orphanedProfile.rows[0]?.discord_user_id !== null) {
      throw new Error("Expected unregister delete to orphan the scoped member group profile.");
    }

    await client.query(`insert into albion_characters (albion_server, albion_character_id, character_name) values ($1, $2, 'Smoke Closure Account')`, [albionServer, closureAccountCharacterId]);
    await client.query(
      `insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, $2, null, $3, $4)`,
      [memberGroupId, discordGuildId, albionServer, closureAccountCharacterId]
    );
    const closureAccountRef = { discordGuildId, albionServer, albionCharacterId: closureAccountCharacterId } as const;
    await accountRepository.adjust(closureAccountRef, "credit", 75n, discordUserId, "Closure smoke credit");
    await client.query(
      `delete from member_group_profiles where discord_guild_id = $1 and albion_server = $2 and albion_character_id = $3`,
      [discordGuildId, albionServer, closureAccountCharacterId]
    );
    const lifecycleClosedAccount = await accountRepository.getAccount(closureAccountRef);
    if (!lifecycleClosedAccount || lifecycleClosedAccount.status !== "closed" || lifecycleClosedAccount.balance !== 0n) {
      throw new Error("Expected loss of the last profile to zero and close the character account.");
    }
    const closureTransactions = await accountRepository.listTransactions(lifecycleClosedAccount.accountId);
    if (!closureTransactions.some((transaction) => transaction.transactionType === "closure_adjustment" && transaction.amount === -75n && !transaction.actorDiscordUserId)) {
      throw new Error("Expected profile loss to record a system-authored closure adjustment.");
    }
    await client.query(
      `insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, $2, null, $3, $4)`,
      [memberGroupId, discordGuildId, albionServer, closureAccountCharacterId]
    );
    const reopenedAccount = await accountRepository.getAccount(closureAccountRef);
    if (!reopenedAccount || reopenedAccount.status !== "open" || reopenedAccount.balance !== 0n || reopenedAccount.accountId !== lifecycleClosedAccount.accountId) {
      throw new Error("Expected the same returning character identity to reopen its preserved account at zero.");
    }
    await client.query(
      `insert into albion_characters (albion_server, albion_character_id, character_name) values ($1, $2, 'Smoke Transfer Counterparty')`,
      [albionServer, transferCounterpartyCharacterId]
    );
    await client.query(
      `insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, $2, null, $3, $4)`,
      [memberGroupId, discordGuildId, albionServer, transferCounterpartyCharacterId]
    );
    const transferCounterpartyRef = { discordGuildId, albionServer, albionCharacterId: transferCounterpartyCharacterId } as const;
    await accountRepository.adjust(closureAccountRef, "credit", 100n, discordUserId, "Transfer smoke credit");
    await accountRepository.transfer(closureAccountRef, transferCounterpartyRef, 25n, discordUserId, "Transfer smoke");
    const transferSourceTransactions = await accountRepository.listTransactions(reopenedAccount.accountId);
    const transferCounterpartyAccount = await accountRepository.getAccount(transferCounterpartyRef);
    const transferCounterpartyTransactions = transferCounterpartyAccount
      ? await accountRepository.listTransactions(transferCounterpartyAccount.accountId)
      : [];
    if (!transferSourceTransactions.some((transaction) => transaction.transactionType === "transfer_debit" && transaction.counterpartyCharacterName === "Smoke Transfer Counterparty")) {
      throw new Error("Expected transfer debit history to identify the destination character.");
    }
    if (!transferCounterpartyTransactions.some((transaction) => transaction.transactionType === "transfer_credit" && transaction.counterpartyCharacterName === "Smoke Closure Account")) {
      throw new Error("Expected transfer credit history to identify the source character.");
    }

    const statusSnapshot = await createStatusRepository(createQueuedTransactionPool(client)).getSnapshot(discordGuildId);
    if (
      statusSnapshot.discordGuildId !== discordGuildId
      || statusSnapshot.memberGroups.length === 0
    ) {
      throw new Error("Expected the status repository to read the invoking Discord server's aggregate snapshot.");
    }

    await client.query("rollback");
    await runTasksRepositorySmoke(postgres);
    await runGiveawayRepositorySmoke(postgres);
    await runDiscordDepartureMembershipSmoke(postgres);
    await runApplicationChannelLifecycleSmoke(postgres);
    await runApplicationAcceptanceOwnershipConcurrencySmoke(postgres);
    await runGeneralTicketSmoke(postgres);
    await runConversationClassRemovalSmoke(postgres);
    await runSpecialisationRepositorySmoke(postgres);
    await runGuildLifecyclePurgeSmoke(postgres);
    await runGuildResetSmoke(postgres);
    await runRegearConcurrencySmoke(postgres);
    console.log("Database schema smoke passed.");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await postgres.end();
}

async function runSpecialisationRepositorySmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-specialisation-${suffix}`;
  const discordUserId = `smoke-specialisation-user-${suffix}`;
  const reviewerId = `smoke-specialisation-reviewer-${suffix}`;
  const albionServer = "europe" as const;
  const albionCharacterId = `smoke-specialisation-character-${suffix}`;
  const repository = createSpecialisationRepository(postgres);
  const reviewerRepository = createReviewerRepository(postgres);
  let memberGroupId: string | undefined;

  try {
    await postgres.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
       values ($1, 'active', 'Specialisation Smoke Guild', now())`,
      [discordGuildId]
    );
    await postgres.query(
      `insert into albion_characters (albion_server, albion_character_id, character_name)
       values ($1, $2, 'Specialisation Smoke Character')`,
      [albionServer, albionCharacterId]
    );
    await postgres.query(
      `insert into discord_user_characters (
        discord_guild_id, discord_user_id, albion_server, albion_character_id
       ) values ($1, $2, $3, $4)`,
      [discordGuildId, discordUserId, albionServer, albionCharacterId]
    );
    const group = await postgres.query<{ member_group_id: string }>(
      `insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
       values ($1, $2, 'group', 'Specialisation Smoke Group') returning member_group_id`,
      [discordGuildId, albionServer]
    );
    memberGroupId = group.rows[0].member_group_id;
    await postgres.query(
      `insert into member_group_profiles (
        member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id
       ) values ($1, $2, $3, $4, $5)`,
      [memberGroupId, discordGuildId, discordUserId, albionServer, albionCharacterId]
    );

    const config = await reviewerRepository.addBinding(discordGuildId, "specialisation", "reviewer-role", reviewerId);
    if (config.discordRoleId !== "reviewer-role" || config.createdByDiscordUserId !== reviewerId) {
      throw new Error("Expected specialisation reviewer configuration to round-trip with its actor.");
    }
    const exclusions = await repository.replaceCatalogueExclusions(
      discordGuildId,
      ["weapon:warbow", "weapon:warbow"],
      reviewerId
    );
    if (exclusions.length !== 1 || exclusions[0]?.catalogueKey !== "weapon:warbow") {
      throw new Error("Expected specialisation catalogue exclusions to replace atomically.");
    }

    const target = catalogueByKey.get("weapon:battleaxe");
    if (!target) throw new Error("Expected Battleaxe in the canonical specialisation catalogue.");
    const request = await repository.reserveRequest({
      discordGuildId,
      submittedByDiscordUserId: discordUserId,
      albionServer,
      albionCharacterId,
      target,
      level: 100,
      reviewChannelId: "review-channel"
    });
    await repository.attachReviewMessage(discordGuildId, request.specialisationRequestId, "review-message");
    const decision = await repository.decideRequest({
      discordGuildId,
      specialisationRequestId: request.specialisationRequestId,
      decision: "confirmed",
      reviewerDiscordUserId: reviewerId,
      proofAvailable: true
    });
    if (!decision.changed || decision.request.state !== "confirmed" || !decision.characterSpecialisation) {
      throw new Error("Expected confirmation to atomically decide the request and create one record.");
    }
    const repeated = await repository.decideRequest({
      discordGuildId,
      specialisationRequestId: request.specialisationRequestId,
      decision: "dismissed",
      reviewerDiscordUserId: `other-${reviewerId}`,
      proofAvailable: false
    });
    if (repeated.changed || repeated.request.state !== "confirmed" || repeated.request.reviewedByDiscordUserId !== reviewerId) {
      throw new Error("Expected a repeated decision to retain the first completed outcome.");
    }

    const treeTarget = catalogueByKey.get("tree:axe");
    if (!treeTarget) throw new Error("Expected Axes in the canonical specialisation catalogue.");
    const manual = await repository.addManualSpecialisation({
      discordGuildId,
      albionServer,
      albionCharacterId,
      target: treeTarget,
      level: 800,
      actorDiscordUserId: reviewerId
    });
    if (manual.source !== "manual" || manual.targetDisplayName !== "Axes") {
      throw new Error("Expected a managed character to accept an audited manual tree record.");
    }
    const afterTreeAdd = await repository.listSpecialisations(discordGuildId, { state: "all" });
    const coveredWeapon = afterTreeAdd.find((record) => record.targetKey === "weapon:battleaxe");
    if (!coveredWeapon?.removedAt || coveredWeapon.removedByDiscordUserId !== reviewerId) {
      throw new Error("Expected the tree record to soft-remove its covered individual weapon record.");
    }
    if ((await repository.listSpecialisations(discordGuildId)).some((record) => record.targetKind === "weapon")) {
      throw new Error("Expected covered individual weapon records to leave the active report.");
    }
    await repository.removeSpecialisation(discordGuildId, manual.characterSpecialisationId, reviewerId);

    await postgres.query(
      `delete from member_group_profiles where discord_guild_id = $1`,
      [discordGuildId]
    );
    await postgres.query(
      `delete from discord_user_characters where discord_guild_id = $1`,
      [discordGuildId]
    );
    if (await repository.getEligibleCharacter(discordGuildId, discordUserId, albionServer, albionCharacterId)) {
      throw new Error("Expected membership loss to remove specialisation submission eligibility.");
    }
    const retained = await repository.listSpecialisations(discordGuildId, { state: "all" });
    if (retained.length !== 2 || !retained.every((record) => record.removedAt)) {
      throw new Error("Expected covered and manually removed specialisations to retain their audit rows through membership loss.");
    }
    if ((await repository.listSpecialisations(discordGuildId)).length !== 0) {
      throw new Error("Expected soft-removed specialisations to leave the active report.");
    }

    try {
      await repository.reserveRequest({
        discordGuildId,
        submittedByDiscordUserId: discordUserId,
        albionServer,
        albionCharacterId,
        target,
        level: 100,
        reviewChannelId: "review-channel"
      });
      throw new Error("Expected an ineligible specialisation request to fail.");
    } catch (error) {
      if (!(error instanceof SpecialisationOperationError) || error.code !== "submitter_ineligible") throw error;
    }
  } finally {
    await createGuildLifecycleRepository(postgres).purgeGuildImmediately(discordGuildId).catch(() => undefined);
    if (memberGroupId) {
      await postgres.query(`delete from member_groups where member_group_id = $1`, [memberGroupId]).catch(() => undefined);
    }
    await postgres.query(
      `delete from albion_characters where albion_server = $1 and albion_character_id = $2`,
      [albionServer, albionCharacterId]
    ).catch(() => undefined);
  }
}

async function runRegearConcurrencySmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-regear-concurrency-${suffix}`;
  const adminUserId = `smoke-regear-admin-${suffix}`;
  const limitUserId = `smoke-regear-limit-user-${suffix}`;
  const albionServer = "europe" as const;
  const adminCharacterId = `smoke-regear-admin-character-${suffix}`;
  const membershipRepository = createMembershipRepository(postgres);
  const regearRepository = createRegearRepository(postgres);

  try {
    await postgres.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
       values ($1, 'active', 'Re-Gear Concurrency Smoke', now())`,
      [discordGuildId]
    );
    await membershipRepository.registerCharacter({
      discordGuildId,
      discordUserId: adminUserId,
      albionServer,
      player: { id: adminCharacterId, name: "Concurrency Admin" }
    });
    const group = await postgres.query<{ member_group_id: string }>(
      `insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
       values ($1, $2, 'group', 'Re-Gear Concurrency Group') returning member_group_id`,
      [discordGuildId, albionServer]
    );
    await postgres.query(
      `insert into member_group_profiles (
        member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id
      ) values ($1, $2, $3, $4, $5)`,
      [group.rows[0].member_group_id, discordGuildId, adminUserId, albionServer, adminCharacterId]
    );
    const reviewerRoleIds = [`smoke-regear-concurrency-reviewer-${suffix}`];
    await postgres.query(
      `insert into reviewer_role_bindings (
        discord_guild_id, domain, discord_role_id, created_by_discord_user_id
      ) values ($1, 'regears', $2, $3)`,
      [discordGuildId, reviewerRoleIds[0], adminUserId]
    );

    for (let index = 1; index <= 24; index += 1) {
      await membershipRepository.registerCharacter({
        discordGuildId,
        discordUserId: limitUserId,
        albionServer,
        player: { id: `smoke-regear-limit-${suffix}-${index}`, name: `Limit ${index}` }
      });
    }
    const registrationAttempts = await Promise.allSettled([25, 26].map((index) => membershipRepository.registerCharacter({
      discordGuildId,
      discordUserId: limitUserId,
      albionServer,
      player: { id: `smoke-regear-limit-${suffix}-${index}`, name: `Limit ${index}` }
    })));
    if (registrationAttempts.filter((result) => result.status === "fulfilled").length !== 1
      || registrationAttempts.filter((result) => result.status === "rejected" && result.reason instanceof CharacterRegistrationLimitError).length !== 1) {
      throw new Error("Expected simultaneous twenty-fifth and twenty-sixth character registrations to create exactly one row.");
    }
    if ((await membershipRepository.listRegisteredCharacters(discordGuildId, limitUserId)).length !== 25) {
      throw new Error("Expected concurrent character registration enforcement to retain exactly 25 registrations.");
    }

    const openContents: RegearContent[] = [];
    for (let index = 1; index <= 24; index += 1) {
      openContents.push(await regearRepository.createContent({
        discordGuildId,
        albionServer,
        name: `Concurrency Content ${index}`,
        contentDate: "2026-08-14",
        channelId: "smoke-regear-channel",
        actorDiscordUserId: adminUserId,
        actorDiscordRoleIds: reviewerRoleIds
      }));
    }
    const contentAttempts = await Promise.allSettled([25, 26].map((index) => regearRepository.createContent({
      discordGuildId,
      albionServer,
      name: `Concurrency Content ${index}`,
      contentDate: "2026-08-14",
      channelId: "smoke-regear-channel",
      actorDiscordUserId: adminUserId,
      actorDiscordRoleIds: reviewerRoleIds
    })));
    if (contentAttempts.filter((result) => result.status === "fulfilled").length !== 1
      || contentAttempts.filter((result) => result.status === "rejected" && result.reason instanceof RegearOperationError && result.reason.code === "content_limit").length !== 1) {
      throw new Error("Expected simultaneous twenty-fifth and twenty-sixth Open content attempts to create exactly one row.");
    }
    const openCount = await postgres.query<{ count: string }>(
      `select count(*)::text as count from regear_contents
       where discord_guild_id = $1 and albion_server = $2 and state = 'open'`,
      [discordGuildId, albionServer]
    );
    if (openCount.rows[0]?.count !== "25") {
      throw new Error("Expected concurrent Open content enforcement to retain exactly 25 records.");
    }

    const claim = await regearRepository.createPendingClaim({
      regearClaimId: randomUUID(),
      discordGuildId,
      regearContentId: openContents[0].regearContentId,
      albionServer,
      albionCharacterId: adminCharacterId,
      expectedOwnerDiscordUserId: adminUserId,
      requestedValue: 500n,
      reviewChannelId: "smoke-regear-channel",
      reviewMessageId: "smoke-regear-review"
    });
    const acceptanceAttempts = await Promise.all([
      regearRepository.acceptPendingClaim(discordGuildId, claim.regearClaimId, adminUserId, reviewerRoleIds),
      regearRepository.acceptPendingClaim(discordGuildId, claim.regearClaimId, adminUserId, reviewerRoleIds)
    ]);
    if (acceptanceAttempts.filter((result) => !result.alreadyAccepted).length !== 1
      || acceptanceAttempts.filter((result) => result.alreadyAccepted).length !== 1) {
      throw new Error("Expected simultaneous re-gear acceptance attempts to produce one acceptance and one idempotent result.");
    }
    const credits = await postgres.query<{ count: string }>(
      `select count(*)::text as count from account_transactions where regear_claim_id = $1`,
      [claim.regearClaimId]
    );
    if (credits.rows[0]?.count !== "1") {
      throw new Error("Expected simultaneous re-gear acceptance to create exactly one linked account credit.");
    }
  } finally {
    const lifecycleRepository = createGuildLifecycleRepository(postgres);
    await lifecycleRepository.purgeGuildImmediately(discordGuildId).catch(() => undefined);
    await postgres.query(
      `delete from albion_characters where albion_server = $1 and albion_character_id like $2`,
      [albionServer, `%${suffix}%`]
    ).catch(() => undefined);
  }
}

async function runGiveawayRepositorySmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-giveaway-${suffix}`;
  const otherGuildId = `smoke-giveaway-other-${suffix}`;
  const firstUserId = `smoke-giveaway-user-1-${suffix}`;
  const secondUserId = `smoke-giveaway-user-2-${suffix}`;
  const registeredOnlyUserId = `smoke-giveaway-registered-only-${suffix}`;
  const repository = createGiveawayRepository(postgres);

  try {
    await postgres.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1, 'active', 'Giveaway Smoke', now()), ($2, 'active', 'Giveaway Other Smoke', now())`,
      [discordGuildId, otherGuildId]
    );
    await postgres.query(
      `insert into albion_characters (albion_server, albion_character_id, character_name) values ('asia', $1, 'Giveaway One'), ('asia', $2, 'Giveaway Two'), ('asia', $3, 'Giveaway Registered Only')`,
      [`giveaway-character-1-${suffix}`, `giveaway-character-2-${suffix}`, `giveaway-character-3-${suffix}`]
    );
    await postgres.query(
      `
      insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id)
      values ($1, $2, 'asia', $3), ($1, $4, 'asia', $5), ($1, $6, 'asia', $7)
      `,
      [
        discordGuildId,
        firstUserId,
        `giveaway-character-1-${suffix}`,
        secondUserId,
        `giveaway-character-2-${suffix}`,
        registeredOnlyUserId,
        `giveaway-character-3-${suffix}`
      ]
    );
    const group = await postgres.query<{ member_group_id: string }>(
      `insert into member_groups (discord_guild_id, albion_server, group_type, group_name) values ($1, 'asia', 'group', 'Giveaway Smoke Group') returning member_group_id`,
      [discordGuildId]
    );
    await postgres.query(
      `
      insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id)
      values ($1, $2, $3, 'asia', $4), ($1, $2, $5, 'asia', $6)
      `,
      [
        group.rows[0].member_group_id,
        discordGuildId,
        firstUserId,
        `giveaway-character-1-${suffix}`,
        secondUserId,
        `giveaway-character-2-${suffix}`
      ]
    );

    const notificationRoleId = `giveaway-notification-role-${suffix}`;

    const giveaway = await repository.create({
      discordGuildId,
      channelId: `channel-${suffix}`,
      originalMessageId: `message-${suffix}`,
      creatorDiscordUserId: firstUserId,
      title: "Smoke Giveaway",
      description: "Smoke giveaway description",
      notificationRoleId,
      drawAt: new Date(Date.now() + 60_000),
      winnerCount: 1
    });
    if (giveaway.notificationRoleId !== notificationRoleId) {
      throw new Error("Expected each giveaway to retain its selected notification-role snapshot.");
    }
    if (!await repository.isManagedUser(discordGuildId, firstUserId)) {
      throw new Error("Expected an active member-group profile to make a giveaway entrant eligible.");
    }
    if (await repository.isManagedUser(discordGuildId, registeredOnlyUserId)) {
      throw new Error("Expected character registration without membership to be insufficient for giveaway eligibility.");
    }

    await repository.addReaction(discordGuildId, giveaway.giveawayId, firstUserId, "unicode:🎁");
    await repository.removeReaction(discordGuildId, giveaway.giveawayId, firstUserId, "unicode:🎁");
    if ((await repository.listEligibleParticipantIds(discordGuildId, giveaway.giveawayId)).length !== 0) {
      throw new Error("Expected removing the gift reaction to remove the giveaway entry.");
    }
    await repository.addReaction(discordGuildId, giveaway.giveawayId, firstUserId, "unicode:🎁");
    await repository.addReaction(discordGuildId, giveaway.giveawayId, secondUserId, "unicode:🎁");
    const recorded = await repository.recordDraw({
      discordGuildId,
      giveawayId: giveaway.giveawayId,
      participantReactions: [
        { discordUserId: firstUserId, emojiKeys: ["unicode:🎁"] },
        { discordUserId: secondUserId, emojiKeys: ["unicode:🎁"] }
      ],
      winnerDiscordUserIds: [firstUserId],
      drawnByDiscordUserId: firstUserId
    });
    if (!recorded || await repository.recordDraw({
      discordGuildId,
      giveawayId: giveaway.giveawayId,
      participantReactions: [],
      winnerDiscordUserIds: [],
      drawnByDiscordUserId: firstUserId
    })) {
      throw new Error("Expected giveaway drawing to be atomic and idempotent.");
    }
    await repository.setAnnouncementMessage(discordGuildId, giveaway.giveawayId, `announcement-${suffix}`);
    if (!(await repository.listDrawnNeedingPublication()).some((pending) => pending.giveawayId === giveaway.giveawayId)) {
      throw new Error("Expected a drawn giveaway to remain pending until its original message is closed.");
    }
    await repository.markOriginalMessageClosed(discordGuildId, giveaway.originalMessageId);
    const closedGiveaway = await repository.getById(discordGuildId, giveaway.giveawayId);
    if (
      !closedGiveaway?.originalMessageClosedAt
      || (await repository.listDrawnNeedingPublication()).some((pending) => pending.giveawayId === giveaway.giveawayId)
    ) {
      throw new Error("Expected draw publication and original-message closure to complete independently.");
    }
    const missingMessageGiveaway = await repository.create({
      discordGuildId,
      channelId: `missing-channel-${suffix}`,
      originalMessageId: `missing-message-${suffix}`,
      creatorDiscordUserId: firstUserId,
      title: "Missing Message Giveaway",
      description: "Missing message smoke",
      drawAt: new Date(Date.now() + 60_000),
      winnerCount: 1
    });
    await repository.recordDraw({
      discordGuildId,
      giveawayId: missingMessageGiveaway.giveawayId,
      participantReactions: [],
      winnerDiscordUserIds: [],
      drawnByDiscordUserId: firstUserId
    });
    await repository.markOriginalMessageDeleted(discordGuildId, missingMessageGiveaway.originalMessageId);
    if ((await repository.listDrawnNeedingPublication()).some((pending) => pending.giveawayId === missingMessageGiveaway.giveawayId)) {
      throw new Error("Expected a missing original message to retire an unpublished draw from scheduler retries.");
    }
    if (!await repository.replaceWinner({
      discordGuildId,
      giveawayId: giveaway.giveawayId,
      unavailableDiscordUserId: firstUserId,
      replacementDiscordUserId: secondUserId,
      actorDiscordUserId: firstUserId
    })) {
      throw new Error("Expected an unavailable giveaway winner to be replaced.");
    }
    const winners = await repository.listWinners(discordGuildId, giveaway.giveawayId);
    if (
      winners.length !== 2
      || winners.find((winner) => winner.discordUserId === firstUserId)?.status !== "replaced"
      || winners.find((winner) => winner.discordUserId === secondUserId)?.status !== "current"
    ) {
      throw new Error("Expected giveaway winner history to retain replaced and current winners.");
    }
  } finally {
    const lifecycleRepository = createGuildLifecycleRepository(postgres);
    await lifecycleRepository.purgeGuildImmediately(discordGuildId).catch(() => undefined);
    await lifecycleRepository.purgeGuildImmediately(otherGuildId).catch(() => undefined);
    await postgres.query(
      `delete from albion_characters where albion_server = 'asia' and albion_character_id in ($1, $2, $3)`,
      [`giveaway-character-1-${suffix}`, `giveaway-character-2-${suffix}`, `giveaway-character-3-${suffix}`]
    ).catch(() => undefined);
  }
}

async function runContentRoleReductionSmoke(postgres: PostgresPool): Promise<void> {
  const suffix = randomUUID();
  const discordGuildId = `content-edit-smoke-${suffix}`;
  const repository = createContentRepository(postgres);

  await postgres.query(
    `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1, 'active', 'Content Edit Smoke', now())`,
    [discordGuildId]
  );

  try {
    const created = await repository.createContent({
      discordGuildId,
      sourceChannelId: `content-edit-source-${suffix}`,
      threadChannelId: `content-edit-thread-${suffix}`,
      hostDiscordUserId: `content-edit-host-${suffix}`,
      title: "Content Edit Smoke",
      description: "",
      scheduledStartAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      roleLabels: Array.from({ length: 10 }, (_, index) => `Role ${index + 1}`)
    });

    for (const slot of created.slots.slice(5)) {
      await repository.upsertSignup(
        discordGuildId,
        created.content.contentId,
        slot.contentRoleSlotId,
        `content-edit-user-${slot.slotIndex}-${suffix}`
      );
    }

    const reduced = await repository.updateContentDetails({
      discordGuildId,
      contentId: created.content.contentId,
      title: "Reduced Content Edit Smoke",
      description: "",
      roleLabels: Array.from({ length: 5 }, (_, index) => `Retained Role ${index + 1}`)
    });
    if (!reduced || reduced.movedToStandbyCount !== 5) {
      throw new Error("Expected a 10-to-5 party edit to move five signups to Standby.");
    }
    if (reduced.snapshot.slots.length !== 5 || reduced.snapshot.slots.some((slot) => slot.slotIndex > 5)) {
      throw new Error("Expected a 10-to-5 party edit to retain only role slots 1 through 5.");
    }
    if (reduced.snapshot.signups.length !== 5 || reduced.snapshot.signups.some((signup) =>
      signup.signupType !== "standby" || signup.contentRoleSlotId !== null
    )) {
      throw new Error("Expected every signup from a removed role to remain active on Standby.");
    }

    try {
      await repository.updateContentDetails({
        discordGuildId,
        contentId: created.content.contentId,
        title: "Invalid Empty Party",
        description: "",
        roleLabels: []
      });
      throw new Error("Expected a content edit with no roles to be rejected.");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Provide at least one role line.") throw error;
    }
  } finally {
    await postgres.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [discordGuildId]);
  }
}

async function runPositionSchemaTransitionSmoke(
  databaseUrl: string,
  adminPool: PostgresPool
): Promise<void> {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const schemaName = `smoke_position_migration_${suffix}`;
  const isolatedPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName}`
  });

  await adminPool.query(`create schema "${schemaName}"`);

  try {
    await migrateDatabaseSchema(isolatedPool);

    const guildId = `position-migration-guild-${suffix}`;
    const userId = `position-migration-user-${suffix}`;
    const characterId = `position-migration-character-${suffix}`;
    await isolatedPool.query(
      "insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1, 'active', 'Position Migration', now())",
      [guildId]
    );
    await isolatedPool.query(
      "insert into albion_characters (albion_server, albion_character_id, character_name) values ('americas', $1, 'Position Migration Character')",
      [characterId]
    );
    await isolatedPool.query(
      "insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, $2, 'americas', $3)",
      [guildId, userId, characterId]
    );
    const group = await isolatedPool.query<{ member_group_id: string }>(
      "insert into member_groups (discord_guild_id, albion_server, group_type, group_name) values ($1, 'americas', 'group', 'Position Migration Group') returning member_group_id",
      [guildId]
    );
    const memberGroupId = group.rows[0].member_group_id;
    const profile = await isolatedPool.query<{ member_group_profile_id: string }>(
      "insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id) values ($1, $2, $3, 'americas', $4) returning member_group_profile_id",
      [memberGroupId, guildId, userId, characterId]
    );
    const memberGroupProfileId = profile.rows[0].member_group_profile_id;
    const position = await isolatedPool.query<{ member_group_position_id: string }>(
      "insert into member_group_positions (discord_guild_id, member_group_id, name, discord_role_id) values ($1, $2, 'Guild Master', $3) returning member_group_position_id",
      [guildId, memberGroupId, `position-migration-role-${suffix}`]
    );
    const memberGroupPositionId = position.rows[0].member_group_position_id;
    const appointment = await isolatedPool.query<{ member_group_position_appointment_id: string }>(
      "insert into member_group_position_appointments (member_group_position_id, member_group_profile_id, discord_guild_id) values ($1, $2, $3) returning member_group_position_appointment_id",
      [memberGroupPositionId, memberGroupProfileId, guildId]
    );
    const memberGroupPositionAppointmentId = appointment.rows[0].member_group_position_appointment_id;

    await isolatedPool.query(`
      alter index member_group_positions_group_name_unique
        rename to member_group_scoped_roles_group_name_unique;
      alter index member_group_position_appointments_profile
        rename to member_group_scoped_role_assignments_profile;

      alter table member_group_positions rename constraint member_group_positions_pkey
        to member_group_scoped_roles_pkey;
      alter table member_group_positions rename constraint member_group_positions_guild_nonempty
        to member_group_scoped_roles_guild_nonempty;
      alter table member_group_positions rename constraint member_group_positions_name_nonempty
        to member_group_scoped_roles_name_nonempty;
      alter table member_group_positions rename constraint member_group_positions_discord_role_nonempty
        to member_group_scoped_roles_role_nonempty;
      alter table member_group_positions rename constraint member_group_positions_group_fk
        to member_group_scoped_roles_group_fk;
      alter table member_group_positions rename constraint member_group_positions_position_guild_unique
        to member_group_scoped_roles_member_group_scoped_role_id_disco_key;

      alter table member_group_position_appointments rename constraint member_group_position_appointments_pkey
        to member_group_scoped_role_assignments_pkey;
      alter table member_group_position_appointments rename constraint member_group_position_appointments_guild_nonempty
        to member_group_scoped_role_assignments_guild_nonempty;
      alter table member_group_position_appointments rename constraint member_group_position_appointments_position_fk
        to member_group_scoped_role_assignments_role_fk;
      alter table member_group_position_appointments rename constraint member_group_position_appointments_profile_fk
        to member_group_scoped_role_assignments_profile_fk;
      alter table member_group_position_appointments rename constraint member_group_position_appointments_position_profile_unique
        to member_group_scoped_role_assi_member_group_scoped_role_id_m_key;

      alter sequence member_group_positions_member_group_position_id_seq
        rename to member_group_scoped_roles_member_group_scoped_role_id_seq;
      alter sequence member_group_position_appointments_id_seq
        rename to member_group_scoped_role_assi_member_group_scoped_role_assi_seq;

      alter table member_group_positions
        rename column member_group_position_id to member_group_scoped_role_id;
      alter table member_group_position_appointments
        rename column member_group_position_appointment_id to member_group_scoped_role_assignment_id;
      alter table member_group_position_appointments
        rename column member_group_position_id to member_group_scoped_role_id;
      alter table member_group_positions rename to member_group_scoped_roles;
      alter table member_group_position_appointments rename to member_group_scoped_role_assignments;
      delete from guild_manager_schema_migrations where version = 19;
    `);

    await migrateDatabaseSchema(isolatedPool);
    await migrateDatabaseSchema(isolatedPool);

    const migrated = await isolatedPool.query<{
      schema_version: number;
      position_id: string;
      appointment_id: string;
      legacy_positions: string | null;
      legacy_appointments: string | null;
      position_sequence: string | null;
      appointment_sequence: string | null;
    }>(
      `
      select
        (select max(version) from guild_manager_schema_migrations) schema_version,
        (select member_group_position_id::text from member_group_positions where discord_guild_id = $1) position_id,
        (
          select member_group_position_appointment_id::text
          from member_group_position_appointments
          where discord_guild_id = $1
        ) appointment_id,
        to_regclass('member_group_scoped_roles')::text legacy_positions,
        to_regclass('member_group_scoped_role_assignments')::text legacy_appointments,
        to_regclass('member_group_positions_member_group_position_id_seq')::text position_sequence,
        to_regclass('member_group_position_appointments_id_seq')::text appointment_sequence
      `,
      [guildId]
    );
    const result = migrated.rows[0];
    if (
      result.schema_version !== CURRENT_SCHEMA_VERSION
      || result.position_id !== memberGroupPositionId
      || result.appointment_id !== memberGroupPositionAppointmentId
      || result.legacy_positions
      || result.legacy_appointments
      || !result.position_sequence
      || !result.appointment_sequence
    ) {
      throw new Error("Expected the position terminology migration to preserve IDs and remove legacy physical names.");
    }

    const identifiers = await isolatedPool.query<{ name: string }>(
      `
      select conname name
      from pg_constraint
      where conrelid in ('member_group_positions'::regclass, 'member_group_position_appointments'::regclass)
        -- PostgreSQL 18 records automatically named NOT NULL constraints here.
        -- They are outside migration 19's explicitly named-constraint audit.
        and contype <> 'n'
      union all
      select indexname name
      from pg_indexes
      where schemaname = current_schema()
        and tablename in ('member_group_positions', 'member_group_position_appointments')
      `
    );
    if (identifiers.rows.some(({ name }) => name.includes("scoped_role"))) {
      throw new Error("Expected position table constraints and indexes to use canonical terminology.");
    }
  } finally {
    await isolatedPool.end().catch(() => undefined);
    await adminPool.query(`drop schema if exists "${schemaName}" cascade`).catch(() => undefined);
  }
}

async function runCharacterHierarchySchemaTransitionSmoke(
  databaseUrl: string,
  adminPool: PostgresPool
): Promise<void> {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const schemaName = `smoke_character_hierarchy_migration_${suffix}`;
  const isolatedPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName}`
  });

  await adminPool.query(`create schema "${schemaName}"`);

  try {
    await migrateDatabaseSchema(isolatedPool);
    await isolatedPool.query(`
      drop trigger discord_user_characters_assign_registration_order on discord_user_characters;
      drop trigger discord_user_characters_ensure_main_after_insert on discord_user_characters;
      drop trigger discord_user_characters_promote_main_before_delete on discord_user_characters;
      drop function assign_discord_user_character_registration_order();
      drop function ensure_discord_user_main_character();
      drop function promote_discord_user_main_character_before_delete();
      alter table discord_user_characters drop constraint discord_user_characters_registration_order_unique;
      alter table discord_user_characters drop column registration_order;
      delete from guild_manager_schema_migrations where version = 32;
    `);

    const guildId = `hierarchy-migration-guild-${suffix}`;
    const firstUserId = `hierarchy-migration-user-1-${suffix}`;
    const secondUserId = `hierarchy-migration-user-2-${suffix}`;
    await isolatedPool.query(
      `insert into albion_characters (albion_server, albion_character_id, character_name)
       values
         ('americas', $1, 'First'),
         ('americas', $2, 'Selected'),
         ('americas', $3, 'Third'),
         ('americas', $4, 'Fallback First'),
         ('americas', $5, 'Fallback Second')`,
      [
        `hierarchy-migration-first-${suffix}`,
        `hierarchy-migration-selected-${suffix}`,
        `hierarchy-migration-third-${suffix}`,
        `hierarchy-migration-fallback-first-${suffix}`,
        `hierarchy-migration-fallback-second-${suffix}`
      ]
    );
    await isolatedPool.query(
      `insert into discord_user_characters (
         discord_guild_id, discord_user_id, albion_server, albion_character_id, registered_at
       ) values
         ($1, $2, 'americas', $3, '2026-01-01T00:00:00Z'),
         ($1, $2, 'americas', $4, '2026-01-02T00:00:00Z'),
         ($1, $2, 'americas', $5, '2026-01-03T00:00:00Z'),
         ($1, $6, 'americas', $7, '2026-01-01T00:00:00Z'),
         ($1, $6, 'americas', $8, '2026-01-02T00:00:00Z')`,
      [
        guildId,
        firstUserId,
        `hierarchy-migration-first-${suffix}`,
        `hierarchy-migration-selected-${suffix}`,
        `hierarchy-migration-third-${suffix}`,
        secondUserId,
        `hierarchy-migration-fallback-first-${suffix}`,
        `hierarchy-migration-fallback-second-${suffix}`
      ]
    );
    await isolatedPool.query(
      `insert into discord_user_main_characters (
         discord_guild_id, discord_user_id, albion_server, albion_character_id
       ) values ($1, $2, 'americas', $3)`,
      [guildId, firstUserId, `hierarchy-migration-selected-${suffix}`]
    );

    await migrateDatabaseSchema(isolatedPool);
    await migrateDatabaseSchema(isolatedPool);

    const migrated = await isolatedPool.query<{
      discord_user_id: string;
      character_ids: string[];
      main_character_id: string;
    }>(
      `select
         registration.discord_user_id,
         array_agg(registration.albion_character_id order by registration.registration_order) character_ids,
         max(main.albion_character_id) main_character_id
       from discord_user_characters registration
       join discord_user_main_characters main
         on main.discord_guild_id = registration.discord_guild_id
         and main.discord_user_id = registration.discord_user_id
       where registration.discord_guild_id = $1
       group by registration.discord_user_id
       order by registration.discord_user_id`,
      [guildId]
    );
    const first = migrated.rows.find((row) => row.discord_user_id === firstUserId);
    const second = migrated.rows.find((row) => row.discord_user_id === secondUserId);
    if (
      first?.main_character_id !== `hierarchy-migration-selected-${suffix}`
      || first.character_ids.join(",") !== [
        `hierarchy-migration-selected-${suffix}`,
        `hierarchy-migration-first-${suffix}`,
        `hierarchy-migration-third-${suffix}`
      ].join(",")
      || second?.main_character_id !== `hierarchy-migration-fallback-first-${suffix}`
      || second.character_ids.join(",") !== [
        `hierarchy-migration-fallback-first-${suffix}`,
        `hierarchy-migration-fallback-second-${suffix}`
      ].join(",")
    ) {
      throw new Error("Expected the character hierarchy migration to preserve the current main, backfill registration order, and repair missing main selections.");
    }
  } finally {
    await isolatedPool.end().catch(() => undefined);
    await adminPool.query(`drop schema if exists "${schemaName}" cascade`).catch(() => undefined);
  }
}

async function runCharacterHierarchySmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-character-hierarchy-${suffix}`;
  const discordUserId = `smoke-character-hierarchy-user-${suffix}`;
  const concurrentUserId = `smoke-character-hierarchy-concurrent-user-${suffix}`;
  const albionServer = "europe" as const;
  const characterIds = ["first", "second", "third", "fourth"].map(
    (label) => `smoke-character-hierarchy-${label}-${suffix}`
  );
  const concurrentCharacterIds = ["a", "b"].map(
    (label) => `smoke-character-hierarchy-concurrent-${label}-${suffix}`
  );
  const repository = createMembershipRepository(postgres);

  try {
    await postgres.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
       values ($1, 'active', 'Character Hierarchy Smoke', now())`,
      [discordGuildId]
    );
    for (const [index, characterId] of characterIds.slice(0, 3).entries()) {
      await repository.registerCharacter({
        discordGuildId,
        discordUserId,
        albionServer,
        player: { id: characterId, name: ["Zulu", "Alpha", "Mike"][index] }
      });
    }

    let hierarchy = await repository.listRegisteredCharacters(discordGuildId, discordUserId);
    if (hierarchy.map((character) => character.albionCharacterId).join(",") !== characterIds.slice(0, 3).join(",")) {
      throw new Error("Expected new registrations to append in durable registration order rather than display-name order.");
    }
    await assertMainCharacter(postgres, discordGuildId, discordUserId, characterIds[0]);

    await repository.setMainCharacter(hierarchy[2]);
    hierarchy = await repository.listRegisteredCharacters(discordGuildId, discordUserId);
    if (hierarchy.map((character) => character.albionCharacterId).join(",") !== [characterIds[2], characterIds[0], characterIds[1]].join(",")) {
      throw new Error("Expected an explicit main selection to move that character to the front without reordering the others.");
    }
    await repository.unregisterCharacter(hierarchy[0]);
    await assertMainCharacter(postgres, discordGuildId, discordUserId, characterIds[0]);

    hierarchy = await repository.listRegisteredCharacters(discordGuildId, discordUserId);
    await repository.unregisterCharacter(hierarchy[0]);
    await assertMainCharacter(postgres, discordGuildId, discordUserId, characterIds[1]);

    await repository.registerCharacter({
      discordGuildId,
      discordUserId,
      albionServer,
      player: { id: characterIds[3], name: "Bravo" }
    });
    hierarchy = await repository.listRegisteredCharacters(discordGuildId, discordUserId);
    if (hierarchy.map((character) => character.albionCharacterId).join(",") !== [characterIds[1], characterIds[3]].join(",")) {
      throw new Error("Expected a later registration to append after the promoted main character.");
    }

    await Promise.all(concurrentCharacterIds.map((characterId) => repository.registerCharacter({
      discordGuildId,
      discordUserId: concurrentUserId,
      albionServer,
      player: { id: characterId, name: characterId }
    })));
    const concurrentHierarchy = await repository.listRegisteredCharacters(discordGuildId, concurrentUserId);
    if (concurrentHierarchy.length !== 2) {
      throw new Error("Expected concurrent registrations to retain two ordered characters.");
    }
    await assertMainCharacter(postgres, discordGuildId, concurrentUserId, concurrentHierarchy[0].albionCharacterId);

    await repository.kickUser(discordGuildId, discordUserId);
    const kickedAccess = await repository.getMemberAccess(discordGuildId, discordUserId);
    assert.equal(kickedAccess?.blocked, true);
    assert.equal(kickedAccess?.cleanupPending, true);
    assert.ok(kickedAccess?.lastKickedAt);
    for (const characterId of characterIds) {
      const snapshot = await repository.getKickRecoverySnapshot(discordGuildId, discordUserId, albionServer, characterId);
      assert.equal(snapshot.characterKickRecoveryRequired, true);
    }
    const remainingMain = await postgres.query(
      `select 1 from discord_user_main_characters where discord_guild_id = $1 and discord_user_id = $2`,
      [discordGuildId, discordUserId]
    );
    if ((remainingMain.rowCount ?? 0) !== 0) {
      throw new Error("Expected removing a user's final registrations to remove the main selection.");
    }
  } finally {
    await createGuildLifecycleRepository(postgres).purgeGuildImmediately(discordGuildId).catch(() => undefined);
    await postgres.query(
      `delete from albion_characters where albion_server = $1 and albion_character_id like $2`,
      [albionServer, `%${suffix}`]
    ).catch(() => undefined);
  }
}

async function assertMainCharacter(
  postgres: PostgresPool,
  discordGuildId: string,
  discordUserId: string,
  expectedCharacterId: string
): Promise<void> {
  const main = await postgres.query<{ albion_character_id: string }>(
    `select albion_character_id
     from discord_user_main_characters
     where discord_guild_id = $1 and discord_user_id = $2`,
    [discordGuildId, discordUserId]
  );
  if (main.rows[0]?.albion_character_id !== expectedCharacterId) {
    throw new Error(`Expected ${expectedCharacterId} to be the current main character.`);
  }
}

async function runReactionSchemaTransitionSmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-reaction-migration-guild-${suffix}`;
  const discordUserId = `smoke-reaction-migration-user-${suffix}`;
  let memberGroupId: string | undefined;

  try {
    await postgres.query(
      `
      insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
      values ($1, 'active', 'Smoke Reaction Migration Guild', now())
      `,
      [discordGuildId]
    );
    const memberGroup = await postgres.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, 'americas', 'group', 'Smoke Reaction Migration Group')
      returning member_group_id
      `,
      [discordGuildId]
    );
    memberGroupId = memberGroup.rows[0].member_group_id;
    const config = await postgres.query<{ reaction_role_config_id: string }>(
      `
      insert into reaction_role_configs (
        discord_guild_id,
        discord_role_id,
        created_by_discord_user_id
      )
      values ($1, $2, $3)
      returning reaction_role_config_id
      `,
      [discordGuildId, `smoke-reaction-migration-role-${suffix}`, discordUserId]
    );
    const reactionRoleConfigId = config.rows[0].reaction_role_config_id;
    await postgres.query(
      `
      insert into reaction_role_subscriptions (
        reaction_role_config_id,
        discord_guild_id,
        discord_user_id
      )
      values ($1, $2, $3)
      `,
      [reactionRoleConfigId, discordGuildId, discordUserId]
    );
    await postgres.query(
      `
      insert into reaction_role_emoji_placements (
        reaction_role_config_id,
        discord_guild_id,
        channel_id,
        message_id,
        emoji_key,
        emoji_display_value,
        created_by_discord_user_id
      )
      values ($1, $2, $3, $4, 'unicode:✅', '✅', $5)
      `,
      [
        reactionRoleConfigId,
        discordGuildId,
        `smoke-reaction-migration-channel-${suffix}`,
        `smoke-reaction-migration-message-${suffix}`,
        discordUserId
      ]
    );
    await postgres.query(
      `
      create table reaction_role_member_groups (
        reaction_role_config_id bigint not null,
        member_group_id bigint not null references member_groups (member_group_id) on delete cascade,
        discord_guild_id text not null,
        connected_by_discord_user_id text not null,
        created_at timestamptz not null default now(),
        primary key (reaction_role_config_id, member_group_id),
        constraint reaction_role_member_groups_config_fk foreign key (reaction_role_config_id, discord_guild_id)
          references reaction_role_configs (reaction_role_config_id, discord_guild_id) on delete cascade
      )
      `
    );
    await postgres.query(
      `
      insert into reaction_role_member_groups (
        reaction_role_config_id,
        member_group_id,
        discord_guild_id,
        connected_by_discord_user_id
      )
      values ($1, $2, $3, $4)
      `,
      [reactionRoleConfigId, memberGroupId, discordGuildId, discordUserId]
    );
    await postgres.query("delete from guild_manager_schema_migrations where version = 18");

    await migrateDatabaseSchema(postgres);

    const preserved = await postgres.query<{
      config_count: string;
      subscription_count: string;
      placement_count: string;
      obsolete_group_connections: string | null;
      schema_version: number;
    }>(
      `
      select
        (select count(*)::text from reaction_role_configs where reaction_role_config_id = $1) config_count,
        (select count(*)::text from reaction_role_subscriptions where reaction_role_config_id = $1 and discord_user_id = $2) subscription_count,
        (select count(*)::text from reaction_role_emoji_placements where reaction_role_config_id = $1) placement_count,
        to_regclass('reaction_role_member_groups')::text obsolete_group_connections,
        (select max(version) from guild_manager_schema_migrations) schema_version
      `,
      [reactionRoleConfigId, discordUserId]
    );
    const result = preserved.rows[0];
    if (
      result.config_count !== "1"
      || result.subscription_count !== "1"
      || result.placement_count !== "1"
      || result.obsolete_group_connections
      || result.schema_version !== CURRENT_SCHEMA_VERSION
    ) {
      throw new Error(
        "Expected schema 18 transition to preserve reaction configurations, subscriptions, and emoji placements while removing group connections."
      );
    }
  } finally {
    await postgres.query("drop table if exists reaction_role_member_groups").catch(() => undefined);
    await postgres.query(
      "delete from discord_guild_lifecycle where discord_guild_id = $1",
      [discordGuildId]
    ).catch(() => undefined);
    if (memberGroupId) {
      await postgres.query(
        "delete from member_groups where member_group_id = $1",
        [memberGroupId]
      ).catch(() => undefined);
    }
  }
}

async function runDiscordDepartureMembershipSmoke(postgres: PostgresPool): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const discordGuildId = `smoke-departure-guild-${runId}`;
  const discordUserId = `smoke-departure-user-${runId}`;
  const albionServer = "europe";
  const albionCharacterId = `smoke-departure-character-${runId}`;
  const membershipRepository = createMembershipRepository(postgres);
  const reactionRoleRepository = createReactionRoleRepository(postgres);
  let memberGroupId: string | undefined;

  try {
    await postgres.query(
      `
      insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
      values ($1, 'active', 'Smoke Departure Guild', now())
      `,
      [discordGuildId]
    );
    await postgres.query(
      `
      insert into albion_characters (albion_server, albion_character_id, character_name)
      values ($1, $2, $3)
      `,
      [albionServer, albionCharacterId, "Smoke Departure"]
    );
    await postgres.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4)
      `,
      [discordGuildId, discordUserId, albionServer, albionCharacterId]
    );
    const groupResult = await postgres.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'group', 'Smoke Departure Group')
      returning member_group_id
      `,
      [discordGuildId, albionServer]
    );
    memberGroupId = groupResult.rows[0].member_group_id;
    await postgres.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, $3, $4, $5)
      `,
      [memberGroupId, discordGuildId, discordUserId, albionServer, albionCharacterId]
    );
    const reactionConfig = await reactionRoleRepository.addConfig(
      discordGuildId,
      `smoke-departure-reaction-role-${runId}`,
      discordUserId
    );
    await reactionRoleRepository.subscribe(
      discordGuildId,
      reactionConfig.reactionRoleConfigId,
      discordUserId
    );
    const characters = await cleanupDiscordUserDeparture(
      discordGuildId,
      discordUserId,
      membershipRepository,
      reactionRoleRepository
    );
    if (characters.length !== 1 || characters[0].albionCharacterId !== albionCharacterId) {
      throw new Error("Expected departure cleanup to return the removed registration.");
    }

    const registration = await postgres.query(
      `
      select 1
      from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
      `,
      [discordGuildId, discordUserId]
    );
    if ((registration.rowCount ?? 0) !== 0) {
      throw new Error("Expected departure cleanup to remove user-character registrations.");
    }
    if (await reactionRoleRepository.countSubscriptions(
      discordGuildId,
      reactionConfig.reactionRoleConfigId
    ) !== 0) {
      throw new Error("Expected Discord-server departure to delete reaction-role subscriptions.");
    }

    const profile = await postgres.query<{ discord_user_id: string | null }>(
      `
      select discord_user_id
      from member_group_profiles
      where member_group_id = $1
        and albion_server = $2
        and albion_character_id = $3
      `,
      [memberGroupId, albionServer, albionCharacterId]
    );
    if ((profile.rowCount ?? 0) !== 1 || profile.rows[0].discord_user_id !== null) {
      throw new Error("Expected departure cleanup to preserve the profile without a Discord owner.");
    }
    const lifecycle = await membershipRepository.getRegistrationLifecycle(discordGuildId, albionServer, albionCharacterId);
    assert.equal(lifecycle?.state, "hold");
    assert.equal(lifecycle?.expiresAt?.getTime(), lifecycle!.detectedAt.getTime() + 72 * 60 * 60 * 1000);
  } finally {
    await purgeGuildOwnedData(postgres, discordGuildId);
    await postgres.query(
      "delete from discord_guild_lifecycle where discord_guild_id = $1",
      [discordGuildId]
    ).catch(() => undefined);
    if (memberGroupId) {
      await postgres.query("delete from member_groups where member_group_id = $1", [memberGroupId]).catch(() => undefined);
    }
    await postgres.query(
      `
      delete from discord_user_characters
      where discord_guild_id = $1
        and discord_user_id = $2
      `,
      [discordGuildId, discordUserId]
    ).catch(() => undefined);
    await postgres.query(
      `
      delete from albion_characters
      where albion_server = $1
        and albion_character_id = $2
      `,
      [albionServer, albionCharacterId]
    ).catch(() => undefined);
  }
}

async function runGeneralTicketSmoke(postgres: PostgresPool): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guildId = `smoke-ticket-guild-${runId}`;
  const otherGuildId = `smoke-ticket-other-${runId}`;
  const repository = createTicketRepository(postgres);
  try {
    await postgres.query(`insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1,'active','Ticket Smoke Guild',now()),($2,'active','Other Ticket Smoke Guild',now())`, [guildId, otherGuildId]);
    const ticketClass = await repository.createTicketClass({ discordGuildId: guildId, name: "General Help", ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "creator" });
    const ticket = await repository.createTicket({ ticketClassId: ticketClass.ticketClassId, discordGuildId: guildId, openerDiscordUserId: "opener" });
    await repository.setTicketChannel(guildId, ticket.ticketId, "channel");
    if (await repository.getTicket(otherGuildId, ticket.ticketId)) throw new Error("Expected ticket lookup to be tenant scoped.");
    const withControlMessage = await repository.setTicketControlMessageId(guildId, ticket.ticketId, "ticket-control-message");
    if (withControlMessage?.controlMessageId !== "ticket-control-message") throw new Error("Expected ticket control message ID to be stored.");
    if (await repository.setTicketControlMessageId(otherGuildId, ticket.ticketId, "wrong-tenant-control-message")) {
      throw new Error("Expected ticket control message setter to be tenant scoped.");
    }
    if ((await repository.getTicket(guildId, ticket.ticketId))?.controlMessageId !== "ticket-control-message") {
      throw new Error("Expected ticket control message ID to round-trip.");
    }
    await repository.setTicketControlMessageId(guildId, ticket.ticketId, undefined);
    if ((await repository.getTicket(guildId, ticket.ticketId))?.controlMessageId !== undefined) {
      throw new Error("Expected ticket control message ID to clear.");
    }
    await expectCheckConstraintFailure(
      "whitespace-only ticket control message ID",
      "tickets_control_message_id_nonempty",
      () => repository.setTicketControlMessageId(guildId, ticket.ticketId, "   ")
    );
    if ((await repository.getTicket(guildId, ticket.ticketId))?.controlMessageId !== undefined) {
      throw new Error("Expected rejected ticket control message ID not to persist.");
    }
    await repository.markTicketClosed(guildId, ticket.ticketId, "closer");
    if ((await repository.getTicket(guildId, ticket.ticketId))?.status !== "closed") throw new Error("Expected ticket to close.");
    await repository.markTicketReopened(guildId, ticket.ticketId, "reopener");
    if ((await repository.getTicket(guildId, ticket.ticketId))?.status !== "open") throw new Error("Expected ticket to reopen.");
    await repository.markTicketClosed(guildId, ticket.ticketId, "closer");
    await repository.markTicketDeleted(guildId, ticket.ticketId, "reviewer");
    const deleted = await repository.getTicket(guildId, ticket.ticketId);
    if (deleted?.status !== "deleted" || !deleted.deletedAt) throw new Error("Expected deleted ticket lifecycle record to be retained.");

    const manuallyDeletedTicket = await repository.createTicket({ ticketClassId: ticketClass.ticketClassId, discordGuildId: guildId, openerDiscordUserId: "departed-opener" });
    await repository.setTicketChannel(guildId, manuallyDeletedTicket.ticketId, "manually-deleted-channel");
    const reconciledTicket = await repository.markTicketChannelDeleted(guildId, "manually-deleted-channel");
    if (reconciledTicket?.status !== "deleted" || !reconciledTicket.deletedAt || reconciledTicket.deletedByDiscordUserId) {
      throw new Error("Expected direct channel deletion to reconcile the general ticket without an attributed actor.");
    }
  } finally {
    await postgres.query(`delete from discord_guild_lifecycle where discord_guild_id in ($1,$2)`, [guildId, otherGuildId]).catch(() => undefined);
  }
}

async function runApplicationChannelLifecycleSmoke(postgres: PostgresPool): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guildId = `smoke-application-channel-${runId}`;
  const repository = createApplicationRepository(postgres);
  try {
    await postgres.query(`insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at) values ($1,'active','Application Channel Smoke Guild',now())`, [guildId]);
    const applicationClass = await repository.createApplicationClass({ discordGuildId: guildId, name: "Application Lifecycle", outcomeType: "register_character", albionServer: "asia", ticketCategoryId: "category", reviewerRoleId: "reviewer", createdByDiscordUserId: "creator" });
    const application = await repository.createOpenApplication({ applicationClassId: applicationClass.applicationClassId, discordGuildId: guildId, applicantDiscordUserId: "applicant", ticketChannelId: "channel", submittedCharacterName: "Smoke Character", modalAnswers: [], albionServer: "asia" });
    await repository.setCharacterResolutionMessageId(guildId, application.applicationId, "character-message");
    await repository.setApplicationControlMessageId(guildId, application.applicationId, "review-message");
    if (await repository.setApplicationControlMessageId("other-guild", application.applicationId, "wrong-tenant-message")) {
      throw new Error("Expected application control message setters to be tenant scoped.");
    }
    await repository.beginApplicationCharacterSearch(guildId, application.applicationId, "Smoke Charcter");
    const retried = await repository.beginApplicationCharacterSearch(guildId, application.applicationId, "Smoke Character");
    if (
      retried?.characterSearchAttemptCount !== 2
      || retried.submittedCharacterName !== "Smoke Character"
      || retried.characterResolutionMessageId !== "character-message"
      || retried.applicationControlMessageId !== "review-message"
    ) throw new Error("Expected application character searches and canonical message IDs to round-trip.");
    await repository.markApplicationWithdrawn(guildId, application.applicationId);
    await repository.setApplicationControlMessageId(guildId, application.applicationId, "withdrawn-message");
    await repository.markApplicationClosed(guildId, application.applicationId, "applicant");
    const withClosedControl = await repository.setClosedControlMessageId(guildId, application.applicationId, "closed-control-message");
    if (withClosedControl?.closedControlMessageId !== "closed-control-message") throw new Error("Expected closed application control message ID to be stored.");
    if (await repository.setClosedControlMessageId("other-guild", application.applicationId, "wrong-tenant-closed-control-message")) {
      throw new Error("Expected closed application control message setter to be tenant scoped.");
    }
    if ((await repository.getOpenApplication(guildId, application.applicationId))?.closedControlMessageId !== "closed-control-message") {
      throw new Error("Expected closed application control message ID to round-trip.");
    }
    await repository.setClosedControlMessageId(guildId, application.applicationId, undefined);
    if ((await repository.getOpenApplication(guildId, application.applicationId))?.closedControlMessageId !== undefined) {
      throw new Error("Expected closed application control message ID to clear.");
    }
    await expectCheckConstraintFailure(
      "whitespace-only closed application control message ID",
      "open_applications_closed_control_message_id_nonempty",
      () => repository.setClosedControlMessageId(guildId, application.applicationId, "   ")
    );
    if ((await repository.getOpenApplication(guildId, application.applicationId))?.closedControlMessageId !== undefined) {
      throw new Error("Expected rejected closed application control message ID not to persist.");
    }
    let current = await repository.getOpenApplication(guildId, application.applicationId);
    if (
      current?.status !== "withdrawn"
      || current.channelStatus !== "closed"
      || current.applicationControlMessageId !== "withdrawn-message"
    ) throw new Error("Expected withdrawal controls and closed channel state to remain independent.");
    await repository.markApplicationReopened(guildId, application.applicationId, "reviewer");
    current = await repository.getOpenApplication(guildId, application.applicationId);
    if (
      current?.status !== "withdrawn"
      || current.channelStatus !== "open"
      || current.applicationControlMessageId !== "withdrawn-message"
    ) throw new Error("Expected reopening to preserve the withdrawn application control message.");
    await repository.markApplicationClosed(guildId, application.applicationId, "reviewer");
    await repository.markApplicationDeleted(guildId, application.applicationId, "reviewer");
    current = await repository.getOpenApplication(guildId, application.applicationId);
    if (current?.status !== "withdrawn" || current.channelStatus !== "deleted" || !current.deletedAt) throw new Error("Expected deleted application channel lifecycle to retain the decision record.");

    const manuallyDeletedApplication = await repository.createOpenApplication({ applicationClassId: applicationClass.applicationClassId, discordGuildId: guildId, applicantDiscordUserId: "departed-applicant", ticketChannelId: "manually-deleted-channel", submittedCharacterName: "Departed Character", modalAnswers: [], albionServer: "asia" });
    const reconciledApplication = await repository.markApplicationChannelDeleted(guildId, "manually-deleted-channel");
    if (
      reconciledApplication?.status !== "open"
      || reconciledApplication.channelStatus !== "deleted"
      || !reconciledApplication.deletedAt
      || reconciledApplication.deletedByDiscordUserId
    ) throw new Error("Expected direct channel deletion to reconcile the application without changing its decision or attributing an actor.");

    const waitingApplication = await repository.createOpenApplication({ applicationClassId: applicationClass.applicationClassId, discordGuildId: guildId, applicantDiscordUserId: "waiting-applicant", ticketChannelId: "waiting-channel", submittedCharacterName: "Waiting Character", modalAnswers: [], albionServer: "asia" });
    await repository.markApplicationAwaitingMembership(guildId, waitingApplication.applicationId, "reviewer", "Waiting for guild membership.", "open");
    await repository.setApplicationControlMessageId(guildId, waitingApplication.applicationId, "waiting-message");
    await repository.markApplicationClosed(guildId, waitingApplication.applicationId, "reviewer");
    await repository.markApplicationReopened(guildId, waitingApplication.applicationId, "waiting-applicant");
    current = await repository.getOpenApplication(guildId, waitingApplication.applicationId);
    if (
      current?.status !== "awaiting_ingame_membership"
      || current.channelStatus !== "open"
      || current.applicationControlMessageId !== "waiting-message"
    ) throw new Error("Expected cancellation and applicant reopen to retain the waiting decision and control message.");
    await repository.markApplicationAwaitingMembership(guildId, waitingApplication.applicationId, "reviewer", "Still waiting for guild membership.", "awaiting_ingame_membership");
    current = await repository.getOpenApplication(guildId, waitingApplication.applicationId);
    if (current?.applicationControlMessageId !== "waiting-message" || current.lastIngameMembershipFailure !== "Still waiting for guild membership.") {
      throw new Error("Expected repeated membership verification to update the check without replacing waiting controls.");
    }
    await repository.markApplicationAccepted(guildId, waitingApplication.applicationId, "reviewer", "awaiting_ingame_membership");
    await repository.setApplicationControlMessageId(guildId, waitingApplication.applicationId, "accepted-message");
    await repository.markApplicationClosed(guildId, waitingApplication.applicationId, "applicant");
    await repository.markApplicationReopened(guildId, waitingApplication.applicationId, "reviewer");
    current = await repository.getOpenApplication(guildId, waitingApplication.applicationId);
    if (current?.status !== "accepted" || current.applicationControlMessageId !== "accepted-message") {
      throw new Error("Expected accepted controls to survive close and reopen.");
    }

    const rejectedApplication = await repository.createOpenApplication({ applicationClassId: applicationClass.applicationClassId, discordGuildId: guildId, applicantDiscordUserId: "rejected-applicant", ticketChannelId: "rejected-channel", submittedCharacterName: "Rejected Character", modalAnswers: [], albionServer: "asia" });
    await postgres.query(`insert into albion_characters (albion_server, albion_character_id, character_name) values ('asia', $1, 'Rejected Character')`, [`${guildId}:rejected`]);
    await repository.selectApplicationCharacter(guildId, rejectedApplication.applicationId, `${guildId}:rejected`);
    await repository.markApplicationRejected(guildId, rejectedApplication.applicationId, "reviewer");
    await repository.setApplicationControlMessageId(guildId, rejectedApplication.applicationId, "rejected-message");
    await repository.markApplicationClosed(guildId, rejectedApplication.applicationId, "reviewer");
    await repository.markApplicationReopened(guildId, rejectedApplication.applicationId, "rejected-applicant");
    current = await repository.getOpenApplication(guildId, rejectedApplication.applicationId);
    if (current?.status !== "rejected" || current.applicationControlMessageId !== "rejected-message") {
      throw new Error("Expected rejected controls to survive close and reopen.");
    }
  } finally {
    await postgres.query(`delete from discord_guild_lifecycle where discord_guild_id=$1`, [guildId]).catch(() => undefined);
    await postgres.query(`delete from albion_characters where albion_server='asia' and albion_character_id=$1`, [`${guildId}:rejected`]).catch(() => undefined);
  }
}

async function runApplicationAcceptanceOwnershipConcurrencySmoke(postgres: PostgresPool): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guildId = `smoke-application-ownership-${suffix}`;
  const albionServer = "europe" as const;
  const characterId = `smoke-application-character-${suffix}`;
  const applicationRepository = createApplicationRepository(postgres);
  const membershipRepository = createMembershipRepository(postgres);

  try {
    await postgres.query(
      `insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
       values ($1, 'active', 'Application Ownership Concurrency Smoke', now())`,
      [guildId]
    );
    await postgres.query(
      `insert into albion_characters (albion_server, albion_character_id, character_name)
       values ($1, $2, 'Ownership Smoke Character')`,
      [albionServer, characterId]
    );
    const applicationClass = await applicationRepository.createApplicationClass({
      discordGuildId: guildId,
      name: "Ownership Concurrency",
      outcomeType: "register_character",
      albionServer,
      ticketCategoryId: `ownership-category-${suffix}`,
      reviewerRoleId: `ownership-reviewer-${suffix}`,
      createdByDiscordUserId: `ownership-creator-${suffix}`
    });
    const applicants = ["first", "second"].map((label) => `ownership-${label}-applicant-${suffix}`);
    const applications = await Promise.all(applicants.map((applicantDiscordUserId, index) => applicationRepository.createOpenApplication({
      applicationClassId: applicationClass.applicationClassId,
      discordGuildId: guildId,
      applicantDiscordUserId,
      ticketChannelId: `ownership-channel-${index}-${suffix}`,
      submittedCharacterName: "Ownership Smoke Character",
      modalAnswers: [],
      albionServer
    })));
    await Promise.all(applications.map((application) => applicationRepository.selectApplicationCharacter(
      guildId,
      application.applicationId,
      characterId
    )));

    const attempts = await Promise.allSettled(applications.map((application, index) => membershipRepository.completeApplicationAcceptance({
      applicationId: application.applicationId,
      reviewerDiscordUserId: `ownership-reviewer-${index}-${suffix}`,
      expectedApplicationStatus: "open",
      discordGuildId: guildId,
      discordUserId: applicants[index],
      albionServer,
      player: { id: characterId, name: "Ownership Smoke Character" }
    })));
    if (
      attempts.filter((attempt) => attempt.status === "fulfilled").length !== 1
      || attempts.filter((attempt) => attempt.status === "rejected" && attempt.reason instanceof CharacterAlreadyRegisteredError).length !== 1
    ) {
      throw new Error("Expected concurrent application acceptance to retain one owner and return one ownership conflict.");
    }
    const owners = await membershipRepository.listRegisteredCharacters(guildId);
    if (owners.length !== 1 || !applicants.includes(owners[0].discordUserId)) {
      throw new Error("Expected concurrent application acceptance to retain exactly one character owner.");
    }
    const resolvedApplications = await Promise.all(applications.map((application) => applicationRepository.getOpenApplication(guildId, application.applicationId)));
    const accepted = resolvedApplications.filter((application) => application?.status === "accepted");
    const undecided = resolvedApplications.filter((application) => application?.status === "open");
    if (accepted.length !== 1 || undecided.length !== 1 || undecided[0]?.applicantDiscordUserId === owners[0].discordUserId) {
      throw new Error("Expected the losing application acceptance to roll back and remain undecided.");
    }
  } finally {
    await postgres.query("delete from open_applications where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query("delete from application_classes where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query("delete from discord_user_main_characters where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query("delete from discord_user_characters where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query("delete from character_registration_history where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query("delete from discord_guild_lifecycle where discord_guild_id = $1", [guildId]).catch(() => undefined);
    await postgres.query(
      "delete from albion_characters where albion_server = $1 and albion_character_id = $2",
      [albionServer, characterId]
    ).catch(() => undefined);
    const retained = await postgres.query(
      `select 1 from discord_guild_lifecycle where discord_guild_id = $1
       union all select 1 from discord_user_main_characters where discord_guild_id = $1
       union all select 1 from discord_user_characters where discord_guild_id = $1
       union all select 1 from character_registration_history where discord_guild_id = $1
       union all select 1 from open_applications where discord_guild_id = $1
       union all select 1 from application_classes where discord_guild_id = $1
       union all select 1 from albion_characters where albion_server = $2 and albion_character_id = $3`,
      [guildId, albionServer, characterId]
    );
    if ((retained.rowCount ?? 0) !== 0) throw new Error("Expected application ownership concurrency smoke fixtures to be removed.");
  }
}

async function runGuildLifecyclePurgeSmoke(postgres: PostgresPool): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const targetGuildId = `smoke-purge-guild-${runId}`;
  const otherGuildId = `smoke-purge-other-guild-${runId}`;
  const albionServer = "europe";
  const sharedCharacterId = `smoke-purge-shared-character-${runId}`;
  const targetOnlyCharacterId = `smoke-purge-target-character-${runId}`;
  const lifecycleRepository = createGuildLifecycleRepository(postgres);

  try {
    await postgres.query(
      `
      insert into albion_characters (albion_server, albion_character_id, character_name)
      values ($1, $2, $3), ($1, $4, $5)
      `,
      [
        albionServer,
        sharedCharacterId,
        "Smoke Shared Purge",
        targetOnlyCharacterId,
        "Smoke Target Purge"
      ]
    );
    await postgres.query(
      `
      insert into discord_guild_lifecycle (
        discord_guild_id,
        status,
        guild_name,
        activated_at,
        activated_by_discord_user_id
      )
      values
        ($1, 'active', 'Smoke Purge Guild', now(), 'smoke-actor'),
        ($2, 'active', 'Smoke Other Guild', now(), 'smoke-actor')
      `,
      [targetGuildId, otherGuildId]
    );
    await postgres.query(
      `
      insert into discord_user_characters (
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values
        ($1, 'smoke-target-user', $3, $4),
        ($2, 'smoke-other-user', $3, $4)
      `,
      [targetGuildId, otherGuildId, albionServer, sharedCharacterId]
    );
    await postgres.query(
      `
      insert into discord_user_custom_nicknames (discord_guild_id, discord_user_id, nickname)
      values ($1, 'smoke-target-user', 'Smoke Target')
      `,
      [targetGuildId]
    );
    await postgres.query(
      `
      insert into character_role_configs (discord_guild_id, albion_server, discord_role_id)
      values ($1, $2, 'smoke-purge-role')
      `,
      [targetGuildId, albionServer]
    );
    const groupResult = await postgres.query<{ member_group_id: string }>(
      `
      insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
      values ($1, $2, 'group', 'Smoke Purge Group')
      returning member_group_id
      `,
      [targetGuildId, albionServer]
    );
    const memberGroupId = groupResult.rows[0].member_group_id;
    await postgres.query(
      `
      insert into member_group_profiles (
        member_group_id,
        discord_guild_id,
        discord_user_id,
        albion_server,
        albion_character_id
      )
      values ($1, $2, 'smoke-target-user', $3, $4)
      `,
      [memberGroupId, targetGuildId, albionServer, sharedCharacterId]
    );
    await postgres.query(
      `
      insert into member_group_role_configs (member_group_id, discord_role_id)
      values ($1, 'smoke-purge-group-role')
      `,
      [memberGroupId]
    );
    const applicationClassResult = await postgres.query<{ application_class_id: string }>(
      `
      insert into application_classes (
        discord_guild_id,
        name,
        outcome_type,
        member_group_id,
        albion_server,
        ticket_category_id,
        reviewer_role_id,
        created_by_discord_user_id
      )
      values ($1, 'Smoke Purge Application', 'member_group', $2, $3, 'smoke-category', 'smoke-reviewer', 'smoke-actor')
      returning application_class_id
      `,
      [targetGuildId, memberGroupId, albionServer]
    );
    await postgres.query(
      `
      insert into open_applications (
        application_class_id,
        discord_guild_id,
        applicant_discord_user_id,
        ticket_channel_id,
        submitted_character_name,
        albion_server
      )
      values ($1, $2, 'smoke-applicant', 'smoke-application-channel', 'Smoke Character', $3)
      `,
      [applicationClassResult.rows[0].application_class_id, targetGuildId, albionServer]
    );
    const ticketClassResult = await postgres.query<{ ticket_class_id: string }>(
      `
      insert into ticket_classes (
        discord_guild_id,
        name,
        ticket_category_id,
        reviewer_role_id,
        created_by_discord_user_id
      )
      values ($1, 'Smoke Purge Ticket', 'smoke-ticket-category', 'smoke-ticket-reviewer', 'smoke-actor')
      returning ticket_class_id
      `,
      [targetGuildId]
    );
    await postgres.query(
      `
      insert into tickets (
        ticket_class_id,
        discord_guild_id,
        opener_discord_user_id,
        ticket_channel_id
      )
      values ($1, $2, 'smoke-ticket-opener', 'smoke-ticket-channel')
      `,
      [ticketClassResult.rows[0].ticket_class_id, targetGuildId]
    );

    await lifecycleRepository.purgeGuildImmediately(targetGuildId);

    const targetRows = await postgres.query<{ row_count: string }>(
      `
      select sum(row_count)::text as row_count
      from (
        select count(*) as row_count from discord_guild_lifecycle where discord_guild_id = $1
        union all
        select count(*) as row_count from discord_user_characters where discord_guild_id = $1
        union all
        select count(*) as row_count from discord_user_custom_nicknames where discord_guild_id = $1
        union all
        select count(*) as row_count from character_role_configs where discord_guild_id = $1
        union all
        select count(*) as row_count from member_groups where discord_guild_id = $1
        union all
        select count(*) as row_count from member_group_profiles where discord_guild_id = $1
        union all
        select count(*) as row_count from open_applications where discord_guild_id = $1
        union all
        select count(*) as row_count from application_classes where discord_guild_id = $1
        union all
        select count(*) as row_count from tickets where discord_guild_id = $1
        union all
        select count(*) as row_count from ticket_classes where discord_guild_id = $1
      ) purge_check
      `,
      [targetGuildId]
    );
    if (targetRows.rows[0]?.row_count !== "0") {
      throw new Error("Expected guild lifecycle purge to remove all target guild-owned rows.");
    }

    const otherRegistration = await postgres.query(
      `
      select 1
      from discord_user_characters
      where discord_guild_id = $1
        and albion_server = $2
        and albion_character_id = $3
      `,
      [otherGuildId, albionServer, sharedCharacterId]
    );
    if ((otherRegistration.rowCount ?? 0) !== 1) {
      throw new Error("Expected guild lifecycle purge to preserve other guild data.");
    }

    const sharedCharacter = await postgres.query(
      `
      select 1
      from albion_characters
      where albion_server = $1
        and albion_character_id = $2
      `,
      [albionServer, sharedCharacterId]
    );
    if ((sharedCharacter.rowCount ?? 0) !== 1) {
      throw new Error("Expected guild lifecycle purge to preserve shared Albion Online character rows.");
    }
  } finally {
    await lifecycleRepository.purgeGuildImmediately(targetGuildId).catch(() => undefined);
    await lifecycleRepository.purgeGuildImmediately(otherGuildId).catch(() => undefined);
    await postgres.query(
      `
      delete from albion_characters
      where albion_server = $1
        and albion_character_id in ($2, $3)
      `,
      [albionServer, sharedCharacterId, targetOnlyCharacterId]
    ).catch(() => undefined);
  }
}

interface ResetSmokeFixture {
  memberGroupRoleConfigId: string;
}

async function runGuildResetSmoke(postgres: PostgresPool): Promise<void> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const targetGuildId = `smoke-reset-target-${runId}`;
  const otherGuildId = `smoke-reset-other-${runId}`;
  const albionServer = "americas";
  const sharedCharacterId = `smoke-reset-character-${runId}`;
  const resetRepository = createResetRepository(postgres);
  let targetFixture: ResetSmokeFixture | undefined;
  let otherFixture: ResetSmokeFixture | undefined;

  try {
    await postgres.query(
      `
      insert into albion_characters (albion_server, albion_character_id, character_name)
      values ($1, $2, 'Smoke Reset Character')
      `,
      [albionServer, sharedCharacterId]
    );
    targetFixture = await seedResetSmokeGuild(
      postgres,
      targetGuildId,
      `target-${runId}`,
      albionServer,
      sharedCharacterId
    );
    otherFixture = await seedResetSmokeGuild(
      postgres,
      otherGuildId,
      `other-${runId}`,
      albionServer,
      sharedCharacterId
    );

    await resetRepository.purgeGuildData(targetGuildId);

    for (const table of RESET_DIRECT_GUILD_TABLES) {
      const targetRows = await postgres.query<{ row_count: number }>(
        `select count(*)::integer as row_count from ${table} where discord_guild_id = $1`,
        [targetGuildId]
      );
      if (targetRows.rows[0]?.row_count !== 0) {
        throw new Error(`Expected guild reset to remove target rows from ${table}.`);
      }

      const otherRows = await postgres.query<{ row_count: number }>(
        `select count(*)::integer as row_count from ${table} where discord_guild_id = $1`,
        [otherGuildId]
      );
      if (!otherRows.rows[0]?.row_count) {
        throw new Error(`Expected guild reset to preserve other-guild rows in ${table}.`);
      }
    }

    const targetRoleConfig = await postgres.query(
      "select 1 from member_group_role_configs where member_group_role_config_id = $1",
      [targetFixture.memberGroupRoleConfigId]
    );
    if ((targetRoleConfig.rowCount ?? 0) !== 0) {
      throw new Error("Expected guild reset to remove target member-group role configuration.");
    }

    const otherRoleConfig = await postgres.query(
      "select 1 from member_group_role_configs where member_group_role_config_id = $1",
      [otherFixture.memberGroupRoleConfigId]
    );
    if ((otherRoleConfig.rowCount ?? 0) !== 1) {
      throw new Error("Expected guild reset to preserve other-guild member-group role configuration.");
    }

    const targetLifecycle = await postgres.query<{
      status: string;
      activated_by_discord_user_id: string | null;
    }>(
      `
      select status, activated_by_discord_user_id
      from discord_guild_lifecycle
      where discord_guild_id = $1
      `,
      [targetGuildId]
    );
    if (
      targetLifecycle.rows[0]?.status !== "active"
      || targetLifecycle.rows[0]?.activated_by_discord_user_id !== `actor-target-${runId}`
    ) {
      throw new Error("Expected guild reset to preserve the target guild's active lifecycle row.");
    }

    const sharedCharacter = await postgres.query(
      `
      select 1
      from albion_characters
      where albion_server = $1
        and albion_character_id = $2
      `,
      [albionServer, sharedCharacterId]
    );
    if ((sharedCharacter.rowCount ?? 0) !== 1) {
      throw new Error("Expected guild reset to preserve shared Albion Online character cache rows.");
    }
  } finally {
    await resetRepository.purgeGuildData(targetGuildId).catch(() => undefined);
    await resetRepository.purgeGuildData(otherGuildId).catch(() => undefined);
    await postgres.query(
      "delete from discord_guild_lifecycle where discord_guild_id in ($1, $2)",
      [targetGuildId, otherGuildId]
    ).catch(() => undefined);
    await postgres.query(
      `
      delete from albion_characters
      where albion_server = $1
        and albion_character_id = $2
      `,
      [albionServer, sharedCharacterId]
    ).catch(() => undefined);
  }
}

async function seedResetSmokeGuild(
  postgres: PostgresPool,
  discordGuildId: string,
  suffix: string,
  albionServer: string,
  albionCharacterId: string
): Promise<ResetSmokeFixture> {
  const discordUserId = `user-${suffix}`;
  await postgres.query(
    `
    insert into discord_guild_lifecycle (
      discord_guild_id,
      status,
      guild_name,
      activated_at,
      activated_by_discord_user_id
    )
    values ($1, 'active', $2, now(), $3)
    `,
    [discordGuildId, `Reset Smoke ${suffix}`, `actor-${suffix}`]
  );
  await postgres.query(
    `
    insert into discord_user_characters (
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id
    )
    values ($1, $2, $3, $4)
    `,
    [discordGuildId, discordUserId, albionServer, albionCharacterId]
  );
  await postgres.query(
    `insert into specialisation_reviewer_configs (
      discord_guild_id, reviewer_role_id, updated_by_discord_user_id
    ) values ($1, $2, $3)`,
    [discordGuildId, `specialisation-role-${suffix}`, discordUserId]
  );
  await postgres.query(
    `insert into specialisation_catalogue_exclusions (
      discord_guild_id, catalogue_key, excluded_by_discord_user_id
    ) values ($1, 'weapon:warbow', $2)`,
    [discordGuildId, discordUserId]
  );
  await postgres.query(
    `insert into specialisation_requests (
      discord_guild_id, submitted_by_discord_user_id, albion_server, albion_character_id,
      target_key, target_kind, target_display_name, level, review_channel_id
    ) values ($1, $2, $3, $4, 'weapon:warbow', 'weapon', 'Warbow', 100, $5)`,
    [discordGuildId, discordUserId, albionServer, albionCharacterId, `specialisation-channel-${suffix}`]
  );
  await postgres.query(
    `insert into character_specialisations (
      discord_guild_id, albion_server, albion_character_id, target_key, target_kind,
      target_display_name, level, source, recorded_by_discord_user_id
    ) values ($1, $2, $3, 'weapon:battleaxe', 'weapon', 'Battleaxe', 100, 'manual', $4)`,
    [discordGuildId, albionServer, albionCharacterId, discordUserId]
  );
  await postgres.query(
    `
    insert into discord_user_custom_nicknames (discord_guild_id, discord_user_id, nickname)
    values ($1, $2, $3)
    `,
    [discordGuildId, discordUserId, `Nickname ${suffix}`]
  );
  await postgres.query(
    `
    insert into character_role_configs (discord_guild_id, albion_server, discord_role_id)
    values ($1, $2, $3)
    `,
    [discordGuildId, albionServer, `character-role-${suffix}`]
  );

  const customGroup = await postgres.query<{ member_group_id: string }>(
    `
    insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
    values ($1, $2, 'group', $3)
    returning member_group_id
    `,
    [discordGuildId, albionServer, `Group ${suffix}`]
  );
  const guildGroup = await postgres.query<{ member_group_id: string }>(
    `
    insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
    values ($1, $2, 'guild', $3)
    returning member_group_id
    `,
    [discordGuildId, albionServer, `Guild ${suffix}`]
  );
  const allianceGroup = await postgres.query<{ member_group_id: string }>(
    `
    insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
    values ($1, $2, 'alliance', $3)
    returning member_group_id
    `,
    [discordGuildId, albionServer, `Alliance ${suffix}`]
  );
  const customGroupId = customGroup.rows[0].member_group_id;
  const guildGroupId = guildGroup.rows[0].member_group_id;
  const allianceGroupId = allianceGroup.rows[0].member_group_id;

  await postgres.query(
    `
    insert into configured_albion_guilds (
      member_group_id,
      discord_guild_id,
      albion_server,
      albion_guild_id,
      albion_guild_name,
      managed
    )
    values ($1, $2, $3, $4, $5, true)
    `,
    [guildGroupId, discordGuildId, albionServer, `albion-guild-${suffix}`, `Guild ${suffix}`]
  );
  await postgres.query(
    `
    insert into configured_albion_alliances (
      member_group_id,
      discord_guild_id,
      albion_server,
      albion_alliance_id,
      albion_alliance_name,
      albion_alliance_tag
    )
    values ($1, $2, $3, $4, $5, $6)
    `,
    [
      allianceGroupId,
      discordGuildId,
      albionServer,
      `albion-alliance-${suffix}`,
      `Alliance ${suffix}`,
      "RST"
    ]
  );
  await postgres.query(
    `
    insert into discord_guild_defaults (
      discord_guild_id,
      default_albion_guild_member_group_id,
      default_albion_server
    )
    values ($1, $2, $3)
    `,
    [discordGuildId, guildGroupId, albionServer]
  );

  const profile = await postgres.query<{ member_group_profile_id: string }>(
    `
    insert into member_group_profiles (
      member_group_id,
      discord_guild_id,
      discord_user_id,
      albion_server,
      albion_character_id
    )
    values ($1, $2, $3, $4, $5)
    returning member_group_profile_id
    `,
    [customGroupId, discordGuildId, discordUserId, albionServer, albionCharacterId]
  );
  const memberGroupRoleConfig = await postgres.query<{ member_group_role_config_id: string }>(
    `
    insert into member_group_role_configs (member_group_id, discord_role_id)
    values ($1, $2)
    returning member_group_role_config_id
    `,
    [customGroupId, `group-role-${suffix}`]
  );
  const position = await postgres.query<{ member_group_position_id: string }>(
    `
    insert into member_group_positions (
      discord_guild_id,
      member_group_id,
      name,
      discord_role_id
    )
    values ($1, $2, $3, $4)
    returning member_group_position_id
    `,
    [discordGuildId, customGroupId, `Position ${suffix}`, `position-role-${suffix}`]
  );
  await postgres.query(
    `
    insert into member_group_position_appointments (
      member_group_position_id,
      member_group_profile_id,
      discord_guild_id
    )
    values ($1, $2, $3)
    `,
    [
      position.rows[0].member_group_position_id,
      profile.rows[0].member_group_profile_id,
      discordGuildId
    ]
  );

  await postgres.query(
    `
    insert into utc_voice_channels (discord_guild_id, discord_channel_id)
    values ($1, $2)
    `,
    [discordGuildId, `utc-channel-${suffix}`]
  );
  await postgres.query(
    `
    insert into log_channel_configs (
      discord_guild_id,
      discord_channel_id,
      configured_by_discord_user_id
    )
    values ($1, $2, $3)
    `,
    [discordGuildId, `log-channel-${suffix}`, discordUserId]
  );
  await postgres.query(
    `
    insert into temporary_voice_configs (discord_guild_id, base_channel_id)
    values ($1, $2)
    `,
    [discordGuildId, `temporary-voice-base-${suffix}`]
  );
  await postgres.query(
    `
    insert into temporary_voice_channels (
      discord_guild_id,
      discord_channel_id,
      owner_discord_user_id,
      base_channel_id
    )
    values ($1, $2, $3, $4)
    `,
    [
      discordGuildId,
      `temporary-voice-channel-${suffix}`,
      discordUserId,
      `temporary-voice-base-${suffix}`
    ]
  );
  await postgres.query(
    `
    insert into member_update_schedules (
      discord_guild_id,
      cadence,
      weekday,
      hour_utc,
      minute_utc,
      created_by_discord_user_id
    )
    values ($1, 'daily', null, 12, 0, $2)
    `,
    [discordGuildId, discordUserId]
  );

  const applicationClass = await postgres.query<{ application_class_id: string }>(
    `
    insert into application_classes (
      discord_guild_id,
      name,
      outcome_type,
      member_group_id,
      albion_server,
      ticket_category_id,
      reviewer_role_id,
      created_by_discord_user_id
    )
    values ($1, $2, 'member_group', $3, $4, $5, $6, $7)
    returning application_class_id
    `,
    [
      discordGuildId,
      `Application ${suffix}`,
      customGroupId,
      albionServer,
      `application-category-${suffix}`,
      `application-reviewer-${suffix}`,
      discordUserId
    ]
  );
  await postgres.query(
    `
    insert into open_applications (
      application_class_id,
      discord_guild_id,
      applicant_discord_user_id,
      ticket_channel_id,
      submitted_character_name,
      albion_server
    )
    values ($1, $2, $3, $4, $5, $6)
    `,
    [
      applicationClass.rows[0].application_class_id,
      discordGuildId,
      discordUserId,
      `application-channel-${suffix}`,
      `Character ${suffix}`,
      albionServer
    ]
  );

  const ticketClass = await postgres.query<{ ticket_class_id: string }>(
    `
    insert into ticket_classes (
      discord_guild_id,
      name,
      ticket_category_id,
      reviewer_role_id,
      created_by_discord_user_id
    )
    values ($1, $2, $3, $4, $5)
    returning ticket_class_id
    `,
    [
      discordGuildId,
      `Ticket ${suffix}`,
      `ticket-category-${suffix}`,
      `ticket-reviewer-${suffix}`,
      discordUserId
    ]
  );
  await postgres.query(
    `
    insert into tickets (
      ticket_class_id,
      discord_guild_id,
      opener_discord_user_id,
      ticket_channel_id
    )
    values ($1, $2, $3, $4)
    `,
    [
      ticketClass.rows[0].ticket_class_id,
      discordGuildId,
      discordUserId,
      `ticket-channel-${suffix}`
    ]
  );

  await postgres.query(
    `
    insert into content_channel_configs (discord_guild_id, discord_channel_id)
    values ($1, $2)
    `,
    [discordGuildId, `content-channel-${suffix}`]
  );
  await postgres.query(
    `
    insert into content_templates (
      discord_guild_id,
      name,
      title,
      description,
      roles_text,
      created_by_discord_user_id,
      updated_by_discord_user_id
    )
    values ($1, $2, $3, $4, $5, $6, $6)
    `,
    [
      discordGuildId,
      `Template ${suffix}`,
      `Content ${suffix}`,
      "Smoke reset content",
      "Tank",
      discordUserId
    ]
  );
  const content = await postgres.query<{ content_id: string }>(
    `
    insert into content_items (
      discord_guild_id,
      source_channel_id,
      thread_channel_id,
      leader_discord_user_id,
      title,
      description,
      scheduled_start_at
    )
    values ($1, $2, $3, $4, $5, $6, now() + interval '1 day')
    returning content_id
    `,
    [
      discordGuildId,
      `content-source-${suffix}`,
      `content-thread-${suffix}`,
      discordUserId,
      `Content ${suffix}`,
      "Smoke reset content"
    ]
  );
  const slot = await postgres.query<{ content_role_slot_id: string }>(
    `
    insert into content_role_slots (content_id, discord_guild_id, slot_index, label)
    values ($1, $2, 1, 'Tank')
    returning content_role_slot_id
    `,
    [content.rows[0].content_id, discordGuildId]
  );
  await postgres.query(
    `
    insert into content_signups (
      content_id,
      content_role_slot_id,
      discord_guild_id,
      discord_user_id
    )
    values ($1, $2, $3, $4)
    `,
    [
      content.rows[0].content_id,
      slot.rows[0].content_role_slot_id,
      discordGuildId,
      discordUserId
    ]
  );

  const giveaway = await postgres.query<{ giveaway_id: string }>(
    `
    insert into giveaways (
      discord_guild_id,
      channel_id,
      original_message_id,
      announcement_message_id,
      creator_discord_user_id,
      title,
      description,
      image_attachment_name,
      draw_at,
      winner_count,
      state,
      drawn_at,
      original_message_deleted_at
    ) values ($1, $2, $3, $4, $5, $6, $7, 'giveaway-image.png', now(), 1, 'drawn', now(), now())
    returning giveaway_id
    `,
    [
      discordGuildId,
      `giveaway-channel-${suffix}`,
      `giveaway-original-${suffix}`,
      `giveaway-announcement-${suffix}`,
      discordUserId,
      `Giveaway ${suffix}`,
      "Smoke reset giveaway"
    ]
  );
  await postgres.query(
    `
    insert into giveaway_entries (giveaway_id, discord_guild_id, discord_user_id)
    values ($1, $2, $3)
    `,
    [giveaway.rows[0].giveaway_id, discordGuildId, discordUserId]
  );
  await postgres.query(
    `
    insert into giveaway_reactions (giveaway_id, discord_guild_id, discord_user_id, emoji_key)
    values ($1, $2, $3, 'unicode:🎁')
    `,
    [giveaway.rows[0].giveaway_id, discordGuildId, discordUserId]
  );
  await postgres.query(
    `
    insert into giveaway_winners (giveaway_id, discord_guild_id, discord_user_id, winner_position)
    values ($1, $2, $3, 1)
    `,
    [giveaway.rows[0].giveaway_id, discordGuildId, discordUserId]
  );

  const reactionRole = await postgres.query<{ reaction_role_config_id: string }>(
    `
    insert into reaction_role_configs (
      discord_guild_id,
      discord_role_id,
      created_by_discord_user_id
    )
    values ($1, $2, $3)
    returning reaction_role_config_id
    `,
    [discordGuildId, `reaction-role-${suffix}`, discordUserId]
  );
  await postgres.query(
    `
    insert into reaction_role_emoji_placements (
      reaction_role_config_id,
      discord_guild_id,
      channel_id,
      message_id,
      emoji_key,
      emoji_display_value,
      created_by_discord_user_id
    )
    values ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      reactionRole.rows[0].reaction_role_config_id,
      discordGuildId,
      `reaction-channel-${suffix}`,
      `reaction-message-${suffix}`,
      `unicode:✅`,
      "✅",
      discordUserId
    ]
  );
  await postgres.query(
    `
    insert into reaction_role_subscriptions (
      reaction_role_config_id,
      discord_guild_id,
      discord_user_id
    )
    values ($1, $2, $3)
    `,
    [reactionRole.rows[0].reaction_role_config_id, discordGuildId, discordUserId]
  );
  await postgres.query(
    `
    insert into giveaway_notification_roles (
      reaction_role_config_id,
      discord_guild_id,
      created_by_discord_user_id
    )
    values ($1, $2, $3)
    `,
    [reactionRole.rows[0].reaction_role_config_id, discordGuildId, discordUserId]
  );

  const account = await postgres.query<{ account_id: string }>(
    `
    update character_accounts
    set balance = 10, updated_at = now()
    where discord_guild_id = $1
      and albion_server = $2
      and albion_character_id = $3
    returning account_id
    `,
    [discordGuildId, albionServer, albionCharacterId]
  );
  await postgres.query(
    `
    insert into account_transactions (
      account_id,
      discord_guild_id,
      transaction_type,
      amount,
      balance_after,
      actor_discord_user_id,
      description
    )
    values ($1, $2, 'credit', 10, 10, $3, 'Reset smoke credit')
    `,
    [account.rows[0].account_id, discordGuildId, discordUserId]
  );

  const regearContent = await postgres.query<{ regear_content_id: string }>(
    `insert into regear_contents (
      discord_guild_id, albion_server, name, content_date, channel_id, created_by_discord_user_id
    ) values ($1, $2, $3, current_date, $4, $5)
    returning regear_content_id`,
    [discordGuildId, albionServer, `Re-Gear ${suffix}`, `regear-channel-${suffix}`, discordUserId]
  );
  await postgres.query(
    `insert into regear_claims (
      regear_claim_id, discord_guild_id, regear_content_id, albion_server,
      albion_character_id, original_submitter_discord_user_id, requested_value,
      review_channel_id, review_message_id
    ) values ($1, $2, $3, $4, $5, $6, 10, $7, $8)`,
    [
      randomUUID(),
      discordGuildId,
      regearContent.rows[0].regear_content_id,
      albionServer,
      albionCharacterId,
      discordUserId,
      `regear-channel-${suffix}`,
      `regear-review-${suffix}`
    ]
  );

  await postgres.query(`insert into member_registration_lifecycle (discord_guild_id, albion_server, albion_character_id, source, state, detected_at, expires_at)
    values ($1, $2, $3, 'discord_departure', 'hold', now(), now() + interval '72 hours')`, [discordGuildId, albionServer, albionCharacterId]);
  await postgres.query(`insert into membership_evidence_cleanup (discord_guild_id, channel_id, message_id) values ($1, $2, $3)`, [discordGuildId, `cleanup-channel-${suffix}`, `cleanup-message-${suffix}`]);
  // Include persisted kick state so reset verifies deletion and tenant isolation
  // of every new table, including a completed character recovery's marker.
  const kickedUserId = `kicked-${suffix}`;
  await postgres.query(`insert into guild_member_access (discord_guild_id, discord_user_id, last_kicked_at)
    values ($1, $2, now())`, [discordGuildId, kickedUserId]);
  await postgres.query(`insert into character_kick_recovery
    (discord_guild_id, albion_server, albion_character_id, disconnected_discord_user_id, recovery_required)
    values ($1, $2, $3, $4, false)`, [discordGuildId, albionServer, albionCharacterId, kickedUserId]);
  await postgres.query(`insert into member_kick_activity_revocations (discord_guild_id, discord_user_id, kind, target_id)
    values ($1, $2, 'content_host', $3)`, [discordGuildId, kickedUserId, `retired-content-${suffix}`]);
  await postgres.query(`insert into member_kick_activity_cleanup (discord_guild_id, discord_user_id, kind, target_id, channel_id)
    values ($1, $2, 'content', $3, $4)`, [discordGuildId, kickedUserId, `retired-content-${suffix}`, `cleanup-channel-${suffix}`]);
  return {
    memberGroupRoleConfigId: memberGroupRoleConfig.rows[0].member_group_role_config_id
  };
}

async function expectDatabaseFailure(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  label: string,
  operation: () => Promise<unknown>
): Promise<void> {
  const savepointName = `expect_failure_${Math.random().toString(36).slice(2)}`;
  await client.query(`savepoint ${savepointName}`);

  try {
    await operation();
  } catch {
    await client.query(`rollback to savepoint ${savepointName}`);
    await client.query(`release savepoint ${savepointName}`);
    return;
  }

  await client.query(`rollback to savepoint ${savepointName}`);
  await client.query(`release savepoint ${savepointName}`);
  throw new Error(`Expected database failure did not occur: ${label}`);
}

async function expectCheckConstraintFailure(
  label: string,
  constraint: string,
  operation: () => Promise<unknown>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && "constraint" in error
      && error.code === "23514"
      && error.constraint === constraint
    ) return;
    throw error;
  }

  throw new Error(`Expected check-constraint failure did not occur: ${label}`);
}

function createSmokeGuild(
  discordGuildId: string,
  expectedDiscordUserId: string,
  options: {
    initialRoleIds?: string[];
    members?: Record<string, string[]>;
    onAdd?: (roleIds: string[]) => void;
    onRemove?: (roleIds: string[]) => void;
    failRoleUpdate?: boolean;
  } = {}
): Guild {
  const memberRoleIds = new Map<string, Set<string>>();
  const configuredMembers = options.members ?? {
    [expectedDiscordUserId]: options.initialRoleIds ?? []
  };
  for (const [discordUserId, roleIds] of Object.entries(configuredMembers)) {
    memberRoleIds.set(discordUserId, new Set(roleIds));
  }

  const buildMember = (discordUserId: string) => {
    const assignedRoleIds = memberRoleIds.get(discordUserId);
    if (!assignedRoleIds) {
      throw new Error(`Unexpected Discord user fetch: ${discordUserId}`);
    }

    return {
      id: discordUserId,
      guild: { id: discordGuildId },
      roles: {
        cache: {
          has: (roleId: string) => assignedRoleIds.has(roleId)
        },
        add: async (roleIds: string | string[]) => {
          if (options.failRoleUpdate) {
            throw new Error("smoke role update failed");
          }
          const normalized = Array.isArray(roleIds) ? roleIds : [roleIds];
          for (const roleId of normalized) {
            assignedRoleIds.add(roleId);
          }
          options.onAdd?.(normalized);
        },
        remove: async (roleIds: string | string[]) => {
          if (options.failRoleUpdate) {
            throw new Error("smoke role update failed");
          }
          const normalized = Array.isArray(roleIds) ? roleIds : [roleIds];
          for (const roleId of normalized) {
            assignedRoleIds.delete(roleId);
          }
          options.onRemove?.(normalized);
        }
      }
    };
  };

  return {
    id: discordGuildId,
    members: {
      fetch: async (request?: string | { user: string; force?: boolean }) => {
        const discordUserId = typeof request === "string" ? request : request?.user;
        if (!discordUserId) {
          return new Map([...memberRoleIds.keys()].map((memberId) => [memberId, buildMember(memberId)]));
        }

        return buildMember(discordUserId);
      }
    }
  } as unknown as Guild;
}

async function runCustomGroupProfileRemovalSmoke(postgres: PostgresPool): Promise<void> {
  const client = await postgres.connect();
  try {
    await client.query("begin");
    const pool = createQueuedTransactionPool(client);
    const membership = createMembershipRepository(pool);
    const accounts = createAccountRepository(pool);
    const suffix = randomUUID();
    const guild = `smoke-removal-${suffix}`, otherGuild = `smoke-removal-other-${suffix}`;
    const user = "removal-owner", otherUser = "other-owner";
    const characterId = `removal-character-${suffix}`, otherCharacterId = `other-character-${suffix}`;
    const registration = { discordGuildId: guild, discordUserId: user, albionServer: "asia" as const, player: { id: characterId, name: "Removal Character" } };
    await membership.registerCharacter(registration);
    await membership.registerCharacter({ ...registration, albionServer: "europe" });
    await membership.registerCharacter({ ...registration, discordGuildId: otherGuild });
    await membership.registerCharacter({ ...registration, discordUserId: otherUser, player: { id: otherCharacterId, name: "Other Character" } });

    const group = async (name: string, type = "group", discordGuildId = guild, server = "asia") => {
      const result = await pool.query<{ member_group_id: string }>(
        `insert into member_groups (discord_guild_id, albion_server, group_type, group_name)
         values ($1, $2, $3, $4) returning member_group_id`,
        [discordGuildId, server, type, name]
      );
      return result.rows[0].member_group_id;
    };
    const friends = await group("Friends"), alliance = await group("Alliance", "alliance"), autoGuild = await group("Guild", "guild");
    const otherFriends = await group("Friends", "group", otherGuild), europeFriends = await group("Friends", "group", guild, "europe");
    await pool.query(
      `insert into configured_albion_alliances (member_group_id, discord_guild_id, albion_server, albion_alliance_id, albion_alliance_name)
       values ($1, $2, 'asia', $3, 'Alliance')`,
      [alliance, guild, `removal-alliance-${suffix}`]
    );
    const ref = { discordGuildId: guild, albionServer: "asia" as const, albionCharacterId: characterId };
    const target = { ...ref, memberGroupId: friends };
    const friendsProfile = (await membership.addRegisteredProfile({ ...target, discordUserId: user }))!;
    const allianceProfile = (await membership.addRegisteredProfile({ ...ref, memberGroupId: alliance, discordUserId: user }))!;
    await membership.addRegisteredProfile({ ...ref, memberGroupId: autoGuild, discordUserId: user });
    await membership.addRegisteredProfile({ ...target, albionCharacterId: otherCharacterId, discordUserId: otherUser });
    await membership.addRegisteredProfile({ ...target, memberGroupId: otherFriends, discordGuildId: otherGuild, discordUserId: user });
    await membership.addRegisteredProfile({ ...target, memberGroupId: europeFriends, albionServer: "europe", discordUserId: user });
    await pool.query("insert into character_role_configs (discord_guild_id, discord_role_id) values ($1, 'registered-role')", [guild]);
    for (const [groupId, role] of [[friends, "friends-role"], [friends, "shared-role"], [alliance, "alliance-role"], [alliance, "shared-role"]]) {
      await pool.query("insert into member_group_role_configs (member_group_id, discord_role_id) values ($1, $2)", [groupId, role]);
    }
    for (const [profile, role] of [[friendsProfile, "friends-position"], [allianceProfile, "alliance-position"]] as const) {
      const position = await pool.query<{ member_group_position_id: string }>(
        `insert into member_group_positions (discord_guild_id, member_group_id, name, discord_role_id)
         values ($1, $2, 'Officer', $3) returning member_group_position_id`,
        [guild, profile.memberGroupId, role]
      );
      await pool.query(
        `insert into member_group_position_appointments (member_group_position_id, member_group_profile_id, discord_guild_id)
         values ($1, $2, $3)`,
        [position.rows[0].member_group_position_id, profile.memberGroupProfileId, guild]
      );
    }
    await accounts.adjust(ref, "credit", 100n, user, "Membership removal smoke");
    const registrationsBefore = await membership.listRegisteredCharacters(guild, user);
    const accountBefore = await accounts.getAccount(ref);

    for (const invalid of [
      { ...target, discordGuildId: otherGuild },
      { ...target, albionServer: "europe" as const },
      { ...target, memberGroupId: alliance },
      { ...target, memberGroupId: autoGuild },
      { ...target, albionCharacterId: "missing-character" }
    ]) assert.equal(await membership.removeCustomGroupProfile(invalid), undefined);

    const removed = await membership.removeCustomGroupProfile(target);
    assert.equal(removed?.memberGroupProfileId, friendsProfile.memberGroupProfileId);
    assert.equal(removed?.discordUserId, user);
    assert.equal(removed?.characterName, registration.player.name);
    assert.deepEqual(await membership.listRegisteredCharacters(guild, user), registrationsBefore);
    assert.equal(await membership.hasOrphanProfilesForCharacter(guild, "asia", characterId), false);
    assert.deepEqual((await membership.listProfilesForCharacter(guild, "asia", characterId)).map((profile) => profile.memberGroupId).sort(), [alliance, autoGuild].sort());
    assert.equal((await membership.listProfilesForCharacter(otherGuild, "asia", characterId)).length, 1);
    assert.equal((await membership.listProfilesForCharacter(guild, "europe", characterId)).length, 1);
    assert.equal((await membership.listProfilesForCharacter(guild, "asia", otherCharacterId))[0]?.discordUserId, otherUser);
    assert.deepEqual((await membership.listQualifiedRoleIdsForUser(guild, user)).sort(), ["alliance-position", "alliance-role", "registered-role", "shared-role"]);
    const appointments = await pool.query<{ member_group_profile_id: string }>(
      "select member_group_profile_id from member_group_position_appointments where discord_guild_id = $1", [guild]
    );
    assert.deepEqual(appointments.rows.map((row) => row.member_group_profile_id), [allianceProfile.memberGroupProfileId]);
    assert.deepEqual(await accounts.getAccount(ref), accountBefore);
    assert.equal(await membership.removeCustomGroupProfile(target), undefined);

    // Recovery still adopts retained profiles, but cannot restore a deleted membership.
    await membership.orphanRegisteredProfile({ ...ref, memberGroupId: alliance, discordUserId: user });
    const recoveryProfiles = await membership.listProfilesForCharacter(guild, "asia", characterId);
    await membership.registerCharacterAndAdoptOrphans({ ...registration, recovery: {
      expectedRegistrationRevision: null,
      expectedProfileRevisions: Object.fromEntries(recoveryProfiles.map(profile => [profile.memberGroupId, profile.lifecycleRevision!])),
      verifiedMemberGroupIds: [alliance, autoGuild], unavailableMemberGroupIds: []
    } });
    const recovered = await membership.listProfilesForCharacter(guild, "asia", characterId);
    assert.equal(recovered.some((profile) => profile.memberGroupId === friends), false);
    assert.equal(recovered.find((profile) => profile.memberGroupId === alliance)?.discordUserId, user);

    // A residue from the old removal behaviour can also be deleted individually.
    const orphan = await membership.addOrphanProfile(target);
    assert.equal((await membership.removeCustomGroupProfile(target))?.memberGroupProfileId, orphan.memberGroupProfileId);
    assert.equal(await membership.hasOrphanProfilesForCharacter(guild, "asia", characterId), false);
    assert.equal((await accounts.getAccount(ref))?.balance, 100n);

    const solo = { ...registration, player: { id: `solo-${suffix}`, name: "Solo Character" } };
    await membership.registerCharacter(solo);
    const soloRef = { ...ref, albionCharacterId: solo.player.id };
    const soloTarget = { ...soloRef, memberGroupId: friends };
    await membership.addRegisteredProfile({ ...soloTarget, discordUserId: user });
    await accounts.adjust(soloRef, "credit", 75n, user, "Final profile removal smoke");
    await membership.removeCustomGroupProfile(soloTarget);
    assert.equal((await membership.getRegisteredCharacter(guild, "asia", solo.player.id))?.discordUserId, user);
    const closed = (await accounts.getAccount(soloRef))!;
    assert.equal(closed.status, "closed");
    assert.equal(closed.balance, 0n);
    assert.ok((await accounts.listTransactions(closed.accountId)).some((transaction) => transaction.transactionType === "closure_adjustment" && transaction.amount === -75n));
    console.log("Custom-group profile removal smoke passed.");
  } finally {
    await client.query("rollback");
    client.release();
  }
}

function createQueuedTransactionPool(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }): PostgresPool {
  let queue = Promise.resolve();

  const query = async (sql: string, values?: unknown[]) => {
    const result = queue.then(() => client.query(sql, values));
    queue = result.then(() => undefined, () => undefined);
    return await result;
  };

  return {
    query,
    connect: async () => {
      const savepointName = `repository_tx_${Math.random().toString(36).slice(2)}`;
      let savepointStarted = false;

      return {
        query: async (sql: string, values?: unknown[]) => {
          const normalized = sql.trim().toLocaleLowerCase();
          if (normalized === "begin") {
            await query(`savepoint ${savepointName}`);
            savepointStarted = true;
            return { rows: [], rowCount: 0 };
          }
          if (normalized === "commit" && savepointStarted) {
            await query(`release savepoint ${savepointName}`);
            savepointStarted = false;
            return { rows: [], rowCount: 0 };
          }
          if (normalized === "rollback" && savepointStarted) {
            await query(`rollback to savepoint ${savepointName}`);
            await query(`release savepoint ${savepointName}`);
            savepointStarted = false;
            return { rows: [], rowCount: 0 };
          }
          return query(sql, values);
        },
        release: () => undefined
      };
    }
  } as unknown as PostgresPool;
}

async function assertPlacementConflict(
  operation: Promise<unknown>,
  conflict: "role_has_placement" | "message_emoji_in_use"
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (
      error instanceof ReactionRolePlacementConflictError
      && error.conflict === conflict
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected reaction-role placement conflict: ${conflict}.`);
}

async function runTasksRepositorySmoke(postgres: PostgresPool): Promise<void> {
  const client = await postgres.connect();
  const suffix = randomUUID();
  const guilds = [`smoke-tasks-a-${suffix}`, `smoke-tasks-b-${suffix}`];
  const characterId = `smoke-tasks-character-${suffix}`;
  const caller = "tasks-caller";
  const former = "tasks-former-owner";
  try {
    await client.query("begin");
    const fixturePool = createQueuedTransactionPool(client);
    const applications = createApplicationRepository(fixturePool);
    const tickets = createTicketRepository(fixturePool);
    await client.query(`insert into albion_characters (albion_server, albion_character_id, character_name)
      values ('europe', $1, 'Tasks Character')`, [characterId]);
    for (const guildId of guilds) {
      await client.query(`insert into discord_guild_lifecycle (discord_guild_id, status, guild_name, activated_at)
        values ($1, 'active', 'Tasks Smoke', now())`, [guildId]);
      // Report visibility needs no reviewer role; the first tenant also has no active membership.
      await client.query(`insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id)
        values ($1, $2, 'europe', $3)`, [guildId, caller, characterId]);
      const targetGroup = await createMembershipRepository(fixturePool).createGroup({
        discordGuildId: guildId, albionServer: "europe", groupName: `${guildId} group`
      });
      for (const role of ["tasks-reviewer", "other-reviewer"]) {
        const applicationClass = await applications.createApplicationClass({ discordGuildId: guildId, name: `${guildId}-${role}`, outcomeType: role === "tasks-reviewer" ? "member_group" : "register_character", memberGroupId: role === "tasks-reviewer" ? targetGroup.memberGroupId : undefined, albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: role, createdByDiscordUserId: caller });
        for (const status of ["open", "awaiting_ingame_membership", "accepted", "rejected", "withdrawn"]) {
          for (const channelStatus of ["open", "closed", "deleted"]) {
            await client.query(`insert into open_applications (application_class_id, discord_guild_id, applicant_discord_user_id,
              submitted_character_name, albion_server, status, channel_status, created_at)
              values ($1, $2, $3, 'Tasks Character', 'europe', $4, $5, '2026-09-01T12:00:00Z')`,
            [applicationClass.applicationClassId, guildId, role === "tasks-reviewer" ? caller : former, status, channelStatus]);
          }
        }
        const ticketClass = await tickets.createTicketClass({ discordGuildId: guildId, name: `${guildId}-${role}`, ticketCategoryId: "category", reviewerRoleId: role, createdByDiscordUserId: caller });
        for (const status of ["open", "closed", "deleted"]) {
          await client.query(`insert into tickets (ticket_class_id, discord_guild_id, opener_discord_user_id, status)
            values ($1, $2, $3, $4)`, [ticketClass.ticketClassId, guildId, role === "tasks-reviewer" ? caller : former, status]);
        }
      }
      const content = await client.query<{ regear_content_id: string }>(`insert into regear_contents
        (discord_guild_id, albion_server, name, content_date, content_at, channel_id, created_by_discord_user_id,
          state, closed_by_discord_user_id, closed_at)
        values ($1, 'europe', $1, '2026-08-31', '2026-08-31T08:30:00Z', 'channel', $2, 'closed', $2, now()) returning regear_content_id`, [guildId, caller]);
      for (const status of ["pending", "accepted"]) {
        const claimId = randomUUID();
        await client.query(`insert into regear_claims (regear_claim_id, discord_guild_id, regear_content_id,
          albion_server, albion_character_id, original_submitter_discord_user_id, requested_value,
          status, review_channel_id, review_message_id, accepted_value, accepted_by_discord_user_id, accepted_at)
          values ($1::uuid, $2, $3, 'europe', $4, $5, case when $6 = 'pending' then 9007199254740993 else 2500000 end, $6, 'channel', $1::text,
            case when $6 = 'accepted' then 2500000 end,
            case when $6 = 'accepted' then 'reviewer' end,
            case when $6 = 'accepted' then now() end)`,
        [claimId, guildId, content.rows[0].regear_content_id, characterId, former, status]);
        if (status === "accepted") {
          const account = await client.query<{ account_id: string }>(`insert into character_accounts
            (discord_guild_id, albion_server, albion_character_id, balance)
            values ($1, 'europe', $2, 2500000) returning account_id`, [guildId, characterId]);
          await client.query(`insert into account_transactions
            (account_id, discord_guild_id, transaction_type, amount, balance_after, actor_discord_user_id, regear_claim_id)
            values ($1, $2, 'regear_credit', 2500000, 2500000, 'reviewer', $3)`, [account.rows[0].account_id, guildId, claimId]);
        }
      }
      // Open intake appears even with zero claims, across every represented Albion Online server.
      for (const [label, server, contentAt] of [
        ["date-only", "asia", null], ["timed", "europe", "2026-09-01T12:00:00Z"]
      ]) {
        await client.query(`insert into regear_contents
          (discord_guild_id, albion_server, name, content_date, content_at, channel_id,
            announcement_message_id, created_by_discord_user_id)
          values ($1, $2, $3, '2026-09-01', $4, 'channel', $5, $6)`,
        [guildId, server, `${guildId}-${label}`, contentAt, contentAt ? "announcement" : null, former]);
      }
      const removedId = randomUUID();
      await client.query(`insert into regear_claims (regear_claim_id, discord_guild_id, regear_content_id,
        albion_server, albion_character_id, original_submitter_discord_user_id, requested_value,
        review_channel_id, review_message_id)
        values ($1::uuid, $2, $3, 'europe', $4, $5, 10, 'channel', $1::text)`,
      [removedId, guildId, content.rows[0].regear_content_id, characterId, former]);
      assert.ok(await createRegearRepository(fixturePool).removePendingClaim(guildId, removedId));
      for (const [index, state] of ["pending", "pending", "confirmed", "dismissed"].entries()) {
        await client.query(`insert into specialisation_requests (discord_guild_id, submitted_by_discord_user_id,
          albion_server, albion_character_id, target_key, target_kind, target_display_name, level, state,
          review_channel_id, review_message_id, review_message_deleted_at, reviewed_by_discord_user_id, reviewed_at)
          values ($1, $2, 'europe', $3, $4, 'weapon', $5, 100, $6, 'channel', $7, now(),
            case when $6 <> 'pending' then 'reviewer' end,
            case when $6 <> 'pending' then now() end)`,
        [guildId, index === 1 ? former : caller, characterId, `weapon:tasks-${index}`, `${guildId}-${index}`, state, randomUUID()]);
      }
      for (const owner of [caller, former]) {
        for (const state of ["active", "scheduled", "ended", "cancelled", "archived"]) {
          await client.query(`insert into content_items (discord_guild_id, source_channel_id, thread_channel_id,
            leader_discord_user_id, title, description, scheduled_start_at, state)
            values ($1, 'channel', $2, $3, $1, '', '2026-09-01T12:00:00Z', $4)`, [guildId, randomUUID(), owner, state]);
        }
        for (const state of ["open", "drawn", "cancelled"]) {
          await client.query(`insert into giveaways (discord_guild_id, channel_id, original_message_id,
            creator_discord_user_id, title, description, draw_at, winner_count, state)
            values ($1, 'channel', $2, $3, $1, '', '2026-09-01T12:00:00Z', 1, $4)`, [guildId, randomUUID(), owner, state]);
        }
      }
    }
    // Only the second tenant has a currently entitled owner; a bare registration
    // in the first tenant must not label a pending claim as currently actionable.
    await client.query(`insert into member_group_profiles (member_group_id, discord_guild_id, discord_user_id, albion_server, albion_character_id)
      select member_group_id, $1, $2, 'europe', $3 from member_groups where discord_guild_id = $1`, [guilds[1], caller, characterId]);
    await client.query("set constraints all immediate");
    let reportReads = 0;
    const reportPool = createQueuedTransactionPool({ query: async (sql, values) => {
      assert.match(sql.trim(), /^select\b/i, "Tasks execution must only issue SELECT statements");
      assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|notify)\b/i);
      reportReads++;
      return client.query(sql, values);
    } });
    const repository = createTasksRepository(reportPool);
    for (const guildId of guilds) {
      const snapshot = await repository.getSnapshot(guildId);
      assert.equal(snapshot.applications.length, 10);
      for (const role of ["tasks-reviewer", "other-reviewer"]) {
        const applicationsForClass = snapshot.applications.filter((item) => item.name === `${guildId}-${role}`);
        assert.deepEqual(applicationsForClass.map((item) => item.status),
          ["open", "awaiting_ingame_membership", "accepted", "rejected", "withdrawn"]);
        assert.ok(applicationsForClass.every((item) => item.targetMemberGroupName === (role === "tasks-reviewer" ? `${guildId} group` : undefined)));
      }
      assert.ok(snapshot.applications.every((item) => item.name.startsWith(guildId)));
      assert.equal(snapshot.tickets.length, 2);
      assert.deepEqual(new Set(snapshot.tickets.map((item) => item.name)),
        new Set([`${guildId}-tasks-reviewer`, `${guildId}-other-reviewer`]));
      assert.equal(snapshot.regearContents.length, 2);
      assert.deepEqual(snapshot.regearContents.map((item) => item.name), [`${guildId}-date-only`, `${guildId}-timed`]);
      assert.deepEqual(snapshot.regearContents.map((item) => item.albionServer), ["asia", "europe"]);
      assert.equal(snapshot.regearContents[0].contentDate, "2026-09-01");
      assert.equal(snapshot.regearContents[0].contentAt, undefined);
      assert.equal(snapshot.regearContents[0].announcementMessageId, undefined);
      assert.equal(snapshot.regearContents[1].contentAt?.toISOString(), "2026-09-01T12:00:00.000Z");
      assert.equal(snapshot.regearContents[1].announcementMessageId, "announcement");
      assert.equal(snapshot.regears.length, 1, "Pending requests for closed content remain, accepted and removed requests do not");
      assert.equal(snapshot.regears[0].contentName, guildId);
      assert.equal(snapshot.regears[0].contentDate, "2026-08-31");
      assert.equal(snapshot.regears[0].contentAt?.toISOString(), "2026-08-31T08:30:00.000Z");
      assert.equal(snapshot.regears[0].currentOwnerDiscordUserId, guildId === guilds[1] ? caller : undefined);
      assert.equal(snapshot.regears[0].requestedValue, 9007199254740993n);
      assert.equal(snapshot.specialisations.length, 2);
      assert.deepEqual(new Set(snapshot.specialisations.map((item) => item.submittedByDiscordUserId)), new Set([caller, former]));
      assert.ok(snapshot.specialisations.every((item) => item.targetDisplayName.startsWith(guildId)));
      assert.ok(snapshot.specialisations.every((item) => item.reviewMessageId === undefined));
      assert.deepEqual(Object.keys(snapshot).sort(),
        ["discordGuildId", "applications", "tickets", "regearContents", "regears", "specialisations"].sort());
    }
    // A registration in another Discord guild must never supply a missing current owner.
    await client.query(`delete from discord_user_characters where discord_guild_id = $1`, [guilds[0]]);
    const ownerless = await repository.getSnapshot(guilds[0]);
    assert.equal(ownerless.regears.length, 1);
    assert.equal(ownerless.regears[0].currentOwnerDiscordUserId, undefined);
    assert.equal(ownerless.specialisations.length, 2);
    assert.equal((await repository.getSnapshot(guilds[1])).regears[0].currentOwnerDiscordUserId, caller);
    // Closing/removing all work leaves five explicit empty queues and does not affect the other guild.
    await client.query(`update open_applications set channel_status = 'closed' where discord_guild_id = $1`, [guilds[0]]);
    await client.query(`update tickets set status = 'closed' where discord_guild_id = $1`, [guilds[0]]);
    await client.query(`update regear_contents set state = 'closed', closed_by_discord_user_id = $2, closed_at = now()
      where discord_guild_id = $1 and state = 'open'`, [guilds[0], caller]);
    assert.ok(await createRegearRepository(fixturePool).removePendingClaim(guilds[0], ownerless.regears[0].regearClaimId));
    await client.query(`update specialisation_requests set state = 'dismissed', reviewed_by_discord_user_id = $2,
      reviewed_at = now() where discord_guild_id = $1 and state = 'pending'`, [guilds[0], caller]);
    assert.deepEqual(await repository.getSnapshot(guilds[0]), {
      discordGuildId: guilds[0], applications: [], tickets: [], regearContents: [], regears: [], specialisations: []
    });
    assert.equal((await repository.getSnapshot(guilds[1])).applications.length, 10);
    assert.equal(reportReads, 30);
    await client.query("set constraints all immediate");
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function runApplicationPublicationSchemaTransitionSmoke(databaseUrl: string, adminPool: PostgresPool): Promise<void> {
  const schemaName = `smoke_application_publication_${randomUUID().replaceAll("-", "")}`;
  const isolatedPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  await adminPool.query(`create schema "${schemaName}"`);
  try {
    await migrateDatabaseSchema(isolatedPool);
    await isolatedPool.query(`alter table open_applications drop column review_publication;
      alter table open_applications drop column legacy_review_publication;
      delete from guild_manager_schema_migrations where version = 38;`);
    const repository = createApplicationRepository(isolatedPool);
    const lifecycle = createGuildLifecycleRepository(isolatedPool);
    for (const discordGuildId of ["publication-guild", "other-publication-guild"]) {
      await lifecycle.activateGuild({ discordGuildId, guildName: discordGuildId, actorDiscordUserId: "admin" });
    }
    const applicationClass = await repository.createApplicationClass({ discordGuildId: "publication-guild", name: "Applicants",
      outcomeType: "register_character", albionServer: "europe", ticketCategoryId: "category", reviewerRoleId: "reviewers",
      activeRoleId: "temporary", createdByDiscordUserId: "admin" });
    await repository.setApplicationEnabled("publication-guild", applicationClass.applicationClassId, true);
    const input = { discordGuildId: "publication-guild", applicationClassId: applicationClass.applicationClassId,
      applicantDiscordUserId: "applicant", submittedCharacterName: "A query", modalAnswers: [{ question: "Why?", answer: "Because." }], albionServer: "europe" as const };
    const legacy = await repository.createOpenApplication(input);
    await migrateDatabaseSchema(isolatedPool);
    assert.equal((await repository.getOpenApplication(input.discordGuildId, legacy.applicationId))?.legacyReviewPublication, true);
    const oldPublication = (await repository.ensureApplicationReviewPublication(input.discordGuildId, legacy.applicationId))?.reviewPublication;
    assert.equal(oldPublication?.notificationClaimed, true);
    assert.equal(oldPublication?.initialMessage, undefined);
    await repository.setApplicationMessage(input.discordGuildId, applicationClass.applicationClassId, "initial", "Original **instructions**");
    const fresh = await repository.createOpenApplication({ ...input, applicantDiscordUserId: "new-applicant" });
    assert.equal(fresh.legacyReviewPublication, false);
    assert.equal((await repository.ensureApplicationReviewPublication(input.discordGuildId, fresh.applicationId))?.reviewPublication, undefined);
    await isolatedPool.query(`insert into albion_characters (albion_server, albion_character_id, character_name)
      values ('europe', 'selected', 'Exact Name'), ('asia', 'selected', 'Other Server Name')`);
    const firstSelection = await repository.selectApplicationCharacter(input.discordGuildId, fresh.applicationId, "selected");
    assert.equal(firstSelection?.reviewPublication?.initialMessage, "Original **instructions**");
    assert.equal(firstSelection?.reviewPublication?.notificationClaimed, false);
    // A failed Discord edit cannot shift the snapshot to later class configuration.
    await repository.setApplicationMessage(input.discordGuildId, applicationClass.applicationClassId, "initial", "Changed before first card edit");
    await isolatedPool.query(`insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id)
      values ('other-publication-guild', 'outside-owner', 'europe', 'selected'), ('publication-guild', 'other-server-owner', 'asia', 'selected')`);
    assert.equal((await repository.getOpenApplication(input.discordGuildId, fresh.applicationId))?.selectedCharacterOwnerDiscordUserId, undefined);
    await isolatedPool.query(`insert into discord_user_characters (discord_guild_id, discord_user_id, albion_server, albion_character_id)
      values ('publication-guild', 'conflicting-owner', 'europe', 'selected')`);
    assert.equal((await repository.getOpenApplication(input.discordGuildId, fresh.applicationId))?.selectedCharacterOwnerDiscordUserId, "conflicting-owner");
    assert.equal((await repository.listOperationalApplicationTargets(input.discordGuildId)).find((target) => target.applicationId === fresh.applicationId)?.selectedCharacterOwnerDiscordUserId, "conflicting-owner");
    assert.equal(await repository.markApplicationRejected(input.discordGuildId, fresh.applicationId, "reviewer"), undefined);
    assert.equal((await repository.getOpenApplication(input.discordGuildId, fresh.applicationId))?.status, "open");
    await isolatedPool.query(`delete from discord_user_characters where discord_guild_id='publication-guild' and albion_server='europe' and albion_character_id='selected'`);

    const ready = await repository.ensureApplicationReviewPublication(input.discordGuildId, fresh.applicationId);
    assert.equal(ready?.selectedCharacterName, "Exact Name");
    const snapshot = ready!.reviewPublication!;
    assert.equal(snapshot.initialMessage, "Original **instructions**");
    assert.equal(snapshot.notificationClaimed, false);
    await repository.setApplicationMessage(input.discordGuildId, applicationClass.applicationClassId, "initial", "Changed later");
    assert.deepEqual((await repository.ensureApplicationReviewPublication(input.discordGuildId, fresh.applicationId))?.reviewPublication, snapshot);
    assert.equal(await repository.updateApplicationReviewPublication("wrong-guild", fresh.applicationId, snapshot, { ...snapshot, notificationClaimed: true }), false);
    const claimed = { ...snapshot, notificationClaimed: true };
    const competing = await Promise.all([
      repository.updateApplicationReviewPublication(input.discordGuildId, fresh.applicationId, snapshot, claimed),
      repository.updateApplicationReviewPublication(input.discordGuildId, fresh.applicationId, snapshot, claimed)
    ]);
    assert.equal(competing.filter(Boolean).length, 1);
    assert.equal(await repository.updateApplicationReviewPublication(input.discordGuildId, fresh.applicationId, claimed, snapshot), false);
    const posted = { ...claimed, reviewCardMessageId: "review-card", replacedSelectionMessageId: "selection-card", initialMessageId: "initial", answerMessageIds: ["answer-one", "answer-two"] };
    assert.equal(await repository.updateApplicationReviewPublication(input.discordGuildId, fresh.applicationId, claimed, posted), true);
    assert.equal(await repository.claimApplicationFirstMessageId("wrong-guild", fresh.applicationId, undefined, "wrong"), false);
    assert.equal(await repository.claimApplicationFirstMessageId(input.discordGuildId, fresh.applicationId, undefined, "first"), true);
    assert.equal(await repository.claimApplicationFirstMessageId(input.discordGuildId, fresh.applicationId, undefined, "duplicate"), false);
    assert.equal(await repository.claimApplicationFirstMessageId(input.discordGuildId, fresh.applicationId, "first", "replacement"), true);
    const canonical = await repository.getOpenApplication(input.discordGuildId, fresh.applicationId);
    assert.equal(canonical?.applicationControlMessageId, "replacement");
    assert.equal(canonical?.characterResolutionMessageId, "replacement");
    assert.equal(await repository.hasOpenApplicationRequiringRole(input.discordGuildId, "new-applicant", "temporary"), true);
    await repository.markApplicationClosed(input.discordGuildId, fresh.applicationId, "reviewer");
    assert.equal(await repository.hasOpenApplicationRequiringRole(input.discordGuildId, "new-applicant", "temporary"), false);
    const parallelApplication = await repository.createOpenApplication({ ...input, applicantDiscordUserId: "new-applicant" });
    assert.equal(await repository.hasOpenApplicationRequiringRole(input.discordGuildId, "new-applicant", "temporary"), true);
    await repository.markApplicationClosed(input.discordGuildId, parallelApplication.applicationId, "reviewer");
    assert.equal(await repository.selectApplicationCharacter(input.discordGuildId, fresh.applicationId, "selected"), undefined);
    assert.equal(await repository.markApplicationCharacterNotListed(input.discordGuildId, fresh.applicationId), undefined);
    await repository.markApplicationReopened(input.discordGuildId, fresh.applicationId, "reviewer");
    await repository.beginApplicationCharacterSearch(input.discordGuildId, fresh.applicationId, "Another query");
    assert.deepEqual((await repository.getOpenApplication(input.discordGuildId, fresh.applicationId))?.reviewPublication, posted);
    for (const invalid of [{}, { ...snapshot, answerMessageIds: [1] }, { ...snapshot, notificationMessageId: "unclaimed" }, { ...snapshot, initialMessageId: "" }]) {
      await assert.rejects(isolatedPool.query(`update open_applications set review_publication=$2::jsonb where application_id=$1`,
        [fresh.applicationId, JSON.stringify(invalid)]), (error: unknown) => (error as { code?: string }).code === "23514");
    }
    await migrateDatabaseSchema(isolatedPool);
    assert.deepEqual((await repository.getOpenApplication(input.discordGuildId, fresh.applicationId))?.reviewPublication, posted);
  } finally {
    await isolatedPool.end();
    await adminPool.query(`drop schema "${schemaName}" cascade`);
  }
}
