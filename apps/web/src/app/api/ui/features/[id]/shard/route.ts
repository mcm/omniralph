import { apiHandler } from "@/lib/api/handler";
import type { FeatureShardView } from "@/lib/api/feature-shards";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { discardShard, getShardView, startShard } from "@/lib/features/shard";

type Params = { id: string };

/** The feature's newest sharding into epics, with its rounds and drafts (members). */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<FeatureShardView> => getShardView(getDb(), user, params.id),
);

/**
 * Starts sharding the feature's Plan into epics (admins): 409 when it is archived or being
 * sharded already, 400 when the Plan is empty or has no `##` sections.
 */
export const POST = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }): Promise<FeatureShardView> =>
    startShard(getDb(), getDispatcher(), user, params.id),
);

/** Discards the feature's sharding while it drafts or waits for review (admins). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }): Promise<FeatureShardView> =>
    discardShard(getDb(), getDispatcher(), user, params.id),
);
