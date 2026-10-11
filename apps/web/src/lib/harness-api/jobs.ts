import "server-only";
import {
  HARNESS_TOKEN_TTL_SECONDS,
  type JobTaskType,
  type JobToken,
  type JobTokenScope,
  type RunTokenKind,
} from "@omniralph/shared";
import { getTokenSigner } from "@/lib/harness-auth/signer";

/** Route context of `/api/harness/jobs/[id]/*`. */
export interface JobRouteContext {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job ID from the route, or null if it isn't a UUID. */
export async function jobIdParam(ctx: JobRouteContext): Promise<string | null> {
  const { id } = await ctx.params;
  return UUID.test(id) ? id : null;
}

export function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

/** 409: the job isn't running on the calling harness (e.g. it was redelivered to another one). */
export function notCurrentHarness(): Response {
  return Response.json({ error: "not_current_agent" }, { status: 409 });
}

/** What decides a job's tokens and their scopes. */
export interface JobScopeInput {
  taskType: JobTaskType;
  type: string;
  /** The task definition of a run-spec job; null for legacy jobs. */
  taskId: string | null;
}

/**
 * The scopes of a legacy job's single token. Legacy `ralph.*` jobs push their
 * commits, relay session activities and download Linear attachments; every
 * other job may only read its repository.
 */
export function jobScopes(job: Pick<JobScopeInput, "type" | "taskType">): JobTokenScope[] {
  if (job.type.startsWith("ralph.")) {
    return ["credentials:read", "credentials:write", "run:activity", "run:attachments"];
  }
  return ["credentials:read"];
}

/**
 * The scopes of a run-spec job's token. The `session` token (the Claude
 * session's) may read the repository, post activities, download attachments
 * and read Linear, but never push, whatever the task type. The `lifecycle`
 * token (the harness's own) reads the repository, and pushes only for `coding`.
 */
export function runTokenScopes(kind: RunTokenKind, taskType: JobTaskType): JobTokenScope[] {
  if (kind === "session") {
    return ["credentials:read", "run:activity", "run:attachments", "linear:read"];
  }
  return taskType === "coding" ? ["credentials:read", "credentials:write"] : ["credentials:read"];
}

/** Whether a job runs from a run spec (has a `task_id`), so it gets lifecycle and session tokens. */
export function isRunSpecJob(job: Pick<JobScopeInput, "taskId">): boolean {
  return job.taskId !== null;
}

/** A job's signed tokens: `jobToken` (lifecycle, or the legacy single token) and, for run-spec jobs, `sessionToken`. */
export interface SignedJobTokens {
  jobToken: JobToken;
  sessionToken?: JobToken;
}

/**
 * Signs a job's tokens: a `lifecycle` and a `session` token for a run-spec job
 * (`runTokenScopes`), one token without a kind for a legacy job (`jobScopes`).
 */
export async function signJobTokens(
  job: { id: string } & JobScopeInput,
  harnessId: string,
): Promise<SignedJobTokens> {
  if (!isRunSpecJob(job)) {
    const token = await getTokenSigner().signJobToken({
      jobId: job.id,
      harnessId,
      scopes: jobScopes(job),
    });
    return {
      jobToken: { jobId: job.id, token, expiresIn: HARNESS_TOKEN_TTL_SECONDS, kind: "legacy" },
    };
  }
  const sign = async (kind: RunTokenKind): Promise<JobToken> => {
    const token = await getTokenSigner().signJobToken({
      jobId: job.id,
      harnessId,
      scopes: runTokenScopes(kind, job.taskType),
      kind,
    });
    return { jobId: job.id, token, expiresIn: HARNESS_TOKEN_TTL_SECONDS, kind };
  };
  const [jobToken, sessionToken] = await Promise.all([sign("lifecycle"), sign("session")]);
  return { jobToken, sessionToken };
}
