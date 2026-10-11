import { z } from "zod";

/** `aud` of harness access and job tokens. */
export const HARNESS_TOKEN_AUDIENCE = "omniralph-harness";

/** Lifetime of access and job tokens, in seconds. */
export const HARNESS_TOKEN_TTL_SECONDS = 900;

/**
 * Scopes a job token can carry. Review jobs get `credentials:read` only;
 * ralph jobs may also push (`credentials:write`), relay Linear session
 * activities (`ralph:activity`) and download the Linear attachments listed in
 * their payload (`ralph:attachments`).
 */
export const JOB_TOKEN_SCOPES = [
  "credentials:read",
  "credentials:write",
  "ralph:activity",
  "ralph:attachments",
] as const;
export const JobTokenScope = z.enum(JOB_TOKEN_SCOPES);
export type JobTokenScope = z.infer<typeof JobTokenScope>;

/** `POST /api/harness/enroll` */
export const EnrollRequest = z.object({
  enrollmentToken: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(100),
  version: z.string().min(1).max(64),
  /** Capabilities the host can run (it may know ones the control panel doesn't yet). */
  capabilities: z.array(z.string().min(1).max(64)).max(32),
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
