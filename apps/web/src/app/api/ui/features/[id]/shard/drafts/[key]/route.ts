import { apiHandler } from "@/lib/api/handler";
import { updateShardDraftBodySchema, type FeatureShardView } from "@/lib/api/feature-shards";
import { getDb } from "@/lib/db";
import { updateShardDraft } from "@/lib/features/shard";

type Params = { id: string; key: string };

/**
 * Edits, removes or approves one drafted epic while the drafts wait for review (admins):
 * `{ title?, description?, decision? }`.
 */
export const PATCH = apiHandler<"admin", typeof updateShardDraftBodySchema, undefined, Params>(
  { access: "admin", body: updateShardDraftBodySchema },
  async ({ user, params, body }): Promise<FeatureShardView> =>
    updateShardDraft(getDb(), user, params.id, params.key, body),
);
