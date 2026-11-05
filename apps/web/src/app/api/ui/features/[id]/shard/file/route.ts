import { apiHandler } from "@/lib/api/handler";
import { fileShardBodySchema, type FeatureShardView } from "@/lib/api/feature-shards";
import { getDb } from "@/lib/db";
import { fileShard } from "@/lib/features/file-shard";

type Params = { id: string };

/**
 * Files the approved drafts as epics (admins) in the team and project of the repo's work item
 * match: `{ repositoryId }`. 409 until every draft is approved or removed.
 */
export const POST = apiHandler<"admin", typeof fileShardBodySchema, undefined, Params>(
  { access: "admin", body: fileShardBodySchema },
  async ({ user, params, body }): Promise<FeatureShardView> =>
    fileShard({ db: getDb() }, user, params.id, body),
);
