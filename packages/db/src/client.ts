import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Creates a Drizzle client over a `pg` pool. Defaults to `DATABASE_URL` (Neon's pooled URL). */
export function createDb(connectionString = process.env.DATABASE_URL): Database {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString });
  return drizzle(pool, { schema });
}
