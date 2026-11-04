import { apiHandler } from "@/lib/api/handler";
import { updateFeatureBodySchema, type FeatureRow, type SavedFeature } from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { featureRow, requireFeature, updateFeature } from "@/lib/features/manage";

type Params = { id: string };

/** One feature of the organization; another organization's or an unknown ID is 404. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<FeatureRow> =>
    featureRow(await requireFeature(getDb(), user, params.id)),
);

/**
 * Renames a feature, changes its repo, or archives or restores it (members):
 * `{ name?, repositoryId?, archived? }`. 400 when the repo isn't connected.
 */
export const PATCH = apiHandler<"member", typeof updateFeatureBodySchema, undefined, Params>(
  { body: updateFeatureBodySchema },
  async ({ user, params, body }): Promise<SavedFeature> =>
    updateFeature(getDb(), user, params.id, body),
);
