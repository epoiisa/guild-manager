import type { PoolClient } from "pg";
import type { PostgresPool } from "./postgres.js";
import { ENTRY_FEATURES, type EntryFeature } from "../services/entryPanels/types.js";
export interface ContentPanelPublication {
  discordGuildId: string;
  discordChannelId: string;
  configurationRevision: string;
  generation: string;
  previousGeneration: string | null;
  messageId: string | null;
  state: "pending" | "current" | "retired";
  renderHash: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  scanBeforeMessageId: string | null;
}
export interface BeginPanelPublicationInput {
  discordGuildId: string; discordChannelId: string; configurationRevision: string;
  generation: string; previousGeneration: string | null; renderHash: string; now: Date;
}
interface PublicationRow {
  discord_guild_id: string; discord_channel_id: string; configuration_revision: string;
  generation: string; previous_generation: string | null; message_id: string | null;
  state: ContentPanelPublication["state"]; render_hash: string;
  created_at: Date; updated_at: Date; published_at: Date | null; scan_before_message_id: string | null;
}
function mapPublication(row: PublicationRow): ContentPanelPublication {
  return { discordGuildId: row.discord_guild_id, discordChannelId: row.discord_channel_id,
    configurationRevision: row.configuration_revision, generation: row.generation,
    previousGeneration: row.previous_generation, messageId: row.message_id, state: row.state,
    renderHash: row.render_hash, createdAt: row.created_at, updatedAt: row.updated_at,
    publishedAt: row.published_at, scanBeforeMessageId: row.scan_before_message_id };
}

export function createPanelPublicationRepository(pool: PostgresPool, feature: EntryFeature | "content") {
  // Identifiers and the optional scope are selected only from this closed internal enum.
  if (feature !== "content" && !ENTRY_FEATURES.includes(feature)) throw new Error("Unknown entry panel feature.");
  const shared = feature !== "content";
  const messages = shared ? "entry_panel_messages" : "content_panel_messages";
  const configs = shared ? "entry_panel_channels" : "content_channel_configs";
  const scope = shared ? ` and feature = '${feature}'` : "";
  const column = shared ? "feature, " : "";
  const value = shared ? `'${feature}', ` : "";
  return {
    async listPublications(discordGuildId: string): Promise<ContentPanelPublication[]> {
      const result = await pool.query<PublicationRow>(`select * from ${messages} where discord_guild_id = $1${scope} order by created_at, generation`, [discordGuildId]);
      return result.rows.map(mapPublication);
    },
    async beginPublication(input: BeginPanelPublicationInput): Promise<ContentPanelPublication | undefined> {
      if (!/^[A-Za-z0-9_-]{1,25}$/.test(input.generation)) throw new Error("Invalid panel generation.");
      return transaction(pool, async client => {
        const config = await client.query(`select 1 from ${configs} where discord_guild_id = $1${scope}
          and discord_channel_id = $2 and configuration_revision = $3 for update`,
        [input.discordGuildId, input.discordChannelId, input.configurationRevision]);
        if (!config.rows.length) return undefined;
        const result = await client.query<PublicationRow>(`insert into ${messages}
          (${column}discord_guild_id, discord_channel_id, configuration_revision, generation, previous_generation, state, render_hash, created_at, updated_at)
          select ${value}$1, $2, $3, $4, $5::text, 'pending', $6, $7, $7
          where (select generation from ${messages} where discord_guild_id = $1${scope} and state = 'current') is not distinct from $5::text
          on conflict do nothing returning *`,
        [input.discordGuildId, input.discordChannelId, input.configurationRevision, input.generation, input.previousGeneration, input.renderHash, input.now]);
        return result.rows[0] ? mapPublication(result.rows[0]) : undefined;
      });
    },
    async commitPublication(discordGuildId: string, generation: string, messageId: string): Promise<boolean> {
      return transaction(pool, async client => {
        // Lock configuration first, matching begin/config changes/purge; never recreate a missing row.
        const config = await client.query<{ configuration_revision: string; discord_channel_id: string }>(
          `select configuration_revision, discord_channel_id from ${configs} where discord_guild_id = $1${scope} for update`, [discordGuildId]);
        if (!config.rows[0]) return false;
        const pending = await client.query<PublicationRow>(`select * from ${messages} where discord_guild_id = $1${scope}
          and generation = $2 and state = 'pending' for update`, [discordGuildId, generation]);
        const row = pending.rows[0];
        if (!row || row.configuration_revision !== config.rows[0].configuration_revision || row.discord_channel_id !== config.rows[0].discord_channel_id) return false;
        const current = await client.query<{ generation: string }>(`select generation from ${messages} where discord_guild_id = $1${scope} and state = 'current' for update`, [discordGuildId]);
        if ((current.rows[0]?.generation ?? null) !== row.previous_generation) return false;
        await client.query(`update ${messages} set state = 'retired', updated_at = now() where discord_guild_id = $1${scope} and state = 'current'`, [discordGuildId]);
        await client.query(`update ${messages} set state = 'current', message_id = $3, published_at = now(), updated_at = now()
          where discord_guild_id = $1${scope} and generation = $2 and state = 'pending'`, [discordGuildId, generation, messageId]);
        return true;
      });
    },
    async retirePublication(discordGuildId: string, generation: string, messageId?: string): Promise<void> {
      await pool.query(`update ${messages} set state = 'retired', message_id = coalesce($3, message_id), updated_at = now()
        where discord_guild_id = $1${scope} and generation = $2`, [discordGuildId, generation, messageId ?? null]);
    },
    async removePublication(discordGuildId: string, generation: string): Promise<void> {
      await pool.query(`delete from ${messages} where discord_guild_id = $1${scope} and generation = $2 and state <> 'current'`, [discordGuildId, generation]);
    },
    async markRendered(discordGuildId: string, generation: string, renderHash: string): Promise<void> {
      await pool.query(`update ${messages} set render_hash = $3, updated_at = now()
        where discord_guild_id = $1${scope} and generation = $2 and state = 'current'`, [discordGuildId, generation, renderHash]);
    },
    async updateRecoveryCursor(discordGuildId: string, generation: string, scanBeforeMessageId: string | null): Promise<void> {
      await pool.query(`update ${messages} set scan_before_message_id = $3, updated_at = now()
        where discord_guild_id = $1${scope} and generation = $2 and state in ('pending', 'retired')`, [discordGuildId, generation, scanBeforeMessageId]);
    }
  };
}
async function transaction<T>(pool: PostgresPool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); const result = await run(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
