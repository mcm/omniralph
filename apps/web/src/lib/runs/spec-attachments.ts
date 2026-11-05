/**
 * The files people attached in Omniralph to the epic a run works on and to that epic's
 * feature, as the run spec lists them: each with a short-lived presigned URL into the blob
 * store, so the agent downloads them without credentials (and only those files).
 */
import "server-only";
import {
  getEpicFeature,
  getRun,
  listAttachments,
  type Attachment,
  type Database,
  type Job,
  type WorkItemKey,
} from "@omniralph/db";
import { MAX_RUN_ATTACHMENTS, type RunAttachment } from "@omniralph/shared";
import { WORK_ITEM_TRACKERS } from "@/lib/api/work-item-matches";
import { getObjectStorage, type ObjectStorage } from "@/lib/attachments/storage";

/**
 * How long a run's download URLs work: the agent downloads right after claiming, and a
 * redelivered job is resolved again with fresh URLs.
 */
export const RUN_ATTACHMENT_URL_TTL_SECONDS = 30 * 60;

/** The run's attachments can never be listed (too many, or no file storage): the job fails with `message`. */
export class RunAttachmentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAttachmentsError";
  }
}

function isWorkItemTracker(provider: string): provider is WorkItemKey["tracker"] {
  return (WORK_ITEM_TRACKERS as readonly string[]).includes(provider);
}

/**
 * The attachments of the epic a ralph run's job works on (the run's delegated issue: the
 * epic, whose tasks its story runs work, or a single issue), then, when that epic is one of
 * a feature's, the feature's (listed first: the plan's files frame the epic's). None for a
 * job of no ralph run, or a run with no tracker issue (chat and pull request runs).
 *
 * Throws `RunAttachmentsError` when there are more than `MAX_RUN_ATTACHMENTS` or file
 * storage isn't set up; a failure of the store itself (`ObjectStorageError`) is thrown as
 * is, so the claim rolls back and is tried again.
 */
export async function resolveRunAttachments(
  db: Database,
  job: Pick<Job, "ralphRunId">,
  options: { storage?: ObjectStorage | null; now?: Date } = {},
): Promise<RunAttachment[]> {
  if (!job.ralphRunId) return [];
  const run = await getRun(db, job.ralphRunId);
  if (!run?.trackerIssueId || !isWorkItemTracker(run.trackerProvider)) return [];
  const key: WorkItemKey = {
    organizationId: run.organizationId,
    tracker: run.trackerProvider,
    externalId: run.trackerIssueId,
  };
  const feature = await getEpicFeature(db, key);
  const listed: Array<{ attachment: Attachment; owner: RunAttachment["owner"]; name: string }> = [
    ...(feature
      ? await listAttachments(db, {
          kind: "feature",
          organizationId: run.organizationId,
          featureId: feature.id,
        })
      : []
    ).map((attachment) => ({ attachment, owner: "feature" as const, name: feature!.name })),
    ...(await listAttachments(db, { kind: "work_item", ...key })).map((attachment) => ({
      attachment,
      owner: "epic" as const,
      name: run.trackerIdentifier || "the epic",
    })),
  ];
  if (listed.length === 0) return [];
  if (listed.length > MAX_RUN_ATTACHMENTS) {
    throw new RunAttachmentsError(
      `The epic and its feature have ${listed.length} attachments, more than the ${MAX_RUN_ATTACHMENTS} a run downloads. Remove some, then retry.`,
    );
  }
  const storage = options.storage === undefined ? getObjectStorage() : options.storage;
  if (!storage) {
    throw new RunAttachmentsError(
      "The epic or its feature has attachments, but file storage isn't set up on the control panel (BLOB_READ_WRITE_TOKEN), so the run can't download them.",
    );
  }
  const expiresAt = new Date(
    (options.now ?? new Date()).getTime() + RUN_ATTACHMENT_URL_TTL_SECONDS * 1000,
  );
  const urls = await storage.downloadUrls(
    listed.map((l) => l.attachment.storageKey),
    expiresAt,
  );
  return listed.map(({ attachment, owner, name }) => {
    const url = urls.get(attachment.storageKey);
    if (!url) throw new Error(`File storage gave no download URL for attachment ${attachment.id}`);
    return {
      id: attachment.id,
      owner,
      ownerName: name.slice(0, 500),
      fileName: attachment.fileName.slice(0, 500),
      contentType: attachment.contentType,
      size: attachment.size,
      url,
      expiresAt: expiresAt.toISOString(),
    };
  });
}
