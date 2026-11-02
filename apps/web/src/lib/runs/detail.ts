import "server-only";
/**
 * The unified run detail (`GET /api/ui/runs/{id}`): a run's list row plus its steps,
 * attempts and details, for every run kind.
 */
import {
  costForJobs,
  getRalphRunDetailFacts,
  getRunChatThread,
  getReviewRunDetailFacts,
  listRunAttempts,
  listRunIterations,
  loadRunListEntries,
  type Database,
  type RalphEpicAudit,
  type RalphRunDetailFacts,
  type RalphTaskVerification,
  type ReviewRunDetailFacts,
  type RunAttemptEntry,
  type RunIndexEntry,
  type RunIteration,
  type RunLaneEntry,
} from "@omniralph/db";
import type {
  AttemptVerification,
  RunAttempt,
  RunChat,
  RunDetail,
  RunDetails,
  RunIterationView,
  RunLane,
  RunRow,
  RunStep,
} from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { organizationPlaybooks } from "@/lib/playbooks";
import { siblingIssueUrl } from "@/lib/tracker/adapters";
import { reviewTaskNames } from "@/lib/review/post";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";
import { describeAttempt, type AttemptLabelContext } from "@omniralph/shared";
import { runActions } from "./actions";
import { runRow } from "./list";
import { loadRunQuestion } from "./question";
import {
  changeRequestName,
  runReason,
  runReasonLink,
  waitingReasonFacts,
  type RunReasonFacts,
} from "./reason";

/** A looped run's iteration as the run detail shows it. */
export function iterationView(iteration: RunIteration): RunIterationView {
  return {
    id: iteration.id,
    number: iteration.number,
    status: iteration.status,
    verdict: iteration.verdict,
    summary: iteration.summary,
    findings: iteration.findings,
    metric: iteration.metric,
    error: iteration.error,
    outcome: iteration.outcome,
    maxIterations: iteration.maxIterations,
    workerAttemptId: iteration.workerJobId,
    verifierAttemptId: iteration.verifierJobId,
    createdAt: iteration.createdAt.toISOString(),
    verifyingAt: iteration.verifyingAt?.toISOString() ?? null,
    finishedAt: iteration.finishedAt?.toISOString() ?? null,
  };
}

const ms = (from: Date | null, to: Date | null) =>
  from && to ? Math.max(0, to.getTime() - from.getTime()) : null;

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
  /** An epic's manual stories, for its reason. */
  manualStories?: { identifier: string; elsewhere: boolean }[];
  /** A story attempt's check by the task verifier. */
  verificationOf?: (attempt: RunAttemptEntry) => AttemptVerification | null;
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

/** A story attempt's latest check by the task verifier, by the attempt's job ID. */
function verificationsByAttempt(
  stories: readonly { verifications: readonly RalphTaskVerification[] }[],
): Map<string, AttemptVerification> {
  const byAttempt = new Map<string, AttemptVerification>();
  for (const story of stories) {
    // Oldest first: a later check of the same attempt replaces an earlier one.
    for (const v of story.verifications) {
      byAttempt.set(v.storyJobId, {
        status: v.status,
        criteria: v.criteria.map(({ criterion, accepted, reason }) => ({
          criterion,
          accepted,
          reason,
        })),
        summary: v.summary,
        error: v.error,
        verifierAttemptId: v.jobId,
      });
    }
  }
  return byAttempt;
}

/** The run's `index`-th audit's step ID (1-based, so a skipped audit without a job has one). */
export const auditStepId = (index: number) => `audit-${index}`;

/** An epic's audits as steps after its stories, before the PR/MR. */
function auditSteps(
  audits: readonly RalphEpicAudit[],
  workItem: (identifier: string) => Extract<RunStep, { kind: "audit" }>["filed"][number],
): Extract<RunStep, { kind: "audit" }>[] {
  return audits.map((audit, index) => ({
    kind: "audit",
    id: auditStepId(index + 1),
    round: audit.round,
    status: audit.status,
    requirements: audit.requirements.map(({ id, text, status, evidence, missing }) => ({
      id,
      text,
      status,
      evidence,
      missing,
    })),
    summary: audit.summary,
    error: audit.error,
    filed: audit.filed.map(workItem),
    durationMs: ms(new Date(audit.startedAt), audit.finishedAt ? new Date(audit.finishedAt) : null),
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
            tracker: facts.trackerProvider,
            identifier: b.identifier,
            url: siblingIssueUrl(facts.trackerProvider, facts.trackerIssueUrl, b.identifier),
          })),
          manual: facts.waitingOn.manual.map((m) => ({
            tracker: facts.trackerProvider,
            identifier: m.identifier,
            url: siblingIssueUrl(facts.trackerProvider, facts.trackerIssueUrl, m.identifier),
          })),
          relations: facts.waitingOn.relations ?? [],
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
  const workItemRef = (identifier: string) => ({
    tracker: facts.trackerProvider,
    identifier,
    url: siblingIssueUrl(facts.trackerProvider, facts.trackerIssueUrl, identifier),
  });
  const audits = auditSteps(facts.audits, workItemRef);
  const auditStepByJob = new Map(
    facts.audits.flatMap((audit, index) =>
      audit.jobId ? [[audit.jobId, auditStepId(index + 1)] as const] : [],
    ),
  );
  const verifications = verificationsByAttempt(facts.stories);
  const storySteps: RunStep[] = facts.stories.map((story) => {
    const lane = story.laneId ? laneById.get(story.laneId) : null;
    return {
      kind: "story",
      id: story.id,
      workItem: {
        tracker: facts.trackerProvider,
        identifier: story.identifier,
        url: siblingIssueUrl(facts.trackerProvider, facts.trackerIssueUrl, story.identifier),
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
  });
  return {
    steps: [...storySteps, ...audits],
    stepOf: (attempt) =>
      auditStepByJob.get(attempt.id) ??
      (attempt.storyId && storyById.has(attempt.storyId) ? attempt.storyId : null),
    labelContext,
    verificationOf: (attempt) => verifications.get(attempt.id) ?? null,
    details,
    manualStories: facts.stories
      .filter((s) => s.status === "manual")
      .map((s) => ({ identifier: s.identifier, elsewhere: !!s.elsewhere })),
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
    organizationPlaybooks(db, run.organizationId),
    facts.passes.flatMap((p) => p.taskId ?? []),
  );
  // A legacy pass has no task: its step reads "Review", its attempt "Reviewed pull request #12".
  const passTask = new Map(facts.passes.map((p) => [p.id, p.taskId ? taskName(p.taskId) : null]));
  const passName = new Map(facts.passes.map((p) => [p.id, passTask.get(p.id) ?? "Review"]));
  const labelContext = (attempt: RunAttemptEntry): AttemptLabelContext => ({
    ...base,
    reviewTask: (attempt.reviewId && passTask.get(attempt.reviewId)) || null,
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

/**
 * The reason facts of a run (`runReason`, as its Inbox item says): a waiting run's open
 * question, else the relations it waits on, else its first manual story, else its blockers; a queued run's newest attempt's
 * waiting reason; a stopped or failed run's error.
 */
function detailReasonFacts(
  row: RunRow,
  facts: KindFacts,
  question: Awaited<ReturnType<typeof loadRunQuestion>>,
  attempts: readonly RunAttemptEntry[],
): RunReasonFacts | null {
  switch (row.status) {
    case "waiting": {
      if (question) {
        const { kind, story, tool } = question.facts;
        return {
          kind: "question",
          question: kind,
          story,
          tool,
          pullRequest: row.pullRequest
            ? changeRequestName(row.pullRequest.provider, row.pullRequest.number)
            : "pull request",
        };
      }
      const relations = facts.details.waitingOn?.relations ?? [];
      if (relations.length > 0) return { kind: "broken_relations", relations };
      const manual = facts.manualStories?.[0];
      if (manual) return { kind: "manual_story", ...manual };
      const blockers = facts.details.waitingOn?.blockers ?? [];
      if (blockers.length > 0) {
        return { kind: "blocked_epic", blockers: blockers.map((b) => b.identifier) };
      }
      return null;
    }
    case "queued":
      // Attempts are newest first.
      return waitingReasonFacts(attempts[0]?.waitingReason);
    case "stopped":
      return { kind: "stopped", runKind: row.kind, error: facts.details.error };
    case "failed":
      return { kind: "failed", error: facts.details.error };
    default:
      return null;
  }
}

/** What every attempt label of the run `row` may mention: its work item, repo and PR/MR. */
export function attemptLabelBase(row: RunRow): AttemptLabelContext {
  return {
    workItem: row.workItem?.identifier ?? null,
    repository: row.repository?.fullPath ?? null,
    provider: row.repository?.provider ?? null,
    pullRequestNumber: row.pullRequest?.number ?? null,
  };
}

/**
 * The chat an ask run, or an epic or request started from a chat, came from. Only the member
 * who started a web chat gets its Ask link: a web chat is private to them.
 */
export async function loadRunChat(
  db: Database,
  run: Pick<RunIndexEntry, "kind" | "id">,
  viewerId: string,
): Promise<RunChat | null> {
  if (run.kind !== "ask" && run.kind !== "epic" && run.kind !== "request") return null;
  const thread = await getRunChatThread(db, { kind: run.kind, id: run.id });
  if (!thread) return null;
  const own = thread.platform === "web" && thread.startedByUserId === viewerId;
  return {
    threadId: thread.threadId,
    platform: thread.platform,
    href: own ? `/ask/${thread.threadId}` : null,
  };
}

/**
 * A run's list price: the sum over its token-bearing attempts, null when any of them is
 * unpriced or none has tokens, so a run never shows a figure that leaves out part of them.
 */
export function runCost(
  attempts: readonly Pick<RunAttempt, "tokens" | "costUsd">[],
): number | null {
  const bearing = attempts.filter((a) => a.tokens.in + a.tokens.out > 0);
  if (bearing.length === 0) return null;
  let sum = 0;
  for (const attempt of bearing) {
    if (attempt.costUsd === null) return null;
    sum += attempt.costUsd;
  }
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * The run's detail for the user `viewerId`, who is `organization.role` in its organization.
 */
export async function loadRunDetail(
  db: Database,
  run: RunIndexEntry,
  organization: ScopedOrganization,
  viewerId: string,
): Promise<RunDetail | null> {
  const [[entry], attempts, chat, iterations] = await Promise.all([
    loadRunListEntries(db, [run]),
    listRunAttempts(db, run),
    loadRunChat(db, run, viewerId),
    run.kind === "review" || run.kind === "triage"
      ? listRunIterations(db, { kind: run.kind, id: run.id })
      : [],
  ]);
  if (!entry) return null;
  const row = runRow(entry, organization);
  const [open, costs] = await Promise.all([
    loadRunQuestion(db, run, row.workItem?.identifier ?? null),
    costForJobs(
      db,
      attempts.map((a) => a.id),
    ),
  ]);
  const base = attemptLabelBase(row);

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
    costUsd: costs.get(attempt.id) ?? null,
    error: attempt.error,
    step: facts.stepOf(attempt),
    transcriptEvents: attempt.transcriptEvents,
    verification: facts.verificationOf?.(attempt) ?? null,
  }));

  const { pullRequest, ...details } = facts.details;
  const reasonFacts = detailReasonFacts(row, facts, open, attempts);
  return {
    ...row,
    reason: reasonFacts && runReason(reasonFacts),
    reasonLink: reasonFacts && runReasonLink(reasonFacts),
    steps: facts.steps,
    attempts: attemptViews,
    iterations: iterations.map(iterationView),
    details: {
      ...details,
      repository: row.repository,
      branch: row.branch,
      agent: row.agent,
      tokens: row.tokens,
      costUsd: runCost(attemptViews),
      attemptCount: attempts.length,
      pullRequest: row.pullRequest && {
        ...row.pullRequest,
        merged: pullRequest?.merged ?? null,
        closed: pullRequest?.closed ?? null,
      },
      question: open?.question ?? null,
      actions: runActions(row, organization.role, {
        stories: facts.stories,
        attempts: attemptViews,
      }),
    },
    chat,
  };
}
