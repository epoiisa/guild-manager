import type { PostgresPool } from "./postgres.js";
import { purgeGuildOwnedData } from "./guildDataPurge.js";

interface GuildLifecycleRow {
  status: "active" | "inactive";
}

export function createResetRepository(pool: PostgresPool) {
  return {
    async purgeGuildData(discordGuildId: string): Promise<void> {
      const client = await pool.connect();

      try {
        await client.query("begin");

        const lifecycle = await client.query<GuildLifecycleRow>(
          `
          select status
          from discord_guild_lifecycle
          where discord_guild_id = $1
          for update
          `,
          [discordGuildId]
        );
        if (lifecycle.rows[0]?.status !== "active") {
          throw new Error("Guild Manager is not active on this Discord server.");
        }

        await purgeGuildOwnedData(client, discordGuildId);

        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
