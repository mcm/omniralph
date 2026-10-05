import { completeJob, getJob, writeAgentAudit } from "@omniralph/db";
import { JobResult, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, clientIp, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, notCurrentAgent, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import {
  isReviewJob,
  onReviewJobCanceled,
  onReviewJobCompleted,
  parseReviewResult,
} from "@/lib/review/jobs";
import { isLearnRuleJob, onLearnRuleJobCompleted, parseLearnRuleResult } from "@/lib/rules/learn";

/**
 * Stores a job's result. Only the job's current agent may submit it: an agent
 * whose delivery was taken over by another one gets 409.
 *
 * A review job's result must be a `ReviewJobResult`; the review and its
 * findings are persisted and posted to the PR/MR. The agent that completed a
 * review job may submit its result again (e.g. after a timeout): that gets
 * `completed` and finishes persisting/posting if needed, never a second post.
 *
 * A `review.learn-rule` job's result must be a `LearnRuleJobResult` (its token
 * usage stays in the job's result); its rule is deduped and stored as a
 * learned rule. A replayed result stores nothing new.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobResult.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const job = await getJob(db, jobId);
  if (!job) return notFound();
  const review = isReviewJob(job);
  if (review && !parseReviewResult(body.data.result)) return badRequest();
  const learnRule = !review && isLearnRuleJob(job);
  if (learnRule && !parseLearnRuleResult(body.data.result)) return badRequest();

  const outcome = await completeJob(db, {
    jobId,
    agentId: principal.agentId,
    result: body.data.result,
  });
  switch (outcome.status) {
    case "not_found":
      return notFound();
    case "conflict": {
      const current = review || learnRule ? await getJob(db, jobId) : null;
      if (current?.status === "completed" && current.agentId === principal.agentId) {
        if (review) await onReviewJobCompleted(db, current);
        else await onLearnRuleJobCompleted(db, current);
        return Response.json({ status: "completed" } satisfies JobOutcomeResponse);
      }
      return notCurrentAgent();
    }
    case "completed":
    case "canceled": {
      await writeAgentAudit(db, {
        agentId: principal.agentId,
        event: "result_submitted",
        ip: clientIp(req),
        detail: { jobId, status: outcome.status },
      });
      if (review) {
        const finished = (await getJob(db, jobId))!;
        if (outcome.status === "completed") await onReviewJobCompleted(db, finished);
        else await onReviewJobCanceled(db, finished);
      } else if (learnRule && outcome.status === "completed") {
        await onLearnRuleJobCompleted(db, (await getJob(db, jobId))!);
      }
      return Response.json({ status: outcome.status } satisfies JobOutcomeResponse);
    }
    default:
      throw new Error(`Unexpected result outcome ${outcome.status}`);
  }
}
