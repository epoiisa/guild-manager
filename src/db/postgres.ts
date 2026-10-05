import pg from "pg";

export type PostgresPool = pg.Pool;

export function createPostgresPool(databaseUrl: string): PostgresPool {
  return new pg.Pool({
    connectionString: databaseUrl
  });
}

export async function checkPostgresConnection(pool: PostgresPool): Promise<void> {
  await pool.query("select 1");
}
