/**
 * The read-only tracker tools of a run, served under
 * `/api/agent/runs/{id}/tracker/*` with the run's organization's
 * tracker (see `@omniralph/shared` `run-tracker.ts`).
 */
import "server-only";
import {
  TrackerCapabilityError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type IssueComment,
  type IssueSummary,
  type TrackerDocument,
  type TrackerGateway,
} from "@omniralph/tracker";
import { getJobForAgent, type Job } from "@omniralph/db";
import type { RunTrackerComment, RunTrackerDocument, RunTrackerIssue } from "@omniralph/shared";
import type { TrackerTool } from "@omniralph/tasks";
import { requireJob } from "@/lib/agent-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { getTrackerGateway, TrackerNotConnectedError } from "@/lib/tracker/client";
import { organizationPlaybooks, type PlaybookSource } from "@/lib/playbooks";

/**
 * The tracker tools a job's run may call: those its playbook lists, when it
 * turns on `toolSettings.trackerRead`. None for a legacy job or an unknown
 * playbook.
 */
export async function runTrackerTools(
  job: Pick<Job, "taskId">,
  playbooks: PlaybookSource,
): Promise<TrackerTool[]> {
  if (job.taskId === null) return [];
  const playbook = await playbooks.getPlaybook(job.taskId);
  return playbook?.toolSettings.trackerRead ? playbook.tools.tracker : [];
}

export function runTrackerIssue(issue: IssueSummary): RunTrackerIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    team: issue.teamKey,
    state: issue.stateName,
    stateType: issue.stateType,
    priority: issue.priority,
    labels: issue.labels,
    ...(issue.projectName && { project: issue.projectName }),
    ...(issue.parentId && { parentId: issue.parentId }),
    ...(issue.creator && { creator: issue.creator.name }),
  };
}

export function runTrackerComment(comment: IssueComment): RunTrackerComment {
  return {
    body: comment.body,
    ...(comment.author && { author: comment.author }),
    ...(comment.createdAt && { createdAt: comment.createdAt }),
  };
}

export function runTrackerDocument(document: TrackerDocument): RunTrackerDocument {
  return {
    id: document.id,
    title: document.title,
    content: document.content,
    url: document.url,
    updatedAt: document.updatedAt,
    ...(document.projectName && { project: document.projectName }),
    ...(document.issueIdentifier && { issue: document.issueIdentifier }),
  };
}

function failed(status: number, error: string, reason: string): Response {
  return Response.json({ error, message: reason }, { status });
}

/**
 * Serves one tracker tool call of a run: authenticates the run's token
 * (`tracker:read`, so the session token), checks the job runs on the calling
 * agent and its task may use `tool` (`runTrackerTools`, else 403
 * `tracker_tool_not_allowed`), then answers `read`'s result as JSON, read with
 * the gateway of the job's organization. 409 `tracker_not_connected` when the
 * organization has no tracker connected, 404 `tracker_not_found` when the
 * tracker rejects the ID or lacks what the tool reads (e.g. documents), 502
 * `tracker_failed` for any other tracker error.
 */
export async function serveRunTrackerTool(
  req: Request,
  ctx: JobRouteContext,
  tool: TrackerTool,
  read: (tracker: TrackerGateway) => Promise<unknown>,
): Promise<Response> {
  const principal = await requireJob(req, "tracker:read");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return Response.json({ error: "job_mismatch" }, { status: 403 });
  const db = getDb();
  const job = await getJobForAgent(db, jobId, principal.agentId);
  if (!job) return notFound();
  const tools = await runTrackerTools(job, organizationPlaybooks(db, job.organizationId));
  if (!tools.includes(tool)) {
    return Response.json({ error: "tracker_tool_not_allowed" }, { status: 403 });
  }

  try {
    const tracker = await getTrackerGateway({ db, organizationId: job.organizationId });
    return Response.json(await read(tracker), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) {
      return failed(
        409,
        "tracker_not_connected",
        "the run's organization has no tracker connected",
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    // The tool reads what this tracker doesn't have (e.g. documents).
    if (error instanceof TrackerCapabilityError) return failed(404, "tracker_not_found", reason);
    // Linear, for one, answers a read of an unknown issue (its comments, say) with an invalid input error.
    if (error instanceof TrackerNotFoundError || error instanceof TrackerInvalidInputError) {
      return failed(404, "tracker_not_found", reason);
    }
    console.error(`Tracker tool ${tool} failed`, error);
    return failed(502, "tracker_failed", reason);
  }
}
