import { apiHandler } from "@/lib/api/handler";
import { createFeatureBodySchema, type FeatureList, type SavedFeature } from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { createFeature, loadFeatureList } from "@/lib/features/manage";

/**
 * The organization's features, newest first. Every member may look, with a session or an
 * API token (the omniralph-prd plugin).
 */
export const GET = apiHandler({ apiTokens: true }, async ({ user }): Promise<FeatureList> =>
  loadFeatureList(getDb(), user),
);

/**
 * Creates a feature (members, with a session or an API token): `{ name, repositoryId? }`.
 * 400 when the repo isn't one of the organization's connected repos.
 */
export const POST = apiHandler(
  { apiTokens: true, body: createFeatureBodySchema },
  async ({ user, body }): Promise<SavedFeature> => createFeature(getDb(), user, body),
);
