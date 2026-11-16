/**
 * The files people attached in Omniralph to the epic a run works on and to that epic's
 * feature, or to the feature a sharding round plans, as the run spec lists them: each with a
 * short-lived presigned URL into the blob store, so the agent downloads them without
 * credentials (and only those files).
 */
import "server-only";
import {
  getEpicFeature,
  getFeature,
  getFeatureShard,
  getRun,
  listAttachments,
  type Attachment,
  type Database,
  type Job,
  type WorkItemKey,
} from "@omniralph/db";
import { FeatureShardInvoker, MAX_RUN_ATTACHMENTS, type RunAttachment } from "@omniralph/shared";
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

/** How attachments are listed: file storage, and the time their URLs count from (tests). */
export interface ResolveAttachmentsOptions {
  storage?: ObjectStorage | null;
  now?: Date;
}

/** An attachment to list, with what it is attached to. */
interface ListedAttachment {
  attachment: Attachment;
  owner: RunAttachment["owner"];
  name: string;
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
  options: ResolveAttachmentsOptions = {},
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
  const listed: ListedAttachment[] = [
    ...(feature ? await featureAttachments(db, run.organizationId, feature.id, feature.name) : []),
    ...(await listAttachments(db, { kind: "work_item", ...key })).map((attachment) => ({
      attachment,
      owner: "epic" as const,
      name: run.trackerIdentifier || "the epic",
    })),
  ];
  return presign(
    listed,
    { all: "The epic and its feature have", some: "The epic or its feature has" },
    options,
  );
}

/**
 * The attachments of the feature a sharding round plans: a run whose trigger context names a
 * feature's sharding as its invoker (`feature-shard`: the round's worker, or its verifier,
 * whichever playbook that is). None for any other run, or a sharding that no longer exists.
 *
 * Throws as `resolveRunAttachments` does.
 */
export async function resolveShardAttachments(
  db: Database,
  job: Pick<Job, "organizationId">,
  context: Record<string, unknown>,
  options: ResolveAttachmentsOptions = {},
): Promise<RunAttachment[]> {
  const invoker = FeatureShardInvoker.safeParse(context.invoker);
  if (!invoker.success) return [];
  const shard = await getFeatureShard(db, job.organizationId, invoker.data.id);
  if (!shard) return [];
  const feature = await getFeature(db, job.organizationId, shard.featureId);
  if (!feature) return [];
  const listed = await featureAttachments(db, job.organizationId, feature.id, feature.name);
  return presign(listed, { all: "The feature has", some: "The feature has" }, options);
}

async function featureAttachments(
  db: Database,
  organizationId: string,
  featureId: string,
  name: string,
): Promise<ListedAttachment[]> {
  const attachments = await listAttachments(db, { kind: "feature", organizationId, featureId });
  return attachments.map((attachment) => ({ attachment, owner: "feature" as const, name }));
}

/**
 * `listed` as the run spec lists them, each with a URL that works for
 * `RUN_ATTACHMENT_URL_TTL_SECONDS`. The errors start with what the files are attached to:
 * `owners.all` before their count, `owners.some` when any of them has files.
 */
async function presign(
  listed: readonly ListedAttachment[],
  owners: { all: string; some: string },
  options: ResolveAttachmentsOptions,
): Promise<RunAttachment[]> {
  if (listed.length === 0) return [];
  if (listed.length > MAX_RUN_ATTACHMENTS) {
    throw new RunAttachmentsError(
      `${owners.all} ${listed.length} attachments, more than the ${MAX_RUN_ATTACHMENTS} a run downloads. Remove some, then retry.`,
    );
  }
  const storage = options.storage === undefined ? getObjectStorage() : options.storage;
  if (!storage) {
    throw new RunAttachmentsError(
      `${owners.some} attachments, but file storage isn't set up on the control panel (BLOB_READ_WRITE_TOKEN), so the run can't download them.`,
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
