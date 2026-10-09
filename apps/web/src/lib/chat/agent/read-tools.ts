import "server-only";
import {
  ACTIVE_RALPH_RUN_STATUSES,
  getDesiredAgentVersion,
  getReviewDetail,
  getRunDetail,
  jobStatus,
  listAgentOverview,
  listRecentJobs,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  listReviews,
  listRuns,
  type Database,
  type RepositoryOverview,
} from "@omniralph/db";
import { z } from "zod";
import { agentRow, jobRow } from "@/lib/agents/rows";
import { RALPH_RUN_STATUSES, jobHref, ralphRunListHref, truncate } from "@/lib/ralph/display";
import { ralphRunDetailView, ralphRunRow } from "@/lib/ralph/history";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { REVIEW_STATUSES } from "@/lib/reviews/display";
import { reviewDetailView, reviewRow } from "@/lib/reviews/history";
import { defineChatTool, type ChatToolContext, type ChatToolRegistry } from "./tools";

/**
 * `read` tools: the organization's ralph runs, reviews, jobs, agents and
 * repositories, as shown in the control panel. Every query takes the
 * context's organization (the connection's), never one from the model, and
 * every item carries its control-panel `url` so the agent can link it.
 */

/** Most items a tool returns; results say when more exist. */
export const CHAT_TOOL_RESULT_LIMIT = 20;

/** Longest tail of a run's progress log a tool returns. */
export const CHAT_TOOL_PROGRESS_CHARS = 2_000;

const UUID = z.uuid();

/** A list's paging summary: how many matched, and where to see the rest when they don't all fit. */
function listInfo(shown: number, total: number | null, more: boolean, listUrl: string) {
  return {
    shown,
    ...(total === null ? {} : { total }),
    more,
    ...(more
      ? {
          note: `Only the first ${shown} are listed${total === null ? "" : ` of ${total}`}; the rest are on ${listUrl}`,
        }
      : {}),
  };
}

const UNKNOWN_REPOSITORY = {
  error: "unknown_repository",
  message:
    "No connected repository of this organization matches. Use list_repositories to see their names.",
} as const;

/** One of the organization's connected repositories, by id or full path (case-insensitive). */
async function findRepository(
  db: Database,
  organizationId: string,
  ref: string,
): Promise<RepositoryOverview | null> {
  const wanted = ref
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const repositories = await listRepositoryOverview(db, organizationId);
  return repositories.find((r) => r.id === wanted || r.fullPath.toLowerCase() === wanted) ?? null;
}

const repositoryInput = z
  .string()
  .min(1)
  .max(300)
  .nullish()
  .describe("Repository full path (e.g. `acme/api`) or id.");

export const listRalphRunsTool = defineChatTool({
  tier: "read",
  description: `Lists the organization's ralph runs (Linear issues ralph works on), newest first, at most ${CHAT_TOOL_RESULT_LIMIT}. Filter by status (\`active\` = pending, running or waiting) and repository.`,
  inputSchema: z.object({
    status: z.enum(["active", ...RALPH_RUN_STATUSES]).nullish(),
    repository: repositoryInput,
  }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    let repositoryId: string | undefined;
    if (input.repository) {
      const repository = await findRepository(db, organizationId, input.repository);
      if (!repository) return UNKNOWN_REPOSITORY;
      repositoryId = repository.id;
    }
    const status =
      input.status === "active" ? ACTIVE_RALPH_RUN_STATUSES : (input.status ?? undefined);
    const page = await listRuns(db, organizationId, {
      status,
      repositoryId,
      pageSize: CHAT_TOOL_RESULT_LIMIT,
    });
    const listUrl = `${appUrl}${ralphRunListHref("/ralph", {
      status: typeof status === "string" ? status : null,
      repositoryId: repositoryId ?? null,
      page: 1,
    })}`;
    return {
      runs: page.runs.map((entry) => {
        const run = ralphRunRow(entry);
        return {
          id: run.id,
          url: `${appUrl}/ralph/${run.id}`,
          linearIssue: run.linearIdentifier,
          title: run.linearTitle,
          linearUrl: run.linearUrl,
          status: run.status,
          repository: run.repository?.fullPath ?? null,
          stories: run.stories,
          branch: run.branch,
          pullRequest: run.pullRequest,
          agent: run.agent?.name ?? null,
          error: run.error,
          updatedAt: run.updatedAt,
        };
      }),
      ...listInfo(page.runs.length, page.total, page.total > page.runs.length, listUrl),
    };
  },
});

export const getRalphRunTool = defineChatTool({
  tier: "read",
  description:
    "One ralph run by its id or its Linear issue identifier (e.g. `ENG-42`; the latest run of that issue): status, stories and their progress, the progress log's latest entries and PR/MR links.",
  inputSchema: z.object({
    run: z.string().min(1).max(100).describe("Run id or Linear issue identifier."),
  }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    const ref = input.run.trim();
    let runId: string | undefined = UUID.safeParse(ref).success ? ref.toLowerCase() : undefined;
    if (!runId) {
      const page = await listRuns(db, organizationId, {
        linearIdentifier: ref.toUpperCase(),
        pageSize: 1,
      });
      runId = page.runs[0]?.id;
    }
    const detail = runId ? await getRunDetail(db, organizationId, runId) : null;
    if (!detail) {
      return { error: "not_found", message: `No ralph run of this organization matches "${ref}".` };
    }
    const run = ralphRunDetailView(detail);
    return {
      id: run.id,
      url: `${appUrl}/ralph/${run.id}`,
      linearIssue: run.linearIdentifier,
      title: run.linearTitle,
      linearUrl: run.linearUrl,
      kind: run.kind,
      status: run.status,
      error: run.error,
      repository: run.repository?.fullPath ?? null,
      agent: run.agent?.name ?? null,
      branch: run.branch,
      pullRequest: run.pullRequest,
      lanes: run.lanes.map((lane) => ({
        repository: lane.repository.fullPath,
        main: lane.main,
        branch: lane.branch,
        pullRequest: lane.pullRequest,
        cleanup: lane.cleanup,
      })),
      waitingOn: run.waitingOn,
      storyCounts: run.storyCounts,
      stories: run.stories.slice(0, CHAT_TOOL_RESULT_LIMIT).map((story) => ({
        identifier: story.identifier,
        title: story.title,
        status: story.status,
        attempts: story.attempts,
      })),
      ...(run.stories.length > CHAT_TOOL_RESULT_LIMIT
        ? {
            storiesNote: `Only the first ${CHAT_TOOL_RESULT_LIMIT} of ${run.stories.length} stories are listed; all are on the run's page.`,
          }
        : {}),
      progress:
        run.progress.length > CHAT_TOOL_PROGRESS_CHARS
          ? `…${run.progress.slice(-CHAT_TOOL_PROGRESS_CHARS)}`
          : run.progress,
      iterations: run.iterations,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  },
});

export const listReviewsTool = defineChatTool({
  tier: "read",
  description: `Lists the organization's code reviews of PRs/MRs, newest first, at most ${CHAT_TOOL_RESULT_LIMIT}. Filter by repository, PR/MR number and status.`,
  inputSchema: z.object({
    repository: repositoryInput,
    prNumber: z.number().int().positive().nullish().describe("PR/MR number."),
    status: z.enum(REVIEW_STATUSES).nullish(),
  }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    let repositoryId: string | undefined;
    if (input.repository) {
      const repository = await findRepository(db, organizationId, input.repository);
      if (!repository) return UNKNOWN_REPOSITORY;
      repositoryId = repository.id;
    }
    const page = await listReviews(db, {
      organizationId,
      repositoryId,
      prNumber: input.prNumber ?? undefined,
      status: input.status ?? undefined,
      pageSize: CHAT_TOOL_RESULT_LIMIT,
    });
    const listUrl = repositoryId
      ? `${appUrl}/repositories/${repositoryId}/reviews`
      : `${appUrl}/reviews`;
    return {
      reviews: page.reviews.map((entry) => {
        const review = reviewRow(entry);
        return {
          id: review.id,
          url: `${appUrl}/reviews/${review.id}`,
          repository: review.repository.fullPath,
          prNumber: review.prNumber,
          prTitle: review.prTitle,
          prUrl: review.prUrl,
          trigger: review.trigger,
          status: review.status,
          profile: review.profileName,
          agent: review.agent?.name ?? null,
          findingCounts: review.findingCounts,
          error: review.error,
          createdAt: review.createdAt,
        };
      }),
      ...listInfo(page.reviews.length, page.total, page.total > page.reviews.length, listUrl),
    };
  },
});

export const getReviewTool = defineChatTool({
  tier: "read",
  description: `One code review by id: its PR/MR, status, why it stopped and its findings (at most ${CHAT_TOOL_RESULT_LIMIT}).`,
  inputSchema: z.object({ review: z.string().min(1).max(100).describe("Review id.") }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    const id = input.review.trim().toLowerCase();
    const detail = UUID.safeParse(id).success
      ? await getReviewDetail(db, organizationId, id)
      : null;
    if (!detail) {
      return { error: "not_found", message: `No review of this organization has the id "${id}".` };
    }
    const review = reviewDetailView(detail);
    const findings = review.files.flatMap((file) =>
      file.findings.map((finding) => ({
        path: file.path,
        lines:
          finding.startLine === finding.endLine
            ? `${finding.startLine}`
            : `${finding.startLine}-${finding.endLine}`,
        severity: finding.severity,
        category: finding.category,
        title: finding.title,
        status: finding.status,
      })),
    );
    return {
      id: review.id,
      url: `${appUrl}/reviews/${review.id}`,
      repository: review.repository.fullPath,
      prNumber: review.prNumber,
      prTitle: review.prTitle,
      prUrl: review.prUrl,
      trigger: review.trigger,
      status: review.status,
      stopReason: review.stopReason,
      error: review.error,
      profile: review.profileName,
      model: review.model,
      agent: review.agent?.name ?? null,
      durationMs: review.durationMs,
      findingCount: review.findingCount,
      findings: findings.slice(0, CHAT_TOOL_RESULT_LIMIT),
      ...(findings.length > CHAT_TOOL_RESULT_LIMIT
        ? {
            findingsNote: `Only the first ${CHAT_TOOL_RESULT_LIMIT} of ${findings.length} findings are listed; all are on the review's page.`,
          }
        : {}),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    };
  },
});

export const listJobsTool = defineChatTool({
  tier: "read",
  description: `Lists the organization's agent jobs, newest first, at most ${CHAT_TOOL_RESULT_LIMIT}. Filter by status and type (e.g. \`review.run\`, \`ralph.story\`, \`ralph.prepare\`, \`repo.sync\`).`,
  inputSchema: z.object({
    status: z.enum(jobStatus.enumValues).nullish(),
    type: z.string().min(1).max(100).nullish(),
  }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    // One more than shown, to know whether more exist.
    const jobs = await listRecentJobs(db, organizationId, {
      statuses: input.status ? [input.status] : undefined,
      types: input.type ? [input.type.trim()] : undefined,
      limit: CHAT_TOOL_RESULT_LIMIT + 1,
    });
    const shown = jobs.slice(0, CHAT_TOOL_RESULT_LIMIT);
    const listUrl = `${appUrl}/jobs${input.status ? `?status=${input.status}` : ""}`;
    return {
      jobs: shown.map((entry) => {
        const job = jobRow(entry);
        return {
          id: job.id,
          url: `${appUrl}${jobHref(job.id)}`,
          type: job.type,
          capability: job.capability,
          status: job.status,
          target: job.target,
          agent: job.agent?.name ?? null,
          deliveryCount: job.deliveryCount,
          cancelRequested: job.cancelRequested,
          error: job.error && truncate(job.error, 500),
          createdAt: job.createdAt,
          finishedAt: job.finishedAt,
        };
      }),
      ...listInfo(shown.length, null, jobs.length > shown.length, listUrl),
    };
  },
});

export const listAgentsTool = defineChatTool({
  tier: "read",
  description: `Lists the organization's agents (the hosts that run review and ralph jobs), at most ${CHAT_TOOL_RESULT_LIMIT}: online status, version, capabilities, last heartbeat and running jobs.`,
  inputSchema: z.object({}),
  async execute(_input, { db, organizationId, appUrl }: ChatToolContext) {
    const now = new Date();
    const [agents, desiredVersion] = await Promise.all([
      listAgentOverview(db, organizationId),
      getDesiredAgentVersion(db, organizationId),
    ]);
    const shown = agents.slice(0, CHAT_TOOL_RESULT_LIMIT);
    return {
      agents: shown.map((overview) => {
        const agent = agentRow(overview, now, desiredVersion);
        return {
          id: agent.id,
          url: `${appUrl}/agents/${agent.id}`,
          name: agent.name,
          status: agent.revoked ? "revoked" : agent.online ? "online" : "offline",
          version: agent.version,
          desiredVersion: agent.desiredVersion,
          updateStatus: agent.updateStatus,
          enabledCapabilities: agent.enabledCapabilities,
          reportedCapabilities: agent.reportedCapabilities,
          maxConcurrency: agent.maxConcurrency,
          lastHeartbeatAt: agent.lastHeartbeatAt,
          runningJobs: agent.runningJobs.map((job) => ({
            type: job.type,
            target: job.target?.label ?? null,
            url: `${appUrl}${jobHref(job.id)}`,
          })),
          pinnedRepositories: agent.pinnedRepositories.map((r) => r.fullPath),
        };
      }),
      ...listInfo(shown.length, agents.length, agents.length > shown.length, `${appUrl}/agents`),
    };
  },
});

export const listRepositoriesTool = defineChatTool({
  tier: "read",
  description: `Lists the organization's connected repositories by path, at most ${CHAT_TOOL_RESULT_LIMIT}: whether reviews and ralph are enabled, the review profile, pinned agents and the latest review.`,
  inputSchema: z.object({}),
  async execute(_input, { db, organizationId, appUrl }: ChatToolContext) {
    const page = await listRepositoryOverviewPage(db, organizationId, {
      pageSize: CHAT_TOOL_RESULT_LIMIT,
    });
    return {
      repositories: page.repositories.map((repo) => ({
        id: repo.id,
        url: `${appUrl}/repositories/${repo.id}/settings`,
        fullPath: repo.fullPath,
        provider: repo.provider,
        webUrl: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
        reviewsEnabled: repo.enabled,
        ralphEnabled: repo.ralphEnabled,
        reviewProfile: repo.profileName,
        pinnedAgents: repo.pinnedAgents.map((a) => a.name),
        lastReviewAt: repo.lastReviewAt?.toISOString() ?? null,
      })),
      ...listInfo(
        page.repositories.length,
        page.total,
        page.total > page.repositories.length,
        `${appUrl}/repositories`,
      ),
    };
  },
});

export const readTools: ChatToolRegistry = {
  list_ralph_runs: listRalphRunsTool,
  get_ralph_run: getRalphRunTool,
  list_reviews: listReviewsTool,
  get_review: getReviewTool,
  list_jobs: listJobsTool,
  list_agents: listAgentsTool,
  list_repositories: listRepositoriesTool,
};
