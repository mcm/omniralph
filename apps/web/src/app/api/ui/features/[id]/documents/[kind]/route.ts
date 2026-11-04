import { apiHandler } from "@/lib/api/handler";
import {
  featureDocumentQuerySchema,
  saveFeatureDocumentBodySchema,
  type FeatureDocumentRow,
  type SavedFeatureDocument,
} from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { documentKind, loadFeatureDocument, saveDocument } from "@/lib/features/manage";

type Params = { id: string; kind: string };

/**
 * A feature's PRFAQ (`prfaq`) or Plan (`plan`): its latest version (version 0 and empty when
 * never saved), or `?version=` (404 when there is no such version).
 */
export const GET = apiHandler<"member", undefined, typeof featureDocumentQuerySchema, Params>(
  { query: featureDocumentQuerySchema },
  async ({ user, params, query }): Promise<FeatureDocumentRow> =>
    loadFeatureDocument(getDb(), user, params.id, documentKind(params.kind), query.version),
);

/**
 * Saves a new version of the document (members): `{ body, baseVersion }`, `baseVersion` the
 * version the edit started from. Earlier versions are kept. 409 `stale_version` when someone
 * saved a later version, 409 `archived` for an archived feature.
 */
export const PUT = apiHandler<"member", typeof saveFeatureDocumentBodySchema, undefined, Params>(
  { body: saveFeatureDocumentBodySchema },
  async ({ user, params, body }): Promise<SavedFeatureDocument> =>
    saveDocument(getDb(), user, params.id, documentKind(params.kind), body),
);
