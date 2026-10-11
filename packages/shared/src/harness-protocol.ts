import { z } from "zod";

/** `aud` of harness access and job tokens. */
export const HARNESS_TOKEN_AUDIENCE = "omniralph-harness";

/** Lifetime of access and job tokens, in seconds. */
export const HARNESS_TOKEN_TTL_SECONDS = 900;

/**
 * Scopes a job token can carry: read (`credentials:read`) or push
 * (`credentials:write`) the job's repository, relay Linear session activities
 * and permission requests (`run:activity`), download the Linear attachments
 * listed in the payload (`run:attachments`) and read Linear (`linear:read`).
 */
export const JOB_TOKEN_SCOPES = [
  "credentials:read",
  "credentials:write",
  "run:activity",
  "run:attachments",
  "linear:read",
] as const;
export const JobTokenScope = z.enum(JOB_TOKEN_SCOPES);
export type JobTokenScope = z.infer<typeof JobTokenScope>;

/**
 * Which of a run-spec job's two tokens a job token is: the `lifecycle` token
 * the harness keeps for its own calls, or the `session` token it hands the
 * Claude session (env, git credential helper), which can never push. Legacy
 * jobs (no `task_id`) get one token without a kind (`legacy`).
 */
export const RUN_TOKEN_KINDS = ["lifecycle", "session"] as const;
export const RunTokenKind = z.enum(RUN_TOKEN_KINDS);
export type RunTokenKind = z.infer<typeof RunTokenKind>;

/** A job token's kind as seen by the control panel and the harness: `legacy` = no kind claim. */
export const JOB_TOKEN_KINDS = [...RUN_TOKEN_KINDS, "legacy"] as const;
export const JobTokenKind = z.enum(JOB_TOKEN_KINDS);
export type JobTokenKind = z.infer<typeof JobTokenKind>;

/** `POST /api/harness/enroll` */
export const EnrollRequest = z.object({
  enrollmentToken: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(100),
  version: z.string().min(1).max(64),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  harnessId: z.string(),
  refreshToken: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

/** `POST /api/harness/token`: exchanges (and rotates) a refresh token. */
export const TokenRequest = z.object({
  refreshToken: z.string().min(1).max(256),
});
export type TokenRequest = z.infer<typeof TokenRequest>;

export const TokenResponse = z.object({
  accessToken: z.string(),
  /** Seconds until `accessToken` expires. */
  expiresIn: z.number(),
  /** The next refresh token; the presented one must not be used again. */
  refreshToken: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** Error body of the harness API (401, 400, 429, ...). */
export const HarnessApiError = z.object({
  error: z.string(),
});
export type HarnessApiError = z.infer<typeof HarnessApiError>;
