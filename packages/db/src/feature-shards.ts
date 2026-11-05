/**
 * Feature shardings: a feature's Plan sharded into epic drafts by a loop, reviewed by a
 * person, then filed as epics (`apps/web/src/lib/features/shard.ts`). Every write records a
 * live `feature` change for the feature, so its page refreshes.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import {
  featureShards,
  features,
  type FeatureParentIssue,
  type FeatureShardSection,
  type FeatureShardStatus,
} from "./schema.js";

export type FeatureShard = typeof featureShards.$inferSelect;

/** The statuses of a sharding that isn't over: at most one per feature. */
export const ACTIVE_FEATURE_SHARD_STATUSES = [
  "drafting",
  "review",
  "filing",
] as const satisfies readonly FeatureShardStatus[];

type Executor = Pick<Database, "select" | "insert" | "update">;

function recordShardChange(db: unknown, shard: Pick<FeatureShard, "featureId" | "organizationId">) {
  recordChange(db, {
    resource: "feature",
    ids: [shard.featureId],
    organizationId: shard.organizationId,
  });
}

export interface CreateFeatureShardInput {
  organizationId: string;
  featureId: string;
  planVersion: number;
  sections: FeatureShardSection[];
  createdBy: string | null;
}

/**
 * Starts a sharding of the feature (`drafting`), unless one is active already: then
 * `created` is false and `shard` is that one.
 */
export async function createFeatureShard(
  db: Executor,
  input: CreateFeatureShardInput,
): Promise<{ shard: FeatureShard; created: boolean }> {
  const [inserted] = await db
    .insert(featureShards)
    .values(input)
    .onConflictDoNothing({
      target: featureShards.featureId,
      where: sql`status in ('drafting', 'review', 'filing')`,
    })
    .returning();
  if (inserted) {
    recordShardChange(db, inserted);
    return { shard: inserted, created: true };
  }
  const [active] = await db
    .select()
    .from(featureShards)
    .where(
      and(
        eq(featureShards.featureId, input.featureId),
        inArray(featureShards.status, [...ACTIVE_FEATURE_SHARD_STATUSES]),
      ),
    );
  if (!active) throw new Error(`Feature ${input.featureId}'s active sharding vanished`);
  return { shard: active, created: false };
}

/** The organization's sharding by ID (locked `for update` with `lock`), or null. */
export async function getFeatureShard(
  db: Pick<Database, "select">,
  organizationId: string,
  shardId: string,
  options: { lock?: boolean } = {},
): Promise<FeatureShard | null> {
  const query = db
    .select()
    .from(featureShards)
    .where(and(eq(featureShards.id, shardId), eq(featureShards.organizationId, organizationId)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The feature's newest sharding, or null when it was never sharded. */
export async function getLatestFeatureShard(
  db: Pick<Database, "select">,
  organizationId: string,
  featureId: string,
): Promise<FeatureShard | null> {
  const [row] = await db
    .select()
    .from(featureShards)
    .where(
      and(eq(featureShards.featureId, featureId), eq(featureShards.organizationId, organizationId)),
    )
    .orderBy(desc(featureShards.createdAt), desc(featureShards.id))
    .limit(1);
  return row ?? null;
}

export type FeatureShardPatch = Partial<
  Pick<
    FeatureShard,
    | "status"
    | "drafts"
    | "exempt"
    | "summary"
    | "leftovers"
    | "outcome"
    | "error"
    | "repositoryId"
    | "filedBy"
    | "filedAt"
  >
>;

/**
 * Changes a sharding, only while it is in one of `fromStatus` when given; null when it
 * isn't (or doesn't exist).
 */
export async function updateFeatureShard(
  db: Pick<Database, "update">,
  shardId: string,
  patch: FeatureShardPatch,
  fromStatus?: FeatureShardStatus | readonly FeatureShardStatus[],
): Promise<FeatureShard | null> {
  const from = fromStatus === undefined ? null : [fromStatus].flat();
  const [row] = await db
    .update(featureShards)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(featureShards.id, shardId),
        from ? inArray(featureShards.status, [...from]) : undefined,
      ),
    )
    .returning();
  if (row) recordShardChange(db, row);
  return row ?? null;
}

/** Records the feature's parent issue in the tracker. */
export async function setFeatureParentIssue(
  db: Pick<Database, "update">,
  feature: { id: string; organizationId: string },
  parentIssue: FeatureParentIssue,
): Promise<void> {
  await db
    .update(features)
    .set({ parentIssue, updatedAt: new Date() })
    .where(and(eq(features.id, feature.id), eq(features.organizationId, feature.organizationId)));
  recordShardChange(db, { featureId: feature.id, organizationId: feature.organizationId });
}
