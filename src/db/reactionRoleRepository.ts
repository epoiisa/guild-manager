import type { PostgresPool } from "./postgres.js";

export interface ReactionRoleConfig {
  reactionRoleConfigId: string;
  discordGuildId: string;
  discordRoleId: string;
  createdByDiscordUserId: string;
}

export interface ReactionRoleEmojiPlacement {
  reactionRoleEmojiPlacementId: string;
  reactionRoleConfigId: string;
  discordGuildId: string;
  discordRoleId: string;
  channelId: string;
  messageId: string;
  emojiKey: string;
  emojiDisplayValue: string;
  createdByDiscordUserId: string;
}

export type ReactionRolePlacementConflict = "role_has_placement" | "message_emoji_in_use";

export class ReactionRolePlacementConflictError extends Error {
  constructor(public readonly conflict: ReactionRolePlacementConflict) {
    super(conflict);
    this.name = "ReactionRolePlacementConflictError";
  }
}

export function createReactionRoleRepository(pool: PostgresPool) {
  return {
    async addConfig(
      discordGuildId: string,
      discordRoleId: string,
      createdByDiscordUserId: string
    ): Promise<ReactionRoleConfig> {
      const result = await pool.query<ConfigRow>(
        `
        insert into reaction_role_configs (
          discord_guild_id,
          discord_role_id,
          created_by_discord_user_id,
          updated_at
        )
        values ($1, $2, $3, now())
        on conflict (discord_guild_id, discord_role_id) do update set updated_at = now()
        returning
          reaction_role_config_id,
          discord_guild_id,
          discord_role_id,
          created_by_discord_user_id
        `,
        [discordGuildId, discordRoleId, createdByDiscordUserId]
      );
      return mapConfig(result.rows[0]);
    },

    async getConfig(
      discordGuildId: string,
      idOrRoleId: string
    ): Promise<ReactionRoleConfig | undefined> {
      const result = await pool.query<ConfigRow>(
        `
        select
          reaction_role_config_id,
          discord_guild_id,
          discord_role_id,
          created_by_discord_user_id
        from reaction_role_configs
        where discord_guild_id = $1
          and (reaction_role_config_id::text = $2 or discord_role_id = $2)
        limit 1
        `,
        [discordGuildId, idOrRoleId]
      );
      return result.rows[0] ? mapConfig(result.rows[0]) : undefined;
    },

    async listConfigs(discordGuildId: string): Promise<ReactionRoleConfig[]> {
      const result = await pool.query<ConfigRow>(
        `
        select
          reaction_role_config_id,
          discord_guild_id,
          discord_role_id,
          created_by_discord_user_id
        from reaction_role_configs
        where discord_guild_id = $1
        order by discord_role_id
        `,
        [discordGuildId]
      );
      return result.rows.map(mapConfig);
    },

    async removeConfig(
      discordGuildId: string,
      idOrRoleId: string
    ): Promise<ReactionRoleConfig | undefined> {
      const result = await pool.query<ConfigRow>(
        `
        delete from reaction_role_configs
        where discord_guild_id = $1
          and (reaction_role_config_id::text = $2 or discord_role_id = $2)
        returning
          reaction_role_config_id,
          discord_guild_id,
          discord_role_id,
          created_by_discord_user_id
        `,
        [discordGuildId, idOrRoleId]
      );
      return result.rows[0] ? mapConfig(result.rows[0]) : undefined;
    },

    async addPlacement(input: {
      reactionRoleConfigId: string;
      discordGuildId: string;
      channelId: string;
      messageId: string;
      emojiKey: string;
      emojiDisplayValue: string;
      createdByDiscordUserId: string;
    }): Promise<ReactionRoleEmojiPlacement | undefined> {
      const result = await pool.query<PlacementRow>(
        `
        insert into reaction_role_emoji_placements (
          reaction_role_config_id,
          discord_guild_id,
          channel_id,
          message_id,
          emoji_key,
          emoji_display_value,
          created_by_discord_user_id,
          updated_at
        )
        select
          reaction_role_config_id,
          discord_guild_id,
          $3,
          $4,
          $5,
          $6,
          $7,
          now()
        from reaction_role_configs
        where reaction_role_config_id = $1
          and discord_guild_id = $2
        on conflict do nothing
        returning
          reaction_role_emoji_placement_id,
          reaction_role_config_id,
          discord_guild_id,
          channel_id,
          message_id,
          emoji_key,
          emoji_display_value,
          created_by_discord_user_id,
          (
            select discord_role_id
            from reaction_role_configs
            where reaction_role_config_id = reaction_role_emoji_placements.reaction_role_config_id
          ) discord_role_id
        `,
        [
          input.reactionRoleConfigId,
          input.discordGuildId,
          input.channelId,
          input.messageId,
          input.emojiKey,
          input.emojiDisplayValue,
          input.createdByDiscordUserId
        ]
      );
      if (result.rows[0]) return mapPlacement(result.rows[0]);

      const existing = await pool.query<{
        config_exists: boolean;
        role_placement: boolean;
        message_emoji_placement: boolean;
      }>(
        `
        select
          exists (
            select 1
            from reaction_role_configs
            where discord_guild_id = $1 and reaction_role_config_id = $2
          ) config_exists,
          exists (
            select 1
            from reaction_role_emoji_placements
            where discord_guild_id = $1 and reaction_role_config_id = $2
          ) role_placement,
          exists (
            select 1
            from reaction_role_emoji_placements
            where discord_guild_id = $1 and message_id = $3 and emoji_key = $4
          ) message_emoji_placement
        `,
        [
          input.discordGuildId,
          input.reactionRoleConfigId,
          input.messageId,
          input.emojiKey
        ]
      );
      if (!existing.rows[0]?.config_exists) return undefined;
      if (existing.rows[0].role_placement) {
        throw new ReactionRolePlacementConflictError("role_has_placement");
      }
      if (existing.rows[0].message_emoji_placement) {
        throw new ReactionRolePlacementConflictError("message_emoji_in_use");
      }
      return undefined;
    },

    async getPlacementForConfig(
      discordGuildId: string,
      reactionRoleConfigId: string
    ): Promise<ReactionRoleEmojiPlacement | undefined> {
      const result = await pool.query<PlacementRow>(
        `${placementSelect}
         where p.discord_guild_id = $1 and p.reaction_role_config_id = $2
         limit 1`,
        [discordGuildId, reactionRoleConfigId]
      );
      return result.rows[0] ? mapPlacement(result.rows[0]) : undefined;
    },

    async getPlacementByReaction(
      discordGuildId: string,
      messageId: string,
      emojiKey: string
    ): Promise<ReactionRoleEmojiPlacement | undefined> {
      const result = await pool.query<PlacementRow>(
        `${placementSelect}
         where p.discord_guild_id = $1 and p.message_id = $2 and p.emoji_key = $3
         limit 1`,
        [discordGuildId, messageId, emojiKey]
      );
      return result.rows[0] ? mapPlacement(result.rows[0]) : undefined;
    },

    async listPlacements(
      discordGuildId: string,
      reactionRoleConfigId?: string
    ): Promise<ReactionRoleEmojiPlacement[]> {
      const result = await pool.query<PlacementRow>(
        `${placementSelect}
         where p.discord_guild_id = $1
           and ($2::bigint is null or p.reaction_role_config_id = $2)
         order by p.channel_id, p.message_id, p.reaction_role_emoji_placement_id`,
        [discordGuildId, reactionRoleConfigId ?? null]
      );
      return result.rows.map(mapPlacement);
    },

    async removePlacement(
      discordGuildId: string,
      messageId: string,
      reactionRoleConfigId: string
    ): Promise<ReactionRoleEmojiPlacement | undefined> {
      const result = await pool.query<PlacementRow>(
        `
        delete from reaction_role_emoji_placements p
        using reaction_role_configs c
        where p.reaction_role_config_id = c.reaction_role_config_id
          and p.discord_guild_id = $1
          and p.message_id = $2
          and p.reaction_role_config_id = $3
        returning
          p.reaction_role_emoji_placement_id,
          p.reaction_role_config_id,
          p.discord_guild_id,
          c.discord_role_id,
          p.channel_id,
          p.message_id,
          p.emoji_key,
          p.emoji_display_value,
          p.created_by_discord_user_id
        `,
        [discordGuildId, messageId, reactionRoleConfigId]
      );
      return result.rows[0] ? mapPlacement(result.rows[0]) : undefined;
    },

    async removePlacementsForMessage(
      discordGuildId: string,
      messageId: string
    ): Promise<number> {
      const result = await pool.query(
        `
        delete from reaction_role_emoji_placements
        where discord_guild_id = $1 and message_id = $2
        `,
        [discordGuildId, messageId]
      );
      return result.rowCount ?? 0;
    },

    async isManagedUser(
      discordGuildId: string,
      discordUserId: string
    ): Promise<boolean> {
      const result = await pool.query(
        `
        select 1
        from member_group_profiles profile
        join member_groups member_group
          on member_group.member_group_id = profile.member_group_id
          and member_group.discord_guild_id = profile.discord_guild_id
        where profile.discord_guild_id = $1
          and profile.discord_user_id = $2
        limit 1
        `,
        [discordGuildId, discordUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async subscribe(
      discordGuildId: string,
      reactionRoleConfigId: string,
      discordUserId: string
    ): Promise<boolean> {
      const result = await pool.query(
        `
        insert into reaction_role_subscriptions (
          reaction_role_config_id,
          discord_guild_id,
          discord_user_id,
          updated_at
        )
        select reaction_role_config_id, discord_guild_id, $3, now()
        from reaction_role_configs
        where reaction_role_config_id = $2
          and discord_guild_id = $1
        on conflict (reaction_role_config_id, discord_user_id) do nothing
        `,
        [discordGuildId, reactionRoleConfigId, discordUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async unsubscribe(
      discordGuildId: string,
      reactionRoleConfigId: string,
      discordUserId: string
    ): Promise<boolean> {
      const result = await pool.query(
        `
        delete from reaction_role_subscriptions
        where discord_guild_id = $1
          and reaction_role_config_id = $2
          and discord_user_id = $3
        `,
        [discordGuildId, reactionRoleConfigId, discordUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deleteUserSubscriptions(
      discordGuildId: string,
      discordUserId: string
    ): Promise<void> {
      await pool.query(
        `
        delete from reaction_role_subscriptions
        where discord_guild_id = $1 and discord_user_id = $2
        `,
        [discordGuildId, discordUserId]
      );
    },

    async countSubscriptions(
      discordGuildId: string,
      reactionRoleConfigId: string
    ): Promise<number> {
      const result = await pool.query<{ count: string }>(
        `
        select count(*)::text count
        from reaction_role_subscriptions
        where discord_guild_id = $1 and reaction_role_config_id = $2
        `,
        [discordGuildId, reactionRoleConfigId]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async listSubscriberDiscordUserIds(
      discordGuildId: string,
      reactionRoleConfigId: string
    ): Promise<string[]> {
      const result = await pool.query<{ discord_user_id: string }>(
        `
        select discord_user_id
        from reaction_role_subscriptions
        where discord_guild_id = $1 and reaction_role_config_id = $2
        order by discord_user_id
        `,
        [discordGuildId, reactionRoleConfigId]
      );
      return result.rows.map((row) => row.discord_user_id);
    },

    async listSubscriptionCounts(discordGuildId: string): Promise<Map<string, number>> {
      const result = await pool.query<{ reaction_role_config_id: string; count: string }>(
        `
        select reaction_role_config_id, count(*)::text count
        from reaction_role_subscriptions
        where discord_guild_id = $1
        group by reaction_role_config_id
        `,
        [discordGuildId]
      );
      return new Map(
        result.rows.map((row) => [row.reaction_role_config_id, Number(row.count)])
      );
    }
  };
}

const placementSelect = `
  select
    p.reaction_role_emoji_placement_id,
    p.reaction_role_config_id,
    p.discord_guild_id,
    c.discord_role_id,
    p.channel_id,
    p.message_id,
    p.emoji_key,
    p.emoji_display_value,
    p.created_by_discord_user_id
  from reaction_role_emoji_placements p
  join reaction_role_configs c
    on c.reaction_role_config_id = p.reaction_role_config_id
    and c.discord_guild_id = p.discord_guild_id
`;

interface ConfigRow {
  reaction_role_config_id: string;
  discord_guild_id: string;
  discord_role_id: string;
  created_by_discord_user_id: string;
}

interface PlacementRow {
  reaction_role_emoji_placement_id: string;
  reaction_role_config_id: string;
  discord_guild_id: string;
  discord_role_id: string;
  channel_id: string;
  message_id: string;
  emoji_key: string;
  emoji_display_value: string;
  created_by_discord_user_id: string;
}

function mapConfig(row: ConfigRow): ReactionRoleConfig {
  return {
    reactionRoleConfigId: row.reaction_role_config_id,
    discordGuildId: row.discord_guild_id,
    discordRoleId: row.discord_role_id,
    createdByDiscordUserId: row.created_by_discord_user_id
  };
}

function mapPlacement(row: PlacementRow): ReactionRoleEmojiPlacement {
  return {
    reactionRoleEmojiPlacementId: row.reaction_role_emoji_placement_id,
    reactionRoleConfigId: row.reaction_role_config_id,
    discordGuildId: row.discord_guild_id,
    discordRoleId: row.discord_role_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    emojiKey: row.emoji_key,
    emojiDisplayValue: row.emoji_display_value,
    createdByDiscordUserId: row.created_by_discord_user_id
  };
}
