/**
 * The ralph orchestrator's run state machine (ported from cyralph's
 * `EpicEngine.run` and `finish`). Every change to a run goes through
 * `advanceRun`, which holds the run's row lock, so the webhooks, job outcomes
 * and the reconcile cron that race to move a run apply one at a time; it is
 * idempotent (calling it again with nothing new changes nothing).
 */
import {
  getAgent,
  getRepositoryWithConnection,
  listActiveRunJobIds,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  upsertStories,
  type Database,
  type RalphRun,
  type RalphPreparationRequest,
  type RalphRunStatus,
  type RalphStory,
  type RalphStoryStatus,
  type RalphStoryUpdate,
  type RalphTransaction,
  type RalphWaitingOn,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import {
  blockedStories,
  dependencyLabel,
  isEpicComplete,
  isStoryDone,
  isStoryReady,
  openRootBlockers,
  selectNextStory,
  waitingOnFor,
  withoutOutsideBlockers,
  type Epic,
  type Story,
  type WaitingIssue,
} from "@omniralph/ralph";
import {
  MAX_ATTEMPTS_PER_STORY,
  RALPH_CAPABILITY,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
} from "@omniralph/shared";
import type { ScmAdapter } from "@omniralph/scm";
import type { JobDispatcher } from "@/lib/dispatch/dispatcher";
import type { LinearGateway } from "@/lib/linear/gateway";
import { reloadEpic, runEpicOptions } from "./epic-loader";
import { postActivity, quietly, tail } from "./notify";
import { applyJobOutcomes } from "./outcome";
import { buildDescribePrPayload, buildPreparePayload, buildStoryPayload } from "./payload";
import { planFor } from "./plan";
import {
  applyPreparationJob,
  approvedPreparation,
  offerPreparation,
  preparationOf,
} from "./preparation";
import {
  applyPullRequestJob,
  changeRequestTerm,
  moveCompletedEpic,
  openEarlyPullRequest,
} from "./publish";

export interface RalphDeps {
  db: Database;
  linear: LinearGateway;
  dispatcher: JobDispatcher;
  /** The code-host adapter of a repository's connection (default branch, PRs/MRs). */
  adapterFor: (db: Database, connection: ScmConnection) => ScmAdapter;
}

/** Story jobs a run may enqueue in total (cyralph's `maxIterationsPerRun`). */
export const MAX_ITERATIONS_PER_RUN = 50;

/** At most one queued or running job per run (also enforced by the jobs' dedupe key). */
export function runDedupeKey(runId: string): string {
  return `ralph-run:${runId}`;
}

/** Runs that are over: `advanceRun` leaves them alone. */
export const FINISHED_RUN_STATUSES: ReadonlySet<RalphRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

/**
 * The stored status of a story after re-reading it from Linear: done or
 * canceled in Linear wins; a manual label makes a waiting story manual (and
 * removing it makes it pending again). Running, completed and exhausted
 * stories keep their status: the orchestrator owns those.
 */
export function syncedStoryStatus(current: RalphStoryStatus, story: Story): RalphStoryStatus {
  if (story.status === "completed") return "completed";
  if (story.status === "cancelled") return current === "completed" ? current : "canceled";
  if (current === "running" || current === "completed" || current === "exhausted") return current;
  if (story.manual) return "manual";
  if (current === "manual" || current === "canceled") return "pending";
  return current;
}

/**
 * Stores the epic's stories (new ones are added, known ones refreshed) and
 * syncs their status with Linear. Returns the run's stories in order.
 */
export async function syncStories(
  tx: RalphTransaction | Database,
  runId: string,
  epic: Epic,
): Promise<RalphStory[]> {
  const byIssue = new Map(epic.stories.map((s) => [s.issueId ?? s.key, s]));
  const stored = await upsertStories(
    tx,
    runId,
    epic.stories.map((s) => ({
      linearIssueId: s.issueId ?? s.key,
      identifier: s.identifier ?? s.storyId,
      title: s.title,
    })),
  );
  let changed = false;
  for (const row of stored) {
    const story = byIssue.get(row.linearIssueId);
    if (!story) continue;
    const status = syncedStoryStatus(row.status, story);
    if (status !== row.status) {
      await updateStory(tx, row.id, { status });
      changed = true;
    }
  }
  return changed ? listStories(tx, runId) : stored;
}

/** Posts the run's plan (every story with its status) to its agent session. */
export async function publishPlan(
  linear: LinearGateway,
  run: Pick<RalphRun, "linearAgentSessionId">,
  stories: readonly RalphStory[],
): Promise<void> {
  await linear.updateSessionPlan(run.linearAgentSessionId, planFor(stories));
}

/**
 * Changes a story (inside `lockRun`) and, when its status changed, posts the
 * updated plan. Returns the updated story, or null if it's gone.
 */
export async function updateStoryAndPlan(
  linear: LinearGateway,
  tx: RalphTransaction,
  run: RalphRun,
  story: RalphStory,
  update: RalphStoryUpdate,
): Promise<RalphStory | null> {
  const updated = await updateStory(tx, story.id, update);
  if (updated && updated.status !== story.status) {
    await publishPlan(linear, run, await listStories(tx, run.id));
  }
  return updated;
}

export type AdvanceResult =
  | { action: "gone" }
  | { action: "finished"; run: RalphRun }
  /** One of the run's jobs is queued or running: its outcome advances the run. */
  | { action: "busy"; run: RalphRun }
  | { action: "enqueued"; run: RalphRun; story: RalphStory; jobId: string }
  /** Every story is done: a `ralph.describe-pr` job writes the PR/MR. */
  | { action: "describing"; run: RalphRun; jobId: string }
  /** An approved manual-story preparation runs as a `ralph.prepare` job. */
  | { action: "preparing"; run: RalphRun; jobId: string }
  | { action: "waiting"; run: RalphRun; waitingOn: RalphWaitingOn }
  | { action: "completed"; run: RalphRun }
  | { action: "failed"; run: RalphRun };

/**
 * Moves a run forward. First, under the run's row lock, the outcome of every
 * story job that finished is applied (completed, retried or exhausted), and
 * that of the describe job (the PR/MR is opened and the run completes). Then,
 * under the lock again, the stories are re-read from Linear (new sub-issues,
 * relations and states), synced and the plan posted, and the run either
 * enqueues the next ready story as a `ralph.story` job, enqueues the
 * `ralph.describe-pr` job (every story done) or waits (on blockers, manual stories or a person). Nothing is enqueued
 * while one of the run's jobs is queued or running.
 */
export async function advanceRun(runId: string, deps: RalphDeps): Promise<AdvanceResult> {
  // Outcomes commit on their own, so a Linear failure while selecting can't undo them.
  const applied = await lockRun(deps.db, runId, async (tx, run) => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return { busy: false };
    const stories = await applyJobOutcomes({ ...deps, tx, run });
    const pullRequest = await applyPullRequestJob(deps, tx, run);
    const preparation = await applyPreparationJob(deps, tx, run);
    return { busy: stories.busy || pullRequest.busy || preparation.busy };
  });
  if (!applied) return { action: "gone" };
  const result = await lockRun(deps.db, runId, (tx, run) => step(deps, tx, run));
  return result ?? { action: "gone" };
}

/** The epic's stories with the run's own state applied: what selection works on. */
function storiesWithRunState(
  epic: Epic,
  rows: readonly RalphStory[],
  ignoreBlockers: boolean,
): Story[] {
  const byIssue = new Map(rows.map((r) => [r.linearIssueId, r]));
  const stories = epic.stories.map((story): Story => {
    const row = byIssue.get(story.issueId ?? story.key);
    // Completed here wins over Linear (marking it done there may have failed; a single issue stays open).
    if (row?.status === "completed") return { ...story, status: "completed" };
    if (row?.status === "exhausted") return { ...story, exhausted: true };
    return story;
  });
  return ignoreBlockers ? withoutOutsideBlockers(stories) : stories;
}

async function step(deps: RalphDeps, tx: RalphTransaction, run: RalphRun): Promise<AdvanceResult> {
  if (FINISHED_RUN_STATUSES.has(run.status)) return { action: "finished", run };
  if ((await listActiveRunJobIds(tx, run.id)).length > 0) return { action: "busy", run };

  const epic = await reloadEpic(deps.linear, run, await runEpicOptions(deps.db, run));
  const rows = await syncStories(tx, run.id, epic);
  const stories = storiesWithRunState(epic, rows, run.ignoreBlockers);
  // An approved preparation ("Run it") goes first: it was asked for while nothing else could run.
  const approved = await approvedPreparation(deps, tx, run, stories);
  run = approved.run;
  if (approved.story && approved.request) {
    return enqueuePreparation(deps, tx, run, { story: approved.story, request: approved.request });
  }
  const allDone = isEpicComplete(stories);
  // openPullRequestEarly: a draft PR/MR once the first story is pushed.
  if (!allDone) run = await openEarlyPullRequest(deps, tx, run, { epic, rows });
  // Blockers of the epic issue itself gate all of its stories (as in cyralph and Cyrus).
  const rootBlockers = run.ignoreBlockers
    ? []
    : openRootBlockers(epic, await deps.linear.getBlockers(run.linearIssueId));

  if (rootBlockers.length === 0) {
    const focused = run.focusStoryId
      ? stories.find((s) => s.issueId === run.focusStoryId && isStoryReady(s, stories))
      : undefined;
    const next = focused ?? selectNextStory(stories);
    if (next) {
      if (run.iterations >= MAX_ITERATIONS_PER_RUN) {
        return wait(deps, tx, run, { epic, stories, rows, rootBlockers, hitCap: true });
      }
      const row = rows.find((r) => r.linearIssueId === (next.issueId ?? next.key));
      if (row) return enqueueStory(deps, tx, run, { epic, stories, story: next, row });
    }
  }

  if (rootBlockers.length === 0 && allDone) {
    // The PR/MR step failed: a reply (which clears the error) retries it.
    if (run.status === "waiting" && run.error) {
      return { action: "waiting", run, waitingOn: run.waitingOn ?? { blockers: [], manual: [] } };
    }
    return describePullRequest(deps, tx, run, { epic, stories, rows });
  }
  return wait(deps, tx, run, { epic, stories, rows, rootBlockers, hitCap: false });
}

/** The run's agent, while it may still take the run's jobs (not revoked, ralph enabled). */
async function stickyAgentId(db: Database, agentId: string | null): Promise<string | undefined> {
  if (!agentId) return undefined;
  const agent = await getAgent(db, agentId);
  if (!agent || agent.revokedAt || !agent.enabledCapabilities.includes(RALPH_CAPABILITY)) {
    return undefined;
  }
  return agent.id;
}

/** Ends a run that can't go on (e.g. its repository is gone), with an error in its session. */
async function failRun(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  error: string,
): Promise<AdvanceResult> {
  const failed = (await updateRun(tx, run.id, { status: "failed", waitingOn: null, error })) ?? run;
  await postActivity(deps.linear, run.linearAgentSessionId, { type: "error", body: error });
  return { action: "failed", run: failed };
}

/** The run's repository while it may run ralph jobs; else the run fails. */
async function usableRepository(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<{ repository: Repository; connection: ScmConnection } | AdvanceResult> {
  const found = await getRepositoryWithConnection(deps.db, run.repositoryId);
  if (!found || found.repository.disconnectedAt) {
    return failRun(deps, tx, run, "The run's repository is no longer connected, so I stopped.");
  }
  if (!found.repository.ralphEnabled) {
    return failRun(
      deps,
      tx,
      run,
      `Ralph was disabled for \`${found.repository.fullPath}\`, so I stopped. Enable it under ` +
        "**Repository › Settings › Ralph** and delegate the issue again to continue.",
    );
  }
  return found;
}

/**
 * Enqueues one attempt at `story`: its sub-issue moves to started and a
 * `ralph.story` job goes to the run's sticky agent (the agent that started
 * its first job), else to the repository's pinned agent, else to `ralph-jobs`.
 */
async function enqueueStory(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; story: Story; row: RalphStory },
): Promise<AdvanceResult> {
  const { epic, story, row } = input;
  const found = await usableRepository(deps, tx, run);
  if ("action" in found) return found;

  const payload = buildStoryPayload({
    run,
    repository: found.repository,
    connection: found.connection,
    epic,
    stories: input.stories,
    story,
    row,
  });
  const { job, created } = await deps.dispatcher.createAndPublish({
    capability: RALPH_CAPABILITY,
    type: RALPH_STORY_JOB_TYPE,
    payload,
    repositoryId: run.repositoryId,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetAgentId: await stickyAgentId(deps.db, run.agentId),
  });
  if (!created) return { action: "busy", run };

  if (run.kind !== "single" && story.status === "open") {
    await quietly(`Starting ${row.identifier} in Linear`, () =>
      deps.linear.setIssueState(row.linearIssueId, { type: "started" }),
    );
  }
  const running = (await updateStory(tx, row.id, { status: "running", lastJobId: job.id })) ?? row;
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      iterations: run.iterations + 1,
      waitingOn: null,
      error: null,
    })) ?? run;
  await publishPlan(deps.linear, run, await listStories(tx, run.id));
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `▶️ **${row.identifier}: ${row.title}** (attempt ${payload.attempt}/${MAX_ATTEMPTS_PER_STORY})`,
  });
  return { action: "enqueued", run: updated, story: running, jobId: job.id };
}

/**
 * Every story is done: one `ralph.describe-pr` job (on the run's sticky
 * agent) writes the PR/MR title and body, and its outcome opens the PR/MR and
 * completes the run (`applyPullRequestJob`). A run none of whose stories
 * committed anything, and without a PR/MR, has nothing to open: it completes.
 */
async function describePullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; rows: RalphStory[] },
): Promise<AdvanceResult> {
  if (run.prNumber === null && !input.rows.some((r) => r.commitSha)) {
    return complete(deps, tx, run, input);
  }
  const found = await usableRepository(deps, tx, run);
  if ("action" in found) return found;
  const { job, created } = await deps.dispatcher.createAndPublish({
    capability: RALPH_CAPABILITY,
    type: RALPH_DESCRIBE_PR_JOB_TYPE,
    payload: buildDescribePrPayload({ run, ...found, epic: input.epic, rows: input.rows }),
    repositoryId: run.repositoryId,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetAgentId: await stickyAgentId(deps.db, run.agentId),
  });
  if (!created) return { action: "busy", run };
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      prJobId: job.id,
      waitingOn: null,
      error: null,
    })) ?? run;
  await publishPlan(deps.linear, run, input.rows);
  const term = changeRequestTerm(found.repository.provider);
  const what =
    run.kind === "single"
      ? `**${input.epic.identifier}** is done`
      : `All ${input.stories.length} ${input.stories.length === 1 ? "story is" : "stories are"} done`;
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `${what}. Writing the ${term} description.`,
  });
  return { action: "describing", run: updated, jobId: job.id };
}

/**
 * Runs an approved manual-story preparation: a `ralph.prepare` job (the run's
 * one job, on its sticky agent) with the story's commands as they are now and
 * the approval they must match. Its outcome is applied by `applyPreparationJob`.
 */
async function enqueuePreparation(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { story: Story; request: RalphPreparationRequest },
): Promise<AdvanceResult> {
  const { story, request } = input;
  const found = await usableRepository(deps, tx, run);
  if ("action" in found) return found;
  const { job, created } = await deps.dispatcher.createAndPublish({
    capability: RALPH_CAPABILITY,
    type: RALPH_PREPARE_JOB_TYPE,
    payload: buildPreparePayload({
      run,
      ...found,
      story,
      approved: { commandsHash: request.commandsHash, headSha: request.headSha },
    }),
    repositoryId: run.repositoryId,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetAgentId: await stickyAgentId(deps.db, run.agentId),
  });
  if (!created) return { action: "busy", run };
  const state = preparationOf(run);
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      waitingOn: null,
      preparation: { ...state, request: { ...request, jobId: job.id } },
    })) ?? run;
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `Running the preparation of **${request.identifier}: ${request.title}** on \`${run.branch}\`.`,
  });
  return { action: "preparing", run: updated, jobId: job.id };
}

/** Every story is done and there is nothing to open a PR/MR for: the run completes. */
async function complete(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; rows: RalphStory[] },
): Promise<AdvanceResult> {
  const completed =
    (await updateRun(tx, run.id, { status: "completed", waitingOn: null, error: null })) ?? run;
  await publishPlan(deps.linear, run, input.rows);
  const what =
    run.kind === "single"
      ? `**${input.epic.identifier}**`
      : `all ${input.stories.length} ${input.stories.length === 1 ? "story" : "stories"} of **${input.epic.identifier}**`;
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "response",
    body: `Finished ${what} on \`${run.branch}\`. Nothing was committed, so there is no pull/merge request.`,
  });
  await moveCompletedEpic(deps, run);
  return { action: "completed", run: completed };
}

const bold = (issues: readonly WaitingIssue[]) =>
  issues.map((i) => `**${i.identifier}**`).join(", ");

/** The issue refs stored in `waiting_on` (with titles, read from Linear for outside issues). */
async function waitingRefs(
  linear: LinearGateway,
  issues: readonly WaitingIssue[],
  known: ReadonlyMap<string, string>,
): Promise<RalphWaitingOn["blockers"]> {
  return Promise.all(
    issues.map(async ({ id, identifier }) => {
      let title = known.get(id);
      if (title === undefined) {
        try {
          title = (await linear.getIssue(id)).title;
        } catch {
          title = identifier;
        }
      }
      return { id, identifier, title };
    }),
  );
}

/** Whether a run waits on the same issues (jsonb doesn't keep key order, so compare IDs). */
const sameWaitingOn = (a: RalphWaitingOn | null, b: RalphWaitingOn) => {
  const ids = (w: RalphWaitingOn) =>
    JSON.stringify([w.blockers.map((i) => i.id), w.manual.map((i) => i.id)]);
  return !!a && ids(a) === ids(b);
};

/**
 * No story can run now: the run waits, with `waiting_on` listing the open
 * outside blockers and manual stories that hold it up (an `Issue` webhook for
 * one of them, or the reconcile cron, wakes it). The elicitation says what it
 * waits for: just those issues, or (stories exhausted or the iteration cap
 * reached) a person's guidance. It is posted when the run starts waiting or
 * what it waits on changes.
 */
async function wait(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: {
    epic: Epic;
    stories: Story[];
    rows: RalphStory[];
    rootBlockers: WaitingIssue[];
    hitCap: boolean;
  },
): Promise<AdvanceResult> {
  const { epic, stories, rows, rootBlockers, hitCap } = input;
  const found = waitingOnFor({ stories, externalIssues: epic.externalIssues ?? {} });
  const titles = new Map(stories.map((s) => [s.issueId ?? s.key, s.title]));
  const blockers = [
    ...rootBlockers,
    ...found.blockers.filter((b) => !rootBlockers.some((r) => r.id === b.id)),
  ];
  const waitingOn: RalphWaitingOn = {
    blockers: await waitingRefs(deps.linear, blockers, titles),
    manual: await waitingRefs(deps.linear, found.manual, titles),
  };
  await publishPlan(deps.linear, run, rows);
  const all = [...waitingOn.blockers, ...waitingOn.manual];
  const done = stories.filter(isStoryDone).length;
  // A manual story whose preparation can run now: the question is the run's elicitation.
  const asked =
    rootBlockers.length === 0 &&
    (await offerPreparation(deps, tx, run, {
      stories,
      rows,
      ...(all.length > 0 && {
        waiting: `${done}/${stories.length} stories are done; the rest are waiting on ${bold(all)}.`,
      }),
    }));
  if (asked) {
    const updated = (await updateRun(tx, run.id, { status: "waiting", waitingOn })) ?? run;
    return { action: "waiting", run: updated, waitingOn };
  }
  if (run.status === "waiting" && sameWaitingOn(run.waitingOn, waitingOn)) {
    return { action: "waiting", run, waitingOn };
  }
  const updated = (await updateRun(tx, run.id, { status: "waiting", waitingOn })) ?? run;

  const startAnyway = "Reply `start anyway` to ignore the blockers, or `stop` to cancel.";
  const automatic = (issues: readonly WaitingIssue[]) =>
    `I'll start automatically when ${issues.length > 1 ? "any of them is" : "it's"} done or canceled.`;
  const stuck = stories.filter((s) => s.exhausted && !isStoryDone(s));
  let body: string;
  if (rootBlockers.length > 0) {
    body = [
      `**${epic.identifier}** is blocked on ${bold(rootBlockers)}. ${automatic(rootBlockers)}`,
      startAnyway,
    ].join("\n\n");
  } else if (!hitCap && stuck.length === 0 && all.length > 0) {
    body = [
      `${done}/${stories.length} stories are done; the rest are waiting on ${bold(all)}. ${automatic(all)}`,
      startAnyway,
    ].join("\n\n");
  } else {
    const feedback = new Map(rows.map((r) => [r.linearIssueId, r]));
    const lines = [`Paused with ${done}/${stories.length} stories complete on \`${run.branch}\`.`];
    if (hitCap) {
      lines.push(`I reached the per-run iteration cap (${MAX_ITERATIONS_PER_RUN} story attempts).`);
    }
    for (const s of stuck) {
      const row = feedback.get(s.issueId ?? s.key);
      const problem = tail(row?.lastFeedback ?? "unknown", 1500);
      lines.push(
        `**${s.storyId}: ${s.title}** didn't complete after ${row?.attempts ?? MAX_ATTEMPTS_PER_STORY} attempts. Last problem:\n\n${problem}`,
      );
    }
    for (const s of blockedStories(stories, new Set())) {
      const open = s.dependsOn.filter((d) => {
        const dep = stories.find((x) => x.key === d);
        return !dep || !isStoryDone(dep);
      });
      const names = open.map((d) => dependencyLabel({ ...epic, stories }, d));
      lines.push(`**${s.storyId}** is blocked by ${names.join(", ")}.`);
    }
    if (all.length > 0) {
      lines.push(
        `I'll also resume on my own when ${all.map((w) => w.identifier).join(", ")} is done.`,
      );
    }
    lines.push(
      "Reply with guidance (it will be added to every story prompt) and I'll retry, or say `stop`.",
    );
    body = lines.join("\n\n");
  }
  const preparable = stories.filter(
    (s) => s.manual && (s.preparation?.length ?? 0) > 0 && !isStoryDone(s),
  );
  if (preparable.length > 0) {
    const names = preparable.map((s) => `**${s.identifier ?? s.storyId}**`).join(", ");
    body += `\n\nReply \`rerun preparation\` to be asked again about running the preparation commands of ${names}.`;
  }
  await postActivity(deps.linear, run.linearAgentSessionId, { type: "elicitation", body });
  return { action: "waiting", run: updated, waitingOn };
}
