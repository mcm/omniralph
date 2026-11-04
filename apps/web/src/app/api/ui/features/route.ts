import { apiHandler } from "@/lib/api/handler";
import { createFeatureBodySchema, type FeatureList, type SavedFeature } from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { createFeature, loadFeatureList } from "@/lib/features/manage";

/** The organization's features, newest first. Every member may look. */
export const GET = apiHandler({}, async ({ user }): Promise<FeatureList> =>
  loadFeatureList(getDb(), user),
);

/**
 * Creates a feature (members): `{ name, repositoryId? }`. 400 when the repo isn't one of
 * the organization's connected repos.
 */
export const POST = apiHandler(
  { body: createFeatureBodySchema },
  async ({ user, body }): Promise<SavedFeature> => createFeature(getDb(), user, body),
);
