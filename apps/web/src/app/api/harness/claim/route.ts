import { claimJob, getHarness, type Database, type SettledJob } from "@omniralph/db";
import {
  ClaimRequest,
  MAX_JOB_DELIVERIES,
  type JobStartResponse,
  type JobToken,
} from "@omniralph/shared";
import { badRequest, readJson, unauthorized } from "@/lib/harness-auth/request";
import { requireHarness } from "@/lib/harness-auth/verify";
import { runnableCapabilities, signJobToken } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { jobOutcomeHandler } from "@/lib/jobs/handlers";

/** Room above `MAX_CLAIM_WAIT_SECONDS` for the last claim and the response. */
export const maxDuration = 60;

/** How often a held request looks for a claimable job again. */
const CLAIM_RETRY_MS = 2_000;

type ClaimRun = Extract<JobStartResponse, { action: "run" }>;

/**
 * Hands the harness its next job: claims one of its organization's jobs whose
 * capability the harness asked for and has enabled (`claimJob`) and returns it
 * with a job token, in `JobStartResponse`'s `run` shape. With nothing to claim
 * it looks again every `CLAIM_RETRY_MS` until `waitSeconds` passes (204) or
 * the harness hangs up. The job type's outcome handler hears about the start
 * (`onStarted`, whose `skip` moves the claim on to the next job) and about
 * candidates the claim canceled (`onCanceled`) or gave up on (`onFailed`).
 */
export async function POST(req: Request): Promise<Response> {
  const principal = await requireHarness(req);
  if (principal instanceof Response) return principal;
  const body = ClaimRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const { harnessId } = principal;
  const deadline = Date.now() + body.data.waitSeconds * 1000;
  for (;;) {
    // Read on every attempt: the harness may be revoked or reconfigured while the request is held.
    const agent = await getHarness(db, harnessId);
    if (!agent || agent.revokedAt) return unauthorized();
    const run = await claimNext(db, agent, body.data.capabilities);
    if (run) return Response.json(run satisfies ClaimRun);
    const left = deadline - Date.now();
    if (left <= 0 || !(await wait(Math.min(CLAIM_RETRY_MS, left), req.signal))) break;
  }
  return new Response(null, { status: 204 });
}

/** Claims jobs until one is to run (its `onStarted` doesn't skip it) or none is left. */
async function claimNext(
  db: Database,
  agent: { id: string; organizationId: string; enabledCapabilities: string[] },
  capabilities: readonly string[],
): Promise<ClaimRun | null> {
  for (;;) {
    let jobToken: JobToken | undefined;
    const { claim, settled } = await claimJob(db, {
      harnessId: agent.id,
      organizationId: agent.organizationId,
      capabilities,
      enabledCapabilities: runnableCapabilities(agent.enabledCapabilities),
      maxDeliveries: MAX_JOB_DELIVERIES,
      // Sign while claiming: if signing (KMS) fails, the claim rolls back and no delivery is used up.
      beforeClaim: async (job) => {
        jobToken = await signJobToken(job, agent.id);
      },
    });
    for (const job of settled) await onSettled(db, job);
    if (!claim || !jobToken) return null;

    const handler = jobOutcomeHandler(claim.job);
    if (handler?.onStarted) {
      const hook = await handler.onStarted(db, claim.job, agent.id);
      if (hook.skip) continue;
    }
    const { id, capability, type, repositoryId, payload, deliveryCount } = claim.job;
    return {
      action: "run",
      job: { id, capability, type, repositoryId, payload, deliveryCount },
      jobToken,
    };
  }
}

async function onSettled(db: Database, { outcome, job }: SettledJob): Promise<void> {
  const handler = jobOutcomeHandler(job);
  if (outcome === "failed") {
    await handler?.onFailed?.(db, job, job.error ?? "Gave up after too many deliveries");
  } else {
    await handler?.onCanceled?.(db, job);
  }
}

/** Waits `ms`; false when `signal` aborted first. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
