import "server-only";
import {
  getHarness,
  getJob,
  insertJob,
  pinnedHarnessFor,
  requestJobCancel,
  setQueuedJobTarget,
  type CancelJobResult,
  type Database,
  type Job,
  type NewJobInput,
} from "@omniralph/db";

export interface DispatchJobInput extends NewJobInput {
  /**
   * Only this agent may claim the job, regardless of pins (e.g. `repo.sync` pre-clones).
   * Must be an agent of the job's organization.
   */
  targetHarnessId?: string;
}

export interface DispatchedJob {
  job: Job;
  /** False when an active job with the same `dedupeKey` already existed (nothing was inserted). */
  created: boolean;
}

/**
 * Creates jobs and gets them to agents, which claim them from Postgres. The
 * only place that decides which agents may claim a job.
 */
export interface JobDispatcher {
  /** Inserts the job (deduped by `dedupeKey`), claimable by its target agent or any of its organization's. */
  createAndPublish(input: DispatchJobInput): Promise<DispatchedJob>;
  /** Requests cancellation (queued jobs are canceled at once, running ones via heartbeat). */
  cancel(jobId: string): Promise<CancelJobResult>;
  /**
   * Re-resolves which agent may claim a `queued` job from its repo's current
   * pins (e.g. after the agent it targeted was revoked). False if it isn't queued.
   */
  republish(jobId: string): Promise<boolean>;
}

/**
 * `JobDispatcher` on Postgres: the `jobs` table is the queue and agents claim
 * jobs from it. Dispatching only inserts the job, with `target_harness_id` set to
 * the given target agent, else the repo's pinned agent (both of the job's
 * organization), else null (any agent of the organization).
 */
export class PostgresDispatcher implements JobDispatcher {
  private readonly db: Database;

  constructor(options: { db: Database }) {
    this.db = options.db;
  }

  async createAndPublish(input: DispatchJobInput): Promise<DispatchedJob> {
    const { targetHarnessId, ...jobInput } = input;
    const target = await this.targetFor(jobInput, targetHarnessId);
    return insertJob(this.db, { ...jobInput, targetHarnessId: target });
  }

  cancel(jobId: string): Promise<CancelJobResult> {
    return requestJobCancel(this.db, jobId);
  }

  async republish(jobId: string): Promise<boolean> {
    const job = await getJob(this.db, jobId);
    if (!job || job.status !== "queued") return false;
    return setQueuedJobTarget(this.db, job.id, await this.targetFor(job, undefined));
  }

  private async targetFor(
    job: Pick<NewJobInput, "organizationId" | "repositoryId">,
    targetHarnessId: string | undefined,
  ): Promise<string | null> {
    if (targetHarnessId) {
      const target = await getHarness(this.db, targetHarnessId);
      if (target?.organizationId !== job.organizationId) {
        throw new Error(
          `Agent ${targetHarnessId} isn't in organization ${job.organizationId} of the job`,
        );
      }
      return targetHarnessId;
    }
    return job.repositoryId
      ? pinnedHarnessFor(this.db, job.organizationId, job.repositoryId)
      : null;
  }
}
