/**
 * Maps ralph runs from the database to the Ralph runs pages' view props
 * (`./display`): ISO dates, PR/MR labels.
 */
import {
  RUN_DETAIL_MESSAGE_LIMIT,
  type RalphRunChatThread,
  type RalphRunDetail,
  type RalphRunListEntry,
  type ScmProvider,
} from "@omniralph/db";
import { parseRalphSettings } from "@omniralph/shared";
import {
  cleanupLabel,
  ralphMessageState,
  type RalphChatThreadRef,
  type RalphPullRequest,
  type RalphRunDetailView,
  type RalphRunRow,
} from "./display";

function pullRequest(
  provider: ScmProvider | undefined,
  number: number | null,
  url: string | null,
): RalphPullRequest | null {
  if (number === null || !url || !provider) return null;
  return { number, url, label: `${provider === "gitlab" ? "!" : "#"}${number}` };
}

function chatThreadRef(thread: RalphRunChatThread | null): RalphChatThreadRef | null {
  return thread && { platform: thread.platform, channelId: thread.channelId };
}

export function ralphRunRow(entry: RalphRunListEntry): RalphRunRow {
  return {
    id: entry.id,
    origin: entry.origin,
    linearIdentifier: entry.linearIdentifier,
    linearTitle: entry.linearTitle,
    linearUrl: entry.linearUrl,
    chatThread: chatThreadRef(entry.chatThread),
    repository: entry.repository,
    status: entry.status,
    stories: entry.stories,
    branch: entry.branch,
    pullRequest: pullRequest(entry.repository?.provider, entry.prNumber, entry.prUrl),
    agent: entry.agent,
    error: entry.error,
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export function ralphRunDetailView(detail: RalphRunDetail): RalphRunDetailView {
  const { run, repository } = detail;
  const main = detail.lanes.find((l) => l.main);
  const ref = ({ identifier, title }: { identifier: string; title: string }) => ({
    identifier,
    title,
  });
  return {
    id: run.id,
    origin: run.origin,
    linearIdentifier: run.linearIdentifier,
    linearTitle: run.linearTitle,
    linearUrl: run.linearUrl,
    chatThread: chatThreadRef(detail.chatThread),
    kind: run.kind,
    repository,
    status: run.status,
    branch: main?.lane.branch ?? null,
    baseBranch: main?.lane.baseBranch ?? null,
    pullRequest: pullRequest(
      repository?.provider,
      main?.lane.prNumber ?? null,
      main?.lane.prUrl ?? null,
    ),
    lanes: detail.lanes.map(({ lane, repository: laneRepository, main: isMain, ralphSettings }) => {
      const settings = parseRalphSettings(ralphSettings);
      return {
        id: lane.id,
        repository: laneRepository,
        main: isMain,
        branch: lane.branch,
        baseBranch: lane.baseBranch,
        pullRequest: pullRequest(laneRepository.provider, lane.prNumber, lane.prUrl),
        cleanup: cleanupLabel(lane.cleanup),
        reviewRounds: {
          done: lane.reviewRounds,
          max: settings.respondToReviews ? settings.maxReviewRounds : null,
        },
        ciFixRounds: {
          done: lane.ciFixRounds,
          max: settings.respondToCiFailures ? settings.maxFixRounds : null,
        },
      };
    }),
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
      laneId: story.laneId,
      elsewhere: story.elsewhere,
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
    pendingRequests: detail.pendingRequests.map((request) => ({
      id: request.id,
      laneId: request.laneId,
      text: request.text,
      author: request.author,
      createdAt: request.createdAt.toISOString(),
    })),
    messages: detail.messages.map((message) => {
      const view = {
        id: message.id,
        kind: message.kind,
        text: message.text,
        author: message.author,
        job: message.job,
        createdAt: message.createdAt.toISOString(),
        deliveredAt: message.deliveredAt?.toISOString() ?? null,
        consumedAt: message.consumedAt?.toISOString() ?? null,
      };
      return { ...view, state: ralphMessageState({ ...view, jobStatus: message.job.status }) };
    }),
    messageLimit: RUN_DETAIL_MESSAGE_LIMIT,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/**
 * How many of the run's messages (guidance and requests) it hasn't taken in
 * yet: pending requests and live replies its agent hasn't been given.
 */
export function pendingGuidanceCount(detail: RalphRunDetail): number {
  const ids = new Set(detail.pendingRequests.map((request) => request.id));
  for (const { id, deliveredAt, consumedAt } of detail.messages) {
    if (!deliveredAt && !consumedAt) ids.add(id);
  }
  return ids.size;
}

/** When the run last did something (a change, a job starting or ending, a message), as ISO. */
export function lastRunActivity(detail: RalphRunDetail): string {
  const times = [detail.run.updatedAt];
  for (const job of detail.jobs) {
    times.push(job.createdAt);
    if (job.startedAt) times.push(job.startedAt);
    if (job.finishedAt) times.push(job.finishedAt);
  }
  for (const message of detail.messages) {
    times.push(message.createdAt);
    if (message.deliveredAt) times.push(message.deliveredAt);
  }
  return new Date(Math.max(...times.map((time) => time.getTime()))).toISOString();
}
