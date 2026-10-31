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
import { agentWakeChannel, orgWakeChannel } from "@omniralph/shared";
import type { WakePublisher } from "@/lib/ably/publisher";
import { bumpAgentHeartbeat } from "@/lib/agents/heartbeat-cache";
import { hotStateEnabled } from "@/lib/hot-state";
import { syncJobsDue, syncJobsDueFromPostgres } from "./due";

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
 * organization), else null (any agent of the organization). With a wake
 * publisher (Ably), it then wakes the agents that may claim the job; a failed
 * wake is only logged (the heartbeat's `claimable` flag picks the job up).
 */
export class PostgresDispatcher implements JobDispatcher {
  private readonly db: Database;
  private readonly wakePublisher: WakePublisher | null;

  constructor(options: { db: Database; wakePublisher?: WakePublisher | null }) {
    this.db = options.db;
    this.wakePublisher = options.wakePublisher ?? null;
  }

  async createAndPublish(input: DispatchJobInput): Promise<DispatchedJob> {
    const { targetAgentId, ...jobInput } = input;
    const target = await this.targetFor(jobInput, targetAgentId);
    const dispatched = await insertJob(this.db, { ...jobInput, targetAgentId: target });
    // Before the wake, so the woken claim finds the job due.
    if (dispatched.created) await syncJobsDue([dispatched.job]);
    // Also for a deduplicated job: a wake costs at most one empty claim.
    await this.wake(dispatched.job);
    return dispatched;
  }

  async cancel(jobId: string): Promise<CancelJobResult> {
    const result = await requestJobCancel(this.db, jobId);
    if (result === "canceled") await syncJobsDueFromPostgres(this.db, [jobId]);
    // Its agent's next heartbeat tells it to stop the job.
    if (result === "cancel_requested" && hotStateEnabled()) {
      await bumpAgentHeartbeat((await getJob(this.db, jobId))?.agentId);
    }
    return result;
  }

  async republish(jobId: string): Promise<boolean> {
    const job = await getJob(this.db, jobId);
    if (!job || job.status !== "queued") return false;
    const target = await this.targetFor(job, undefined);
    if (!(await setQueuedJobTarget(this.db, job.id, target))) return false;
    await this.wake({ organizationId: job.organizationId, targetAgentId: target });
    return true;
  }

  /** Wakes the job's target agent, else its organization's agents. Never throws. */
  private async wake(job: Pick<Job, "organizationId" | "targetAgentId">): Promise<void> {
    if (!this.wakePublisher) return;
    const channel = job.targetAgentId
      ? agentWakeChannel(job.targetAgentId)
      : orgWakeChannel(job.organizationId);
    try {
      await this.wakePublisher.wake(channel);
    } catch (error) {
      console.error(`Couldn't publish a wake to ${channel}`, error);
    }
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
