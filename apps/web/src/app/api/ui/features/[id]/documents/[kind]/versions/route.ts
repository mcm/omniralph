import { apiHandler } from "@/lib/api/handler";
import type { FeatureDocumentVersions } from "@/lib/api/features";
import { getDb } from "@/lib/db";
import { documentKind, loadFeatureDocumentVersions } from "@/lib/features/manage";

type Params = { id: string; kind: string };

/** Every saved version of a feature's PRFAQ or Plan, newest first, without their bodies. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<FeatureDocumentVersions> =>
    loadFeatureDocumentVersions(getDb(), user, params.id, documentKind(params.kind)),
);
