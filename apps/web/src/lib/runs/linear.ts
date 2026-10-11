/**
 * The read-only Linear tools of a run, served under
 * `/api/harness/runs/{id}/linear/*` with the run's organization's Linear
 * workspace (see `@omniralph/shared` `run-linear.ts`).
 */
import "server-only";
import { InvalidInputLinearError } from "@linear/sdk";
import { getJobForHarness, type Job } from "@omniralph/db";
import type { RunLinearComment, RunLinearDocument, RunLinearIssue } from "@omniralph/shared";
import type { LinearTool } from "@omniralph/tasks";
import { requireJob } from "@/lib/harness-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import type {
  IssueComment,
  IssueSummary,
  LinearDocument,
  LinearGateway,
} from "@/lib/linear/gateway";
import { BUILTIN_DEFINITIONS, type DefinitionSource } from "./resolve";

/**
 * The Linear tools a job's run may call: those its task's agent lists, when
 * the task turns on `toolSettings.linearRead`. None for a legacy job or an
 * unknown task.
 */
export function runLinearTools(
  job: Pick<Job, "taskId">,
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): LinearTool[] {
  if (job.taskId === null) return [];
  const task = definitions.getTask(job.taskId);
  if (!task?.toolSettings.linearRead) return [];
  return definitions.getAgent(task.agentId)?.tools.linear ?? [];
}

export function runLinearIssue(issue: IssueSummary): RunLinearIssue {
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

export function runLinearComment(comment: IssueComment): RunLinearComment {
  return {
    body: comment.body,
    ...(comment.author && { author: comment.author }),
    ...(comment.createdAt && { createdAt: comment.createdAt }),
  };
}

export function runLinearDocument(document: LinearDocument): RunLinearDocument {
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
 * Serves one Linear tool call of a run: authenticates the run's token
 * (`linear:read`, so the session token), checks the job runs on the calling
 * harness and its task may use `tool` (`runLinearTools`, else 403
 * `linear_tool_not_allowed`), then answers `read`'s result as JSON, read with
 * the gateway of the job's organization. 503 `linear_not_connected` when the
 * organization has no Linear workspace, 404 `linear_not_found` when Linear
 * rejects the ID, 502 `linear_failed` for any other Linear error.
 */
export async function serveRunLinearTool(
  req: Request,
  ctx: JobRouteContext,
  tool: LinearTool,
  read: (linear: LinearGateway) => Promise<unknown>,
): Promise<Response> {
  const principal = await requireJob(req, "linear:read");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return Response.json({ error: "job_mismatch" }, { status: 403 });
  const db = getDb();
  const job = await getJobForHarness(db, jobId, principal.harnessId);
  if (!job) return notFound();
  if (!runLinearTools(job).includes(tool)) {
    return Response.json({ error: "linear_tool_not_allowed" }, { status: 403 });
  }

  try {
    const linear = await getLinearGateway({ db, organizationId: job.organizationId });
    return Response.json(await read(linear), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof LinearNotConnectedError) {
      return failed(
        503,
        "linear_not_connected",
        "the run's organization has no Linear workspace connected",
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof InvalidInputLinearError) return failed(404, "linear_not_found", reason);
    console.error(`Linear tool ${tool} failed`, error);
    return failed(502, "linear_failed", reason);
  }
}
