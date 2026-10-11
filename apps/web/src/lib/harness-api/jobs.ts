import "server-only";
import {
  HARNESS_TOKEN_TTL_SECONDS,
  type JobTaskType,
  type JobToken,
  type JobTokenScope,
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

/** What decides a job token's scopes. */
export interface JobScopeInput {
  taskType: JobTaskType;
  type: string;
}

/**
 * The scopes of a job's token. Legacy `ralph.*` jobs push their commits, relay
 * session activities and download Linear attachments; every other job may
 * only read its repository.
 */
export function jobScopes(job: JobScopeInput): JobTokenScope[] {
  if (job.type.startsWith("ralph.")) {
    return ["credentials:read", "credentials:write", "ralph:activity", "ralph:attachments"];
  }
  return ["credentials:read"];
}

/** Signs a job token carrying the job's scopes (`jobScopes`). */
export async function signJobToken(
  job: { id: string } & JobScopeInput,
  harnessId: string,
): Promise<JobToken> {
  const token = await getTokenSigner().signJobToken({
    jobId: job.id,
    harnessId,
    scopes: jobScopes(job),
  });
  return { jobId: job.id, token, expiresIn: HARNESS_TOKEN_TTL_SECONDS };
}
