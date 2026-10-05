import type { PostgresPool } from "./postgres.js";
import type { EntryFeature, EntryRole, EntrySelection } from "../services/entryPanels/types.js";
import { createPanelPublicationRepository } from "./panelPublicationRepository.js";

export function createEntryPanelRepository(pool: PostgresPool) {
  return {
    async getChannel(guildId: string, feature: EntryFeature): Promise<EntrySelection | undefined> {
      const result = await pool.query<{ discord_channel_id: string; configuration_revision: string }>(
        "select discord_channel_id, configuration_revision from entry_panel_channels where discord_guild_id = $1 and feature = $2", [guildId, feature]);
      const row = result.rows[0];
      return row ? { discordChannelId: row.discord_channel_id, configurationRevision: row.configuration_revision } : undefined;
    },
    async setChannel(guildId: string, feature: EntryFeature, channelId: string): Promise<void> {
      // Reapplying a setting repairs presentation without invalidating unfinished forms.
      await pool.query(`insert into entry_panel_channels (discord_guild_id, feature, discord_channel_id) values ($1, $2, $3)
        on conflict (discord_guild_id, feature) do update set discord_channel_id = excluded.discord_channel_id,
        configuration_revision = case when entry_panel_channels.discord_channel_id = excluded.discord_channel_id
          then entry_panel_channels.configuration_revision else gen_random_uuid()::text end`, [guildId, feature, channelId]);
    },
    async clearChannel(guildId: string, feature: EntryFeature): Promise<void> {
      await pool.query("delete from entry_panel_channels where discord_guild_id = $1 and feature = $2", [guildId, feature]);
    },
    async prepareChannel(guildId: string, feature: EntryFeature, channelId: string, revision: string, generation: string, hash: string): Promise<boolean> {
      // Keep the previous configuration authoritative until Discord confirms publication.
      const result = await pool.query(`insert into entry_panel_messages
        (discord_guild_id, feature, discord_channel_id, configuration_revision, generation, previous_generation, state, render_hash)
        select $1, $2, $3, $4, $5, (select generation from entry_panel_messages where discord_guild_id = $1 and feature = $2 and state = 'current'), 'pending', $6
        on conflict do nothing returning generation`, [guildId, feature, channelId, revision, generation, hash]);
      return result.rows.length > 0;
    },
    async commitChannel(guildId: string, feature: EntryFeature, generation: string, messageId: string, expectedRevision: string | undefined): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await client.query<{ configuration_revision: string }>("select configuration_revision from entry_panel_channels where discord_guild_id = $1 and feature = $2 for update", [guildId, feature]);
        if (current.rows[0]?.configuration_revision !== expectedRevision) { await client.query("rollback"); return false; }
        const pending = await client.query<{ discord_channel_id: string; configuration_revision: string }>("select discord_channel_id, configuration_revision from entry_panel_messages where discord_guild_id = $1 and feature = $2 and generation = $3 and state = 'pending' for update", [guildId, feature, generation]);
        const row = pending.rows[0];
        if (!row) { await client.query("rollback"); return false; }
        await client.query(`insert into entry_panel_channels (discord_guild_id, feature, discord_channel_id, configuration_revision) values ($1,$2,$3,$4)
          on conflict (discord_guild_id, feature) do update set discord_channel_id = excluded.discord_channel_id, configuration_revision = excluded.configuration_revision`, [guildId, feature, row.discord_channel_id, row.configuration_revision]);
        await client.query("update entry_panel_messages set state = 'retired', updated_at = now() where discord_guild_id = $1 and feature = $2 and state = 'current'", [guildId, feature]);
        await client.query("update entry_panel_messages set state = 'current', message_id = $4, published_at = now(), updated_at = now() where discord_guild_id = $1 and feature = $2 and generation = $3", [guildId, feature, generation, messageId]);
        await client.query("commit");
        return true;
      } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
      finally { client.release(); }
    },
    async listRoles(guildId: string, kind: EntryRole): Promise<string[]> {
      const result = await pool.query<{ discord_role_id: string }>("select discord_role_id from entry_panel_roles where discord_guild_id = $1 and role_kind = $2 order by discord_role_id", [guildId, kind]);
      return result.rows.map(row => row.discord_role_id);
    },
    async addRole(guildId: string, kind: EntryRole, roleId: string): Promise<boolean> {
      const result = await pool.query("insert into entry_panel_roles (discord_guild_id, role_kind, discord_role_id) values ($1, $2, $3) on conflict do nothing returning discord_role_id", [guildId, kind, roleId]);
      return result.rows.length > 0;
    },
    async removeRole(guildId: string, kind: EntryRole, roleId: string): Promise<boolean> {
      const result = await pool.query("delete from entry_panel_roles where discord_guild_id = $1 and role_kind = $2 and discord_role_id = $3 returning discord_role_id", [guildId, kind, roleId]);
      return result.rows.length > 0;
    },
    publications(feature: EntryFeature) { return createPanelPublicationRepository(pool, feature); }
  };
}
