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

/**
 * Closes the client's pool and waits until every connection has closed.
 * `pool.end()` resolves as soon as its clients are released, before their
 * sockets close, so stopping the server right after it can terminate a
 * connection that is still closing (an uncaught `57P01`).
 */
export async function closeDb(db: Database): Promise<void> {
  const pool = db.$client;
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on("remove", () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
