/** Named concurrency pools of an organization (`pools`). */
import { DEFAULT_POOLS } from "@omniralph/shared";
import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { pools } from "./schema.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Seeds the `short` and `long` pools of an organization (no-op for existing ones). */
export async function seedPools(db: Queryable, organizationId: string): Promise<void> {
  await db
    .insert(pools)
    .values(DEFAULT_POOLS.map((name) => ({ organizationId, name })))
    .onConflictDoNothing();
}

/** The names of an organization's pools, oldest first. */
export async function listPoolNames(db: Database, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ name: pools.name })
    .from(pools)
    .where(eq(pools.organizationId, organizationId))
    .orderBy(asc(pools.createdAt), asc(pools.name));
  return rows.map((r) => r.name);
}
