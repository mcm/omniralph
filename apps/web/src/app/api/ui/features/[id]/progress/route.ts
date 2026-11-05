import { apiHandler } from "@/lib/api/handler";
import type { FeatureProgress } from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { loadFeatureProgress } from "@/lib/features/progress";

type Params = { id: string };

/**
 * How far along a feature is: each epic with its state and stories in the tracker, its latest
 * run and PRs, and the roll-up of epics and stories done. Another organization's or an
 * unknown feature is 404.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<FeatureProgress> =>
    loadFeatureProgress({ db: getDb() }, user, params.id),
);
