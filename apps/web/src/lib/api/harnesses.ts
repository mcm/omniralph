import { AgentUpdateReport, SELF_UPDATE_SUPPORT } from "@omniralph/shared";
import { z } from "zod";
import type { AuditEventName } from "@/lib/harnesses/display";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { isoDate, mutationResultSchema } from "./schemas";

/** Wire formats of the harness endpoints under `/api/ui`. */

const limits = z.record(z.string(), z.number());

/** `HarnessRow` on the wire. */
export const harnessRowSchema = z.object({
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
  /** The task types the harness reports (its local `acceptedTaskTypes`); read-only. */
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
}) satisfies z.ZodType<HarnessRow>;

/** `GET /api/ui/harnesses`: the organization's harnesses (the Harnesses page). */
export const harnessListSchema = z.object({ harnesses: z.array(harnessRowSchema) });
export type HarnessList = z.infer<typeof harnessListSchema>;

/** Most characters of an enrollment's name. */
export const ENROLLMENT_NAME_MAX = 100;

/** `POST /api/ui/harness-enrollments` body: the harness's name, blank for the host's own. */
export const createEnrollmentSchema = z.object({
  name: z
    .string()
    .trim()
    .max(ENROLLMENT_NAME_MAX, {
      error: `Names can be at most ${ENROLLMENT_NAME_MAX} characters.`,
    }),
});

/** `POST /api/ui/harness-enrollments` response: the one-time token, shown once. */
export const createdEnrollmentSchema = mutationResultSchema.extend({
  /** Polled for the harness that redeems the token (`GET /api/ui/harness-enrollments/{id}`). */
  id: z.string(),
  /** Shown once; only its hash is stored. */
  token: z.string(),
  /** 1 hour from its creation. */
  expiresAt: isoDate,
  /** The `omniralph-agent enroll …` command to run on the harness host. */
  command: z.string(),
});
export type CreatedEnrollment = z.infer<typeof createdEnrollmentSchema>;

/** `GET /api/ui/harness-enrollments/{id}`: the harness that redeemed the token, once one has. */
export const enrollmentStatusSchema = z.object({
  id: z.string(),
  expiresAt: isoDate,
  harness: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;

// ── A harness's pages (`/api/ui/harnesses/{id}/…`) ──────────────────────────

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

/** A `harness_audit` row. */
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
 * `GET /api/ui/harnesses/{id}`: what every tab of a harness shows (the audit log on every
 * tab, since a token theft warning shows above all of them).
 */
export const harnessDetailSchema = z.object({
  harness: harnessRowSchema,
  /** Settings › Harness defaults version ("1.5.0 (latest on npm)" when it tracks npm's latest); null: not set. */
  globalDesiredVersion: z.string().nullable(),
  /** The 50 most recent audit events, newest first. */
  audit: z.array(auditRowSchema),
  /** The latest sync job (last 7 days) of each pinned repository. */
  pinSyncJobs: z.array(pinSyncJobSchema),
});
export type HarnessDetail = z.infer<typeof harnessDetailSchema>;

/** An `install` job targeted at the harness. */
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

/** `GET /api/ui/harnesses/{id}/installables`: the reported installables and the last day's installs. */
export const harnessInstallablesSchema = z.object({
  /** As the harness's last heartbeat reported them. */
  installables: z.array(z.object({ name: z.string(), version: z.string() })),
  /** `install` jobs targeted at the harness in the last 24 hours, newest first. */
  installJobs: z.array(installJobRowSchema),
});
export type HarnessInstallables = z.infer<typeof harnessInstallablesSchema>;
export type InstallableRow = HarnessInstallables["installables"][number];

/** A catalog host tool on the harness (`AgentHostTool` of `@omniralph/db`). */
export const hostToolRowSchema = z.object({
  hostToolId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  configuredPath: z.string().nullable(),
  /** Whether the configured path exists, as last reported; null: not reported on it yet. */
  configuredPathExists: z.boolean().nullable(),
  discoveredPath: z.string().nullable(),
  /** The harness's last report on the tool; null: never. */
  reportedAt: isoDate.nullable(),
  /** `effectiveHostToolPath()`: the path the harness runs the tool from; null: unavailable. */
  effectivePath: z.string().nullable(),
});
export type HostToolRow = z.infer<typeof hostToolRowSchema>;

/** `GET /api/ui/harnesses/{id}/host-tools`: every host tool of the catalog on the harness, by name. */
export const harnessHostToolsSchema = z.object({ hostTools: z.array(hostToolRowSchema) });
export type HarnessHostTools = z.infer<typeof harnessHostToolsSchema>;

/**
 * A harness's central config, as the Settings tab saves it. Strict: the task types it runs are
 * its own (its local `acceptedTaskTypes`), so sending any is refused.
 */
export const harnessConfigFormSchema = z.strictObject({
  /** Null uses the organization's default (Settings › Harnesses). */
  maxConcurrency: z.number().nullable(),
  /** Per-pool concurrency limits (1 to the effective max concurrency); left-out pools use the default. */
  poolLimits: z.record(z.string(), z.number()),
});
export type HarnessConfigForm = z.infer<typeof harnessConfigFormSchema>;

/**
 * `PUT /api/ui/harnesses/{id}/settings`: the Settings tab's changes, saved in one request in
 * this order (left-out parts aren't changed). Strict: pins are edited from the repository's
 * settings only, so a `pin` or `unpin` here is refused, and so are task types (the
 * harness's own, reported read-only), here or in `config`.
 */
export const harnessSettingsSaveSchema = z.strictObject({
  config: harnessConfigFormSchema.optional(),
  /** The desired version override; "" clears it. */
  version: z.string().max(100).optional(),
});
export type HarnessSettingsSave = z.infer<typeof harnessSettingsSaveSchema>;

/** `PUT /api/ui/harnesses/{id}/host-tools`: configured paths to save, in order ("" clears one). */
export const hostToolPathsSaveSchema = z.object({
  paths: z
    .array(z.object({ hostToolId: z.string(), path: z.string().max(4096) }))
    .min(1)
    .max(100),
});
export type HostToolPathsSave = z.infer<typeof hostToolPathsSaveSchema>;

/**
 * The response of a save the harness picks up with its next heartbeat: it has once its
 * `lastHeartbeatAt` is later than `savedAt` (both the server's clock).
 */
export const harnessSavedSchema = mutationResultSchema.extend({ savedAt: isoDate });
export type HarnessSaved = z.infer<typeof harnessSavedSchema>;

/** `POST /api/ui/harnesses/{id}/update` ("Update now") response: the version requested. */
export const harnessUpdateRequestedSchema = mutationResultSchema.extend({ version: z.string() });

/** `POST /api/ui/harnesses/{id}/installs` body. */
export const installRequestSchema = z.object({
  name: z.string().max(214),
  /** An exact version or a dist-tag; blank for `latest`. */
  version: z.string().max(64).optional(),
});

/** `POST /api/ui/harnesses/{id}/installs` response: the install job (deduped while one runs). */
export const installEnqueuedSchema = mutationResultSchema.extend({ jobId: z.string() });
