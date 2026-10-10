/**
 * Job protocol between the control panel and agents: the queue message, the
 * heartbeat and the job lifecycle endpoints (`/api/agent/heartbeat`,
 * `/api/agent/jobs/{id}/start|result|fail`). See `docs/adr/0001-job-dispatch.md`.
 */
import { z } from "zod";
import type { JobTokenScope } from "./agent-protocol.js";
import type { Capability } from "./index.js";

/** Consumer group every agent uses on every topic, so agents compete for messages. */
export const QUEUE_CONSUMER_GROUP = "agents";

/** Messages (and the idempotency window) live for 24h; still-queued jobs then expire. */
export const JOB_RETENTION_SECONDS = 24 * 60 * 60;

/** A job is failed once it has been delivered (started) this many times without finishing. */
export const MAX_JOB_DELIVERIES = 3;

/** How often agents heartbeat. */
export const HEARTBEAT_INTERVAL_SECONDS = 20;

/** Longest lease extension Vercel Queues accepts (`visibilityTimeoutSeconds`). */
export const MAX_LEASE_SECONDS = 3600;

/**
 * An organization's shared topic for a capability, e.g.
 * `review-jobs-org-<organizationId>`: only that organization's agents poll it.
 */
export function capabilityTopic(capability: string, organizationId: string): string {
  return `${capability}-jobs-org-${organizationId}`;
}

/** The topic for jobs of repos pinned to one agent, e.g. `review-jobs-agent-<agentId>`. */
export function agentTopic(capability: string, agentId: string): string {
  return `${capability}-jobs-agent-${agentId}`;
}

/**
 * The built-in capability every agent runs, regardless of central config:
 * housekeeping jobs such as `repo.sync`. Its jobs only reach an agent through
 * its own topic (`system-jobs-agent-<agentId>`).
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

/** Payload of every queue message; the job itself lives in Postgres. */
export const JobMessage = z.object({
  jobId: z.uuid(),
});
export type JobMessage = z.infer<typeof JobMessage>;

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

/** The npm package agents run and update themselves to. */
export const AGENT_PACKAGE = "@omniralph/agent";

/** A semantic version (semver 2.0, no leading `v`), e.g. `1.4.0` or `1.5.0-beta.1`. */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** An agent version: valid semver, at most 64 characters. */
export const AgentVersion = z.string().max(64).regex(SEMVER_PATTERN);
export type AgentVersion = z.infer<typeof AgentVersion>;

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
export const AGENT_UPDATE_STATES = ["idle", "draining", "installing", "confirming"] as const;
export type AgentUpdateStateName = (typeof AGENT_UPDATE_STATES)[number];

export const AgentUpdateReport = z.object({
  state: z.enum(AGENT_UPDATE_STATES),
  /** The version being installed or confirmed. */
  version: z.string().max(64).nullable(),
  /** The version before the update (the rollback target). */
  previous: z.string().max(64).nullable(),
  /** Starts of the pending version so far (it's rolled back after 3). */
  startsSincePending: z.int().min(0).max(1000),
  /** Why the last update failed, if it did. */
  error: z.string().max(2000).nullable(),
});
export type AgentUpdateReport = z.infer<typeof AgentUpdateReport>;

/**
 * An admin's "Update now" from the control panel: the agent updates to
 * `version` at once, even if it failed before (it's taken off the failed
 * versions), and reports `id` back as `handledUpdateRequestId`.
 */
export const AgentUpdateRequest = z.object({
  id: z.uuid(),
  version: AgentVersion,
});
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequest>;

/** `POST /api/agent/heartbeat` request, sent every `HEARTBEAT_INTERVAL_SECONDS`. */
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
  update: AgentUpdateReport.optional(),
  /** Versions that failed to install or to stay up; the agent never retries them. */
  failedVersions: z.array(z.string().max(64)).max(100).default([]),
  /** The last `updateRequest` the agent acted on; the control panel then clears it. */
  handledUpdateRequestId: z.uuid().nullable().optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** A freshly signed job token (`AGENT_TOKEN_TTL_SECONDS`). */
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

/** Central configuration, returned on every heartbeat. */
export const HeartbeatResponse = z.object({
  maxConcurrency: z.int().min(1),
  pollIntervalSeconds: z.int().min(1),
  enabledCapabilities: z.array(capabilityName),
  /**
   * Effective per-capability concurrency limits of the enabled capabilities.
   * The agent only receives a capability's jobs while it runs fewer than this.
   */
  capabilityLimits: CapabilityLimits.default({}),
  /** Repositories pinned to this agent (pre-cloned via `repo.sync` jobs). */
  pinnedRepoIds: z.array(z.uuid()),
  /** The agent's organization: its capability topics are that organization's. */
  organizationId: z.uuid(),
  /** Topics to poll, in consumer group `QUEUE_CONSUMER_GROUP`. */
  topics: z.array(z.string()),
  /** Vercel Queues region the topics live in (the proxy's `{region}` path segment). */
  queueRegion: z.string(),
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
  desiredVersion: AgentVersion.nullable().default(null),
  /** An update an admin asked for and the agent hasn't acted on yet. */
  updateRequest: AgentUpdateRequest.nullable().default(null),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** The job as handed to the agent on `run`. */
export const JobPayload = z.object({
  id: z.uuid(),
  capability: z.string(),
  type: z.string(),
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
 * `POST /api/agent/jobs/{id}/start` response. On `skip` the agent acknowledges
 * the message without running anything.
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

/** `POST /api/agent/jobs/{id}/result`: the capability's output (e.g. findings for a review). */
export const JobResult = z.object({
  result: z.record(z.string(), z.unknown()),
});
export type JobResult = z.infer<typeof JobResult>;

/** `POST /api/agent/jobs/{id}/fail` */
export const JobFailure = z.object({
  /** Transient failure (e.g. a Claude rate limit): redeliver after `retryAfterSeconds`. */
  retryable: z.boolean(),
  retryAfterSeconds: z.int().min(0).max(MAX_LEASE_SECONDS).optional(),
  error: z.string().max(4000).optional(),
});
export type JobFailure = z.infer<typeof JobFailure>;

/**
 * Response of `/result` and `/fail`. `retry`: don't acknowledge; set the
 * message's lease to `retryAfterSeconds` so it is redelivered then. Otherwise
 * acknowledge the message.
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
 * `POST /api/agent/credentials` response (authenticated with a job token): a
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
