import { isKickActivityRevoked } from "./kickActivitiesRepository.js";
import { createContentSignupApprovalRepository, withContentTransaction, resolvePendingSignupRequests } from "./contentSignupApprovalRepository.js";
export type { ContentSignupRequest, RequestSignupInput, RequestSignupResult, DecideSignupRequestInput, DecideSignupRequestResult, WithdrawSignupResult } from "./contentSignupApprovalRepository.js";
import { CONTENT_ACTIVE_DURATION_MS, UNSCHEDULED_WAITING_DURATION_MS } from "../services/content/lifecycle.js";
import type { PostgresPool } from "./postgres.js";

interface Queryable {
  query: PostgresPool["query"];
}

export type ContentState = "scheduled" | "unscheduled" | "active" | "ended" | "cancelled" | "archived";
export type SignupState = "active" | "removed";
export type SignupType = "role" | "standby";

export interface ContentChannelConfig {
  discordGuildId: string;
  discordChannelId: string;
  configurationRevision: string;
}

export interface ContentTemplate {
  contentTemplateId: string;
  discordGuildId: string;
  name: string;
  title: string;
  description: string;
  rolesText: string;
  createdByDiscordUserId: string;
  updatedByDiscordUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentItem {
  renderRevision?: string;
  renderedRevision?: string | null;
  approvalRequired?: boolean;
  multiSignupEnabled?: boolean;
  contentId: string;
  discordGuildId: string;
  sourceChannelId: string;
  threadChannelId: string;
  hostDiscordUserId: string;
  title: string;
  description: string;
  scheduledStartAt: Date | null;
  graphicAttachmentName?: string | null;
  state: ContentState;
  announcementMessageId: string | null;
  detailsMessageId?: string | null;
  controlMessageId: string | null;
  startNotificationMessageId: string | null;
  startNotificationClaimedAt?: Date | null;
  lastRenderedAt: Date | null;
  startedAt: Date | null;
  firstStartedAt?: Date | null;
  startedByDiscordUserId?: string | null;
  startRevision?: string | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentRoleSlot {
  contentRoleSlotId: string;
  contentId: string;
  discordGuildId: string;
  slotIndex: number;
  label: string;
}

export interface ContentSignup {
  contentSignupId: string;
  contentId: string;
  contentRoleSlotId: string | null;
  discordGuildId: string;
  discordUserId: string;
  signupType: SignupType;
  state: SignupState;
  removedAt: Date | null;
  removedByDiscordUserId: string | null;
}

export interface ContentSnapshot {
  content: ContentItem;
  slots: ContentRoleSlot[];
  signups: ContentSignup[];
}

export interface CreateTemplateInput {
  discordGuildId: string;
  name: string;
  title: string;
  description: string;
  rolesText: string;
  discordUserId: string;
}

export interface UpdateTemplateInput extends CreateTemplateInput {
  contentTemplateId: string;
}

export interface CreateContentInput {
  approvalRequired?: boolean;
  multiSignupEnabled?: boolean;
  discordGuildId: string;
  sourceChannelId: string;
  threadChannelId: string;
  hostDiscordUserId: string;
  title: string;
  description: string;
  scheduledStartAt: Date | null;
  roleLabels: string[];
  graphicAttachmentName?: string;
  postedAt?: Date;
}

export interface UpdateContentDetailsInput {
  actorDiscordUserId?: string;
  discordGuildId: string;
  contentId: string;
  title: string;
  description: string;
  roleLabels: string[];
  scheduledStartAt?: Date;
  graphicAttachmentName?: string;
  requireScheduledState?: boolean;
}

export interface UpdateContentDetailsResult {
  snapshot: ContentSnapshot;
  movedToStandbyCount: number;
  invalidatedRequestIds: string[];
}

interface ContentChannelRow {
  discord_guild_id: string;
  discord_channel_id: string;
  configuration_revision: string;
}

interface ContentTemplateRow {
  content_template_id: string;
  discord_guild_id: string;
  name: string;
  title: string;
  description: string;
  roles_text: string;
  created_by_discord_user_id: string;
  updated_by_discord_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ContentItemRow {
  render_revision: string;
  rendered_revision: string | null;
  approval_required: boolean;
  multi_signup_enabled: boolean;
  content_id: string;
  discord_guild_id: string;
  source_channel_id: string;
  thread_channel_id: string;
  leader_discord_user_id: string;
  title: string;
  description: string;
  scheduled_start_at: Date | null;
  graphic_attachment_name: string | null;
  state: ContentState;
  initial_message_id: string | null;
  details_message_id: string | null;
  control_message_id: string | null;
  start_notification_message_id: string | null;
  start_notification_claimed_at: Date | null;
  last_rendered_at: Date | null;
  started_at: Date | null;
  first_started_at: Date | null;
  started_by_discord_user_id: string | null;
  start_revision: string | null;
  ended_at: Date | null;
  cancelled_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ContentRoleSlotRow {
  content_role_slot_id: string;
  content_id: string;
  discord_guild_id: string;
  slot_index: number;
  label: string;
}

interface ContentSignupRow {
  content_signup_id: string;
  content_id: string;
  content_role_slot_id: string | null;
  discord_guild_id: string;
  discord_user_id: string;
  signup_type: SignupType;
  state: SignupState;
  removed_at: Date | null;
  removed_by_discord_user_id: string | null;
}

export function createContentRepository(pool: PostgresPool) {
  return {
    isHostAuthorityRevoked: (guildId: string, userId: string, targetId: string) => isKickActivityRevoked(pool, guildId, userId, "content_host", targetId),
    ...createContentSignupApprovalRepository(pool),
    getContentChannel: (discordGuildId: string) => getContentChannel(pool, discordGuildId),
    setContentChannel: (discordGuildId: string, discordChannelId: string) =>
      setContentChannel(pool, discordGuildId, discordChannelId),
    clearContentChannel: (discordGuildId: string) => clearContentChannel(pool, discordGuildId),
    createTemplate: (input: CreateTemplateInput) => createTemplate(pool, input),
    updateTemplate: (input: UpdateTemplateInput) => updateTemplate(pool, input),
    listTemplates: (discordGuildId: string) => listTemplates(pool, discordGuildId),
    getTemplate: (discordGuildId: string, contentTemplateId: string) =>
      getTemplate(pool, discordGuildId, contentTemplateId),
    removeTemplate: (discordGuildId: string, contentTemplateId: string) =>
      removeTemplate(pool, discordGuildId, contentTemplateId),
    createContent: (input: CreateContentInput) => createContent(pool, input),
    updateContentDetails: (input: UpdateContentDetailsInput) => updateContentDetails(pool, input),
    getContentByThread: (discordGuildId: string, threadChannelId: string) =>
      getContentByThread(pool, discordGuildId, threadChannelId),
    getContentSnapshot: (discordGuildId: string, contentId: string) =>
      getContentSnapshot(pool, discordGuildId, contentId),
    listUnarchivedContent: (discordGuildId: string) => listUnarchivedContent(pool, discordGuildId),
    setContentMessageIds: (
      discordGuildId: string,
      contentId: string,
      announcementMessageId: string,
      controlMessageId: string,
      detailsMessageId: string
    ) => setContentMessageIds(pool, discordGuildId, contentId, announcementMessageId, controlMessageId, detailsMessageId),
    setDetailsMessage: (discordGuildId: string, contentId: string, messageId: string) =>
      setDetailsMessage(pool, discordGuildId, contentId, messageId),
    setControlMessage: (discordGuildId: string, contentId: string, messageId: string) =>
      setControlMessage(pool, discordGuildId, contentId, messageId),
    markRendered: (discordGuildId: string, contentId: string, expectedRevision?: string) => markRendered(pool, discordGuildId, contentId, expectedRevision),
    setHost: (discordGuildId: string, contentId: string, hostDiscordUserId: string, actorDiscordUserId?: string) =>
      setHost(pool, discordGuildId, contentId, hostDiscordUserId, actorDiscordUserId),
    upsertSignup: (discordGuildId: string, contentId: string, roleSlotId: string | null, discordUserId: string) =>
      upsertSignup(pool, discordGuildId, contentId, roleSlotId, discordUserId),
    removeSignup: (discordGuildId: string, contentId: string, discordUserId: string, removedByDiscordUserId: string) =>
      removeSignup(pool, discordGuildId, contentId, discordUserId, removedByDiscordUserId),
    markStarted: (discordGuildId: string, contentId: string, now = new Date(), actorDiscordUserId?: string) => markStarted(pool, discordGuildId, contentId, now, actorDiscordUserId),
    markUnstarted: (discordGuildId: string, contentId: string, actorDiscordUserId: string, startRevision: string, messageId: string, now = new Date()) =>
      markUnstarted(pool, discordGuildId, contentId, actorDiscordUserId, startRevision, messageId, now),
    claimContentDueCleanup: (discordGuildId: string, contentId: string, now: Date) => claimContentDueCleanup(pool, discordGuildId, contentId, now),
    claimStartNotification: (discordGuildId: string, contentId: string, startRevision?: string | null) => claimStartNotification(pool, discordGuildId, contentId, startRevision),
    setStartNotificationMessage: (discordGuildId: string, contentId: string, messageId: string, startRevision?: string | null) =>
      setStartNotificationMessage(pool, discordGuildId, contentId, messageId, startRevision),
    markEnded: (discordGuildId: string, contentId: string, actorDiscordUserId?: string) => markEnded(pool, discordGuildId, contentId, actorDiscordUserId),
    markCancelled: (discordGuildId: string, contentId: string, actorDiscordUserId?: string) => markCancelled(pool, discordGuildId, contentId, actorDiscordUserId),
    markArchived: (discordGuildId: string, contentId: string, actorDiscordUserId?: string) => markArchived(pool, discordGuildId, contentId, actorDiscordUserId),
    listContentForThreadTitleReconciliation: () => listContentForThreadTitleReconciliation(pool),
    listContentDueStart: (now: Date) => listContentDueStart(pool, now),
    listContentDueCleanup: (now: Date) => listContentDueCleanup(pool, now),
    listContentNeedingControlMessage: (includeRenderedOpenContent = false) => listContentNeedingControlMessage(pool, includeRenderedOpenContent),
    deleteContent: (discordGuildId: string, contentId: string) => deleteContent(pool, discordGuildId, contentId)
  };
}

async function getContentChannel(pool: Queryable, discordGuildId: string): Promise<ContentChannelConfig | undefined> {
  const result = await pool.query<ContentChannelRow>(
    `
    select discord_guild_id, discord_channel_id, configuration_revision
    from content_channel_configs
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
  const row = result.rows[0];
  return row ? { discordGuildId: row.discord_guild_id, discordChannelId: row.discord_channel_id, configurationRevision: row.configuration_revision } : undefined;
}

async function setContentChannel(pool: Queryable, discordGuildId: string, discordChannelId: string): Promise<void> {
  await pool.query(
    `
    insert into content_channel_configs (discord_guild_id, discord_channel_id, updated_at)
    values ($1, $2, now())
    on conflict (discord_guild_id) do update set
      configuration_revision = case when content_channel_configs.discord_channel_id = excluded.discord_channel_id
        then content_channel_configs.configuration_revision else gen_random_uuid()::text end,
      discord_channel_id = excluded.discord_channel_id,
      updated_at = excluded.updated_at
    `,
    [discordGuildId, discordChannelId]
  );
}

async function clearContentChannel(pool: Queryable, discordGuildId: string): Promise<void> {
  await pool.query(
    `
    delete from content_channel_configs
    where discord_guild_id = $1
    `,
    [discordGuildId]
  );
}

async function createTemplate(pool: Queryable, input: CreateTemplateInput): Promise<ContentTemplate> {
  const result = await pool.query<ContentTemplateRow>(
    `
    insert into content_templates (
      discord_guild_id,
      name,
      title,
      description,
      roles_text,
      created_by_discord_user_id,
      updated_by_discord_user_id,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $6, now())
    returning ${templateColumns}
    `,
    [input.discordGuildId, input.name, input.title, input.description, input.rolesText, input.discordUserId]
  );
  return mapTemplate(result.rows[0]);
}

async function updateTemplate(pool: Queryable, input: UpdateTemplateInput): Promise<ContentTemplate | undefined> {
  const result = await pool.query<ContentTemplateRow>(
    `
    update content_templates
    set
      name = $3,
      title = $4,
      description = $5,
      roles_text = $6,
      updated_by_discord_user_id = $7,
      updated_at = now()
    where discord_guild_id = $1 and content_template_id = $2
    returning ${templateColumns}
    `,
    [
      input.discordGuildId,
      input.contentTemplateId,
      input.name,
      input.title,
      input.description,
      input.rolesText,
      input.discordUserId
    ]
  );
  return result.rows[0] ? mapTemplate(result.rows[0]) : undefined;
}

async function listTemplates(pool: Queryable, discordGuildId: string): Promise<ContentTemplate[]> {
  const result = await pool.query<ContentTemplateRow>(
    `
    select ${templateColumns}
    from content_templates
    where discord_guild_id = $1
    order by lower(name), content_template_id
    `,
    [discordGuildId]
  );
  return result.rows.map(mapTemplate);
}

async function getTemplate(pool: Queryable, discordGuildId: string, contentTemplateId: string): Promise<ContentTemplate | undefined> {
  const result = await pool.query<ContentTemplateRow>(
    `
    select ${templateColumns}
    from content_templates
    where discord_guild_id = $1 and content_template_id = $2
    `,
    [discordGuildId, contentTemplateId]
  );
  return result.rows[0] ? mapTemplate(result.rows[0]) : undefined;
}

async function removeTemplate(pool: Queryable, discordGuildId: string, contentTemplateId: string): Promise<boolean> {
  const result = await pool.query(
    `
    delete from content_templates
    where discord_guild_id = $1 and content_template_id = $2
    `,
    [discordGuildId, contentTemplateId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function createContent(pool: PostgresPool, input: CreateContentInput): Promise<ContentSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const contentResult = await client.query<ContentItemRow>(
      `
      insert into content_items (
        discord_guild_id,
        source_channel_id,
        thread_channel_id,
        leader_discord_user_id,
        title,
        description,
        scheduled_start_at,
        graphic_attachment_name,
        state,
        approval_required,
        multi_signup_enabled,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11, $12, coalesce($10::timestamptz, now()), now())
      returning ${contentColumns}
      `,
      [
        input.discordGuildId,
        input.sourceChannelId,
        input.threadChannelId,
        input.hostDiscordUserId,
        input.title,
        input.description,
        input.scheduledStartAt,
        input.graphicAttachmentName ?? null,
        input.scheduledStartAt === null ? "unscheduled" : "scheduled",
        input.postedAt ?? null,
        input.approvalRequired ?? false,
        input.multiSignupEnabled ?? false
      ]
    );
    const content = mapContent(contentResult.rows[0]);
    await insertRoleSlots(client, input.discordGuildId, content.contentId, input.roleLabels);
    await client.query("commit");
    return (await getContentSnapshot(pool, input.discordGuildId, content.contentId))!;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateContentDetails(pool: PostgresPool, input: UpdateContentDetailsInput): Promise<UpdateContentDetailsResult | undefined> {
  if (input.roleLabels.length === 0) {
    throw new Error("Provide at least one role line.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select content_id from content_items where discord_guild_id=$1 and content_id=$2 for update`, [input.discordGuildId,input.contentId]);
    const existingSlotResult = await client.query<ContentRoleSlotRow>(
      `
      select ${slotColumns}
      from content_role_slots
      where discord_guild_id = $1 and content_id = $2
      order by slot_index
      for update
      `,
      [input.discordGuildId, input.contentId]
    );

    const contentResult = await client.query<ContentItemRow>(
      `
      update content_items
      set title = $3,
          description = $4,
          scheduled_start_at = coalesce($5, scheduled_start_at),
          graphic_attachment_name = coalesce($6, graphic_attachment_name),
          updated_at = now()
      where discord_guild_id = $1 and content_id = $2
        and state in ('scheduled', 'unscheduled', 'active')
        and (not $7::boolean or state in ('scheduled', 'unscheduled'))
        and ($8::text is null or leader_discord_user_id=$8)
        and ${cleanupDeadlineSql} > clock_timestamp()
        and ($5::timestamptz is null or (scheduled_start_at is not null and $5 > now()))
      returning ${contentColumns}
      `,
      [
        input.discordGuildId,
        input.contentId,
        input.title,
        input.description,
        input.scheduledStartAt ?? null,
        input.graphicAttachmentName ?? null,
        input.requireScheduledState ?? false,
        input.actorDiscordUserId ?? null
      ]
    );

    if (!contentResult.rows[0]) {
      await client.query("rollback");
      return undefined;
    }

    const invalidatedRequestIds: string[] = [];
    // Invalidate exact changed/removed slots before their labels or identities change.
    for (const slot of existingSlotResult.rows) {
      if (input.roleLabels[slot.slot_index - 1] !== slot.label) {
        const invalidated = await client.query<{request_id:string}>(`update content_signup_requests set status='invalidated',resolved_at=now(),presentation_finished_at=null where discord_guild_id=$1 and content_id=$2 and status='pending' and role_slot_id=$3 returning request_id`, [input.discordGuildId,input.contentId,slot.content_role_slot_id]);
        invalidatedRequestIds.push(...invalidated.rows.map(row => row.request_id));
      }
    }
    const retainedSlotCount = Math.min(existingSlotResult.rows.length, input.roleLabels.length);
    for (let index = 0; index < retainedSlotCount; index += 1) {
      await client.query(
        `
        update content_role_slots
        set label = $4,
            updated_at = now()
        where discord_guild_id = $1 and content_id = $2 and slot_index = $3
        `,
        [input.discordGuildId, input.contentId, index + 1, input.roleLabels[index]]
      );
    }

    let movedToStandbyCount = 0;
    if (input.roleLabels.length < existingSlotResult.rows.length) {
      const movedSignupResult = await client.query(
        `
        update content_signups as signup
        set content_role_slot_id = null,
            signup_type = 'standby',
            updated_at = now()
        from content_role_slots as slot
        where signup.discord_guild_id = $1
          and signup.content_id = $2
          and signup.state = 'active'
          and signup.signup_type = 'role'
          and signup.content_role_slot_id = slot.content_role_slot_id
          and slot.discord_guild_id = $1
          and slot.content_id = $2
          and slot.slot_index > $3
        `,
        [input.discordGuildId, input.contentId, input.roleLabels.length]
      );
      movedToStandbyCount = movedSignupResult.rowCount ?? 0;

      await client.query(
        `
        delete from content_role_slots
        where discord_guild_id = $1 and content_id = $2 and slot_index > $3
        `,
        [input.discordGuildId, input.contentId, input.roleLabels.length]
      );
    } else if (input.roleLabels.length > existingSlotResult.rows.length) {
      await insertRoleSlots(
        client,
        input.discordGuildId,
        input.contentId,
        input.roleLabels.slice(existingSlotResult.rows.length),
        existingSlotResult.rows.length + 1
      );
    }

    await client.query("commit");
    return {
      snapshot: (await getContentSnapshot(pool, input.discordGuildId, input.contentId))!,
      movedToStandbyCount,
      invalidatedRequestIds
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertRoleSlots(
  pool: Queryable,
  discordGuildId: string,
  contentId: string,
  roleLabels: string[],
  startingSlotIndex = 1
): Promise<void> {
  for (let index = 0; index < roleLabels.length; index += 1) {
    await pool.query(
      `
      insert into content_role_slots (content_id, discord_guild_id, slot_index, label, updated_at)
      values ($1, $2, $3, $4, now())
      `,
      [contentId, discordGuildId, startingSlotIndex + index, roleLabels[index]]
    );
  }
}

async function getContentByThread(pool: Queryable, discordGuildId: string, threadChannelId: string): Promise<ContentSnapshot | undefined> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where discord_guild_id = $1 and thread_channel_id = $2
    `,
    [discordGuildId, threadChannelId]
  );
  const row = result.rows[0];
  return row ? getContentSnapshot(pool, discordGuildId, row.content_id) : undefined;
}

async function getContentSnapshot(pool: Queryable, discordGuildId: string, contentId: string): Promise<ContentSnapshot | undefined> {
  const contentResult = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where discord_guild_id = $1 and content_id = $2
    `,
    [discordGuildId, contentId]
  );
  const contentRow = contentResult.rows[0];
  if (!contentRow) return undefined;

  const [slotResult, signupResult] = await Promise.all([
    pool.query<ContentRoleSlotRow>(
      `
      select ${slotColumns}
      from content_role_slots
      where discord_guild_id = $1 and content_id = $2
      order by slot_index
      `,
      [discordGuildId, contentId]
    ),
    pool.query<ContentSignupRow>(
      `
      select ${signupColumns}
      from content_signups
      where discord_guild_id = $1 and content_id = $2 and state = 'active'
      order by content_signup_id
      `,
      [discordGuildId, contentId]
    )
  ]);

  return {
    content: mapContent(contentRow),
    slots: slotResult.rows.map(mapSlot),
    signups: signupResult.rows.map(mapSignup)
  };
}

async function setContentMessageIds(
  pool: Queryable,
  discordGuildId: string,
  contentId: string,
  announcementMessageId: string,
  controlMessageId: string,
  detailsMessageId: string
): Promise<void> {
  await pool.query(
    `
    update content_items
    set initial_message_id = $3,
        control_message_id = $4,
        details_message_id = $5,
        last_rendered_at = now(),
        updated_at = now()
    where discord_guild_id = $1 and content_id = $2
    `,
    [discordGuildId, contentId, announcementMessageId, controlMessageId, detailsMessageId]
  );
}

async function setControlMessage(pool: Queryable, discordGuildId: string, contentId: string, messageId: string): Promise<void> {
  await pool.query(
    `
    update content_items
    set control_message_id = $3,
        last_rendered_at = now(),
        updated_at = now()
    where discord_guild_id = $1 and content_id = $2
    `,
    [discordGuildId, contentId, messageId]
  );
}

async function setDetailsMessage(pool: Queryable, discordGuildId: string, contentId: string, messageId: string): Promise<void> {
  await pool.query(
    `update content_items set details_message_id = $3, updated_at = now()
     where discord_guild_id = $1 and content_id = $2`,
    [discordGuildId, contentId, messageId]
  );
}

async function markRendered(pool: Queryable, discordGuildId: string, contentId: string, expectedRevision?: string): Promise<void> {
  await pool.query(
    `
    update content_items
    set rendered_revision = render_revision,
        last_rendered_at = now(),
        updated_at = now()
    where discord_guild_id = $1 and content_id = $2
      and ($3::uuid is null or render_revision = $3)
    `,
    [discordGuildId, contentId, expectedRevision ?? null]
  );
}

async function setHost(pool: PostgresPool, discordGuildId: string, contentId: string, hostDiscordUserId: string, actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  return withContentTransaction(pool, discordGuildId, contentId, async (client, content) => {
    if (!content?.is_open || (actorDiscordUserId && content.leader_discord_user_id !== actorDiscordUserId))
      return undefined;
    const result = await client.query<ContentItemRow>(`update content_items set leader_discord_user_id=$3,updated_at=now() where discord_guild_id=$1 and content_id=$2 returning ${contentColumns}`, [discordGuildId, contentId, hostDiscordUserId]);
    return mapContent(result.rows[0]);
  });
}

async function upsertSignup(pool: PostgresPool, discordGuildId: string, contentId: string, roleSlotId: string | null, discordUserId: string): Promise<void> {
  const result = await createContentSignupApprovalRepository(pool).requestSignup({ discordGuildId, contentId, roleSlotId, discordUserId });
  if (result.status === 'slot_filled')
    throw new Error('That role is already filled. No changes were made.');
  if (result.status === 'slot_changed')
    throw new Error('That role has changed. Choose a role again.');
  if (result.status === 'closed')
    throw new Error('This party is no longer open for signups.');
}

async function removeSignup(pool: PostgresPool, discordGuildId: string, contentId: string, discordUserId: string, removedByDiscordUserId: string): Promise<boolean> {
  const result = await createContentSignupApprovalRepository(pool).withdrawSignup({ discordGuildId, contentId, discordUserId, actorDiscordUserId: removedByDiscordUserId });
  return result.removedSignup || result.removedRequest;
}

// Only the winning transition sets the start time. Notification delivery has a
// separate claim so pre-send failures can be retried without resetting expiry.
// PostgreSQL rechecks state and deadline after concurrent row updates complete.
async function markStarted(pool: Queryable, discordGuildId: string, contentId: string, now: Date, actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  const result = await pool.query<ContentItemRow>(
    `update content_items
     set state = 'active', started_at = $3, first_started_at = coalesce(first_started_at, $3),
       started_by_discord_user_id = $4, start_revision = gen_random_uuid(),
       start_notification_message_id = null, start_notification_claimed_at = null, updated_at = now()
     where discord_guild_id = $1 and content_id = $2
       and state in ('scheduled', 'unscheduled') and started_at is null
       and ($4::text is null or leader_discord_user_id=$4)
       and ${cleanupDeadlineSql} > $3
     returning ${contentColumns}`,
    [discordGuildId, contentId, now, actorDiscordUserId ?? null]
  );
  return result.rows[0] ? mapContent(result.rows[0]) : undefined;
}

async function markUnstarted(pool: Queryable, discordGuildId: string, contentId: string,
  actorDiscordUserId: string, startRevision: string, messageId: string, now: Date): Promise<ContentItem | undefined> {
  const result = await pool.query<ContentItemRow>(
    `update content_items
     set state = case when scheduled_start_at is null then 'unscheduled' else 'scheduled' end,
       started_at = null, started_by_discord_user_id = null, start_revision = null,
       start_notification_message_id = null, start_notification_claimed_at = null, updated_at = now()
     where discord_guild_id = $1 and content_id = $2 and leader_discord_user_id = $3
       and state = 'active' and start_revision = $4::uuid and start_notification_message_id = $5
       and (scheduled_start_at is null or scheduled_start_at > greatest($6::timestamptz, clock_timestamp()))
       and ${cleanupDeadlineSql} > greatest($6::timestamptz, clock_timestamp())
     returning ${contentColumns}`,
    [discordGuildId, contentId, actorDiscordUserId, startRevision, messageId, now]
  );
  return result.rows[0] ? mapContent(result.rows[0]) : undefined;
}

// Claim before touching Discord, rechecking the current deadline under the row
// lock. Keep terminal records eligible until Discord cleanup succeeds, so a
// transient Discord failure can be retried on the next scheduler pass.
async function claimContentDueCleanup(pool: PostgresPool, discordGuildId: string, contentId: string, now: Date): Promise<ContentItem | undefined> {
  return withContentTransaction(pool, discordGuildId, contentId, async (client) => {
    const result = await client.query<ContentItemRow>(`update content_items
  set state = case when state in ('scheduled', 'unscheduled', 'active') then 'ended' else state end,
    ended_at = case when state in ('scheduled', 'unscheduled', 'active') then coalesce(ended_at, $3) else ended_at end,
    updated_at = now()
  where discord_guild_id = $1 and content_id = $2
   and state in ('scheduled', 'unscheduled', 'active', 'ended', 'cancelled')
   and ${cleanupDeadlineSql} <= $3
  returning ${contentColumns}`, [discordGuildId, contentId, now]);
    if (result.rows[0])
      await resolvePendingSignupRequests(client, discordGuildId, contentId, "closed");
    return result.rows[0] ? mapContent(result.rows[0]) : undefined;
  });
}

async function claimStartNotification(pool: Queryable, discordGuildId: string, contentId: string, startRevision?: string | null): Promise<boolean> {
  const result = await pool.query(
    `update content_items set start_notification_claimed_at = now(), updated_at = now()
     where discord_guild_id = $1 and content_id = $2 and state = 'active'
       and start_notification_message_id is null and start_notification_claimed_at is null
       and ($3::uuid is null or start_revision = $3)
       and ${cleanupDeadlineSql} > now()`,
    [discordGuildId, contentId, startRevision ?? null]
  );
  return (result.rowCount ?? 0) > 0;
}

async function setStartNotificationMessage(pool: Queryable, discordGuildId: string, contentId: string, messageId: string, startRevision?: string | null): Promise<boolean> {
  const result = await pool.query(
    `
    update content_items
    set start_notification_message_id = coalesce(start_notification_message_id, $3),
        updated_at = now()
    where discord_guild_id = $1 and content_id = $2
      and ($4::uuid is null or (state = 'active' and start_revision = $4))
    `,
    [discordGuildId, contentId, messageId, startRevision ?? null]
  );
  return (result.rowCount ?? 0) > 0;
}

async function markEnded(pool: PostgresPool, discordGuildId: string, contentId: string, actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  return markState(pool, discordGuildId, contentId, "ended", "ended_at", undefined, actorDiscordUserId);
}

async function markCancelled(pool: PostgresPool, discordGuildId: string, contentId: string, actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  return markState(pool, discordGuildId, contentId, "cancelled", "cancelled_at", undefined, actorDiscordUserId);
}

async function markArchived(pool: PostgresPool, discordGuildId: string, contentId: string, actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  return markState(pool, discordGuildId, contentId, "archived", "archived_at", ["ended", "cancelled"], actorDiscordUserId);
}

async function markState(pool: PostgresPool, discordGuildId: string, contentId: string, state: ContentState, timestampColumn: "ended_at" | "cancelled_at" | "archived_at", allowedStates = ["scheduled", "unscheduled", "active"], actorDiscordUserId?: string): Promise<ContentItem | undefined> {
  return withContentTransaction(pool, discordGuildId, contentId, async (client, content) => {
    if (actorDiscordUserId && content?.leader_discord_user_id !== actorDiscordUserId)
      return undefined;
    const result = await client.query<ContentItemRow>(`
  update content_items
  set state = $3,
    ${timestampColumn} = coalesce(${timestampColumn}, now()),
    updated_at = now()
  where discord_guild_id = $1 and content_id = $2 and state = any($4)
  returning ${contentColumns}
  `, [discordGuildId, contentId, state, allowedStates]);
    if (result.rows[0])
      await resolvePendingSignupRequests(client, discordGuildId, contentId, "closed");
    return result.rows[0] ? mapContent(result.rows[0]) : undefined;
  });
}

async function listContentDueStart(pool: Queryable, now: Date): Promise<ContentItem[]> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where ((state = 'scheduled' and scheduled_start_at is not null and scheduled_start_at <= $1)
      or (state = 'active' and start_notification_message_id is null and start_notification_claimed_at is null))
      and ${cleanupDeadlineSql} > $1
    order by scheduled_start_at asc
    `,
    [now]
  );
  return result.rows.map(mapContent);
}

async function listUnarchivedContent(pool: Queryable, discordGuildId: string): Promise<ContentItem[]> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where discord_guild_id = $1 and state <> 'archived'
    order by coalesce(scheduled_start_at, started_at, created_at) asc, content_id asc
    `,
    [discordGuildId]
  );
  return result.rows.map(mapContent);
}

async function listContentForThreadTitleReconciliation(pool: Queryable): Promise<ContentItem[]> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where state in ('scheduled', 'unscheduled', 'active')
    order by scheduled_start_at asc
    `
  );
  return result.rows.map(mapContent);
}

async function listContentDueCleanup(pool: Queryable, now: Date): Promise<ContentItem[]> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where state in ('scheduled', 'unscheduled', 'active', 'ended', 'cancelled') and ${cleanupDeadlineSql} <= $1
    order by ${cleanupDeadlineSql} asc, content_id asc
    `,
    [now]
  );
  return result.rows.map(mapContent);
}

async function listContentNeedingControlMessage(pool: Queryable, includeRenderedOpenContent: boolean): Promise<ContentItem[]> {
  const result = await pool.query<ContentItemRow>(
    `
    select ${contentColumns}
    from content_items
    where state <> 'archived'
      and (((control_message_id is null or details_message_id is null) and state in ('scheduled', 'unscheduled', 'active'))
        or ($1::boolean and state in ('scheduled', 'unscheduled', 'active'))
        or rendered_revision is distinct from render_revision)
    order by content_id
    `,
    [includeRenderedOpenContent]
  );
  return result.rows.map(mapContent);
}

async function deleteContent(pool: Queryable, discordGuildId: string, contentId: string): Promise<boolean> {
  const result = await pool.query(
    `
    delete from content_items
    where discord_guild_id = $1 and content_id = $2
    `,
    [discordGuildId, contentId]
  );
  return (result.rowCount ?? 0) > 0;
}

export const cleanupDeadlineSql = `(case
  when scheduled_start_at is not null then scheduled_start_at + interval '${CONTENT_ACTIVE_DURATION_MS} milliseconds'
  when coalesce(first_started_at, started_at) is not null then coalesce(first_started_at, started_at) + interval '${CONTENT_ACTIVE_DURATION_MS} milliseconds'
  else created_at + interval '${UNSCHEDULED_WAITING_DURATION_MS} milliseconds'
end)`;

const templateColumns = `
  content_template_id,
  discord_guild_id,
  name,
  title,
  description,
  roles_text,
  created_by_discord_user_id,
  updated_by_discord_user_id,
  created_at,
  updated_at
`;

export const contentColumns = `
  render_revision,
  rendered_revision,
  approval_required,
  multi_signup_enabled,
  content_id,
  discord_guild_id,
  source_channel_id,
  thread_channel_id,
  leader_discord_user_id,
  title,
  description,
  scheduled_start_at,
  graphic_attachment_name,
  state,
  initial_message_id,
  details_message_id,
  control_message_id,
  start_notification_message_id,
  start_notification_claimed_at,
  last_rendered_at,
  started_at,
  first_started_at,
  started_by_discord_user_id,
  start_revision,
  ended_at,
  cancelled_at,
  archived_at,
  created_at,
  updated_at
`;

const slotColumns = `
  content_role_slot_id,
  content_id,
  discord_guild_id,
  slot_index,
  label
`;

const signupColumns = `
  content_signup_id,
  content_id,
  content_role_slot_id,
  discord_guild_id,
  discord_user_id,
  signup_type,
  state,
  removed_at,
  removed_by_discord_user_id
`;

function mapTemplate(row: ContentTemplateRow): ContentTemplate {
  return {
    contentTemplateId: row.content_template_id,
    discordGuildId: row.discord_guild_id,
    name: row.name,
    title: row.title,
    description: row.description,
    rolesText: row.roles_text,
    createdByDiscordUserId: row.created_by_discord_user_id,
    updatedByDiscordUserId: row.updated_by_discord_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapContent(row: ContentItemRow): ContentItem {
  return {
    approvalRequired: row.approval_required ?? false,
    multiSignupEnabled: row.multi_signup_enabled ?? false,
    renderRevision: row.render_revision,
    renderedRevision: row.rendered_revision,
    contentId: row.content_id,
    discordGuildId: row.discord_guild_id,
    sourceChannelId: row.source_channel_id,
    threadChannelId: row.thread_channel_id,
    hostDiscordUserId: row.leader_discord_user_id,
    title: row.title,
    description: row.description,
    scheduledStartAt: row.scheduled_start_at,
    graphicAttachmentName: row.graphic_attachment_name,
    state: row.state,
    announcementMessageId: row.initial_message_id,
    detailsMessageId: row.details_message_id,
    controlMessageId: row.control_message_id,
    startNotificationMessageId: row.start_notification_message_id,
    startNotificationClaimedAt: row.start_notification_claimed_at,
    lastRenderedAt: row.last_rendered_at,
    startedAt: row.started_at,
    firstStartedAt: row.first_started_at ?? null,
    startedByDiscordUserId: row.started_by_discord_user_id ?? null,
    startRevision: row.start_revision ?? null,
    endedAt: row.ended_at,
    cancelledAt: row.cancelled_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSlot(row: ContentRoleSlotRow): ContentRoleSlot {
  return {
    contentRoleSlotId: row.content_role_slot_id,
    contentId: row.content_id,
    discordGuildId: row.discord_guild_id,
    slotIndex: row.slot_index,
    label: row.label
  };
}

function mapSignup(row: ContentSignupRow): ContentSignup {
  return {
    contentSignupId: row.content_signup_id,
    contentId: row.content_id,
    contentRoleSlotId: row.content_role_slot_id,
    discordGuildId: row.discord_guild_id,
    discordUserId: row.discord_user_id,
    signupType: row.signup_type,
    state: row.state,
    removedAt: row.removed_at,
    removedByDiscordUserId: row.removed_by_discord_user_id
  };
}
