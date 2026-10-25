/**
 * Job protocol between the control panel and agents: the heartbeat and the
 * job lifecycle endpoints (`/api/harness/heartbeat`, `/api/harness/claim`,
 * `/api/harness/jobs/{id}/result|fail`). See `docs/adr/0006-postgres-job-queue.md`.
 */
import {
  HOST_TOOL_NAME_PATTERN,
  HostToolName,
  InstallablePackageName,
  InstallableVersion,
} from "@omniralph/tasks";
import { z } from "zod";
import { JobRepository, JobToken } from "./job-basics.js";
import { POOLS } from "./pools.js";
import { RunSpec } from "./run-spec.js";

export { JobRepository, JobToken } from "./job-basics.js";

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

/** `system` job that clones or fetches a repo into the agent's cache without running anything. */
export const REPO_SYNC_JOB_TYPE = "repo.sync";

/**
 * `system` job that runs approved commands (a manual story's `cyralph-prepare`
 * commands) in a lane's branch worktree, with no Claude session and no git
 * credential. Its payload and result are `WorktreeExecPayload`/`WorktreeExecResult`.
 */
export const WORKTREE_EXEC_JOB_TYPE = "worktree.exec";

/**
 * `system` job that cleans up a lane's branch worktree after its PR/MR merged
 * and carries out the answers to the cleanup questions (push or drop leftover
 * stashes, push or delete a kept branch). Its payload and result are
 * `WorktreeCleanupPayload`/`WorktreeCleanupResult`. The only system RPC whose
 * token may push.
 */
export const WORKTREE_CLEANUP_JOB_TYPE = "worktree.cleanup";

/**
 * `system` job that installs or updates an installable (an npm package with an
 * `omniralph` manifest) into the harness's installables prefix. Its payload and
 * result are `InstallPayload`/`InstallResult`. The harness refuses packages its
 * local `installables.allow` doesn't allow.
 */
export const INSTALL_JOB_TYPE = "install";

/**
 * The system RPCs a harness runs: fixed commands with no Claude session,
 * dispatched by job type (`jobs.type`) as jobs of task type `system`.
 */
export const SYSTEM_RPCS = [
  REPO_SYNC_JOB_TYPE,
  WORKTREE_EXEC_JOB_TYPE,
  WORKTREE_CLEANUP_JOB_TYPE,
  INSTALL_JOB_TYPE,
] as const;
export type SystemRpcName = (typeof SYSTEM_RPCS)[number];

export function isSystemRpc(name: string): name is SystemRpcName {
  return (SYSTEM_RPCS as readonly string[]).includes(name);
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

const poolName = z.string().min(1).max(64);

/** How a legacy job type is routed: its task type (its pool follows, `poolForTaskType`). */
export interface JobRouting {
  taskType: JobTaskType;
}

const LEGACY_JOB_ROUTING: Record<string, JobRouting> = {
  "review.reply": { taskType: "query" },
  "review.learn-rule": { taskType: "query" },
  "chat.ask": { taskType: "query" },
  "triage.run": { taskType: "query" },
  "ralph.prepare": { taskType: "coding" },
  "ralph.cleanup": { taskType: "coding" },
  [REPO_SYNC_JOB_TYPE]: { taskType: "system" },
  [WORKTREE_EXEC_JOB_TYPE]: { taskType: "system" },
  [WORKTREE_CLEANUP_JOB_TYPE]: { taskType: "system" },
  [INSTALL_JOB_TYPE]: { taskType: "system" },
};

/**
 * The task type of a legacy job type (one of today's hard-coded job
 * types). Throws for any other type.
 */
export function legacyJobRouting(type: string): JobRouting {
  const routing = LEGACY_JOB_ROUTING[type];
  if (!routing) throw new Error(`Unknown legacy job type ${type}`);
  return { ...routing };
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

/** The effective limit of each pool (`short` and `long`). */
export function effectivePoolLimits(
  limits: Partial<Record<string, number>>,
  maxConcurrency: number,
): PoolLimits {
  return Object.fromEntries(
    POOLS.map((name) => [name, effectivePoolLimit(name, limits, maxConcurrency)]),
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

/** An installable installed on a harness, as its heartbeat reports it. */
export const ReportedInstallable = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
});
export type ReportedInstallable = z.infer<typeof ReportedInstallable>;

/** A Claude model the harness's login can run (the Agent SDK's `supportedModels()`). */
export const ReportedModel = z.object({
  value: z.string().min(1).max(200),
  displayName: z.string().max(200),
});
export type ReportedModel = z.infer<typeof ReportedModel>;

/** A host tool's name (`HostToolName` of `@omniralph/tasks`, which task definitions require by). */
export { HOST_TOOL_NAME_PATTERN, HostToolName };

/** An absolute path to a host tool's executable on a harness. */
export const HostToolPath = z
  .string()
  .max(4096)
  .refine((path) => path.startsWith("/"), "must be an absolute path");

/**
 * What a harness found for a host tool of the last heartbeat response's
 * `hostTools`: whether the configured path is a usable executable (null when
 * none is configured; false when it's missing, not executable or blocked by
 * the local `blockedExecPaths`) and the first match on the harness's own
 * `PATH` that isn't blocked.
 */
export const ReportedHostTool = z.object({
  name: HostToolName,
  /** The configured path checked: a check of a path no longer configured is ignored. */
  configuredPath: HostToolPath.nullable().optional(),
  configuredPathExists: z.boolean().nullable(),
  discoveredPath: HostToolPath.nullable(),
});
export type ReportedHostTool = z.infer<typeof ReportedHostTool>;

/** A host tool of the organization's catalog, with the path configured for this harness. */
export const KnownHostTool = z.object({
  name: HostToolName,
  /** Null when none is configured: the harness then uses the path it discovers. */
  configuredPath: HostToolPath.nullable(),
});
export type KnownHostTool = z.infer<typeof KnownHostTool>;

/** `POST /api/harness/heartbeat` request, sent every `HEARTBEAT_INTERVAL_SECONDS`. */
export const Heartbeat = z.object({
  version: z.string().min(1).max(64),
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
  /** The installables installed on the harness (absent from older harnesses). */
  installables: z.array(ReportedInstallable).max(100).default([]),
  /** The Claude models the harness's login can run (absent from older harnesses; none when unknown). */
  models: z.array(ReportedModel).max(100).default([]),
  /** The host tools of the last response's `hostTools`, as the harness found them. */
  hostTools: z.array(ReportedHostTool).max(100).default([]),
  /** When the harness's Ably token (`ably` of a response) expires; absent when it has none. */
  ablyTokenExpiresAt: z.iso.datetime().optional(),
  /**
   * The pools the harness would claim from right now (`ClaimRequest.pools`),
   * sent in wake mode while it has a free slot: the response's `claimable`
   * then says whether a claim would find a job. Absent otherwise.
   */
  claimablePools: z.array(poolName).max(32).optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** Ably channel that wakes one harness for jobs targeted at it. */
export function harnessWakeChannel(harnessId: string): string {
  return `harness:${harnessId}`;
}

/** Ably channel that wakes an organization's harnesses for untargeted jobs. */
export function orgWakeChannel(organizationId: string): string {
  return `org:${organizationId}`;
}

/** A subscribe-only Ably token (JWT) for the harness's two wake channels. */
export const AblyToken = z.object({
  token: z.string().min(1),
  /** ISO timestamp. */
  expiresAt: z.iso.datetime(),
});
export type AblyToken = z.infer<typeof AblyToken>;

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
   * Effective concurrency limits of the `short` and `long` pools. The
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
  /** New job tokens for the harness's still-running jobs: both of a run-spec job (by `kind`), the single token of a legacy job. */
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
  /**
   * The organization's host tools with this harness's configured paths: the
   * harness reports on each in its next heartbeat. A configured path wins;
   * when it isn't usable the tool is unavailable (no fallback to `PATH`).
   */
  hostTools: z.array(KnownHostTool).default([]),
  /**
   * A fresh Ably token, sent when the harness has none or its token expires
   * within the hour; null when the control panel has Ably off (the harness
   * long-polls its claims). Absent from older control panels.
   */
  ably: AblyToken.nullable().optional(),
  /**
   * Whether a claim for the request's `claimablePools` would find a job right
   * now. Sent only when the request carried `claimablePools`.
   */
  claimable: z.boolean().optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** The job as handed to the agent on `run`. */
export const JobPayload = z.object({
  id: z.uuid(),
  type: z.string(),
  taskType: JobTaskType,
  /** `poolForTaskType(taskType)`: null for `system` jobs. */
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
  /** The job's task type isn't one the harness accepts. */
  "task_type_not_accepted",
  "skipped",
  /** A review job whose head SHA already has a completed review. */
  "already_reviewed",
] as const;
export const JobSkipReason = z.enum(JOB_SKIP_REASONS);
export type JobSkipReason = z.infer<typeof JobSkipReason>;

/**
 * A started job: `run` with the job and its tokens (`POST /api/harness/claim`
 * only answers `run`). On `skip` the agent runs nothing.
 */
export const JobStartResponse = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("run"),
      /**
       * The job's routing (ID, type, task type, pool, deliveries). A legacy
       * job's `payload` is its input; a run-spec job's input is `runSpec`.
       */
      job: JobPayload,
      /**
       * Run-spec jobs (with a `taskId`) only: the run resolved by the control
       * panel at claim time, with both tokens.
       */
      runSpec: RunSpec.optional(),
      /**
       * The job's token, refreshed via heartbeat. For run-spec jobs (with a
       * `taskId`) the `lifecycle` token, kept by the harness for its own calls;
       * for legacy jobs the single token in-job processes (e.g. the
       * `git-credential` helper) use.
       */
      jobToken: JobToken,
      /** Run-spec jobs only: the `session` token, the only one the Claude session gets. */
      sessionToken: JobToken.optional(),
    })
    .superRefine((run, ctx) => {
      if ((run.job.taskId !== null) !== (run.runSpec !== undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["runSpec"],
          message: "runSpec is required for, and only for, jobs with a taskId",
        });
      } else if (run.runSpec && run.runSpec.jobId !== run.job.id) {
        ctx.addIssue({ code: "custom", path: ["runSpec", "jobId"], message: "not the job's ID" });
      }
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

/** `POST /api/harness/jobs/{id}/result`: the job's output (e.g. findings for a review). */
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

/** Payload of a `repo.sync` job. */
export const RepoSyncPayload = z.object({
  repository: JobRepository,
});
export type RepoSyncPayload = z.infer<typeof RepoSyncPayload>;

/** Payload of an `install` job: the installable and its version (default `latest`). */
export const InstallPayload = z.object({
  name: InstallablePackageName,
  version: InstallableVersion.optional(),
});
export type InstallPayload = z.infer<typeof InstallPayload>;

/**
 * Result of an `install` job: the installed installable's name and version,
 * and what its manifest provides.
 */
export const InstallResult = z.object({
  name: z.string(),
  version: z.string(),
  /** False when that version was installed already. */
  changed: z.boolean(),
  /** Its command names. */
  commands: z.array(z.string()).default([]),
  /** Its MCP server names. */
  mcpServers: z.array(z.string()).default([]),
  /** How many skills it has. */
  skills: z.int().min(0).default(0),
});
export type InstallResult = z.infer<typeof InstallResult>;

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
