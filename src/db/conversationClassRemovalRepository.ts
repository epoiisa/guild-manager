import type { PostgresPool } from "./postgres.js";

export type ConversationKind = "application" | "ticket";
export interface ClassConversation {
  id: string;
  channelId?: string;
  userId: string;
  status: "open" | "closed" | "deleted";
}
export interface ConversationClassSnapshot {
  classId: string;
  name: string;
  sourceChannelId?: string;
  sourceMessageId?: string;
  activeRoleId?: string;
  conversations: ClassConversation[];
}

/** Class removal is separate from ordinary channel deletion and group archival. */
export function createConversationClassRemovalRepository(pool: PostgresPool, kind: ConversationKind) {
  const classes = kind === "application" ? "application_classes" : "ticket_classes";
  const records = kind === "application" ? "open_applications" : "tickets";
  const classId = kind === "application" ? "application_class_id" : "ticket_class_id";
  const recordId = kind === "application" ? "application_id" : "ticket_id";
  const status = kind === "application" ? "channel_status" : "status";
  const userId = kind === "application" ? "applicant_discord_user_id" : "opener_discord_user_id";

  return {
    kind,
    async getSnapshot(guildId: string, id: string): Promise<ConversationClassSnapshot | undefined> {
      const result = await pool.query<{
        class_id: string; name: string; source_channel_id: string | null; source_message_id: string | null;
        active_role_id: string | null; conversations: ClassConversation[];
      }>(`
        select c.${classId} as class_id, c.name, c.source_channel_id, c.source_message_id,
          ${kind === "application" ? "c.active_role_id" : "null::text"} as active_role_id,
          coalesce(jsonb_agg(jsonb_build_object(
            'id', r.${recordId}::text, 'channelId', r.ticket_channel_id,
            'userId', r.${userId}, 'status', r.${status}
          ) order by r.${recordId}) filter (where r.${recordId} is not null), '[]'::jsonb) as conversations
        from ${classes} c
        left join ${records} r on r.${classId}=c.${classId} and r.discord_guild_id=c.discord_guild_id
        where c.discord_guild_id=$1 and c.${classId}=$2
        group by c.${classId}
      `, [guildId, id]);
      const row = result.rows[0];
      return row ? {
        classId: row.class_id, name: row.name,
        sourceChannelId: row.source_channel_id ?? undefined, sourceMessageId: row.source_message_id ?? undefined,
        activeRoleId: row.active_role_id ?? undefined,
        conversations: row.conversations.map((record) => ({ ...record, channelId: record.channelId ?? undefined }))
      } : undefined;
    },
    async disable(guildId: string, id: string): Promise<void> {
      // Archived application classes are already disabled and reject every UPDATE.
      await pool.query(`update ${classes} set enabled=false, updated_at=now() where discord_guild_id=$1 and ${classId}=$2 and enabled=true`, [guildId, id]);
    },
    async markDeleted(guildId: string, id: string, actorId: string): Promise<void> {
      await pool.query(`
        update ${records} set ${status}='deleted', deleted_at=coalesce(deleted_at, now()),
          deleted_by_discord_user_id=coalesce(deleted_by_discord_user_id, $3), updated_at=now()
        where discord_guild_id=$1 and ${recordId}=$2
      `, [guildId, id, actorId]);
    },
    async remove(guildId: string, id: string): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const target = await client.query<{ enabled: boolean }>(
          `select enabled from ${classes} where discord_guild_id=$1 and ${classId}=$2 for update`, [guildId, id]
        );
        if (!target.rows[0]) { await client.query("commit"); return false; }
        if (target.rows[0].enabled) throw new Error("Class intake must be disabled before removal.");
        const remaining = await client.query(`select 1 from ${records} where discord_guild_id=$1 and ${classId}=$2 and ${status}<>'deleted' limit 1`, [guildId, id]);
        if (remaining.rows.length) throw new Error("Class conversations must be deleted before removal.");
        await client.query(`delete from ${records} where discord_guild_id=$1 and ${classId}=$2`, [guildId, id]);
        await client.query(`delete from ${classes} where discord_guild_id=$1 and ${classId}=$2`, [guildId, id]);
        await client.query("commit");
        return true;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

export type ConversationClassRemovalRepository = ReturnType<typeof createConversationClassRemovalRepository>;
