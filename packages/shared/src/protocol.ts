/**
 * Job protocol between the control panel and agents: the heartbeat and the
 * job lifecycle endpoints (`/api/harness/heartbeat`, `/api/harness/claim`,
 * `/api/harness/jobs/{id}/result|fail`). See `docs/adr/0006-postgres-job-queue.md`.
 */
import { z } from "zod";
import type { JobTokenScope } from "./harness-protocol.js";
import type { Capability } from "./index.js";

/** Jobs (and the dedupe window) live for 24h; still-queued jobs then expire. */
export const JOB_RETENTION_SECONDS = 24 * 60 * 60;

/** A job is failed once it has been delivered (started) this many times without finishing. */
export const MAX_JOB_DELIVERIES = 3;

/** How often agents heartbeat. */
export const HEARTBEAT_INTERVAL_SECONDS = 20;

/**
 * How long a claimed job's lease lasts (6 missed heartbeats): each heartbeat
 * renews it, and once it lapses another agent may claim the job.
 */
export const JOB_LEASE_SECONDS = 120;

/** Longest delay before a retried job may be claimed again (`retryAfterSeconds`). */
export const MAX_LEASE_SECONDS = 3600;

/**
 * The built-in capability every agent runs, regardless of central config:
 * housekeeping jobs such as `repo.sync`. Its jobs are always targeted at one
 * agent (`jobs.target_harness_id`).
 */
export const SYSTEM_CAPABILITY = "system";
export type SystemCapability = typeof SYSTEM_CAPABILITY;

/** `system` job that clones or fetches a repo into the agent's cache without running anything. */
export const REPO_SYNC_JOB_TYPE = "repo.sync";

/**
 * The job token scopes each capability's jobs get. Review, triage and repo
 * sync are read-only; ralph jobs push their commits, relay session activities and
 * download Linear attachments through the control panel.
 */
export const CAPABILITY_JOB_SCOPES: Record<Capability | SystemCapability, JobTokenScope[]> = {
  review: ["credentials:read"],
  ralph: ["credentials:read", "credentials:write", "ralph:activity", "ralph:attachments"],
  triage: ["credentials:read"],
  system: ["credentials:read"],
};

const capabilityName = z.string().min(1).max(64);

/**
 * Per-capability caps on concurrent jobs (`agents.capability_limits`), each
 * within `maxConcurrency`. Unset capabilities use `defaultCapabilityLimit`.
 */
export const CapabilityLimits = z.record(capabilityName, z.int().min(1).max(1000));
export type CapabilityLimits = z.infer<typeof CapabilityLimits>;

/**
 * A capability's limit when none is set: `ralph` jobs (hours-long stories)
 * leave one slot free for other work on agents with two or more slots; other
 * capabilities may use every slot.
 */
export function defaultCapabilityLimit(capability: string, maxConcurrency: number): number {
  return capability === "ralph" ? Math.max(1, maxConcurrency - 1) : maxConcurrency;
}

/** A capability's effective limit: the stored one (or the default), clamped to 1…`maxConcurrency`. */
export function effectiveCapabilityLimit(
  capability: string,
  limits: Partial<Record<string, number>>,
  maxConcurrency: number,
): number {
  const limit = limits[capability] ?? defaultCapabilityLimit(capability, maxConcurrency);
  return Math.max(1, Math.min(maxConcurrency, limit));
}

/** The effective limit of each capability in `capabilities`. */
export function effectiveCapabilityLimits(
  capabilities: readonly string[],
  limits: Partial<Record<string, number>>,
  maxConcurrency: number,
): CapabilityLimits {
  return Object.fromEntries(
    capabilities.map((name) => [name, effectiveCapabilityLimit(name, limits, maxConcurrency)]),
  );
}

/**
 * How a harness runs a job: `query`, `review` and `coding` run a Claude
 * session; `system` jobs are fixed commands (e.g. `repo.sync`) every harness
 * accepts.
 */
export const JOB_TASK_TYPES = ["query", "review", "coding", "system"] as const;
export const JobTaskType = z.enum(JOB_TASK_TYPES);
export type JobTaskType = z.infer<typeof JobTaskType>;

export function isJobTaskType(value: string): value is JobTaskType {
  return (JOB_TASK_TYPES as readonly string[]).includes(value);
}

/** The pools seeded for every organization: `short` (query, review) and `long` (coding). */
export const DEFAULT_POOLS = ["short", "long"] as const;

const poolName = z.string().min(1).max(64);

/** How a legacy job type is routed: its task type and pool (null for `system`). */
export interface JobRouting {
  taskType: JobTaskType;
  pool: string | null;
}

const LEGACY_JOB_ROUTING: Record<string, JobRouting> = {
  "review.run": { taskType: "review", pool: "short" },
  "review.reply": { taskType: "query", pool: "short" },
  "review.learn-rule": { taskType: "query", pool: "short" },
  "chat.ask": { taskType: "query", pool: "short" },
  "triage.run": { taskType: "query", pool: "short" },
  "ralph.describe-pr": { taskType: "query", pool: "short" },
  "ralph.story": { taskType: "coding", pool: "long" },
  "ralph.request": { taskType: "coding", pool: "long" },
  "ralph.prepare": { taskType: "coding", pool: "long" },
  "ralph.cleanup": { taskType: "coding", pool: "long" },
  [REPO_SYNC_JOB_TYPE]: { taskType: "system", pool: null },
};

/**
 * The task type and pool of a legacy job type (one of today's hard-coded job
 * types). Throws for any other type.
 */
export function legacyJobRouting(type: string): JobRouting {
  const routing = LEGACY_JOB_ROUTING[type];
  if (!routing) throw new Error(`Unknown legacy job type ${type}`);
  return { ...routing };
}

const CAPABILITY_TASK_TYPES: Record<string, readonly JobTaskType[]> = {
  review: ["query", "review"],
  ralph: ["coding"],
  triage: ["query"],
};
const CAPABILITY_POOLS: Record<string, string> = {
  review: "short",
  triage: "short",
  ralph: "long",
};

/**
 * The task types a harness accepts and its pool limits, from its legacy
 * capability settings (`review` → `query`, `review`; `ralph` → `coding`;
 * `triage` → `query`; `review`/`triage` limits → `short`, taking the smaller,
 * `ralph` → `long`). Matches the backfill of migration 0056.
 */
export function legacyHarnessRouting(
  enabledCapabilities: readonly string[],
  capabilityLimits: Partial<Record<string, number>>,
): { acceptedTaskTypes: JobTaskType[]; poolLimits: PoolLimits } {
  const accepted = new Set(enabledCapabilities.flatMap((c) => CAPABILITY_TASK_TYPES[c] ?? []));
  const poolLimits: PoolLimits = {};
  for (const [capability, limit] of Object.entries(capabilityLimits)) {
    const pool = CAPABILITY_POOLS[capability];
    if (pool === undefined || limit === undefined) continue;
    poolLimits[pool] = Math.min(poolLimits[pool] ?? limit, limit);
  }
  return { acceptedTaskTypes: JOB_TASK_TYPES.filter((t) => accepted.has(t)), poolLimits };
}

/**
 * Per-pool caps on concurrent jobs (`harnesses.pool_limits`), each within
 * `maxConcurrency`. Unset pools use `defaultPoolLimit`.
 */
export const PoolLimits = z.record(poolName, z.int().min(1).max(1000));
export type PoolLimits = z.infer<typeof PoolLimits>;

/**
 * A pool's limit when none is set: `long` jobs (hours-long stories) leave one
 * slot free for other work on harnesses with two or more slots; other pools
 * may use every slot.
 */
export function defaultPoolLimit(pool: string, maxConcurrency: number): number {
  return pool === "long" ? Math.max(1, maxConcurrency - 1) : maxConcurrency;
}

/** A pool's effective limit: the stored one (or the default), clamped to 1…`maxConcurrency`. */
export function effectivePoolLimit(
  pool: string,
  limits: Partial<Record<string, number>>,
  maxConcurrency: number,
): number {
  const limit = limits[pool] ?? defaultPoolLimit(pool, maxConcurrency);
  return Math.max(1, Math.min(maxConcurrency, limit));
}

/** The effective limit of each pool in `pools` (default: `short` and `long`). */
export function effectivePoolLimits(
  limits: Partial<Record<string, number>>,
  maxConcurrency: number,
  pools: readonly string[] = DEFAULT_POOLS,
): PoolLimits {
  return Object.fromEntries(
    pools.map((name) => [name, effectivePoolLimit(name, limits, maxConcurrency)]),
  );
}

/** The npm package agents run and update themselves to. */
export const HARNESS_PACKAGE = "@omniralph/harness";

/** A semantic version (semver 2.0, no leading `v`), e.g. `1.4.0` or `1.5.0-beta.1`. */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** An agent version: valid semver, at most 64 characters. */
export const HarnessVersion = z.string().max(64).regex(SEMVER_PATTERN);
export type HarnessVersion = z.infer<typeof HarnessVersion>;

/**
 * Whether agent `version` is at least `minimum`, comparing major.minor.patch
 * only (a prerelease of `minimum` counts: it's built from the same code).
 * False for a version that isn't semver.
 */
export function harnessVersionAtLeast(version: string, minimum: string): boolean {
  const core = (v: string) => {
    const match = SEMVER_PATTERN.exec(v.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const have = core(version);
  const want = core(minimum);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}

/**
 * Whether the agent can update itself: only under pm2 (which restarts it into
 * the new version). Other hosts report `unsupported` and must be updated by hand.
 */
export const SELF_UPDATE_SUPPORT = ["supported", "unsupported"] as const;
export type SelfUpdateSupport = (typeof SELF_UPDATE_SUPPORT)[number];

/**
 * Where an agent is in a self-update: `idle`, `draining` (no new jobs while
 * running ones finish), `installing`, or `confirming` (running a freshly
 * installed version that hasn't stayed up for a minute yet).
 */
export const HARNESS_UPDATE_STATES = ["idle", "draining", "installing", "confirming"] as const;
export type HarnessUpdateStateName = (typeof HARNESS_UPDATE_STATES)[number];

export const HarnessUpdateReport = z.object({
  state: z.enum(HARNESS_UPDATE_STATES),
  /** The version being installed or confirmed. */
  version: z.string().max(64).nullable(),
  /** The version before the update (the rollback target). */
  previous: z.string().max(64).nullable(),
  /** Starts of the pending version so far (it's rolled back after 3). */
  startsSincePending: z.int().min(0).max(1000),
  /** Why the last update failed, if it did. */
  error: z.string().max(2000).nullable(),
});
export type HarnessUpdateReport = z.infer<typeof HarnessUpdateReport>;

/**
 * An admin's "Update now" from the control panel: the agent updates to
 * `version` at once, even if it failed before (it's taken off the failed
 * versions), and reports `id` back as `handledUpdateRequestId`.
 */
export const HarnessUpdateRequest = z.object({
  id: z.uuid(),
  version: HarnessVersion,
});
export type HarnessUpdateRequest = z.infer<typeof HarnessUpdateRequest>;

/** `POST /api/harness/heartbeat` request, sent every `HEARTBEAT_INTERVAL_SECONDS`. */
export const Heartbeat = z.object({
  version: z.string().min(1).max(64),
  /** Capabilities the host can run (it may know ones the control panel doesn't yet). */
  capabilities: z.array(capabilityName).max(32),
  runningJobIds: z.array(z.uuid()).max(100),
  /** Job slots the agent has free right now. */
  freeSlots: z.int().min(0).max(1000),
  /** `jobMessages` injected into their job's live session since the last heartbeat. */
  deliveredMessageIds: z.array(z.uuid()).max(500).default([]),
  /** `jobMessages` that had no live session to go to (e.g. the job was running its gates). */
  rejectedMessageIds: z.array(z.uuid()).max(500).default([]),
  /** Whether the agent updates itself to `desiredVersion` (absent from older agents). */
  selfUpdate: z.enum(SELF_UPDATE_SUPPORT).optional(),
  /** The agent's self-update progress. */
  update: HarnessUpdateReport.optional(),
  /** Versions that failed to install or to stay up; the agent never retries them. */
  failedVersions: z.array(z.string().max(64)).max(100).default([]),
  /** The last `updateRequest` the agent acted on; the control panel then clears it. */
  handledUpdateRequestId: z.uuid().nullable().optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** A freshly signed job token (`HARNESS_TOKEN_TTL_SECONDS`). */
export const JobToken = z.object({
  jobId: z.uuid(),
  token: z.string(),
  /** Seconds until `token` expires. */
  expiresIn: z.number(),
});
export type JobToken = z.infer<typeof JobToken>;

/**
 * A message for a running job's live Claude session (a Linear reply to a ralph
 * run): the agent injects it and acknowledges it in its next heartbeat.
 */
export const JobMessageDelivery = z.object({
  jobId: z.uuid(),
  messageId: z.uuid(),
  text: z.string(),
});
export type JobMessageDelivery = z.infer<typeof JobMessageDelivery>;

/** `pollIntervalSeconds` sent to old (Vercel Queues) agents, which require it. */
export const LEGACY_POLL_INTERVAL_SECONDS = 5;

/** Central configuration, returned on every heartbeat. */
export const HeartbeatResponse = z.object({
  maxConcurrency: z.int().min(1),
  /**
   * @deprecated Agents claim jobs through `POST /api/harness/claim`. Always
   * `LEGACY_POLL_INTERVAL_SECONDS`, sent only so old agents still parse the response.
   */
  pollIntervalSeconds: z.int().min(1).optional(),
  /** Task types the harness may claim jobs of (`system` is always accepted). */
  acceptedTaskTypes: z.array(JobTaskType),
  /**
   * Effective per-pool concurrency limits of the organization's pools. The
   * harness only claims a pool's jobs while it runs fewer than this.
   */
  poolLimits: PoolLimits,
  /** Repositories pinned to this agent (pre-cloned via `repo.sync` jobs). */
  pinnedRepoIds: z.array(z.uuid()),
  /** The agent's organization: it only claims that organization's jobs. */
  organizationId: z.uuid(),
  /**
   * @deprecated Vercel Queues topics old agents poll. Always empty, so old agents
   * stop polling; agents claim jobs through `POST /api/harness/claim`.
   */
  topics: z.array(z.string()).optional(),
  /** @deprecated Vercel Queues region of `topics`. Always `""`. */
  queueRegion: z.string().optional(),
  /** Running jobs the agent must stop (canceled, or no longer its job). */
  cancelJobIds: z.array(z.uuid()),
  /** New job tokens for the agent's still-running jobs. */
  jobTokens: z.array(JobToken),
  /** Undelivered messages for the agent's running jobs, oldest first. */
  jobMessages: z.array(JobMessageDelivery).default([]),
  /**
   * The version the agent should run (the agent's override, else its
   * organization's setting); null when none is chosen. Agents under pm2 update themselves to it.
   */
  desiredVersion: HarnessVersion.nullable().default(null),
  /** An update an admin asked for and the agent hasn't acted on yet. */
  updateRequest: HarnessUpdateRequest.nullable().default(null),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** The job as handed to the agent on `run`. */
export const JobPayload = z.object({
  id: z.uuid(),
  capability: z.string(),
  type: z.string(),
  taskType: JobTaskType,
  /** Null for `system` jobs. */
  pool: poolName.nullable(),
  /** The task definition the job runs; null for legacy jobs. */
  taskId: z.string().nullable(),
  repositoryId: z.uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  /** 1 on the first delivery. */
  deliveryCount: z.int().min(1),
});
export type JobPayload = z.infer<typeof JobPayload>;

export const JOB_SKIP_REASONS = [
  "not_found",
  "canceled",
  "completed",
  "failed",
  "expired",
  "max_deliveries",
  "capability_disabled",
  "skipped",
  /** A review job whose head SHA already has a completed review. */
  "already_reviewed",
] as const;
export const JobSkipReason = z.enum(JOB_SKIP_REASONS);
export type JobSkipReason = z.infer<typeof JobSkipReason>;

/**
 * A started job: `run` with the job and its token (`POST /api/harness/claim`
 * only answers `run`). On `skip` the agent runs nothing.
 */
export const JobStartResponse = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("run"),
    job: JobPayload,
    /** Token for in-job processes (e.g. the `git-credential` helper); refreshed via heartbeat. */
    jobToken: JobToken,
  }),
  z.object({
    action: z.literal("skip"),
    reason: JobSkipReason,
  }),
]);
export type JobStartResponse = z.infer<typeof JobStartResponse>;

/** Longest `POST /api/harness/claim` holds the request while there's nothing to claim. */
export const MAX_CLAIM_WAIT_SECONDS = 50;

/**
 * `POST /api/harness/claim` request. The response is `JobStartResponse`'s `run`
 * shape (200), or 204 once `waitSeconds` passed with nothing to claim.
 */
export const ClaimRequest = z.object({
  /**
   * Pools the harness has a free slot in: only their jobs (of task types the
   * harness accepts) and `system` jobs are claimed.
   */
  pools: z.array(poolName).max(32),
  waitSeconds: z.int().min(0).max(MAX_CLAIM_WAIT_SECONDS).default(MAX_CLAIM_WAIT_SECONDS),
});
export type ClaimRequest = z.input<typeof ClaimRequest>;

/** `POST /api/harness/jobs/{id}/result`: the capability's output (e.g. findings for a review). */
export const JobResult = z.object({
  result: z.record(z.string(), z.unknown()),
});
export type JobResult = z.infer<typeof JobResult>;

/** `POST /api/harness/jobs/{id}/fail` */
export const JobFailure = z.object({
  /** Transient failure (e.g. a Claude rate limit): claimable again after `retryAfterSeconds`. */
  retryable: z.boolean(),
  retryAfterSeconds: z.int().min(0).max(MAX_LEASE_SECONDS).optional(),
  error: z.string().max(4000).optional(),
});
export type JobFailure = z.infer<typeof JobFailure>;

/**
 * Response of `/result` and `/fail`. `retry`: the job is queued again and may
 * be claimed after `retryAfterSeconds`; the agent does nothing else.
 */
export const JobOutcomeResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed") }),
  z.object({ status: z.literal("failed") }),
  z.object({ status: z.literal("canceled") }),
  z.object({ status: z.literal("retry"), retryAfterSeconds: z.int().min(0) }),
]);
export type JobOutcomeResponse = z.infer<typeof JobOutcomeResponse>;

/** Where a job's repository lives; part of the payload of every job that needs a checkout. */
export const JobRepository = z.object({
  provider: z.enum(["github", "gitlab"]),
  /** `owner/repo` or `group/subgroup/project`. */
  fullPath: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/)
    .refine((p) => p.split("/").every((segment) => segment !== "." && segment !== ".."), {
      message: "invalid path segment",
    }),
  /** HTTPS clone URL without credentials (the agent's `git-credential` helper supplies them). */
  cloneUrl: z.url(),
});
export type JobRepository = z.infer<typeof JobRepository>;

/** Payload of a `repo.sync` job. */
export const RepoSyncPayload = z.object({
  repository: JobRepository,
});
export type RepoSyncPayload = z.infer<typeof RepoSyncPayload>;

/**
 * `POST /api/harness/credentials` response (authenticated with a job token): a
 * short-lived, read-only credential for the job's repository.
 */
export const CloneCredentialResponse = z.object({
  cloneUrl: z.url(),
  username: z.string().min(1),
  password: z.string().min(1),
  /** ISO 8601 */
  expiresAt: z.iso.datetime(),
});
export type CloneCredentialResponse = z.infer<typeof CloneCredentialResponse>;
