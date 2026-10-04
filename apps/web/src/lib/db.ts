import "server-only";
import { createDb, type Database } from "@omniralph/db";

let db: Database | undefined;

/** Shared Drizzle client over Neon's pooled `DATABASE_URL`, created on first use. */
export function getDb(): Database {
  db ??= createDb();
  return db;
}
