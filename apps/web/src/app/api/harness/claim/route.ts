import { claimJob, getHarness, type Database, type SettledJob } from "@omniralph/db";
import {
  ClaimRequest,
  MAX_JOB_DELIVERIES,
  type JobStartResponse,
  type RunSpec,
} from "@omniralph/shared";
import { badRequest, readJson, unauthorized } from "@/lib/harness-auth/request";
import { requireHarness } from "@/lib/harness-auth/verify";
import { signJobTokens, type SignedJobTokens } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { RunSpecError, resolveRunSpec } from "@/lib/runs/resolve";
import { jobHooks } from "@/lib/sinks";

/** Room above `MAX_CLAIM_WAIT_SECONDS` for the last claim and the response. */
export const maxDuration = 60;

/** How often a held request looks for a claimable job again. */
const CLAIM_RETRY_MS = 2_000;

type ClaimRun = Extract<JobStartResponse, { action: "run" }>;

/**
 * Hands the harness its next job: claims one of its organization's jobs of a
 * task type the harness accepts, in a pool it asked for (or a `system` job),
 * whose minimum harness version it meets (`claimJob`) and returns it
 * with its tokens (`signJobTokens`: a lifecycle and a session token for a
 * run-spec job, one token for a legacy job) and, for a run-spec job (with a
 * `task_id`), its `runSpec` (`resolveRunSpec`), in `JobStartResponse`'s `run`
 * shape. A run spec that can never be resolved fails its job. With nothing to claim
 * it looks again every `CLAIM_RETRY_MS` until `waitSeconds` passes (204) or
 * the harness hangs up. The job's hooks (`jobHooks`: its task's sink, or its
 * type's outcome handler for a legacy job) hear about the start
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
    const run = await claimNext(db, agent, body.data.pools);
    if (run) return Response.json(run satisfies ClaimRun);
    const left = deadline - Date.now();
    if (left <= 0 || !(await wait(Math.min(CLAIM_RETRY_MS, left), req.signal))) break;
  }
  return new Response(null, { status: 204 });
}

/** Claims jobs until one is to run (its `onStarted` doesn't skip it) or none is left. */
async function claimNext(
  db: Database,
  agent: {
    id: string;
    organizationId: string;
    acceptedTaskTypes: string[];
    reportedVersion: string | null;
  },
  pools: readonly string[],
): Promise<ClaimRun | null> {
  for (;;) {
    let tokens: SignedJobTokens | undefined;
    let runSpec: RunSpec | undefined;
    const { claim, settled } = await claimJob(db, {
      harnessId: agent.id,
      organizationId: agent.organizationId,
      acceptedTaskTypes: agent.acceptedTaskTypes,
      pools,
      harnessVersion: agent.reportedVersion,
      maxDeliveries: MAX_JOB_DELIVERIES,
      // Sign and resolve while claiming: if signing (KMS) or loading fails, the
      // claim rolls back and no delivery is used up.
      beforeClaim: async (job) => {
        tokens = await signJobTokens(job, agent.id);
        runSpec = undefined;
        if (!tokens.sessionToken) return;
        try {
          runSpec = await resolveRunSpec(db, job, {
            lifecycle: tokens.jobToken,
            session: tokens.sessionToken,
          });
        } catch (error) {
          if (error instanceof RunSpecError) return { fail: error.message };
          throw error;
        }
      },
    });
    for (const job of settled) await onSettled(db, job);
    if (!claim || !tokens) return null;

    const handler = jobHooks(claim.job);
    if (handler?.onStarted) {
      const hook = await handler.onStarted(db, claim.job, agent.id);
      if (hook.skip) continue;
    }
    const { id, type, taskType, pool, taskId, repositoryId, payload, deliveryCount } = claim.job;
    return {
      action: "run",
      job: { id, type, taskType, pool, taskId, repositoryId, payload, deliveryCount },
      ...tokens,
      ...(runSpec ? { runSpec } : {}),
    };
  }
}

async function onSettled(db: Database, { outcome, job }: SettledJob): Promise<void> {
  const handler = jobHooks(job);
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
