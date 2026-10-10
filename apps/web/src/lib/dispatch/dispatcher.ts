import "server-only";
import {
  getAgent,
  getJob,
  insertJob,
  pinnedAgentFor,
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
  targetAgentId?: string;
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
 * jobs from it. Dispatching only inserts the job, with `target_agent_id` set to
 * the given target agent, else the repo's pinned agent (both of the job's
 * organization), else null (any agent of the organization).
 */
export class PostgresDispatcher implements JobDispatcher {
  private readonly db: Database;

  constructor(options: { db: Database }) {
    this.db = options.db;
  }

  async createAndPublish(input: DispatchJobInput): Promise<DispatchedJob> {
    const { targetAgentId, ...jobInput } = input;
    const target = await this.targetFor(jobInput, targetAgentId);
    return insertJob(this.db, { ...jobInput, targetAgentId: target });
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
    targetAgentId: string | undefined,
  ): Promise<string | null> {
    if (targetAgentId) {
      const target = await getAgent(this.db, targetAgentId);
      if (target?.organizationId !== job.organizationId) {
        throw new Error(
          `Agent ${targetAgentId} isn't in organization ${job.organizationId} of the job`,
        );
      }
      return targetAgentId;
    }
    return job.repositoryId ? pinnedAgentFor(this.db, job.organizationId, job.repositoryId) : null;
  }
}
