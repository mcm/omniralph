import { AgentUpdateReport, SELF_UPDATE_SUPPORT } from "@omniralph/shared";
import { z } from "zod";
import type { AuditEventName } from "@/lib/agents/display";
import type { AgentRow } from "@/lib/agents/rows";
import { isoDate, mutationResultSchema } from "./schemas";

/** Wire formats of the agent endpoints under `/api/ui`. */

const limits = z.record(z.string(), z.number());

/** `AgentRow` on the wire. */
export const agentRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  revoked: z.boolean(),
  version: z.string().nullable(),
  desiredVersion: z.string().nullable(),
  desiredVersionOverride: z.string().nullable(),
  tracksLatest: z.boolean(),
  selfUpdate: z.enum(SELF_UPDATE_SUPPORT).nullable(),
  update: AgentUpdateReport.nullable(),
  failedVersions: z.array(z.string()),
  updateRequest: z.object({ version: z.string(), requestedAt: isoDate }).nullable(),
  updateStatus: z.enum(["up_to_date", "updating", "failed", "manual"]),
  /** The task types the agent reports (its local `acceptedTaskTypes`); read-only. */
  acceptedTaskTypes: z.array(z.string()),
  maxConcurrency: z.number(),
  overrides: z.object({ maxConcurrency: z.number().nullable() }),
  defaults: z.object({ maxConcurrency: z.number() }),
  poolLimits: limits,
  effectivePoolLimits: limits,
  runningJobs: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      taskType: z.string(),
      target: z.object({ label: z.string(), url: z.string().nullable() }).nullable(),
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

/** `GET /api/ui/agents`: the organization's agents (the Agents page). */
export const agentListSchema = z.object({ agents: z.array(agentRowSchema) });
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

const AUDIT_EVENTS = [
  "enroll",
  "token_refresh",
  "refresh_reuse",
  "revoke",
  "delete",
  "credential_issued",
  "result_submitted",
  "auth_failed",
] as const satisfies readonly AuditEventName[];

/** A `agent_audit` row. */
export const auditRowSchema = z.object({
  id: z.string(),
  event: z.enum(AUDIT_EVENTS),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
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
export const agentDetailSchema = z.object({
  agent: agentRowSchema,
  /** Settings › Agent defaults version ("1.5.0 (latest on npm)" when it tracks npm's latest); null: not set. */
  globalDesiredVersion: z.string().nullable(),
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

/** A catalog host tool on the agent (`AgentHostTool` of `@omniralph/db`). */
export const hostToolRowSchema = z.object({
  hostToolId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  configuredPath: z.string().nullable(),
  /** Whether the configured path exists, as last reported; null: not reported on it yet. */
  configuredPathExists: z.boolean().nullable(),
  discoveredPath: z.string().nullable(),
  /** The agent's last report on the tool; null: never. */
  reportedAt: isoDate.nullable(),
  /** `effectiveHostToolPath()`: the path the agent runs the tool from; null: unavailable. */
  effectivePath: z.string().nullable(),
});
export type HostToolRow = z.infer<typeof hostToolRowSchema>;

/** `GET /api/ui/agents/{id}/host-tools`: every host tool of the catalog on the agent, by name. */
export const agentHostToolsSchema = z.object({ hostTools: z.array(hostToolRowSchema) });
export type AgentHostTools = z.infer<typeof agentHostToolsSchema>;

/**
 * An agent's central config, as the Settings tab saves it. Strict: the task types it runs are
 * its own (its local `acceptedTaskTypes`), so sending any is refused.
 */
export const agentConfigFormSchema = z.strictObject({
  /** Null uses the organization's default (Settings › Agents). */
  maxConcurrency: z.number().nullable(),
  /** Per-pool concurrency limits (1 to the effective max concurrency); left-out pools use the default. */
  poolLimits: z.record(z.string(), z.number()),
});
export type AgentConfigForm = z.infer<typeof agentConfigFormSchema>;

/**
 * `PUT /api/ui/agents/{id}/settings`: the Settings tab's changes, saved in one request in
 * this order (left-out parts aren't changed). Strict: pins are edited from the repository's
 * settings only, so a `pin` or `unpin` here is refused, and so are task types (the
 * agent's own, reported read-only), here or in `config`.
 */
export const agentSettingsSaveSchema = z.strictObject({
  config: agentConfigFormSchema.optional(),
  /** The desired version override; "" clears it. */
  version: z.string().max(100).optional(),
});
export type AgentSettingsSave = z.infer<typeof agentSettingsSaveSchema>;

/** `PUT /api/ui/agents/{id}/host-tools`: configured paths to save, in order ("" clears one). */
export const hostToolPathsSaveSchema = z.object({
  paths: z
    .array(z.object({ hostToolId: z.string(), path: z.string().max(4096) }))
    .min(1)
    .max(100),
});
export type HostToolPathsSave = z.infer<typeof hostToolPathsSaveSchema>;

/**
 * The response of a save the agent picks up with its next heartbeat: it has once its
 * `lastHeartbeatAt` is later than `savedAt` (both the server's clock).
 */
export const agentSavedSchema = mutationResultSchema.extend({ savedAt: isoDate });
export type AgentSaved = z.infer<typeof agentSavedSchema>;

/** `POST /api/ui/agents/{id}/update` ("Update now") response: the version requested. */
export const agentUpdateRequestedSchema = mutationResultSchema.extend({ version: z.string() });

/** `POST /api/ui/agents/{id}/installs` body. */
export const installRequestSchema = z.object({
  name: z.string().max(214),
  /** An exact version or a dist-tag; blank for `latest`. */
  version: z.string().max(64).optional(),
});

/** `POST /api/ui/agents/{id}/installs` response: the install job (deduped while one runs). */
export const installEnqueuedSchema = mutationResultSchema.extend({ jobId: z.string() });
