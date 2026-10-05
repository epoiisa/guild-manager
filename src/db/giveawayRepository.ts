import { isKickActivityRevoked } from "./kickActivitiesRepository.js";
import type { PostgresPool } from "./postgres.js";

export type GiveawayState = "open" | "drawn" | "cancelled";

export interface GiveawayRecord {
  giveawayId: string;
  discordGuildId: string;
  channelId: string;
  originalMessageId: string;
  announcementMessageId?: string;
  creatorDiscordUserId: string;
  title: string;
  description: string;
  imageAttachmentName?: string;
  notificationRoleId?: string;
  drawAt: Date;
  winnerCount: number;
  state: GiveawayState;
  drawnAt?: Date;
  drawnByDiscordUserId?: string;
  cancelledAt?: Date;
  cancelledByDiscordUserId?: string;
  originalMessageClosedAt?: Date;
  originalMessageDeletedAt?: Date;
  createdAt: Date;
}

export interface GiveawayWinner {
  giveawayWinnerId: string;
  giveawayId: string;
  discordUserId: string;
  winnerPosition: number;
  status: "current" | "replaced";
  selectedAt: Date;
  replacedAt?: Date;
  replacedByDiscordUserId?: string;
}

export interface GiveawayReactionSnapshot {
  discordUserId: string;
  emojiKeys: string[];
}

export function createGiveawayRepository(pool: PostgresPool) {
  return {
    isHostAuthorityRevoked: (guildId: string, userId: string, targetId: string) => isKickActivityRevoked(pool, guildId, userId, "giveaway_host", targetId),
    async create(input: {
      discordGuildId: string;
      channelId: string;
      originalMessageId: string;
      creatorDiscordUserId: string;
      title: string;
      description: string;
      imageAttachmentName?: string;
      notificationRoleId?: string;
      drawAt: Date;
      winnerCount: number;
    }): Promise<GiveawayRecord> {
      const result = await pool.query<GiveawayRow>(
        `
        insert into giveaways (
          discord_guild_id,
          channel_id,
          original_message_id,
          creator_discord_user_id,
          title,
          description,
          image_attachment_name,
          notification_role_id,
          draw_at,
          winner_count
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning *
        `,
        [
          input.discordGuildId,
          input.channelId,
          input.originalMessageId,
          input.creatorDiscordUserId,
          input.title,
          input.description,
          input.imageAttachmentName ?? null,
          input.notificationRoleId ?? null,
          input.drawAt,
          input.winnerCount
        ]
      );
      return mapGiveaway(result.rows[0]);
    },

    async getById(discordGuildId: string, giveawayId: string): Promise<GiveawayRecord | undefined> {
      const result = await pool.query<GiveawayRow>(
        "select * from giveaways where discord_guild_id = $1 and giveaway_id = $2",
        [discordGuildId, giveawayId]
      );
      return result.rows[0] ? mapGiveaway(result.rows[0]) : undefined;
    },

    async getOpenByMessage(discordGuildId: string, messageId: string): Promise<GiveawayRecord | undefined> {
      const result = await pool.query<GiveawayRow>(
        `select * from giveaways where discord_guild_id = $1 and original_message_id = $2 and state = 'open'`,
        [discordGuildId, messageId]
      );
      return result.rows[0] ? mapGiveaway(result.rows[0]) : undefined;
    },

    async getByMessage(discordGuildId: string, messageId: string): Promise<GiveawayRecord | undefined> {
      const result = await pool.query<GiveawayRow>(
        `select * from giveaways where discord_guild_id = $1 and original_message_id = $2`,
        [discordGuildId, messageId]
      );
      return result.rows[0] ? mapGiveaway(result.rows[0]) : undefined;
    },

    async listOpen(discordGuildId: string): Promise<GiveawayRecord[]> {
      const result = await pool.query<GiveawayRow>(
        `select * from giveaways where discord_guild_id = $1 and state = 'open' order by draw_at, giveaway_id`,
        [discordGuildId]
      );
      return result.rows.map(mapGiveaway);
    },

    async listOwned(
      discordGuildId: string,
      creatorDiscordUserId: string | undefined,
      states: GiveawayState[]
    ): Promise<GiveawayRecord[]> {
      const result = await pool.query<GiveawayRow>(
        `
        select *
        from giveaways
        where discord_guild_id = $1
          and ($2::text is null or creator_discord_user_id = $2)
          and state = any($3::text[])
        order by draw_at desc, giveaway_id desc
        limit 25
        `,
        [discordGuildId, creatorDiscordUserId ?? null, states]
      );
      return result.rows.map(mapGiveaway);
    },

    async listHostHistory(discordGuildId: string, creatorDiscordUserId: string): Promise<GiveawayRecord[]> {
      const result = await pool.query<GiveawayRow>(
        `
        select * from giveaways
        where discord_guild_id = $1 and creator_discord_user_id = $2
        order by case when state = 'open' then 0 else 1 end,
          case when state = 'open' then draw_at end asc,
          case when state <> 'open' then coalesce(cancelled_at, drawn_at, created_at) end desc,
          giveaway_id desc
        `,
        [discordGuildId, creatorDiscordUserId]
      );
      return result.rows.map(mapGiveaway);
    },

    async listDue(now: Date): Promise<GiveawayRecord[]> {
      const result = await pool.query<GiveawayRow>(
        `select * from giveaways where state = 'open' and draw_at <= $1 order by draw_at, giveaway_id`,
        [now]
      );
      return result.rows.map(mapGiveaway);
    },

    async listDrawnNeedingPublication(): Promise<GiveawayRecord[]> {
      const result = await pool.query<GiveawayRow>(
        `
        select * from giveaways
        where state = 'drawn'
          and original_message_deleted_at is null
          and (
            announcement_message_id is null
            or original_message_closed_at is null
          )
        order by drawn_at, giveaway_id
        `
      );
      return result.rows.map(mapGiveaway);
    },

    async isManagedUser(discordGuildId: string, discordUserId: string): Promise<boolean> {
      const result = await pool.query(
        `
        select 1
        from member_group_profiles
        where discord_guild_id = $1 and discord_user_id = $2
          and not exists (select 1 from guild_member_access access where access.discord_guild_id = $1 and access.discord_user_id = $2 and (access.blocked or access.cleanup_pending))
        limit 1
        `,
        [discordGuildId, discordUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async addReaction(
      discordGuildId: string,
      giveawayId: string,
      discordUserId: string,
      emojiKey: string
    ): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const reaction = await client.query(
          `
          insert into giveaway_reactions (giveaway_id, discord_guild_id, discord_user_id, emoji_key)
          select giveaway_id, discord_guild_id, $3, $4
          from giveaways
          where discord_guild_id = $1 and giveaway_id = $2 and state = 'open'
          on conflict do nothing
          `,
          [discordGuildId, giveawayId, discordUserId, emojiKey]
        );
        if ((reaction.rowCount ?? 0) > 0) {
          await client.query(
            `
            insert into giveaway_entries (giveaway_id, discord_guild_id, discord_user_id)
            values ($1, $2, $3)
            on conflict (giveaway_id, discord_user_id)
            do update set updated_at = now()
            `,
            [giveawayId, discordGuildId, discordUserId]
          );
        }
        await client.query("commit");
        return (reaction.rowCount ?? 0) > 0;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async removeReaction(
      discordGuildId: string,
      giveawayId: string,
      discordUserId: string,
      emojiKey: string
    ): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const reaction = await client.query(
          `
          delete from giveaway_reactions reaction
          using giveaways giveaway
          where reaction.giveaway_id = giveaway.giveaway_id
            and reaction.discord_guild_id = giveaway.discord_guild_id
            and reaction.discord_guild_id = $1
            and reaction.giveaway_id = $2
            and reaction.discord_user_id = $3
            and reaction.emoji_key = $4
            and giveaway.state = 'open'
          `,
          [discordGuildId, giveawayId, discordUserId, emojiKey]
        );
        await client.query(
          `
          delete from giveaway_entries entry
          where entry.discord_guild_id = $1
            and entry.giveaway_id = $2
            and entry.discord_user_id = $3
            and not exists (
              select 1 from giveaway_reactions reaction
              where reaction.giveaway_id = entry.giveaway_id
                and reaction.discord_user_id = entry.discord_user_id
            )
          `,
          [discordGuildId, giveawayId, discordUserId]
        );
        await client.query("commit");
        return (reaction.rowCount ?? 0) > 0;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async removeReactionsForMessage(
      discordGuildId: string,
      messageId: string,
      emojiKey?: string
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const giveaway = await client.query<{ giveaway_id: string }>(
          `select giveaway_id from giveaways where discord_guild_id = $1 and original_message_id = $2 and state = 'open'`,
          [discordGuildId, messageId]
        );
        const giveawayId = giveaway.rows[0]?.giveaway_id;
        if (!giveawayId) {
          await client.query("rollback");
          return;
        }
        await client.query(
          `delete from giveaway_reactions where discord_guild_id = $1 and giveaway_id = $2 and ($3::text is null or emoji_key = $3)`,
          [discordGuildId, giveawayId, emojiKey ?? null]
        );
        await client.query(
          `
          delete from giveaway_entries entry
          where entry.discord_guild_id = $1
            and entry.giveaway_id = $2
            and not exists (
              select 1 from giveaway_reactions reaction
              where reaction.giveaway_id = entry.giveaway_id
                and reaction.discord_user_id = entry.discord_user_id
            )
          `,
          [discordGuildId, giveawayId]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listEligibleParticipantIds(discordGuildId: string, giveawayId: string): Promise<string[]> {
      const result = await pool.query<{ discord_user_id: string }>(
        `
        select entry.discord_user_id
        from giveaway_entries entry
        where entry.discord_guild_id = $1
          and entry.giveaway_id = $2
          and exists (
            select 1 from member_group_profiles profile
            where profile.discord_guild_id = entry.discord_guild_id
              and profile.discord_user_id = entry.discord_user_id
          )
          and not exists (select 1 from guild_member_access access where access.discord_guild_id = entry.discord_guild_id and access.discord_user_id = entry.discord_user_id and (access.blocked or access.cleanup_pending))
        order by entry.joined_at, entry.discord_user_id
        `,
        [discordGuildId, giveawayId]
      );
      return result.rows.map((row) => row.discord_user_id);
    },

    async listRecordedParticipantIds(discordGuildId: string, giveawayId: string): Promise<string[]> {
      const result = await pool.query<{ discord_user_id: string }>(
        `
        select discord_user_id
        from giveaway_entries
        where discord_guild_id = $1 and giveaway_id = $2
        order by joined_at, discord_user_id
        `,
        [discordGuildId, giveawayId]
      );
      return result.rows.map((row) => row.discord_user_id);
    },

    async removeUserFromOpenGiveaways(discordGuildId: string, discordUserId: string): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
          delete from giveaway_reactions reaction
          using giveaways giveaway
          where reaction.giveaway_id = giveaway.giveaway_id
            and reaction.discord_guild_id = giveaway.discord_guild_id
            and reaction.discord_guild_id = $1
            and reaction.discord_user_id = $2
            and giveaway.state = 'open'
          `,
          [discordGuildId, discordUserId]
        );
        await client.query(
          `
          delete from giveaway_entries entry
          using giveaways giveaway
          where entry.giveaway_id = giveaway.giveaway_id
            and entry.discord_guild_id = giveaway.discord_guild_id
            and entry.discord_guild_id = $1
            and entry.discord_user_id = $2
            and giveaway.state = 'open'
          `,
          [discordGuildId, discordUserId]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async recordDraw(input: {
      discordGuildId: string;
      giveawayId: string;
      participantReactions: GiveawayReactionSnapshot[];
      winnerDiscordUserIds: string[];
      drawnByDiscordUserId?: string;
    }): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const updated = await client.query(
          `
          update giveaways
          set state = 'drawn', drawn_at = now(), drawn_by_discord_user_id = $3, updated_at = now()
          where discord_guild_id = $1 and giveaway_id = $2 and state = 'open'
          `,
          [input.discordGuildId, input.giveawayId, input.drawnByDiscordUserId ?? null]
        );
        if ((updated.rowCount ?? 0) === 0) {
          await client.query("rollback");
          return false;
        }

        const blockedParticipants = await client.query(
          `select 1 from guild_member_access where discord_guild_id = $1
            and discord_user_id = any($2::text[]) and (blocked or cleanup_pending) limit 1`,
          [input.discordGuildId, [...new Set([...input.participantReactions.map(entry => entry.discordUserId), ...input.winnerDiscordUserIds])]]
        );
        if (blockedParticipants.rows.length > 0) {
          await client.query("rollback");
          return false;
        }

        await client.query(
          "delete from giveaway_reactions where discord_guild_id = $1 and giveaway_id = $2",
          [input.discordGuildId, input.giveawayId]
        );
        await client.query(
          "delete from giveaway_entries where discord_guild_id = $1 and giveaway_id = $2",
          [input.discordGuildId, input.giveawayId]
        );
        for (const participant of input.participantReactions) {
          await client.query(
            `insert into giveaway_entries (giveaway_id, discord_guild_id, discord_user_id) values ($1, $2, $3)`,
            [input.giveawayId, input.discordGuildId, participant.discordUserId]
          );
          for (const emojiKey of participant.emojiKeys) {
            await client.query(
              `insert into giveaway_reactions (giveaway_id, discord_guild_id, discord_user_id, emoji_key) values ($1, $2, $3, $4)`,
              [input.giveawayId, input.discordGuildId, participant.discordUserId, emojiKey]
            );
          }
        }
        for (const [index, discordUserId] of input.winnerDiscordUserIds.entries()) {
          await client.query(
            `
            insert into giveaway_winners (
              giveaway_id, discord_guild_id, discord_user_id, winner_position
            ) values ($1, $2, $3, $4)
            `,
            [input.giveawayId, input.discordGuildId, discordUserId, index + 1]
          );
        }
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listWinners(discordGuildId: string, giveawayId: string): Promise<GiveawayWinner[]> {
      const result = await pool.query<GiveawayWinnerRow>(
        `
        select * from giveaway_winners
        where discord_guild_id = $1 and giveaway_id = $2
        order by winner_position, selected_at, giveaway_winner_id
        `,
        [discordGuildId, giveawayId]
      );
      return result.rows.map(mapWinner);
    },

    async setAnnouncementMessage(
      discordGuildId: string,
      giveawayId: string,
      announcementMessageId: string
    ): Promise<void> {
      await pool.query(
        `update giveaways set announcement_message_id = $3, updated_at = now() where discord_guild_id = $1 and giveaway_id = $2`,
        [discordGuildId, giveawayId, announcementMessageId]
      );
    },

    async markOriginalMessageDeleted(discordGuildId: string, messageId: string): Promise<void> {
      await pool.query(
        `
        update giveaways
        set
          original_message_deleted_at = coalesce(original_message_deleted_at, now()),
          state = case when state = 'open' then 'cancelled' else state end,
          cancelled_at = case when state = 'open' then coalesce(cancelled_at, now()) else cancelled_at end,
          updated_at = now()
        where discord_guild_id = $1 and original_message_id = $2
        `,
        [discordGuildId, messageId]
      );
    },

    async markOriginalMessageClosed(discordGuildId: string, messageId: string): Promise<void> {
      await pool.query(
        `
        update giveaways
        set original_message_closed_at = coalesce(original_message_closed_at, now()), updated_at = now()
        where discord_guild_id = $1 and original_message_id = $2
        `,
        [discordGuildId, messageId]
      );
    },

    async markChannelDeleted(discordGuildId: string, channelId: string): Promise<void> {
      await pool.query(
        `
        update giveaways
        set
          state = 'cancelled',
          cancelled_at = coalesce(cancelled_at, now()),
          original_message_deleted_at = coalesce(original_message_deleted_at, now()),
          updated_at = now()
        where discord_guild_id = $1 and channel_id = $2 and state = 'open'
        `,
        [discordGuildId, channelId]
      );
    },

    async cancel(
      discordGuildId: string,
      giveawayId: string,
      cancelledByDiscordUserId: string
    ): Promise<GiveawayRecord | undefined> {
      const result = await pool.query<GiveawayRow>(
        `
        update giveaways
        set state = 'cancelled', cancelled_at = now(), cancelled_by_discord_user_id = $3, updated_at = now()
        where discord_guild_id = $1 and giveaway_id = $2 and state = 'open'
        returning *
        `,
        [discordGuildId, giveawayId, cancelledByDiscordUserId]
      );
      return result.rows[0] ? mapGiveaway(result.rows[0]) : undefined;
    },

    async replaceWinner(input: {
      discordGuildId: string;
      giveawayId: string;
      unavailableDiscordUserId: string;
      replacementDiscordUserId: string;
      actorDiscordUserId: string;
    }): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const replaced = await client.query<{ winner_position: number }>(
          `
          update giveaway_winners winner
          set status = 'replaced', replaced_at = now(), replaced_by_discord_user_id = $4
          from giveaways giveaway
          where winner.giveaway_id = giveaway.giveaway_id
            and winner.discord_guild_id = giveaway.discord_guild_id
            and winner.discord_guild_id = $1
            and winner.giveaway_id = $2
            and winner.discord_user_id = $3
            and winner.status = 'current'
            and giveaway.state = 'drawn'
          returning winner.winner_position
          `,
          [
            input.discordGuildId,
            input.giveawayId,
            input.unavailableDiscordUserId,
            input.actorDiscordUserId
          ]
        );
        const position = replaced.rows[0]?.winner_position;
        if (!position) {
          await client.query("rollback");
          return false;
        }
        await client.query(
          `
          insert into giveaway_winners (
            giveaway_id, discord_guild_id, discord_user_id, winner_position
          ) values ($1, $2, $3, $4)
          `,
          [input.giveawayId, input.discordGuildId, input.replacementDiscordUserId, position]
        );
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

interface GiveawayRow {
  giveaway_id: string;
  discord_guild_id: string;
  channel_id: string;
  original_message_id: string;
  announcement_message_id: string | null;
  creator_discord_user_id: string;
  title: string;
  description: string;
  image_attachment_name: string | null;
  notification_role_id: string | null;
  draw_at: Date;
  winner_count: number;
  state: GiveawayState;
  drawn_at: Date | null;
  drawn_by_discord_user_id: string | null;
  cancelled_at: Date | null;
  cancelled_by_discord_user_id: string | null;
  original_message_closed_at: Date | null;
  original_message_deleted_at: Date | null;
  created_at: Date;
}

interface GiveawayWinnerRow {
  giveaway_winner_id: string;
  giveaway_id: string;
  discord_user_id: string;
  winner_position: number;
  status: "current" | "replaced";
  selected_at: Date;
  replaced_at: Date | null;
  replaced_by_discord_user_id: string | null;
}

function mapGiveaway(row: GiveawayRow): GiveawayRecord {
  return {
    giveawayId: row.giveaway_id,
    discordGuildId: row.discord_guild_id,
    channelId: row.channel_id,
    originalMessageId: row.original_message_id,
    announcementMessageId: row.announcement_message_id ?? undefined,
    creatorDiscordUserId: row.creator_discord_user_id,
    title: row.title,
    description: row.description,
    imageAttachmentName: row.image_attachment_name ?? undefined,
    notificationRoleId: row.notification_role_id ?? undefined,
    drawAt: row.draw_at,
    winnerCount: row.winner_count,
    state: row.state,
    drawnAt: row.drawn_at ?? undefined,
    drawnByDiscordUserId: row.drawn_by_discord_user_id ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cancelledByDiscordUserId: row.cancelled_by_discord_user_id ?? undefined,
    originalMessageClosedAt: row.original_message_closed_at ?? undefined,
    originalMessageDeletedAt: row.original_message_deleted_at ?? undefined,
    createdAt: row.created_at
  };
}

function mapWinner(row: GiveawayWinnerRow): GiveawayWinner {
  return {
    giveawayWinnerId: row.giveaway_winner_id,
    giveawayId: row.giveaway_id,
    discordUserId: row.discord_user_id,
    winnerPosition: row.winner_position,
    status: row.status,
    selectedAt: row.selected_at,
    replacedAt: row.replaced_at ?? undefined,
    replacedByDiscordUserId: row.replaced_by_discord_user_id ?? undefined
  };
}
