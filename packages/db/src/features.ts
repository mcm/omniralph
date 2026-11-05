/**
 * Features: groups of epics planned together, each with a PRFAQ and a Plan (versioned: every
 * save adds a version and keeps the earlier ones) and attachments. Attachments belong to a
 * feature or to a work item; their files live in object storage (the caller stores and
 * deletes them), only their metadata here.
 *
 * Every write records a live change: `feature` for a feature, its documents and its
 * attachments (`ids` = the feature), `work_item` for a work item's attachments.
 */
import { and, asc, desc, eq, isNull, max, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import {
  attachments,
  featureDocuments,
  featureEpics,
  features,
  repositories,
  users,
} from "./schema.js";
import type { WorkItemTracker } from "./work-item-matches.js";
import { workItemUrlId, type WorkItemKey } from "./work-items.js";

export type Feature = typeof features.$inferSelect;
export type FeatureStatus = Feature["status"];
export type FeatureDocument = typeof featureDocuments.$inferSelect;
export type FeatureDocumentKind = FeatureDocument["kind"];
export type Attachment = typeof attachments.$inferSelect;

/** A feature with the repo it's scoped to, if any, and how many epics it has. */
export interface FeatureWithRepository extends Feature {
  epicCount: number;
  repository: {
    id: string;
    provider: (typeof repositories.$inferSelect)["provider"];
    fullPath: string;
  } | null;
}

async function loadFeatures(
  db: Pick<Database, "select">,
  organizationId: string,
  featureId?: string,
): Promise<FeatureWithRepository[]> {
  const rows = await db
    .select({
      feature: features,
      repositoryProvider: repositories.provider,
      repositoryFullPath: repositories.fullPath,
      epicCount: sql<number>`(select count(*)::int from ${featureEpics} where ${featureEpics.featureId} = ${features.id})`,
    })
    .from(features)
    .leftJoin(repositories, eq(repositories.id, features.repositoryId))
    .where(
      and(
        eq(features.organizationId, organizationId),
        featureId ? eq(features.id, featureId) : undefined,
      ),
    )
    .orderBy(desc(features.createdAt), desc(features.id));
  return rows.map(({ feature, repositoryProvider, repositoryFullPath, epicCount }) => ({
    ...feature,
    epicCount: Number(epicCount),
    repository:
      feature.repositoryId && repositoryProvider && repositoryFullPath
        ? { id: feature.repositoryId, provider: repositoryProvider, fullPath: repositoryFullPath }
        : null,
  }));
}

/** The organization's features, newest first. */
export async function listFeatures(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<FeatureWithRepository[]> {
  return loadFeatures(db, organizationId);
}

/** One of the organization's features, or null. */
export async function getFeature(
  db: Pick<Database, "select">,
  organizationId: string,
  featureId: string,
): Promise<FeatureWithRepository | null> {
  const [feature] = await loadFeatures(db, organizationId, featureId);
  return feature ?? null;
}

/** Whether `repositoryId` is one of the organization's connected repositories. */
async function isConnectedRepository(
  db: Pick<Database, "select">,
  organizationId: string,
  repositoryId: string,
): Promise<boolean> {
  const [repository] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repositoryId),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    );
  return repository !== undefined;
}

export interface CreateFeatureInput {
  organizationId: string;
  name: string;
  /** The repo its epics build in, or null for none. */
  repositoryId: string | null;
  createdBy: string | null;
}

export type CreateFeatureResult =
  | { status: "created"; feature: FeatureWithRepository }
  /** The repository isn't one of the organization's connected repositories. */
  | { status: "unknown_repository" };

/** Creates a feature in `planning`, without documents yet. */
export async function createFeature(
  db: Database,
  input: CreateFeatureInput,
): Promise<CreateFeatureResult> {
  const { organizationId } = input;
  return db.transaction(async (tx) => {
    if (
      input.repositoryId &&
      !(await isConnectedRepository(tx, organizationId, input.repositoryId))
    ) {
      return { status: "unknown_repository" as const };
    }
    const [feature] = await tx
      .insert(features)
      .values({
        organizationId,
        name: input.name,
        repositoryId: input.repositoryId,
        createdBy: input.createdBy,
      })
      .returning();
    recordChange(tx, { resource: "feature", ids: [feature!.id], organizationId });
    return {
      status: "created" as const,
      feature: (await getFeature(tx, organizationId, feature!.id))!,
    };
  });
}

export interface UpdateFeatureInput {
  organizationId: string;
  featureId: string;
  name?: string;
  repositoryId?: string | null;
  /** `archived` archives the feature, `planning` restores it. */
  status?: FeatureStatus;
}

export type UpdateFeatureResult =
  | { status: "updated"; feature: FeatureWithRepository }
  | { status: "not_found" }
  | { status: "unknown_repository" };

/** Renames a feature, changes its repo, or archives or restores it (each only when given). */
export async function updateFeature(
  db: Database,
  input: UpdateFeatureInput,
): Promise<UpdateFeatureResult> {
  const { organizationId, featureId } = input;
  return db.transaction(async (tx) => {
    const current = await getFeature(tx, organizationId, featureId);
    if (!current) return { status: "not_found" as const };
    if (
      input.repositoryId &&
      input.repositoryId !== current.repositoryId &&
      !(await isConnectedRepository(tx, organizationId, input.repositoryId))
    ) {
      return { status: "unknown_repository" as const };
    }
    await tx
      .update(features)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.repositoryId !== undefined && { repositoryId: input.repositoryId }),
        ...(input.status !== undefined && { status: input.status }),
        updatedAt: new Date(),
      })
      .where(eq(features.id, featureId));
    recordChange(tx, { resource: "feature", ids: [featureId], organizationId });
    return {
      status: "updated" as const,
      feature: (await getFeature(tx, organizationId, featureId))!,
    };
  });
}

// ── Documents ────────────────────────────────────────────────────────────

/**
 * A feature's PRFAQ or Plan: its latest version, or `version` when given. Null when the
 * feature isn't the organization's, or the document (or that version) was never saved.
 */
export async function getFeatureDocument(
  db: Pick<Database, "select">,
  organizationId: string,
  featureId: string,
  kind: FeatureDocumentKind,
  version?: number,
): Promise<FeatureDocument | null> {
  const [document] = await db
    .select()
    .from(featureDocuments)
    .where(
      and(
        eq(featureDocuments.organizationId, organizationId),
        eq(featureDocuments.featureId, featureId),
        eq(featureDocuments.kind, kind),
        version !== undefined ? eq(featureDocuments.version, version) : undefined,
      ),
    )
    .orderBy(desc(featureDocuments.version))
    .limit(1);
  return document ?? null;
}

/** One saved version of a document, without its body. */
export type FeatureDocumentVersion = Pick<
  FeatureDocument,
  "version" | "createdBy" | "createdAt"
> & {
  /** The saver's name, null when unknown (no name, or the user is gone). */
  createdByName: string | null;
};

/** Every saved version of a feature's PRFAQ or Plan, newest first. */
export async function listFeatureDocumentVersions(
  db: Pick<Database, "select">,
  organizationId: string,
  featureId: string,
  kind: FeatureDocumentKind,
): Promise<FeatureDocumentVersion[]> {
  return db
    .select({
      version: featureDocuments.version,
      createdBy: featureDocuments.createdBy,
      createdAt: featureDocuments.createdAt,
      createdByName: users.name,
    })
    .from(featureDocuments)
    .leftJoin(users, eq(users.id, featureDocuments.createdBy))
    .where(
      and(
        eq(featureDocuments.organizationId, organizationId),
        eq(featureDocuments.featureId, featureId),
        eq(featureDocuments.kind, kind),
      ),
    )
    .orderBy(desc(featureDocuments.version));
}

export interface SaveFeatureDocumentInput {
  organizationId: string;
  featureId: string;
  kind: FeatureDocumentKind;
  body: string;
  /** The version the save was made from: the latest one read, 0 for a document never saved. */
  baseVersion: number;
  createdBy: string | null;
}

export type SaveFeatureDocumentResult =
  | { status: "saved"; document: FeatureDocument }
  | { status: "not_found" }
  /** An archived feature's documents don't change; nothing was written. */
  | { status: "archived" }
  /** Someone saved a later version since `baseVersion`; nothing was written. */
  | { status: "stale"; currentVersion: number };

/**
 * Saves a new version of a feature's PRFAQ or Plan, keeping the earlier ones, unless the
 * latest version isn't `baseVersion` (a save from a stale copy). Saves of one feature are
 * serialized by locking its row.
 */
export async function saveFeatureDocument(
  db: Database,
  input: SaveFeatureDocumentInput,
): Promise<SaveFeatureDocumentResult> {
  const { organizationId, featureId, kind } = input;
  return db.transaction(async (tx) => {
    const [feature] = await tx
      .select({ status: features.status })
      .from(features)
      .where(and(eq(features.id, featureId), eq(features.organizationId, organizationId)))
      .for("update");
    if (!feature) return { status: "not_found" as const };
    if (feature.status === "archived") return { status: "archived" as const };
    const [latest] = await tx
      .select({ version: max(featureDocuments.version) })
      .from(featureDocuments)
      .where(and(eq(featureDocuments.featureId, featureId), eq(featureDocuments.kind, kind)));
    const currentVersion = latest?.version ?? 0;
    if (currentVersion !== input.baseVersion) {
      return { status: "stale" as const, currentVersion };
    }
    const [document] = await tx
      .insert(featureDocuments)
      .values({
        featureId,
        organizationId,
        kind,
        version: currentVersion + 1,
        body: input.body,
        createdBy: input.createdBy,
      })
      .returning();
    await tx.update(features).set({ updatedAt: new Date() }).where(eq(features.id, featureId));
    recordChange(tx, { resource: "feature", ids: [featureId], organizationId });
    return { status: "saved" as const, document: document! };
  });
}

// ── Epics ────────────────────────────────────────────────────────────────

/**
 * Makes the work item one of the feature's epics (a work item has at most one feature: it
 * moves from any other; the caller checked the feature is the organization's). Records a
 * `feature` change for the feature (and the one it left).
 */
export async function linkFeatureEpic(
  db: Database,
  input: { featureId: string } & WorkItemKey,
): Promise<void> {
  const [previous] = await db
    .select({ featureId: featureEpics.featureId })
    .from(featureEpics)
    .where(
      and(
        eq(featureEpics.organizationId, input.organizationId),
        eq(featureEpics.tracker, input.tracker),
        eq(featureEpics.externalId, input.externalId),
      ),
    );
  await db
    .insert(featureEpics)
    .values({
      featureId: input.featureId,
      organizationId: input.organizationId,
      tracker: input.tracker,
      externalId: input.externalId,
    })
    .onConflictDoUpdate({
      target: [featureEpics.organizationId, featureEpics.tracker, featureEpics.externalId],
      set: { featureId: input.featureId },
    });
  const ids = [input.featureId];
  if (previous && previous.featureId !== input.featureId) ids.push(previous.featureId);
  recordChange(db, { resource: "feature", ids, organizationId: input.organizationId });
}

// ── Attachments ──────────────────────────────────────────────────────────

/** What an attachment belongs to: a feature of the organization, or a work item. */
export type AttachmentOwner =
  | { kind: "feature"; organizationId: string; featureId: string }
  | ({ kind: "work_item" } & WorkItemKey);

function ownerCondition(owner: AttachmentOwner) {
  return owner.kind === "feature"
    ? and(
        eq(attachments.organizationId, owner.organizationId),
        eq(attachments.featureId, owner.featureId),
      )
    : and(
        eq(attachments.organizationId, owner.organizationId),
        eq(attachments.tracker, owner.tracker),
        eq(attachments.externalId, owner.externalId),
      );
}

function recordAttachmentChange(
  db: unknown,
  attachment: Pick<Attachment, "organizationId" | "featureId" | "tracker" | "externalId">,
): void {
  const { organizationId } = attachment;
  if (attachment.featureId) {
    recordChange(db, { resource: "feature", ids: [attachment.featureId], organizationId });
  } else if (attachment.tracker && attachment.externalId) {
    recordChange(db, {
      resource: "work_item",
      ids: [workItemUrlId(attachment.tracker, attachment.externalId)],
      organizationId,
    });
  }
}

/** The owner's attachments, oldest first. */
export async function listAttachments(
  db: Pick<Database, "select">,
  owner: AttachmentOwner,
): Promise<Attachment[]> {
  return db
    .select()
    .from(attachments)
    .where(ownerCondition(owner))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
}

/** One of the organization's attachments, or null. */
export async function getAttachment(
  db: Pick<Database, "select">,
  organizationId: string,
  attachmentId: string,
): Promise<Attachment | null> {
  const [attachment] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.organizationId, organizationId)));
  return attachment ?? null;
}

export interface InsertAttachmentInput {
  /** Generated by the caller, which stored the file under `storageKey` first. */
  id: string;
  owner: AttachmentOwner;
  fileName: string;
  contentType: string;
  size: number;
  storageKey: string;
  createdBy: string | null;
}

/** Records an attachment whose file the caller has stored. */
export async function insertAttachment(
  db: Database,
  input: InsertAttachmentInput,
): Promise<Attachment> {
  const { owner } = input;
  const [attachment] = await db
    .insert(attachments)
    .values({
      id: input.id,
      organizationId: owner.organizationId,
      featureId: owner.kind === "feature" ? owner.featureId : null,
      tracker: owner.kind === "work_item" ? (owner.tracker as WorkItemTracker) : null,
      externalId: owner.kind === "work_item" ? owner.externalId : null,
      fileName: input.fileName,
      contentType: input.contentType,
      size: input.size,
      storageKey: input.storageKey,
      createdBy: input.createdBy,
    })
    .returning();
  recordAttachmentChange(db, attachment!);
  return attachment!;
}

/**
 * Deletes one of the organization's attachments and answers it (the caller deletes its file),
 * or null when there is none.
 */
export async function deleteAttachment(
  db: Database,
  organizationId: string,
  attachmentId: string,
): Promise<Attachment | null> {
  const [attachment] = await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.organizationId, organizationId)))
    .returning();
  if (!attachment) return null;
  recordAttachmentChange(db, attachment);
  return attachment;
}
