import "server-only";
/**
 * The unified run detail (`GET /api/ui/runs/{id}`): a run's list row plus its steps,
 * attempts and details, for every run kind.
 */
import {
  getRalphRunDetailFacts,
  getReviewRunDetailFacts,
  listRunAttempts,
  loadRunListEntries,
  type Database,
  type RalphRunDetailFacts,
  type ReviewRunDetailFacts,
  type RunAttemptEntry,
  type RunIndexEntry,
  type RunLaneEntry,
} from "@omniralph/db";
import type { RunAttempt, RunDetail, RunDetails, RunLane, RunRow, RunStep } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { organizationDefinitions } from "@/lib/definitions";
import { reviewTaskNames } from "@/lib/review/post";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";
import { describeAttempt, type AttemptLabelContext } from "@/lib/run-model/attempt-labels";
import { runActions } from "./actions";
import { runRow } from "./list";
import { loadRunQuestion } from "./question";

const ms = (from: Date | null, to: Date | null) =>
  from && to ? Math.max(0, to.getTime() - from.getTime()) : null;

/** A story's Linear URL, from its epic's (same workspace): `https://linear.app/<ws>/issue/<id>`. */
export function storyIssueUrl(runUrl: string | null, identifier: string): string | null {
  const workspace = runUrl?.match(/^(https:\/\/linear\.app\/[^/]+)\/issue\//)?.[1];
  return workspace ? `${workspace}/issue/${identifier}` : null;
}

function laneView(lane: RunLaneEntry): RunLane {
  const { repository, pullRequest } = lane;
  return {
    id: lane.id,
    repository: { id: repository.id, provider: repository.provider, fullPath: repository.fullPath },
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    pullRequest: pullRequest && {
      provider: repository.provider,
      number: pullRequest.number,
      url:
        pullRequest.url && /^https?:\/\//i.test(pullRequest.url)
          ? pullRequest.url
          : changeRequestWebUrl(
              repository.provider,
              repository.baseUrl,
              repository.fullPath,
              pullRequest.number,
            ),
      merged: pullRequest.merged,
      closed: pullRequest.closed,
      draft: pullRequest.draft,
      reviewState: pullRequest.reviewState,
    },
  };
}

interface KindFacts {
  steps: RunStep[];
  /** The step each attempt belongs to, and what its label mentions. */
  stepOf: (attempt: RunAttemptEntry) => string | null;
  labelContext: (attempt: RunAttemptEntry) => AttemptLabelContext;
  details: Pick<RunDetails, "routedBy" | "error" | "waitingOn" | "lanes" | "baseBranch"> & {
    pullRequest: { merged: boolean | null; closed: boolean | null } | null;
  };
  /** Stories as `runActions` sees them. */
  stories?: {
    id: string;
    status: string;
    pullRequest: { merged: boolean; closed: boolean } | null;
  }[];
}

/** The steps of a run whose every attempt is a step (request, triage, ask). */
function attemptSteps(
  attempts: RunAttemptEntry[],
  label: (attempt: RunAttemptEntry) => string,
): RunStep[] {
  return [...attempts].reverse().map((attempt) => ({
    kind: "attempt",
    id: attempt.id,
    label: label(attempt),
    status: attempt.status,
    durationMs: ms(attempt.startedAt, attempt.finishedAt),
  }));
}

function ralphKindFacts(
  row: RunRow,
  facts: RalphRunDetailFacts,
  attempts: RunAttemptEntry[],
  base: AttemptLabelContext,
): KindFacts {
  const lanes = facts.lanes.map(laneView);
  const laneById = new Map(facts.lanes.map((l) => [l.id, l]));
  const main = facts.lanes.find((l) => l.main) ?? facts.lanes[0] ?? null;
  const storyById = new Map(facts.stories.map((s) => [s.id, s]));
  const labelContext = (attempt: RunAttemptEntry): AttemptLabelContext => ({
    ...base,
    story: (attempt.storyId && storyById.get(attempt.storyId)?.identifier) || null,
  });
  const waitingOn =
    row.status === "waiting" && facts.waitingOn
      ? {
          blockers: facts.waitingOn.blockers.map((b) => ({
            tracker: "linear" as const,
            identifier: b.identifier,
            url: storyIssueUrl(facts.linearIssueUrl, b.identifier),
          })),
          manual: facts.waitingOn.manual.map((m) => ({
            tracker: "linear" as const,
            identifier: m.identifier,
            url: storyIssueUrl(facts.linearIssueUrl, m.identifier),
          })),
        }
      : null;
  const details = {
    routedBy: facts.routedBy,
    error: facts.error,
    waitingOn,
    lanes,
    baseBranch: main?.baseBranch ?? null,
    pullRequest: main?.pullRequest
      ? { merged: main.pullRequest.merged, closed: main.pullRequest.closed }
      : null,
  };
  if (row.kind === "request") {
    return {
      steps: attemptSteps(attempts, (a) =>
        describeAttempt({ type: a.type, status: a.status, context: labelContext(a) }),
      ),
      stepOf: (attempt) => attempt.id,
      labelContext,
      details,
    };
  }
  const lanePullRequest = (laneId: string | null) => {
    const pr = laneId ? laneById.get(laneId)?.pullRequest : main?.pullRequest;
    return pr ? { merged: pr.merged, closed: pr.closed } : null;
  };
  return {
    steps: facts.stories.map((story) => {
      const lane = story.laneId ? laneById.get(story.laneId) : null;
      return {
        kind: "story",
        id: story.id,
        workItem: {
          tracker: "linear",
          identifier: story.identifier,
          url: storyIssueUrl(facts.linearIssueUrl, story.identifier),
        },
        title: story.title,
        status: story.status,
        attempts: story.attempts,
        durationMs: story.durationMs,
        commit: story.commitSha,
        lastFeedback: story.lastFeedback,
        lane: lane
          ? {
              id: lane.id,
              repository: {
                id: lane.repository.id,
                provider: lane.repository.provider,
                fullPath: lane.repository.fullPath,
              },
              branch: lane.branch,
            }
          : null,
      };
    }),
    stepOf: (attempt) =>
      attempt.storyId && storyById.has(attempt.storyId) ? attempt.storyId : null,
    labelContext,
    details,
    stories: facts.stories.map((s) => ({
      id: s.id,
      status: s.status,
      pullRequest: lanePullRequest(s.laneId),
    })),
  };
}

async function reviewKindFacts(
  db: Database,
  run: RunIndexEntry,
  facts: ReviewRunDetailFacts,
  attempts: RunAttemptEntry[],
  base: AttemptLabelContext,
): Promise<KindFacts> {
  const taskName = await reviewTaskNames(
    organizationDefinitions(db, run.organizationId),
    facts.passes.flatMap((p) => p.taskId ?? []),
  );
  const passName = new Map(
    facts.passes.map((p) => [p.id, p.taskId ? taskName(p.taskId) : "Review"]),
  );
  const labelContext = (attempt: RunAttemptEntry): AttemptLabelContext => ({
    ...base,
    reviewTask: (attempt.reviewId && passName.get(attempt.reviewId)) || null,
  });
  const steps: RunStep[] = facts.passes.map((pass) => ({
    kind: "review_pass",
    id: pass.id,
    taskName: passName.get(pass.id)!,
    status: pass.status,
    tokens: pass.tokens,
    durationMs: pass.durationMs,
    openFindings: pass.openFindings,
  }));
  const correlation = facts.correlationJobId
    ? attempts.find((a) => a.id === facts.correlationJobId)
    : undefined;
  if (correlation) {
    steps.push({
      kind: "correlation",
      id: correlation.id,
      label: describeAttempt({
        type: correlation.type,
        status: correlation.status,
        context: labelContext(correlation),
      }),
      status: correlation.status,
      tokens: correlation.tokens,
      durationMs: ms(correlation.startedAt, correlation.finishedAt),
    });
  }
  return {
    steps,
    stepOf: (attempt) =>
      attempt.id === correlation?.id
        ? attempt.id
        : attempt.reviewId && passName.has(attempt.reviewId)
          ? attempt.reviewId
          : null,
    labelContext,
    details: {
      routedBy: null,
      error: facts.error,
      waitingOn: null,
      lanes: [],
      baseBranch: null,
      pullRequest: { merged: facts.lane?.merged ?? null, closed: facts.lane?.closed ?? null },
    },
  };
}

function attemptKindFacts(attempts: RunAttemptEntry[], base: AttemptLabelContext): KindFacts {
  const labelContext = () => base;
  return {
    steps: attemptSteps(attempts, (a) =>
      describeAttempt({ type: a.type, status: a.status, context: base }),
    ),
    stepOf: (attempt) => attempt.id,
    labelContext,
    details: {
      routedBy: null,
      // What the newest attempt reported, when it didn't succeed.
      error: attempts.find((a) => a.status !== "completed")?.error ?? null,
      waitingOn: null,
      lanes: [],
      baseBranch: null,
      pullRequest: null,
    },
  };
}

/** The run's detail for a user who is `organization.role` in its organization. */
export async function loadRunDetail(
  db: Database,
  run: RunIndexEntry,
  organization: ScopedOrganization,
): Promise<RunDetail | null> {
  const [[entry], attempts] = await Promise.all([
    loadRunListEntries(db, [run]),
    listRunAttempts(db, run),
  ]);
  if (!entry) return null;
  const row = runRow(entry, organization);
  const question = await loadRunQuestion(db, run, row.workItem?.identifier ?? null);
  const base: AttemptLabelContext = {
    workItem: row.workItem?.identifier ?? null,
    repository: row.repository?.fullPath ?? null,
    provider: row.repository?.provider ?? null,
    pullRequestNumber: row.pullRequest?.number ?? null,
  };

  let facts: KindFacts;
  switch (run.kind) {
    case "epic":
    case "request": {
      const ralph = await getRalphRunDetailFacts(db, run.id);
      if (!ralph) return null;
      facts = ralphKindFacts(row, ralph, attempts, base);
      break;
    }
    case "review": {
      const review = await getReviewRunDetailFacts(db, run.id);
      if (!review) return null;
      facts = await reviewKindFacts(db, run, review, attempts, base);
      break;
    }
    case "triage":
    case "ask":
      facts = attemptKindFacts(attempts, base);
      break;
  }

  const attemptViews: RunAttempt[] = attempts.map((attempt) => ({
    id: attempt.id,
    label: describeAttempt({
      type: attempt.type,
      status: attempt.status,
      context: { ...facts.labelContext(attempt), agent: attempt.agent?.name ?? null },
    }),
    type: attempt.type,
    status: attempt.status,
    agent: attempt.agent,
    deliveries: attempt.deliveries,
    cancelRequested: attempt.cancelRequested,
    createdAt: attempt.createdAt.toISOString(),
    startedAt: attempt.startedAt?.toISOString() ?? null,
    finishedAt: attempt.finishedAt?.toISOString() ?? null,
    tokens: attempt.tokens,
    error: attempt.error,
    step: facts.stepOf(attempt),
    transcriptEvents: attempt.transcriptEvents,
  }));

  const { pullRequest, ...details } = facts.details;
  return {
    ...row,
    steps: facts.steps,
    attempts: attemptViews,
    details: {
      ...details,
      repository: row.repository,
      branch: row.branch,
      agent: row.agent,
      tokens: row.tokens,
      attemptCount: attempts.length,
      pullRequest: row.pullRequest && {
        ...row.pullRequest,
        merged: pullRequest?.merged ?? null,
        closed: pullRequest?.closed ?? null,
      },
      question,
      actions: runActions(row, organization.role, {
        stories: facts.stories,
        attempts: attemptViews,
      }),
    },
  };
}
