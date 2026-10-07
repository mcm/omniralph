import "server-only";
import {
  getAgent,
  getJob,
  insertJob,
  markJobPublished,
  pinnedAgentFor,
  requestJobCancel,
  type CancelJobResult,
  type Database,
  type Job,
  type NewJobInput,
} from "@omniralph/db";
import {
  agentTopic,
  capabilityTopic,
  JOB_RETENTION_SECONDS,
  type JobMessage,
} from "@omniralph/shared";
import { QueueClient } from "@vercel/queue";
import { publishRegion } from "./config";

export interface DispatchJobInput extends NewJobInput {
  /**
   * Send to this agent's topic regardless of pins (e.g. `repo.sync` pre-clones).
   * Must be an agent of the job's organization.
   */
  targetAgentId?: string;
}

export interface DispatchedJob {
  job: Job;
  /** False when an active job with the same `dedupeKey` already existed (nothing was published). */
  created: boolean;
}

/**
 * Creates jobs and gets them to agents. Postgres holds the job; the transport
 * only carries `{ jobId }`. The only place that knows how jobs are delivered
 * (see `docs/adr/0001-job-dispatch.md`).
 */
export interface JobDispatcher {
  /** Inserts the job (deduped by `dedupeKey`) and publishes it to its topic. */
  createAndPublish(input: DispatchJobInput): Promise<DispatchedJob>;
  /** Requests cancellation (queued jobs are canceled at once, running ones via heartbeat). */
  cancel(jobId: string): Promise<CancelJobResult>;
  /**
   * Publishes a `queued` job again to the topic its repo's pins now resolve to
   * (e.g. after the agent it was sent to was revoked). False if it isn't queued.
   */
  republish(jobId: string): Promise<boolean>;
}

/** The subset of `QueueClient` the dispatcher uses. */
export interface QueuePublisher {
  send(
    topic: string,
    payload: JobMessage,
    options: { idempotencyKey: string; retentionSeconds: number },
  ): Promise<{ messageId: string | null }>;
}

/**
 * `JobDispatcher` on Vercel Queues (poll mode). Messages are published
 * deploymentless (`deploymentId: null`) so they survive redeploys, with
 * `idempotencyKey = jobId` and 24h retention, to the job's organization's
 * `<capability>-jobs-org-<organizationId>`, or to
 * `<capability>-jobs-agent-<agentId>` when the repo is pinned (to an agent of
 * that organization).
 */
export class VercelQueuesDispatcher implements JobDispatcher {
  private readonly db: Database;
  private publisher: QueuePublisher | undefined;

  constructor(options: { db: Database; publisher?: QueuePublisher }) {
    this.db = options.db;
    this.publisher = options.publisher;
  }

  async createAndPublish(input: DispatchJobInput): Promise<DispatchedJob> {
    const { targetAgentId, ...jobInput } = input;
    const { job, created } = await insertJob(this.db, jobInput);
    // An existing job whose publish failed (topic still null) is published again;
    // the idempotency key makes a duplicate publish harmless.
    if (!created && job.topic !== null) return { job, created };

    return { job: await this.publish(job, targetAgentId), created };
  }

  private async publish(job: Job, targetAgentId: string | undefined): Promise<Job> {
    const topic = await this.topicFor(job, targetAgentId);
    const { messageId } = await this.getPublisher().send(
      topic,
      { jobId: job.id },
      { idempotencyKey: job.id, retentionSeconds: JOB_RETENTION_SECONDS },
    );
    await markJobPublished(this.db, job.id, { topic, messageId });
    return { ...job, topic, queueMessageId: messageId };
  }

  cancel(jobId: string): Promise<CancelJobResult> {
    return requestJobCancel(this.db, jobId);
  }

  async republish(jobId: string): Promise<boolean> {
    const job = await getJob(this.db, jobId);
    if (!job || job.status !== "queued") return false;
    await this.publish(job, undefined);
    return true;
  }

  private async topicFor(job: Job, targetAgentId: string | undefined): Promise<string> {
    if (targetAgentId) {
      const target = await getAgent(this.db, targetAgentId);
      if (target?.organizationId !== job.organizationId) {
        throw new Error(`Agent ${targetAgentId} isn't in job ${job.id}'s organization`);
      }
      return agentTopic(job.capability, targetAgentId);
    }
    const pinned = job.repositoryId
      ? await pinnedAgentFor(this.db, job.organizationId, job.repositoryId)
      : null;
    return pinned
      ? agentTopic(job.capability, pinned)
      : capabilityTopic(job.capability, job.organizationId);
  }

  private getPublisher(): QueuePublisher {
    // Created on first publish: the client resolves its OIDC token per request.
    this.publisher ??= new QueueClient({ region: publishRegion(), deploymentId: null });
    return this.publisher;
  }
}
