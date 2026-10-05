import type { PostgresPool } from "./postgres.js";
import { cleanupDeadlineSql, contentColumns, mapContent, type ContentItem, type ContentItemRow } from "./contentRepository.js";

export type SignupRequestStatus = "pending" | "accepted" | "declined" | "withdrawn" | "superseded" | "invalidated" | "closed";

export interface ContentSignupRequest {
  requestId: string;
  discordGuildId: string;
  contentId: string;
  discordUserId: string;
  roleSlotId: string | null;
  slotIndex: number | null;
  roleLabel: string | null;
  status: SignupRequestStatus;
  requestMessageId: string | null;
  outcomeMessageId: string | null;
  requestNotificationClaimedAt: Date | null;
  outcomeNotificationClaimedAt: Date | null;
  presentationFinishedAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface RequestRow {
  request_id: string;
  discord_guild_id: string;
  content_id: string;
  discord_user_id: string;
  role_slot_id: string | null;
  slot_index: number | null;
  role_label: string | null;
  status: SignupRequestStatus;
  request_message_id: string | null;
  outcome_message_id: string | null;
  request_notification_claimed_at: Date | null;
  outcome_notification_claimed_at: Date | null;
  presentation_finished_at: Date | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface RequestSignupInput {
  discordGuildId: string;
  contentId: string;
  discordUserId: string;
  roleSlotId: string | null;
  expectedSlot?: {
    slotIndex: number;
    label: string;
  };
  actorDiscordUserId?: string;
}

export interface RequestSignupResult {
  status: "signed_up" | "requested" | "unchanged" | "already_signed_up" | "slot_filled" | "slot_changed" | "closed" | "not_host";
  request?: ContentSignupRequest;
}

export interface DecideSignupRequestInput {
  discordGuildId: string;
  contentId: string;
  actorDiscordUserId: string;
  decision: "accept" | "decline";
  requestId?: string;
  discordUserId?: string;
  requestMessageId?: string;
  validateAvailability?: (request: ContentSignupRequest) => Promise<boolean>;
}

export interface DecideSignupRequestResult {
  status: "accepted" | "declined" | "not_pending" | "not_host" | "closed" | "slot_filled" | "slot_changed" | "unavailable";
  request?: ContentSignupRequest;
}

export interface WithdrawSignupInput {
  discordGuildId: string;
  contentId: string;
  discordUserId: string;
  actorDiscordUserId?: string;
}

export interface WithdrawSignupResult {
  status: "removed" | "none" | "closed" | "not_host";
  removedSignup: boolean;
  removedRequest: boolean;
}

export interface ContentQueryable {
  query: PostgresPool["query"];
}

// Every content mutation locks the owning content row before any signup, slot, or request.
export async function withContentTransaction<T>(pool: PostgresPool, guild: string, contentId: string, operation: (client: ContentQueryable, content: (ContentItemRow & {
  is_open: boolean;
}) | undefined) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<ContentItemRow & {
      is_open: boolean;
    }>(`
      select ${contentColumns}
      from content_items
      where discord_guild_id = $1 and content_id = $2 for update
      `, [guild, contentId]);
    const content = result.rows[0];
    if (content) {
      const current = await client.query<{
        is_open: boolean;
      }>(`
        select (state in ('scheduled', 'unscheduled', 'active') and ${cleanupDeadlineSql} > clock_timestamp()) as is_open
        from content_items
        where discord_guild_id = $1 and content_id = $2
        `, [guild, contentId]);
      content.is_open = current.rows[0]?.is_open ?? false;
    }
    const value = await operation(client, content);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function resolvePendingSignupRequests(client: ContentQueryable, guild: string, contentId: string, status: SignupRequestStatus, user?: string): Promise<number> {
  const result = await client.query(`
    update content_signup_requests
    set status = $3, resolved_at = now(), presentation_finished_at = null
    where discord_guild_id = $1 and content_id = $2 and status = 'pending' and ($4::text is null or discord_user_id = $4)
    `, [guild, contentId, status, user ?? null]);
  return result.rowCount ?? 0;
}

async function pending(client: ContentQueryable, guild: string, contentId: string, user: string): Promise<ContentSignupRequest | undefined> {
  const result = await client.query<RequestRow>(`
    select *
    from content_signup_requests
    where discord_guild_id = $1 and content_id = $2 and discord_user_id = $3 and status = 'pending'
    `, [guild, contentId, user]);
  return result.rows[0] ? mapRequest(result.rows[0]) : undefined;
}

async function target(client: ContentQueryable, guild: string, contentId: string, slotId: string | null, user: string, ignoreOccupancy = false) {
  if (slotId === null)
    return {
      status: "valid" as const, slotIndex: null, label: null
    };
  const result = await client.query<{
    slot_index: number;
    label: string;
    occupied: boolean;
  }>(`
    select slot_index, label, exists(select 1
    from content_signups s
    where s.discord_guild_id = $1 and s.content_id = $2 and s.content_role_slot_id = $3
      and s.state = 'active' and s.signup_type = 'role' and s.discord_user_id<>$4) as occupied
    from content_role_slots
    where discord_guild_id = $1 and content_id = $2 and content_role_slot_id = $3
    `, [guild, contentId, slotId, user]);
  const row = result.rows[0];
  if (!row)
    return {
      status: "slot_changed" as const
    };
  if (row.occupied && !ignoreOccupancy)
    return {
      status: "slot_filled" as const
    };
  return {
    status: "valid" as const, slotIndex: row.slot_index, label: row.label
  };
}
// Only called after target validation under the owning party's transaction lock.
async function assignSignup(client: ContentQueryable, guild: string, contentId: string, slotId: string | null, user: string): Promise<void> {
  await client.query(`
    update content_signups
    set state = 'removed', removed_at = now(), removed_by_discord_user_id = $3, updated_at = now()
    where discord_guild_id = $1 and content_id = $2 and discord_user_id = $3 and state = 'active'
    `, [guild, contentId, user]);
  await client.query(`
    insert into content_signups(content_id, content_role_slot_id, discord_guild_id, discord_user_id, signup_type, updated_at) values($1, $2, $3, $4, $5, now())
    `, [contentId, slotId, guild, user, slotId === null ? "standby" : "role"]);
}

export function createContentSignupApprovalRepository(pool: PostgresPool) {
  return {
    requestSignup: (input: RequestSignupInput): Promise<RequestSignupResult> => withContentTransaction(pool, input.discordGuildId, input.contentId, async (client, content) => {
      const { discordGuildId: guild, contentId, discordUserId: user, roleSlotId } = input;
      if (!content?.is_open) {
        await resolvePendingSignupRequests(client, guild, contentId, "closed");
        return {
          status: "closed"
        };
      }
      if (input.actorDiscordUserId && input.actorDiscordUserId !== content.leader_discord_user_id)
        return {
          status: "not_host"
        };
      const existing = await pending(client, guild, contentId, user);
      const direct = !content.approval_required || user === content.leader_discord_user_id || !!input.actorDiscordUserId;
      const repeat = !direct && existing?.roleSlotId === roleSlotId;
      const place = await target(client, guild, contentId, roleSlotId, user, content.multi_signup_enabled || repeat);
      if (place.status !== "valid")
        return {
          status: place.status
        };
      if (input.expectedSlot && (input.expectedSlot.slotIndex !== place.slotIndex || input.expectedSlot.label !== place.label))
        return {
          status: "slot_changed"
        };
      const current = await client.query<{
        content_role_slot_id: string | null;
      }>(`
        select content_role_slot_id
        from content_signups
        where discord_guild_id = $1 and content_id = $2 and discord_user_id = $3 and state = 'active'
        `, [guild, contentId, user]);
      if (current.rows[0] && current.rows[0].content_role_slot_id === roleSlotId) {
        await resolvePendingSignupRequests(client, guild, contentId, "withdrawn", user);
        return {
          status: "already_signed_up"
        };
      }
      if (direct) {
        await assignSignup(client, guild, contentId, roleSlotId, user);
        const matches = existing && existing.roleSlotId === roleSlotId && existing.slotIndex === place.slotIndex && existing.roleLabel === place.label;
        await resolvePendingSignupRequests(client, guild, contentId, matches ? "accepted" : "withdrawn", user);
        return {
          status: "signed_up", request: existing ? {
            ...existing, status: matches ? "accepted" : "withdrawn"
          } : undefined
        };
      }
      if (existing && existing.roleSlotId === roleSlotId && existing.slotIndex === place.slotIndex && existing.roleLabel === place.label)
        return {
          status: "unchanged", request: existing
        };
      await resolvePendingSignupRequests(client, guild, contentId, "superseded", user);
      const result = await client.query<RequestRow>(`
        insert into content_signup_requests(discord_guild_id, content_id, discord_user_id, role_slot_id, slot_index, role_label) values($1, $2, $3, $4, $5, $6)
        returning *
        `, [guild, contentId, user, roleSlotId, place.slotIndex, place.label]);
      return {
        status: "requested", request: mapRequest(result.rows[0])
      };
    }),
    decideSignupRequest: (input: DecideSignupRequestInput): Promise<DecideSignupRequestResult> => withContentTransaction(pool, input.discordGuildId, input.contentId, async (client, content) => {
      const { discordGuildId: guild, contentId } = input;
      if (content && input.actorDiscordUserId !== content.leader_discord_user_id)
        return {
          status: "not_host"
        };
      if (!content?.is_open) {
        await resolvePendingSignupRequests(client, guild, contentId, "closed");
        return {
          status: "closed"
        };
      }
      if (!input.requestId && !input.discordUserId)
        return {
          status: "not_pending"
        };
      const result = await client.query<RequestRow>(`
        select *
        from content_signup_requests
        where discord_guild_id = $1 and content_id = $2 and status = 'pending' and ($3::uuid is null or request_id = $3) and ($4::text is null or discord_user_id = $4) for update
        `, [guild, contentId, input.requestId ?? null, input.discordUserId ?? null]);
      const request = result.rows[0] ? mapRequest(result.rows[0]) : undefined;
      if (!request || (input.requestMessageId && request.requestMessageId !== input.requestMessageId))
        return {
          status: "not_pending"
        };
      if (input.decision === "accept") {
        const place = await target(client, guild, contentId, request.roleSlotId, request.discordUserId, content.multi_signup_enabled);
        if (place.status !== "valid")
          return {
            status: place.status, request
          };
        if (place.slotIndex !== request.slotIndex || place.label !== request.roleLabel)
          return {
            status: "slot_changed", request
          };
        if (input.validateAvailability && !await input.validateAvailability(request))
          return {
            status: "unavailable", request
          };
        const stillOpen = await client.query(`
          select 1
          from content_items
          where discord_guild_id = $1 and content_id = $2 and ${cleanupDeadlineSql}>clock_timestamp()
          `, [guild, contentId]);
        if (!stillOpen.rows[0]) {
          await resolvePendingSignupRequests(client, guild, contentId, "closed");
          return {
            status: "closed"
          };
        }
        await assignSignup(client, guild, contentId, request.roleSlotId, request.discordUserId);
      }
      const status = input.decision === "accept" ? "accepted" : "declined";
      const changed = await client.query<RequestRow>(`
        update content_signup_requests
        set status = $4, resolved_at = now()
        where discord_guild_id = $1 and content_id = $2 and request_id = $3
        returning *
        `, [guild, contentId, request.requestId, status]);
      return {
        status, request: mapRequest(changed.rows[0])
      };
    }),
    withdrawSignup: (input: WithdrawSignupInput): Promise<WithdrawSignupResult> => withContentTransaction(pool, input.discordGuildId, input.contentId, async (client, content) => {
      const { discordGuildId: guild, contentId, discordUserId: user, actorDiscordUserId: actor = user } = input;
      if (actor !== user && actor !== content?.leader_discord_user_id)
        return {
          status: "not_host", removedSignup: false, removedRequest: false
        };
      const removedRequest = (await resolvePendingSignupRequests(client, guild, contentId, content?.is_open ? "withdrawn" : "closed", user)) > 0;
      const result = await client.query(`
        update content_signups
        set state = 'removed', removed_at = now(), removed_by_discord_user_id = $4, updated_at = now()
        where discord_guild_id = $1 and content_id = $2 and discord_user_id = $3 and state = 'active'
        `, [guild, contentId, user, actor]);
      const removedSignup = (result.rowCount ?? 0) > 0;
      return {
        status: removedRequest || removedSignup ? "removed" : "none", removedSignup, removedRequest
      };
    }),
    getPendingSignupRequest: (guild: string, contentId: string, user: string) => pending(pool, guild, contentId, user),
    getSignupRequest: async (guild: string, contentId: string, id: string) => {
      const result = await pool.query<RequestRow>(`
        select *
        from content_signup_requests
        where discord_guild_id = $1 and content_id = $2 and request_id = $3
        `, [guild, contentId, id]);
      return result.rows[0] ? mapRequest(result.rows[0]) : undefined;
    },
    listSignupRequests: async (guild: string, contentId: string) => {
      const result = await pool.query<RequestRow>(`
        select *
        from content_signup_requests
        where discord_guild_id = $1 and content_id = $2
        order by created_at, request_id
        `, [guild, contentId]);
      return result.rows.map(mapRequest);
    },
    claimSignupRequestNotification: async (guild: string, contentId: string, id: string, kind: "request" | "outcome") => {
      const column = kind === "request" ? "request_notification_claimed_at" : "outcome_notification_claimed_at";
      const condition = kind === "request" ? "status='pending'" : "status in ('accepted','declined','invalidated')";
      const result = await pool.query(`
        update content_signup_requests
        set ${column} = now()
        where discord_guild_id = $1 and content_id = $2 and request_id = $3 and ${column} is null and ${condition}
        `, [guild, contentId, id]);
      return (result.rowCount ?? 0) > 0;
    },
    setSignupRequestMessage: async (guild: string, contentId: string, id: string, kind: "request" | "outcome", messageId: string, expectedMessageId?: string | null) => {
      const column = kind === "request" ? "request_message_id" : "outcome_message_id";
      const result = await pool.query(`
        update content_signup_requests
        set ${column} = $4
        where discord_guild_id = $1 and content_id = $2 and request_id = $3 and ($5::boolean or ${column} is not distinct
        from $6::text)
        `, [guild, contentId, id, messageId, expectedMessageId === undefined, expectedMessageId ?? null]);
      return (result.rowCount ?? 0) > 0;
    },
    finishSignupRequestPresentation: async (guild: string, contentId: string, id: string) => {
      await pool.query(`
        update content_signup_requests
        set presentation_finished_at = now()
        where discord_guild_id = $1 and content_id = $2 and request_id = $3 and status<>'pending'
        `, [guild, contentId, id]);
    },
    reconcileSignupRequestClosure: (guild: string, contentId: string) => withContentTransaction(pool, guild, contentId, async (client, content) => {
      if (!content?.is_open)
        await resolvePendingSignupRequests(client, guild, contentId, "closed");
    }),
    listContentNeedingSignupApprovalReconciliation: async (): Promise<ContentItem[]> => {
      const result = await pool.query<ContentItemRow>(`
        select ${contentColumns}
        from content_items
        where exists(select 1
        from content_signup_requests r
        where r.content_id = content_items.content_id and r.discord_guild_id = content_items.discord_guild_id and (r.status = 'pending' or r.presentation_finished_at is null))
        order by content_id
        `);
      return result.rows.map(mapContent);
    }
  };
}

function mapRequest(row: RequestRow): ContentSignupRequest {
  return {
    requestId: row.request_id,
    discordGuildId: row.discord_guild_id,
    contentId: row.content_id,
    discordUserId: row.discord_user_id,
    roleSlotId: row.role_slot_id,
    slotIndex: row.slot_index,
    roleLabel: row.role_label,
    status: row.status,
    requestMessageId: row.request_message_id,
    outcomeMessageId: row.outcome_message_id,
    requestNotificationClaimedAt: row.request_notification_claimed_at,
    outcomeNotificationClaimedAt: row.outcome_notification_claimed_at,
    presentationFinishedAt: row.presentation_finished_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}
