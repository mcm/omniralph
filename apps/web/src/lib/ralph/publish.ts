/**
 * The PR/MR of a ralph run (ported from cyralph's `syncPullRequest` and
 * `describePullRequest`). The control panel opens and updates it through the
 * SCM adapter; agents never hold code-host API tokens. When every story is
 * done, a `ralph.describe-pr` job writes the title and body; its outcome
 * (applied by `advanceRun` under the run's row lock) opens the PR/MR as a
 * draft or updates the open one, marks it ready and finishes the run. With
 * `openPullRequestEarly`, a draft with a templated body is opened as soon as
 * the first story is pushed.
 */
import {
  getJob,
  getRepository,
  getRepositoryWithConnection,
  listStories,
  updateRun,
  type Job,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { Epic } from "@omniralph/ralph";
import type { RepoRef, ScmAdapter } from "@omniralph/scm";
import {
  epicCompletedTarget,
  parseRalphSettings,
  RalphDescribePrPayload,
  RalphDescribePrResult,
} from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { errorMessage, postActivity, quietly, tail } from "./notify";
import { jobFailure } from "./outcome";
import { planFor } from "./plan";
import { sanitizePullRequestText, type PullRequestText } from "./pull-request";
import type { RalphDeps } from "./run";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

type Provider = Repository["provider"];

/** "pull request" (GitHub) or "merge request" (GitLab). */
export function changeRequestTerm(provider: Provider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** The label of a PR/MR link in the agent session. */
export function changeRequestLabel(provider: Provider, number: number): string {
  return provider === "gitlab" ? `Merge request !${number}` : `Pull request #${number}`;
}

/** The Linear epic a PR/MR links back to. */
export interface LinearLink {
  identifier: string;
  title: string;
  url?: string | null;
}

/**
 * Appended to every PR/MR body after sanitizing (so the Linear link, which
 * isn't on the code host, stays a link). Readers of a public repository may
 * not be able to open it, so it's only a footnote.
 */
export function pullRequestFooter(epic: LinearLink): string {
  const linear = epic.url ? `[${epic.identifier}](${epic.url})` : epic.identifier;
  return ["---", `Linear: ${linear} · _Opened by Omniralph._`].join("\n");
}

/** The title and body of an early (draft) PR/MR, before the describe job rewrites them. */
export function templatedPullRequest(
  epic: LinearLink,
  stories: readonly Pick<RalphStory, "identifier" | "title" | "status">[],
  provider: Provider,
): PullRequestText {
  const done = (s: (typeof stories)[number]) => s.status === "completed" || s.status === "canceled";
  return {
    title: epic.title,
    body: [
      `Implements **${epic.title}**, story by story. This ${changeRequestTerm(provider)} stays a draft ` +
        "until every story is done; its description is rewritten then.",
      "",
      "**Stories**",
      "",
      ...stories.map((s) => `- [${done(s) ? "x" : " "}] ${s.identifier}: ${s.title}`),
    ].join("\n"),
  };
}

interface RunRepository {
  adapter: ScmAdapter;
  repo: RepoRef;
  repository: Repository;
  connection: ScmConnection;
}

async function runRepository(deps: RalphDeps, run: RalphRun): Promise<RunRepository> {
  const found = run.repositoryId
    ? await getRepositoryWithConnection(deps.db, run.repositoryId)
    : null;
  if (!found || found.repository.disconnectedAt) {
    throw new Error("the run's repository is no longer connected");
  }
  return {
    adapter: deps.adapterFor(deps.db, found.connection),
    repo: { fullPath: found.repository.fullPath, externalId: found.repository.externalId },
    repository: found.repository,
    connection: found.connection,
  };
}

/** Agent- or Linear-written text, sanitized for the code host, with the Linear footer. */
async function postableText(
  target: RunRepository,
  text: PullRequestText,
  epic: LinearLink,
): Promise<PullRequestText> {
  const { adapter, repo, repository, connection } = target;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const clean = await sanitizePullRequestText(text, {
    allowedHosts: [new URL(webUrl).hostname],
    isRepositoryUser: (username) => adapter.hasWriteAccess(repo, username),
  });
  return { title: clean.title, body: `${clean.body.trim()}\n\n${pullRequestFooter(epic)}` };
}

export interface PublishedPullRequest {
  number: number;
  url: string;
  /** Opened now, rather than an open one updated. */
  created: boolean;
}

/**
 * Opens the run's PR/MR as a draft or, when one is open for the branch,
 * updates its title and body (never a second one); then marks it ready.
 */
export async function publishPullRequest(
  deps: RalphDeps,
  run: RalphRun,
  text: PullRequestText,
  epic: LinearLink,
): Promise<PublishedPullRequest> {
  const target = await runRepository(deps, run);
  const { adapter, repo } = target;
  const { title, body } = await postableText(target, text, epic);
  let pr: PublishedPullRequest;
  const open = await adapter.findOpenChangeRequest(repo, run.branch);
  if (open) {
    await adapter.updateChangeRequest(repo, open.number, { title, body });
    pr = { number: open.number, url: open.url, created: false };
  } else {
    const opened = await adapter.createChangeRequest(repo, {
      sourceBranch: run.branch,
      targetBranch: run.baseBranch,
      title,
      body,
      draft: true,
    });
    // Opened by someone else meanwhile: it gets this text all the same.
    if (!opened.created) await adapter.updateChangeRequest(repo, opened.number, { title, body });
    pr = opened;
  }
  await adapter.markChangeRequestReady(repo, pr.number);
  return pr;
}

/**
 * `openPullRequestEarly`: once a story is pushed, opens a draft PR/MR with a
 * templated body (or adopts the one open for the branch, as it is). Runs
 * without the setting, with a PR/MR already, without a pushed story or with
 * every story done (the describe job opens it then) are left alone. A failure
 * is reported as a thought: the next story's outcome tries again.
 */
export async function openEarlyPullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; rows: readonly RalphStory[] },
): Promise<RalphRun> {
  if (run.prNumber !== null || !input.rows.some((r) => r.status === "completed" && r.commitSha)) {
    return run;
  }
  if (!run.repositoryId) return run;
  const found = await getRepositoryWithConnection(deps.db, run.repositoryId);
  if (!found?.repository.ralphSettings.openPullRequestEarly) return run;
  const provider = found.repository.provider;
  const term = changeRequestTerm(provider);
  const epic = { identifier: input.epic.identifier, title: input.epic.title, url: input.epic.url };
  let pr: PublishedPullRequest;
  try {
    const target = await runRepository(deps, run);
    const open = await target.adapter.findOpenChangeRequest(target.repo, run.branch);
    if (open) pr = { number: open.number, url: open.url, created: false };
    else {
      const text = await postableText(
        target,
        templatedPullRequest(epic, input.rows, provider),
        epic,
      );
      pr = await target.adapter.createChangeRequest(target.repo, {
        sourceBranch: run.branch,
        targetBranch: run.baseBranch,
        ...text,
        draft: true,
      });
    }
  } catch (error) {
    await postActivity(deps.linear, run.linearAgentSessionId, {
      type: "thought",
      body: `I couldn't open a draft ${term} yet (I'll try again after the next story): ${tail(errorMessage(error), 1500)}`,
    });
    return run;
  }
  const updated = (await updateRun(tx, run.id, { prNumber: pr.number, prUrl: pr.url })) ?? run;
  await quietly(`Adding the ${term} to session ${run.linearAgentSessionId}`, () =>
    deps.linear.addSessionExternalUrl(
      run.linearAgentSessionId,
      changeRequestLabel(provider, pr.number),
      pr.url,
    ),
  );
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `${pr.created ? "Opened a draft" : "Found the open"} ${term} for \`${run.branch}\`: ${pr.url}`,
  });
  return updated;
}

/**
 * Every story of the epic is complete: the epic moves to the repository's
 * `epicCompletedState` (cyralph's `epicCompletedStateName`/`Type`), a state of
 * that name or else the first state of that type. Runs after the PR/MR step,
 * whether or not it worked; a single issue is left alone. A failure is logged,
 * never fails the run.
 */
export async function moveCompletedEpic(
  deps: Pick<RalphDeps, "db" | "linear">,
  run: Pick<RalphRun, "kind" | "linearIssueId" | "repositoryId">,
): Promise<void> {
  if (run.kind === "single") return;
  await quietly(`Moving epic ${run.linearIssueId} to its completed state`, async () => {
    const repository = run.repositoryId ? await getRepository(deps.db, run.repositoryId) : null;
    const target = epicCompletedTarget(
      repository && parseRalphSettings(repository.ralphSettings).epicCompletedState,
    );
    if (target) await deps.linear.setIssueState(run.linearIssueId, target);
  });
}

/** The PR/MR step failed: the run waits for a reply, which retries it. */
async function pullRequestFailed(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  term: string,
  reason: string,
): Promise<void> {
  const error = `Every story is done, but I couldn't open the ${term}: ${tail(reason, 3000)}`;
  await updateRun(tx, run.id, {
    status: "waiting",
    waitingOn: { blockers: [], manual: [] },
    prJobId: null,
    error,
  });
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "error",
    body: `${error}\n\nReply with guidance (for example \`retry\`) and I'll try the ${term} step again, or say \`stop\`.`,
  });
}

/** The final response: the PR/MR and every story with its commit. */
function finalResponse(
  run: RalphRun,
  epic: LinearLink,
  stories: readonly RalphStory[],
  pr: PublishedPullRequest,
  provider: Provider,
): string {
  const what =
    run.kind === "single"
      ? `**${epic.identifier}**`
      : `all ${stories.length} ${stories.length === 1 ? "story" : "stories"} of **${epic.identifier}**`;
  const link = `[${changeRequestLabel(provider, pr.number)}](${pr.url})`;
  const lines = stories.map((s) => {
    const mark = s.status === "completed" ? "✅" : s.status === "canceled" ? "🚫" : "•";
    return `- ${mark} **${s.identifier}**: ${s.title}${s.commitSha ? ` (\`${s.commitSha.slice(0, 10)}\`)` : ""}`;
  });
  return [
    `Finished ${what} on \`${run.branch}\`. ${pr.created ? "Opened" : "Updated"} ${link}, ready for review.`,
    "",
    ...lines,
  ].join("\n");
}

/**
 * Applies the outcome of the run's `ralph.describe-pr` job, once it has
 * finished (inside the run's row lock): opens or updates the PR/MR with the
 * agent's title and body, marks it ready, stores it on the run, adds it to the
 * agent session and completes the run with a final response. A failed job or
 * PR/MR call leaves the run waiting with an `error` activity. Returns whether
 * the job is still queued or running.
 */
export async function applyPullRequestJob(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<{ busy: boolean }> {
  if (!run.prJobId) return { busy: false };
  const job = await getJob(deps.db, run.prJobId);
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return { busy: true };

  const payload = job ? RalphDescribePrPayload.safeParse(job.payload) : null;
  const provider = payload?.success ? payload.data.repository.provider : "github";
  const term = changeRequestTerm(provider);
  const parsed = job?.status === "completed" ? RalphDescribePrResult.safeParse(job.result) : null;
  if (!parsed?.success || !payload?.success) {
    const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
    await pullRequestFailed(deps, tx, run, term, `writing its description failed: ${why}.`);
    await moveCompletedEpic(deps, run);
    return { busy: false };
  }

  const epic: LinearLink = {
    identifier: payload.data.epic.identifier,
    title: payload.data.epic.title,
    url: payload.data.epic.url,
  };
  let pr: PublishedPullRequest;
  try {
    pr = await publishPullRequest(deps, run, parsed.data, epic);
  } catch (error) {
    await pullRequestFailed(deps, tx, run, term, `${errorMessage(error)}.`);
    await moveCompletedEpic(deps, run);
    return { busy: false };
  }

  const completed =
    (await updateRun(tx, run.id, {
      status: "completed",
      prNumber: pr.number,
      prUrl: pr.url,
      prJobId: null,
      waitingOn: null,
      error: null,
    })) ?? run;
  const stories = await listStories(tx, run.id);
  await quietly(`Posting the plan of session ${run.linearAgentSessionId}`, () =>
    deps.linear.updateSessionPlan(run.linearAgentSessionId, planFor(stories)),
  );
  await quietly(`Adding the ${term} to session ${run.linearAgentSessionId}`, () =>
    deps.linear.addSessionExternalUrl(
      run.linearAgentSessionId,
      changeRequestLabel(provider, pr.number),
      pr.url,
    ),
  );
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "response",
    body: finalResponse(completed, epic, stories, pr, provider),
  });
  await moveCompletedEpic(deps, run);
  return { busy: false };
}
