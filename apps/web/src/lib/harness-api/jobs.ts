import "server-only";
import {
  HARNESS_TOKEN_TTL_SECONDS,
  CAPABILITY_JOB_SCOPES,
  isCapability,
  SYSTEM_CAPABILITY,
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

export function jobScopes(capability: string): JobTokenScope[] {
  if (capability === SYSTEM_CAPABILITY) return CAPABILITY_JOB_SCOPES.system;
  return isCapability(capability) ? CAPABILITY_JOB_SCOPES[capability] : [];
}

/** Signs a job token carrying the capability's scopes. */
export async function signJobToken(
  job: { id: string; capability: string },
  harnessId: string,
): Promise<JobToken> {
  const token = await getTokenSigner().signJobToken({
    jobId: job.id,
    harnessId,
    scopes: jobScopes(job.capability),
  });
  return { jobId: job.id, token, expiresIn: HARNESS_TOKEN_TTL_SECONDS };
}
