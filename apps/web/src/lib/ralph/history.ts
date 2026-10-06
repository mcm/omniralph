/**
 * Maps ralph runs from the database to the Ralph runs pages' view props
 * (`./display`): ISO dates, PR/MR labels.
 */
import type { RalphRunDetail, RalphRunListEntry, ScmProvider } from "@omniralph/db";
import type { RalphPullRequest, RalphRunDetailView, RalphRunRow } from "./display";

function pullRequest(
  provider: ScmProvider,
  number: number | null,
  url: string | null,
): RalphPullRequest | null {
  if (number === null || !url) return null;
  return { number, url, label: `${provider === "gitlab" ? "!" : "#"}${number}` };
}

export function ralphRunRow(entry: RalphRunListEntry): RalphRunRow {
  return {
    id: entry.id,
    linearIdentifier: entry.linearIdentifier,
    linearTitle: entry.linearTitle,
    linearUrl: entry.linearUrl,
    repository: entry.repository,
    status: entry.status,
    stories: entry.stories,
    branch: entry.branch,
    pullRequest: pullRequest(entry.repository.provider, entry.prNumber, entry.prUrl),
    agent: entry.agent,
    error: entry.error,
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export function ralphRunDetailView(detail: RalphRunDetail): RalphRunDetailView {
  const { run, repository } = detail;
  const ref = ({ identifier, title }: { identifier: string; title: string }) => ({
    identifier,
    title,
  });
  return {
    id: run.id,
    linearIdentifier: run.linearIdentifier,
    linearTitle: run.linearTitle,
    linearUrl: run.linearUrl,
    kind: run.kind,
    repository,
    status: run.status,
    branch: run.branch,
    baseBranch: run.baseBranch,
    pullRequest: pullRequest(repository.provider, run.prNumber, run.prUrl),
    agent: detail.agent,
    error: run.error,
    waitingOn:
      run.status === "waiting" && run.waitingOn
        ? { blockers: run.waitingOn.blockers.map(ref), manual: run.waitingOn.manual.map(ref) }
        : null,
    guidance: run.guidance.map(({ text, at }) => ({ text, at })),
    progress: run.progress,
    iterations: run.iterations,
    storyCounts: {
      total: detail.stories.length,
      completed: detail.stories.filter((s) => s.status === "completed").length,
    },
    stories: detail.stories.map((story) => ({
      id: story.id,
      identifier: story.identifier,
      title: story.title,
      status: story.status,
      attempts: story.attempts,
      lastFeedback: story.lastFeedback,
      commitSha: story.commitSha,
      lastJobId: story.lastJobId,
    })),
    jobs: detail.jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      cancelRequested: job.cancelRequested,
      deliveryCount: job.deliveryCount,
      error: job.error,
      agent: job.agent,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    })),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}
