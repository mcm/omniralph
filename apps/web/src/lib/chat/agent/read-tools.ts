import "server-only";
import {
  ACTIVE_RALPH_RUN_STATUSES,
  appendChatMessage,
  getDesiredHarnessVersion,
  getReviewDetail,
  getRunDetail,
  jobStatus,
  listHarnessOverview,
  listRecentJobs,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  listReviews,
  listRuns,
  type Database,
  type RepositoryOverview,
} from "@omniralph/db";
import { CHAT_ASK_MIN_AGENT_VERSION, MAX_CHAT_ASK_QUESTION_LENGTH } from "@omniralph/shared";
import { z } from "zod";
import { harnessRow, jobRow } from "@/lib/harnesses/rows";
import { RALPH_RUN_STATUSES, jobHref, ralphRunListHref, truncate } from "@/lib/ralph/display";
import {
  lastRunActivity,
  pendingGuidanceCount,
  ralphRunDetailView,
  ralphRunRow,
} from "@/lib/ralph/history";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { REVIEW_STATUSES } from "@/lib/reviews/display";
import { reviewDetailView, reviewRow } from "@/lib/reviews/history";
import { enqueueChatAsk, type ChatAskAttachment } from "../ask";
import { attachmentName } from "../attachments";
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

export const UNKNOWN_REPOSITORY = {
  error: "unknown_repository",
  message:
    "No connected repository of this organization matches. Use list_repositories to see their names.",
} as const;

/** One of the organization's connected repositories, by id or full path (case-insensitive). */
export async function findRepository(
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

/**
 * The ID of the organization's run `ref` names: a run id, or a Linear issue
 * identifier (its latest run). Null when none matches.
 */
export async function findRalphRunId(
  db: Database,
  organizationId: string,
  ref: string,
): Promise<string | null> {
  if (UUID.safeParse(ref).success) return ref.toLowerCase();
  const page = await listRuns(db, organizationId, {
    linearIdentifier: ref.toUpperCase(),
    pageSize: 1,
  });
  return page.runs[0]?.id ?? null;
}

export const getRalphRunTool = defineChatTool({
  tier: "read",
  description:
    "One ralph run by its id or its Linear issue identifier (e.g. `ENG-42`; the latest run of that issue): status, the story being worked on, stories and their progress, how many messages (guidance, requests) it hasn't taken in yet, when it last did something, the progress log's latest entries and PR/MR links.",
  inputSchema: z.object({
    run: z.string().min(1).max(100).describe("Run id or Linear issue identifier."),
  }),
  async execute(input, { db, organizationId, appUrl }: ChatToolContext) {
    const ref = input.run.trim();
    const runId = await findRalphRunId(db, organizationId, ref);
    const detail = runId ? await getRunDetail(db, organizationId, runId) : null;
    if (!detail) {
      return { error: "not_found", message: `No ralph run of this organization matches "${ref}".` };
    }
    const run = ralphRunDetailView(detail);
    const currentStory = run.stories.find((story) => story.status === "running") ?? null;
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
      currentStory: currentStory && {
        identifier: currentStory.identifier,
        title: currentStory.title,
        attempts: currentStory.attempts,
      },
      pendingGuidance: pendingGuidanceCount(detail),
      lastActivityAt: lastRunActivity(detail),
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
      listHarnessOverview(db, organizationId),
      getDesiredHarnessVersion(db, organizationId),
    ]);
    const shown = agents.slice(0, CHAT_TOOL_RESULT_LIMIT);
    return {
      agents: shown.map((overview) => {
        const agent = harnessRow(overview, now, desiredVersion);
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
        pinnedHarnesses: repo.pinnedHarnesses.map((a) => a.name),
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

/** The message posted when a code question is handed to an agent. */
export function lookingIntoMessage(fullPath: string): string {
  return `Looking into \`${fullPath}\`…`;
}

/** Most attached files a code question includes. */
const MAX_CHAT_ASK_ATTACHMENTS = 5;

/** The thread's attachments with these refs, loaded for a code question (an error result for an unknown ref). */
async function chatAskAttachments(
  context: ChatToolContext,
  refs: readonly string[],
): Promise<{ files: ChatAskAttachment[] } | { error: "unknown_attachment"; message: string }> {
  const known = [...(context.attachments?.values() ?? [])];
  const files: ChatAskAttachment[] = [];
  for (const ref of new Set(refs.map((r) => r.trim()))) {
    const attachment = context.attachments?.get(ref);
    if (!attachment) {
      return {
        error: "unknown_attachment",
        message:
          known.length > 0
            ? `"${ref}" isn't a file attached in this thread. The thread's attachments: ${known.map((a) => `${a.ref} (${attachmentName(a.meta)})`).join(", ")}.`
            : "No files are attached in this thread: ask without attachments.",
      };
    }
    const name = attachmentName(attachment.meta);
    const content = await attachment.load();
    if (content.status === "skipped") files.push({ kind: "skipped", name, reason: content.reason });
    else if (content.kind === "text") files.push({ kind: "text", name, text: content.text });
    else files.push({ kind: "image", name });
  }
  return { files };
}

export const askAboutCodeTool = defineChatTool({
  tier: "read",
  description:
    "Asks a question about the code of one of the organization's connected repositories (any, not only ralph-enabled ones). An agent answers it from a read-only checkout of the default branch; the answer is posted in this thread a little later, so the tool only posts that it is looking into it. A follow-up's context includes the thread's previous code question and its answer.",
  inputSchema: z.object({
    repository: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "Full path of a connected repository of the organization, e.g. `acme/api`, or its id.",
      ),
    question: z
      .string()
      .min(1)
      .max(MAX_CHAT_ASK_QUESTION_LENGTH)
      .describe(
        "The self-contained question about the code, with every detail from the conversation the agent needs (it only sees the latest messages and the previous code question).",
      ),
    attachments: z
      .array(z.string().min(1).max(40))
      .max(MAX_CHAT_ASK_ATTACHMENTS)
      .optional()
      .describe(
        "Refs of files attached in the thread (`[attachment <ref>: …]`) the question is about, e.g. a pasted log or a screenshot. The agent gets text files' content; it can't see images, so describe what a screenshot shows in the question.",
      ),
  }),
  async execute(input, context: ChatToolContext) {
    const { db, organizationId, chatThread, thread, appUrl } = context;
    const attachments = await chatAskAttachments(context, input.attachments ?? []);
    if ("error" in attachments) return attachments;
    const repository = await findRepository(db, organizationId, input.repository);
    if (!repository) return UNKNOWN_REPOSITORY;
    const { dispatcher, adapterFor } = await context.ralph();
    const outcome = await enqueueChatAsk(
      { db, dispatcher, adapterFor },
      {
        organizationId,
        repositoryId: repository.id,
        chatThreadId: chatThread.id,
        question: input.question,
        messages: context.turnMessages,
        attachments: attachments.files,
      },
    );
    switch (outcome.status) {
      case "unknown_repository":
        return UNKNOWN_REPOSITORY;
      case "no_capable_agent":
        return {
          error: "no_capable_agent",
          message:
            outcome.agents.length === 0
              ? `No agent of the organization that would take this question is online, so nobody can answer it now. Nothing was queued. An admin can check the agents on ${appUrl}/agents.`
              : `None of the online agents that would take this question can answer code questions: that needs the review capability on agent version ${CHAT_ASK_MIN_AGENT_VERSION} or later. Nothing was queued. An admin can update the agents on ${appUrl}/agents.`,
          agents: outcome.agents,
        };
      case "failed":
        return { error: "failed", message: outcome.error };
      case "duplicate":
        return {
          status: "already_asked",
          message:
            "This question is already being looked into in this thread; its answer will be posted here. Don't ask it again.",
        };
      case "enqueued": {
        const text = sanitizeCapped(
          lookingIntoMessage(outcome.repository.fullPath),
          { allowedHosts: [new URL(appUrl).host] },
          MAX_BODY_CHARS,
        );
        await thread.post({ markdown: text });
        await appendChatMessage(db, { threadId: chatThread.id, role: "assistant", content: text });
        context.handedOff();
        return {
          status: "asked",
          message:
            "The question was handed to an agent and the thread was told; the answer will be posted here. End your turn without repeating it.",
        };
      }
    }
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
  ask_about_code: askAboutCodeTool,
};
