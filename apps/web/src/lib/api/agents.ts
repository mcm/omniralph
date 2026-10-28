import {
  AgentHostReport,
  AgentUpdateReport,
  CLAUDE_LOGIN_SOURCES,
  CLAUDE_LOGIN_STATUSES,
  HOST_TOOL_PROBLEMS,
  HOST_TOOL_SOURCES,
  SELF_UPDATE_SUPPORT,
} from "@omniralph/shared";
import { z } from "zod";
import { AUDIT_EVENTS } from "@/lib/agents/display";
import type { AgentRow } from "@/lib/agents/rows";
import { AGENT_STATUS_KINDS } from "@/lib/fleet/status";
import { organizationRefSchema, repositoryRefSchema, RUN_KINDS, workItemRefSchema } from "./runs";
import { isoDate, mutationResultSchema } from "./schemas";
import { settingsHistoryEntrySchema } from "./settings-history";

/** Wire formats of the agent endpoints under `/api/ui`. */

/** `AgentRow` on the wire. */
const fleetTone = z.enum(["run", "fail", "neutral"]);

export const agentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `agents.live_online`. */
  online: z.boolean(),
  revoked: z.boolean(),
  /** `agentStatus` (`lib/fleet/status.ts`). */
  status: z.object({ kind: z.enum(AGENT_STATUS_KINDS), label: z.string(), tone: fleetTone }),
  runningCount: z.number(),
  host: AgentHostReport.nullable(),
  version: z.string().nullable(),
  /** Its target: its local pin, else its organization's version. */
  desiredVersion: z.string().nullable(),
  /** The version pinned on the agent, as it reports it; read-only. */
  versionPin: z.string().nullable(),
  tracksLatest: z.boolean(),
  selfUpdate: z.enum(SELF_UPDATE_SUPPORT).nullable(),
  update: AgentUpdateReport.nullable(),
  failedVersions: z.array(z.string()),
  updateStatus: z.enum(["up_to_date", "updating", "failed", "manual"]),
  /** The task types the agent reports (its local `acceptedTaskTypes`); read-only. */
  acceptedTaskTypes: z.array(z.string()),
  /** Attempts running, and the slots the agent reports (null until it reports them); read-only. */
  slots: z.object({ running: z.number(), max: z.number().nullable() }),
  runningJobs: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      taskType: z.string(),
      target: z.object({ label: z.string(), url: z.string().nullable() }).nullable(),
      runId: z.string().nullable(),
    }),
  ),
  pinnedRepositories: z.array(
    z.object({
      id: z.string(),
      provider: z.enum(["github", "gitlab"]),
      fullPath: z.string(),
      webUrl: z.string(),
    }),
  ),
  lastHeartbeatAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
}) satisfies z.ZodType<AgentRow>;

/** A Fleet row: an agent with its organization and the user's role there (Design rule 13). */
export const fleetAgentRowSchema = agentRowSchema.extend({ organization: organizationRefSchema });
export type FleetAgentRow = z.infer<typeof fleetAgentRowSchema>;

/** The version policy of the organizations in scope (`lib/fleet/status.ts`'s `VersionPolicy`). */
export const versionPolicySchema = z.object({
  /** `unset`: none chosen yet, so agents stay on what they run. */
  mode: z.enum(["latest", "pinned", "unset"]),
  /** The pinned version; null otherwise. */
  version: z.string().nullable(),
  /** The version agents should be on now; null when unknown. */
  target: z.string().nullable(),
});

/** Fleet's summary cells, over the non-revoked agents in scope. */
export const fleetSummarySchema = z.object({
  total: z.number(),
  /** From `agents.live_online`. */
  online: z.number(),
  offline: z.number(),
  /** Agents with a running attempt. */
  busy: z.number(),
  /** Null under all organizations when they differ ("Varies by organization"). */
  versionPolicy: versionPolicySchema.nullable(),
  /**
   * Online agents on and behind their organization's target, and pinned on the agent (on their
   * own target); any agent whose update failed.
   */
  versions: z.object({
    onTarget: z.number(),
    behind: z.number(),
    pinned: z.number(),
    updateFailed: z.number(),
  }),
  /** Agents that report a narrower set of kinds than every kind. */
  acceptedKinds: z.object({ limited: z.number(), total: z.number() }),
});
export type FleetSummary = z.infer<typeof fleetSummarySchema>;

/** `GET /api/ui/agents?organization=`: the agents in scope (Fleet) and their summary. */
export const agentListSchema = z.object({
  agents: z.array(fleetAgentRowSchema),
  summary: fleetSummarySchema,
  /**
   * The version policy's latest change (section `agent_defaults`, the cell's ⓘ) with one
   * organization in scope; null before any change, or with several organizations.
   */
  versionHistory: settingsHistoryEntrySchema.nullable(),
});
export type AgentList = z.infer<typeof agentListSchema>;

/** Most characters of an enrollment's name. */
export const ENROLLMENT_NAME_MAX = 100;

/** `POST /api/ui/agent-enrollments` body: the agent's name, blank for the host's own. */
export const createEnrollmentSchema = z.object({
  name: z
    .string()
    .trim()
    .max(ENROLLMENT_NAME_MAX, {
      error: `Names can be at most ${ENROLLMENT_NAME_MAX} characters.`,
    }),
});

/** `POST /api/ui/agent-enrollments` response: the one-time token, shown once. */
export const createdEnrollmentSchema = mutationResultSchema.extend({
  /** Polled for the agent that redeems the token (`GET /api/ui/agent-enrollments/{id}`). */
  id: z.string(),
  /** Shown once; only its hash is stored. */
  token: z.string(),
  /** 1 hour from its creation. */
  expiresAt: isoDate,
  /** The `omniralph-agent enroll …` command to run on the agent host. */
  command: z.string(),
});
export type CreatedEnrollment = z.infer<typeof createdEnrollmentSchema>;

/** `GET /api/ui/agent-enrollments/{id}`: the agent that redeemed the token, once one has. */
export const enrollmentStatusSchema = z.object({
  id: z.string(),
  expiresAt: isoDate,
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;

// ── An agent's pages (`/api/ui/agents/{id}/…`) ──────────────────────────

/** `jobs.status`, as `@omniralph/db`'s `JobStatus`. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  "skipped",
] as const;
const jobStatus = z.enum(JOB_STATUSES);

/** A `agent_audit` row. */
export const auditRowSchema = z.object({
  id: z.string(),
  event: z.enum(AUDIT_EVENTS),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
  /** The name (else email) of the user who revoked or removed the agent; null otherwise. */
  actor: z.string().nullable(),
  createdAt: isoDate,
});
export type AuditRow = z.infer<typeof auditRowSchema>;

/** The latest `repo.sync` job of a pinned repository (the pre-clone pinning starts). */
export const pinSyncJobSchema = z.object({
  repositoryId: z.string(),
  id: z.string(),
  status: jobStatus,
  error: z.string().nullable(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
});
export type PinSyncJob = z.infer<typeof pinSyncJobSchema>;

/**
 * `GET /api/ui/agents/{id}`: what every tab of an agent shows (the audit log on every
 * tab, since a token theft warning shows above all of them).
 */
/** The run an attempt belongs to, as Fleet links it. */
const attemptRunSchema = z.object({ id: z.string(), kind: z.enum(RUN_KINDS), title: z.string() });

/** An attempt running on the agent (Running now). `type` is the raw job type; never shown. */
export const runningAttemptSchema = z.object({
  id: z.string(),
  type: z.string(),
  /** `describeAttempt`: "Building SOC-1720". */
  label: z.string(),
  run: attemptRunSchema.nullable(),
  repository: repositoryRefSchema.nullable(),
  workItem: workItemRefSchema.nullable(),
  /** "Story 1 of 3" when it builds a story of an epic; else null. */
  step: z.string().nullable(),
  startedAt: isoDate.nullable(),
});
export type RunningAttempt = z.infer<typeof runningAttemptSchema>;

/** A finished attempt of the agent (Recent work). `type` is the raw job type; never shown. */
export const recentAttemptSchema = z.object({
  id: z.string(),
  type: z.string(),
  /** `describeAttempt`: "Cleaned up the SOC-1719 worktree", "Couldn't sync api". */
  label: z.string(),
  status: z.enum(JOB_STATUSES),
  durationMs: z.number().nullable(),
  finishedAt: isoDate,
  run: attemptRunSchema.nullable(),
});
export type RecentAttempt = z.infer<typeof recentAttemptSchema>;

/** The agent's token health (the Security line). */
export const agentSecuritySchema = z.object({
  lastTokenRefreshAt: isoDate.nullable(),
  /** `refresh_reuse` audit events in the last 30 days. */
  reuseAlerts30d: z.number(),
  /** The latest of them; null when none. */
  lastReuseAt: isoDate.nullable(),
  /** `auth_failed` audit events in the last 30 days. */
  authFailures30d: z.number(),
});

/** An install on the agent that is queued or running, or failed in the last 24 hours (Packages). */
export const agentInstallSchema = z.object({
  id: z.string(),
  /** The package; null when the job names none. */
  name: z.string().nullable(),
  state: z.enum(["installing", "failed"]),
  /** Why it failed; null while installing. */
  error: z.string().nullable(),
  createdAt: isoDate,
});
export type AgentInstall = z.infer<typeof agentInstallSchema>;

export const agentDetailSchema = z.object({
  agent: fleetAgentRowSchema,
  /** The models it last reported, by display name. */
  models: z.array(z.object({ value: z.string(), displayName: z.string() })),
  /** The packages it last reported installed. */
  installables: z.array(z.object({ name: z.string(), version: z.string() })),
  /** Installs in progress, and failed ones of the last 24 hours, newest first. */
  installs: z.array(agentInstallSchema),
  /** Its running attempts, oldest first. */
  runningNow: z.array(runningAttemptSchema),
  /** Its last 10 finished attempts (system work included), newest first. */
  recentWork: z.array(recentAttemptSchema),
  security: agentSecuritySchema,
  /** The version policy's version (Fleet › Version policy; "1.5.0 (latest on npm)" when it tracks npm's latest); null: not set. */
  globalDesiredVersion: z.string().nullable(),
  /**
   * Its machine settings as it last reported them (its `settings.json`; read-only, edited on
   * the agent's page): both pools' limits, its version pin and its installables allow-list.
   * Null until it reports them.
   */
  local: z.object({
    poolLimits: z.object({ short: z.number(), long: z.number() }).nullable(),
    versionPin: z.string().nullable(),
    installablesAllow: z.array(z.string()).nullable(),
  }),
  /**
   * The host tools it configured locally or was asked about, as it last reported them, by
   * name: a tool with a `path` is usable (`source` tells where the path came from); one
   * without is not found, or has a configured path with a `problem`. Empty until it reports.
   */
  hostTools: z.array(
    z.object({
      name: z.string(),
      path: z.string().nullable(),
      source: z.enum(HOST_TOOL_SOURCES).nullable(),
      problem: z.enum(HOST_TOOL_PROBLEMS).nullable(),
    }),
  ),
  /** The host tools the organization's playbooks require that it reports no path for, sorted. */
  missingRequiredHostTools: z.array(z.string()),
  /**
   * Whether Claude is signed in on it, and with what (`source`; null when not signed in), as it
   * last reported. Null until it reports (older agents).
   */
  claude: z
    .object({
      status: z.enum(CLAUDE_LOGIN_STATUSES),
      source: z.enum(CLAUDE_LOGIN_SOURCES).nullable(),
    })
    .nullable(),
  /** The 50 most recent audit events, newest first. */
  audit: z.array(auditRowSchema),
  /** The latest sync job (last 7 days) of each pinned repository. */
  pinSyncJobs: z.array(pinSyncJobSchema),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

/** An `install` job targeted at the agent. */
export const installJobRowSchema = z.object({
  id: z.string(),
  status: jobStatus,
  name: z.string().nullable(),
  /** The requested version; null: `latest`. */
  version: z.string().nullable(),
  installedVersion: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: isoDate,
});
export type InstallJobRow = z.infer<typeof installJobRowSchema>;

/** `GET /api/ui/agents/{id}/installables`: the reported installables and the last day's installs. */
export const agentInstallablesSchema = z.object({
  /** As the agent's last heartbeat reported them. */
  installables: z.array(z.object({ name: z.string(), version: z.string() })),
  /** `install` jobs targeted at the agent in the last 24 hours, newest first. */
  installJobs: z.array(installJobRowSchema),
});
export type AgentInstallables = z.infer<typeof agentInstallablesSchema>;
export type InstallableRow = AgentInstallables["installables"][number];

/**
 * The response of a save the agent picks up with its next heartbeat: it has once its
 * `lastHeartbeatAt` is later than `savedAt` (both the server's clock).
 */
export const agentSavedSchema = mutationResultSchema.extend({ savedAt: isoDate });
export type AgentSaved = z.infer<typeof agentSavedSchema>;

/** `POST /api/ui/agents/{id}/installs` body. */
export const installRequestSchema = z.object({
  name: z.string().max(214),
  /** An exact version or a dist-tag; blank for `latest`. */
  version: z.string().max(64).optional(),
});

/** `POST /api/ui/agents/{id}/installs` response: the install job (deduped while one runs). */
export const installEnqueuedSchema = mutationResultSchema.extend({ jobId: z.string() });
