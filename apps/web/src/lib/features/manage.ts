import "server-only";
import {
  createFeature as createFeatureRow,
  getFeature,
  getFeatureDocument,
  listFeatureDocumentVersions,
  listFeatures,
  saveFeatureDocument,
  updateFeature as updateFeatureRow,
  type Database,
  type FeatureDocument,
  type FeatureDocumentKind,
  type FeatureWithRepository,
} from "@omniralph/db";
import {
  FEATURE_DOCUMENT_KINDS,
  type CreateFeatureBody,
  type FeatureDocumentRow,
  type FeatureDocumentVersions,
  type FeatureList,
  type FeatureRow,
  type SaveFeatureDocumentBody,
  type SavedFeature,
  type SavedFeatureDocument,
  type UpdateFeatureBody,
} from "@/lib/api/features";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrgUser } from "@/lib/auth/session";

/**
 * Features: what the `/api/ui/features/**` handlers load and change, in the user's active
 * organization. Every member may create features, edit their PRFAQ and Plan, and archive them.
 */

export const FEATURE_NOT_FOUND_MESSAGE = "That feature doesn't exist.";
export const DOCUMENT_NOT_FOUND_MESSAGE = "That version doesn't exist.";
export const UNKNOWN_REPOSITORY_MESSAGE = "That repo isn't connected.";
export const ARCHIVED_MESSAGE = "This feature is archived. Restore it to change it.";
export const STALE_DOCUMENT_MESSAGE =
  "Someone saved a newer version since you opened this. Reload it to see their changes.";

export function featureRow(feature: FeatureWithRepository): FeatureRow {
  return {
    id: feature.id,
    name: feature.name,
    status: feature.status,
    repository: feature.repository,
    createdAt: feature.createdAt.toISOString(),
    updatedAt: feature.updatedAt.toISOString(),
  };
}

const unknownRepository = () =>
  new ApiRouteError(400, UNKNOWN_REPOSITORY_MESSAGE, "unknown_repository", {
    repositoryId: UNKNOWN_REPOSITORY_MESSAGE,
  });

/** A document kind from the URL, else 404. */
export function documentKind(kind: string): FeatureDocumentKind {
  if (!(FEATURE_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    throw ApiRouteError.notFound();
  }
  return kind as FeatureDocumentKind;
}

export async function loadFeatureList(db: Database, user: OrgUser): Promise<FeatureList> {
  return { features: (await listFeatures(db, user.organization.id)).map(featureRow) };
}

/** The active organization's feature, else 404. */
export async function requireFeature(
  db: Database,
  user: OrgUser,
  featureId: string,
): Promise<FeatureWithRepository> {
  const feature = await getFeature(db, user.organization.id, featureId);
  if (!feature) throw ApiRouteError.notFound(FEATURE_NOT_FOUND_MESSAGE);
  return feature;
}

export async function createFeature(
  db: Database,
  user: OrgUser,
  body: CreateFeatureBody,
): Promise<SavedFeature> {
  const result = await createFeatureRow(db, {
    organizationId: user.organization.id,
    name: body.name,
    repositoryId: body.repositoryId ?? null,
    createdBy: user.id,
  });
  if (result.status === "unknown_repository") throw unknownRepository();
  return { ok: true, feature: featureRow(result.feature) };
}

export async function updateFeature(
  db: Database,
  user: OrgUser,
  featureId: string,
  body: UpdateFeatureBody,
): Promise<SavedFeature> {
  const result = await updateFeatureRow(db, {
    organizationId: user.organization.id,
    featureId,
    name: body.name,
    repositoryId: body.repositoryId,
    status: body.archived === undefined ? undefined : body.archived ? "archived" : "planning",
  });
  if (result.status === "not_found") throw ApiRouteError.notFound(FEATURE_NOT_FOUND_MESSAGE);
  if (result.status === "unknown_repository") throw unknownRepository();
  return { ok: true, feature: featureRow(result.feature) };
}

function documentRow(
  kind: FeatureDocumentKind,
  document: FeatureDocument | null,
): FeatureDocumentRow {
  return document
    ? {
        kind,
        version: document.version,
        body: document.body,
        savedAt: document.createdAt.toISOString(),
      }
    : { kind, version: 0, body: "", savedAt: null };
}

/**
 * A feature's PRFAQ or Plan: its latest version (version 0, empty, when never saved), or
 * `version` (404 when there is no such version).
 */
export async function loadFeatureDocument(
  db: Database,
  user: OrgUser,
  featureId: string,
  kind: FeatureDocumentKind,
  version?: number,
): Promise<FeatureDocumentRow> {
  await requireFeature(db, user, featureId);
  const document = await getFeatureDocument(db, user.organization.id, featureId, kind, version);
  if (!document && version !== undefined) {
    throw ApiRouteError.notFound(DOCUMENT_NOT_FOUND_MESSAGE);
  }
  return documentRow(kind, document);
}

export async function loadFeatureDocumentVersions(
  db: Database,
  user: OrgUser,
  featureId: string,
  kind: FeatureDocumentKind,
): Promise<FeatureDocumentVersions> {
  await requireFeature(db, user, featureId);
  const versions = await listFeatureDocumentVersions(db, user.organization.id, featureId, kind);
  return {
    versions: versions.map((version) => ({
      version: version.version,
      savedAt: version.createdAt.toISOString(),
      savedBy: version.createdBy,
    })),
  };
}

/**
 * Saves a new version of a feature's PRFAQ or Plan. 409 `stale_version` when someone saved
 * a version after `baseVersion`, 409 `archived` for an archived feature.
 */
export async function saveDocument(
  db: Database,
  user: OrgUser,
  featureId: string,
  kind: FeatureDocumentKind,
  body: SaveFeatureDocumentBody,
): Promise<SavedFeatureDocument> {
  const result = await saveFeatureDocument(db, {
    organizationId: user.organization.id,
    featureId,
    kind,
    body: body.body,
    baseVersion: body.baseVersion,
    createdBy: user.id,
  });
  switch (result.status) {
    case "not_found":
      throw ApiRouteError.notFound(FEATURE_NOT_FOUND_MESSAGE);
    case "archived":
      throw new ApiRouteError(409, ARCHIVED_MESSAGE, "archived");
    case "stale":
      throw new ApiRouteError(409, STALE_DOCUMENT_MESSAGE, "stale_version");
    case "saved":
      return { ok: true, document: documentRow(kind, result.document) };
  }
}

/** The active organization's feature that isn't archived, for adding attachments. */
export async function requireOpenFeature(
  db: Database,
  user: OrgUser,
  featureId: string,
): Promise<FeatureWithRepository> {
  const feature = await requireFeature(db, user, featureId);
  if (feature.status === "archived") throw new ApiRouteError(409, ARCHIVED_MESSAGE, "archived");
  return feature;
}
