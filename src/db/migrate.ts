import { loadConfig } from "../config.js";
import { createPostgresPool } from "./postgres.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabaseSchema } from "./schema.js";

const config = loadConfig();
const postgres = createPostgresPool(config.databaseUrl);

try {
  await migrateDatabaseSchema(postgres);
  console.log(`Database schema is at version ${CURRENT_SCHEMA_VERSION}.`);
} finally {
  await postgres.end();
}
