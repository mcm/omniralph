import {
  claimJob,
  getAgent,
  agentAcceptedTaskTypes,
  type Database,
  type SettledJob,
} from "@omniralph/db";
import {
  ClaimRequest,
  MAX_JOB_DELIVERIES,
  poolForTaskType,
  type JobStartResponse,
  type RunSpec,
} from "@omniralph/shared";
import { badRequest, readJson, unauthorized } from "@/lib/agent-auth/request";
import { readAgentAuthState } from "@/lib/agent-auth/auth-state";
import { requireAgent } from "@/lib/agent-auth/verify";
import { readAgentOrganization } from "@/lib/agents/organization";
import { hasDueJob, reconcileDueJobs, syncJobsDue } from "@/lib/dispatch/due";
import { signJobTokens, type SignedJobTokens } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { RunSpecError, resolveRunSpec } from "@/lib/runs/resolve";
import { organizationPlaybooks } from "@/lib/playbooks";
import { scheduleJobOutcomeChecks } from "@/lib/ralph/due";
import { jobHooks } from "@/lib/sinks";
import { liveRoute } from "@/lib/live/request";

/** Room above `MAX_CLAIM_WAIT_SECONDS` for the last claim and the response. */
export const maxDuration = 60;

/** How often a held request looks for a due job again. */
const CLAIM_RETRY_MS = 2_000;

type ClaimRun = Extract<JobStartResponse, { action: "run" }>;

/**
 * Hands the agent its next job: claims one of its organization's jobs of a
 * task type the agent accepts, in a pool it asked for (`poolForTaskType`; or a `system` job),
 * whose minimum agent version it meets (`claimJob`) and returns it
 * with its tokens (`signJobTokens`: a lifecycle and a session token for a
 * run-spec job, one token for a legacy job) and, for a run-spec job (with a
 * `task_id`), its `runSpec` (`resolveRunSpec`), in `JobStartResponse`'s `run`
 * shape. A run spec that can never be resolved fails its job. With nothing to claim
 * it looks again every `CLAIM_RETRY_MS` until `waitSeconds` passes (204) or
 * the agent hangs up. Each look asks Redis first (`hasDueJob`): Postgres is only
 * queried while the agent's organization has a job due (or Redis can't tell). The job's hooks (`jobHooks`: its task's sink, or its
 * type's outcome handler for a legacy job) hear about the start
 * (`onStarted`, whose `skip` moves the claim on to the next job) and about
 * candidates the claim canceled (`onCanceled`) or gave up on (`onFailed`).
 */
async function post(req: Request): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const body = ClaimRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const { agentId } = principal;
  const organizationId = await readAgentOrganization(db, agentId);
  if (!organizationId) return unauthorized();
  const deadline = Date.now() + body.data.waitSeconds * 1000;
  for (let attempt = 0; ; attempt++) {
    if (await hasDueJob(db, organizationId)) {
      // Read on every attempt: the agent may be revoked or reconfigured while the request is held.
      const agent = await getAgent(db, agentId);
      if (!agent || agent.revokedAt) return unauthorized();
      // The task types it runs: the request's, else the ones it last reported (older agents).
      const acceptedTaskTypes = body.data.acceptedTaskTypes ?? agentAcceptedTaskTypes(agent);
      const run = await claimNext(db, { ...agent, acceptedTaskTypes }, body.data.pools);
      if (run) return Response.json(run satisfies ClaimRun);
      await reconcileDueJobs(db, organizationId);
    } else if (attempt > 0 && (await readAgentAuthState(db, agentId)) !== "active") {
      // `requireAgent` checked the first attempt; a revocation still ends a held request.
      return unauthorized();
    }
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
      agentId: agent.id,
      organizationId: agent.organizationId,
      acceptedTaskTypes: agent.acceptedTaskTypes,
      pools,
      agentVersion: agent.reportedVersion,
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
    await syncJobsDue([...settled.map(({ job }) => job), ...(claim ? [claim.job] : [])]);
    // Their ralph runs are advanced even if the outcome hooks below never run.
    await scheduleJobOutcomeChecks(settled.map(({ job }) => job));
    for (const job of settled) await onSettled(db, job);
    if (!claim || !tokens) return null;

    const handler = await jobHooks(claim.job, organizationPlaybooks(db, claim.job.organizationId));
    if (handler?.onStarted) {
      const hook = await handler.onStarted(db, claim.job, agent.id);
      if (hook.skip) continue;
    }
    const { id, type, taskType, taskId, repositoryId, payload, deliveryCount } = claim.job;
    // The derived pool, so the agent counts the job against that pool's slots.
    const pool = poolForTaskType(taskType);
    return {
      action: "run",
      job: { id, type, taskType, pool, taskId, repositoryId, payload, deliveryCount },
      ...tokens,
      ...(runSpec ? { runSpec } : {}),
    };
  }
}

/** A failing hook or hook lookup is logged, so it can't lose the claim or stop the other settled jobs' hooks. */
async function onSettled(db: Database, { outcome, job }: SettledJob): Promise<void> {
  try {
    const handler = await jobHooks(job, organizationPlaybooks(db, job.organizationId));
    if (outcome === "failed") {
      await handler?.onFailed?.(db, job, job.error ?? "Gave up after too many deliveries");
    } else {
      await handler?.onCanceled?.(db, job);
    }
  } catch (error) {
    console.error(`Job outcome hook failed for job ${job.id}`, error);
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

export const POST = liveRoute(post);
