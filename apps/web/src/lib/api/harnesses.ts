import { HarnessUpdateReport, SELF_UPDATE_SUPPORT } from "@omniralph/shared";
import { z } from "zod";
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
  update: HarnessUpdateReport.nullable(),
  failedVersions: z.array(z.string()),
  updateRequest: z.object({ version: z.string(), requestedAt: isoDate }).nullable(),
  updateStatus: z.enum(["up_to_date", "updating", "failed", "manual"]),
  acceptedTaskTypes: z.array(z.string()),
  maxConcurrency: z.number(),
  overrides: z.object({
    acceptedTaskTypes: z.array(z.string()).nullable(),
    maxConcurrency: z.number().nullable(),
  }),
  defaults: z.object({ acceptedTaskTypes: z.array(z.string()), maxConcurrency: z.number() }),
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
  /** The `omniralph-harness enroll …` command to run on the harness host. */
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
