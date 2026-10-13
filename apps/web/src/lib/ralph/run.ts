/**
 * The ralph orchestrator's run state machine (ported from cyralph's
 * `EpicEngine.run` and `finish`). Every change to a run goes through
 * `advanceRun`, which holds the run's row lock, so the webhooks, job outcomes
 * and the reconcile cron that race to move a run apply one at a time; it is
 * idempotent (calling it again with nothing new changes nothing).
 */
import {
  getHarness,
  resolveHarnessConfig,
  getMainLane,
  getRepositoryWithConnection,
  listActiveRunJobIds,
  listLanes,
  listMessages,
  listStories,
  lockRun,
  pinnedHarnessFor,
  updateLane,
  updateRun,
  updateStory,
  upsertStories,
  type Database,
  type RalphLane,
  type RalphMessage,
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
  isLinearRun,
  runReference,
  resolveRepositorySwitches,
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
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PUSH_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  WORKTREE_EXEC_JOB_TYPE,
  legacyJobRouting,
  ralphHiddenRef,
} from "@omniralph/shared";
import {
  describePrJobInput,
  MAX_ITERATIONS_PER_RUN,
  pushJobInput,
  pushTimingFor,
  ralphJobInput,
  requestTaskFor,
  requestTrigger,
  storyLimits,
  storyTaskFor,
} from "./coding";
import type { ScmAdapter } from "@omniralph/scm";
import { organizationDefinitions } from "@/lib/definitions";
import type { JobDispatcher } from "@/lib/dispatch/dispatcher";
import type { LinearGateway } from "@/lib/linear/gateway";
import { notifyRunThread } from "./chat-notify";
import {
  conversationFor,
  runCompletedEvent,
  runFailedEvent,
  type ChatSource,
  type RunConversation,
} from "./conversation";
import { gatherRunAttachments, payloadAttachments } from "./attachments";
import { reloadEpic, runEpicOptions } from "./epic-loader";
import { deleteRunHiddenRefs } from "./hidden-refs";
import { mainBranch, routeStories, storyLane, type StoryLanes } from "./lanes";
import { postActivity, quietly, tail } from "./notify";
import { settleStrandedMessages } from "./messages";
import { applyJobOutcomes, isBlockedFeedback } from "./outcome";
import { awaitRepository } from "./repository-selection";
import {
  buildDescribePrPayload,
  buildPreparePayload,
  buildPushPayload,
  buildRequestPayload,
  buildStoryPayload,
} from "./payload";
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
  finishPublishing,
  laneRows,
  lanesToPublish,
  moveCompletedEpic,
  openEarlyPullRequest,
  withPullRequestLinks,
  type PublishedLane,
} from "./publish";
import {
  applyRequestJob,
  consumeStoryRequests,
  NOTHING_TO_DO,
  pendingRequestLanes,
  runLanes,
  takeRequestOutput,
  workingOnRequestsNote,
} from "./requests";

export interface RalphDeps {
  db: Database;
  /**
   * The organization whose runs these are: routing only considers its
   * repositories, and `linear` is its Linear workspace's gateway.
   */
  organizationId: string;
  linear: LinearGateway;
  dispatcher: JobDispatcher;
  /** The code-host adapter of a repository's connection (default branch, PRs/MRs). */
  adapterFor: (db: Database, connection: ScmConnection) => ScmAdapter;
  /** Where chat runs' threads are posted through (default: the deployment's chat bot). */
  chat?: ChatSource;
}

export { MAX_ITERATIONS_PER_RUN };

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
 * Stores the epic's stories (new ones are added, known ones refreshed, with
 * their lane from `routeStories`) and syncs their status with Linear. Returns
 * the run's stories in order.
 */
export async function syncStories(
  tx: RalphTransaction | Database,
  runId: string,
  epic: Epic,
  lanes?: StoryLanes,
): Promise<RalphStory[]> {
  const byIssue = new Map(epic.stories.map((s) => [s.issueId ?? s.key, s]));
  const stored = await upsertStories(
    tx,
    runId,
    epic.stories.map((s) => ({
      linearIssueId: s.issueId ?? s.key,
      identifier: s.identifier ?? s.storyId,
      title: s.title,
      ...lanes?.get(s.issueId ?? s.key),
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

/** Posts the run's plan (every story with its status) to its conversation. */
export async function publishPlan(
  conversation: RunConversation,
  stories: readonly RalphStory[],
): Promise<void> {
  await conversation.updatePlan(planFor(stories));
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
    await publishPlan(conversationFor(run, { linear }), await listStories(tx, run.id));
  }
  return updated;
}

export type AdvanceResult =
  | { action: "gone" }
  | { action: "finished"; run: RalphRun }
  /** One of the run's jobs is queued or running: its outcome advances the run. */
  | { action: "busy"; run: RalphRun }
  | { action: "enqueued"; run: RalphRun; story: RalphStory; jobId: string }
  /** Every story is done and the story task pushes only at the end: a `ralph.push` run pushes a lane's branch. */
  | { action: "pushing"; run: RalphRun; jobId: string }
  /** Every story is done: a `ralph.describe-pr` job writes a lane's PR/MR. */
  | { action: "describing"; run: RalphRun; jobId: string }
  /** An approved manual-story preparation runs as a `worktree.exec` system RPC. */
  | { action: "preparing"; run: RalphRun; jobId: string }
  /** A lane's pending requests run as a `ralph.request` job. */
  | { action: "requesting"; run: RalphRun; jobId: string }
  | { action: "waiting"; run: RalphRun; waitingOn: RalphWaitingOn }
  | { action: "completed"; run: RalphRun }
  | { action: "failed"; run: RalphRun };

/**
 * Moves a run forward. First, under the run's row lock, replies its ended
 * job's live session never got are settled (`settleStrandedMessages`), the outcome of every
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
    // Replies the ended job's session never got become guidance (or pending requests) first.
    await settleStrandedMessages(deps.linear, tx, run);
    const stories = await applyJobOutcomes({ ...deps, tx, run });
    const pullRequest = await applyPullRequestJob(deps, tx, run);
    const preparation = await applyPreparationJob(deps, tx, run);
    const request = await applyRequestJob(deps, tx, run);
    return { busy: stories.busy || pullRequest.busy || preparation.busy || request.busy };
  });
  if (!applied) return { action: "gone" };
  const result = await lockRun(deps.db, runId, (tx, run) => step(deps, tx, run));
  // A run that's over no longer needs its hidden refs (a stopped one may resume from them).
  if (result?.action === "completed" || result?.action === "failed") {
    await deleteRunHiddenRefs(deps, result.run);
  }
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
  // Routing found no repository: the run waits until a person picks one.
  if (!run.repositoryId) {
    const asked = await awaitRepository(deps, tx, run);
    if ("failed" in asked) return failRun(deps, tx, run, asked.failed);
    return { action: "waiting", run: asked, waitingOn: { blockers: [], manual: [] } };
  }
  // A chat run has no Linear issue: only its requests run, as in request mode.
  if (!isLinearRun(run)) {
    const epic = await chatRequestEpic(tx, run);
    const [next] = await pendingRequestLanes(tx, run);
    if (next) return enqueueRequest(deps, tx, run, { epic, stories: [], ...next });
    return finishRequests(deps, tx, run);
  }
  const { linearIssueId } = run;

  const epic = await reloadEpic(deps.linear, run, await runEpicOptions(deps.db, run));
  // Stories routed to another repository get a lane there; those belonging nowhere here are manual.
  const rows = await syncStories(tx, run.id, epic, await routeStories(deps, tx, run, epic));
  const stories = storiesWithRunState(epic, rows, run.ignoreBlockers);
  // A mention: only its requests run (no story loop, no Linear state changes, no blockers).
  if (run.mode === "request") {
    const [next] = await pendingRequestLanes(tx, run);
    if (next) return enqueueRequest(deps, tx, run, { epic, stories, ...next });
    return finishRequests(deps, tx, run);
  }
  // An approved preparation ("Run it") goes first: it was asked for while nothing else could run.
  const approved = await approvedPreparation(deps, tx, run, stories);
  run = approved.run;
  if (approved.story && approved.request) {
    return enqueuePreparation(deps, tx, run, { story: approved.story, request: approved.request });
  }
  const allDone = isEpicComplete(stories);
  // A draft PR/MR once the first story is pushed (`opensPullRequestEarly`).
  if (!allDone) run = await openEarlyPullRequest(deps, tx, run, { epic, rows });
  // Blockers of the epic issue itself gate all of its stories (as in cyralph and Cyrus).
  const rootBlockers = run.ignoreBlockers
    ? []
    : openRootBlockers(epic, await deps.linear.getBlockers(linearIssueId));

  if (rootBlockers.length === 0) {
    const focused = run.focusStoryId
      ? stories.find((s) => s.issueId === run.focusStoryId && isStoryReady(s, stories))
      : undefined;
    const next = focused ?? selectNextStory(stories);
    if (next) {
      const main = run.repositoryId
        ? await getRepositoryWithConnection(deps.db, run.repositoryId)
        : null;
      const cap = (
        await storyLimits(main?.repository, organizationDefinitions(deps.db, run.organizationId))
      ).maxIterationsPerRun;
      if (run.iterations >= cap) {
        return wait(deps, tx, run, { epic, stories, rows, rootBlockers, hitCap: cap });
      }
      const row = rows.find((r) => r.linearIssueId === (next.issueId ?? next.key));
      if (row) return enqueueStory(deps, tx, run, { epic, stories, story: next, row });
    }
  }

  // No story runs now (every story is done, or the run waits): requests (e.g. "push and open
  // a PR", or a reply on a blocked epic) run directly, lane by lane (cyralph's `runAllRequests`).
  const [requests] = await pendingRequestLanes(tx, run);
  if (requests) return enqueueRequest(deps, tx, run, { epic, stories, ...requests });

  if (rootBlockers.length === 0 && allDone) {
    // The PR/MR step failed: a reply (which clears the error) retries it.
    if (run.status === "waiting" && run.error) {
      return { action: "waiting", run, waitingOn: run.waitingOn ?? { blockers: [], manual: [] } };
    }
    return publishLanes(deps, tx, run, { epic, stories, rows });
  }
  return wait(deps, tx, run, { epic, stories, rows, rootBlockers, hitCap: null });
}

/** A chat run's branch: `omniralph/chat-<id>`. */
export function chatRunBranch(run: RalphRun): string {
  return `omniralph/${runReference(run)}`;
}

/** Longest title a chat run's request jobs show (the first line of its first request). */
const MAX_CHAT_TITLE_CHARS = 120;

/**
 * What a chat run's request jobs work on in place of a Linear issue: the run
 * (`chat-<id>`), titled with the first line of its first request.
 */
async function chatRequestEpic(tx: RalphTransaction, run: RalphRun): Promise<Epic> {
  const first = (await listMessages(tx, run.id)).find((m) => m.kind === "request");
  const line = first?.text.trim().split("\n")[0]?.trim() ?? "";
  const title =
    line.length > MAX_CHAT_TITLE_CHARS ? `${line.slice(0, MAX_CHAT_TITLE_CHARS - 1)}…` : line;
  const identifier = runReference(run);
  return {
    kind: "single",
    issueId: run.id,
    identifier,
    title: title || "Request from chat",
    description: "",
    branchName: chatRunBranch(run),
    qualityGates: [],
    stories: [],
  };
}

/**
 * A harness while it may still take a run's jobs (not revoked, accepting
 * `coding` tasks itself or by the organization's default, in the run's
 * organization).
 */
async function usableHarnessId(
  db: Database,
  organizationId: string,
  harnessId: string | null,
): Promise<string | undefined> {
  if (!harnessId) return undefined;
  const agent = await getHarness(db, harnessId);
  if (
    !agent ||
    agent.revokedAt ||
    agent.organizationId !== organizationId ||
    !(await resolveHarnessConfig(db, agent)).acceptedTaskTypes.includes("coding")
  ) {
    return undefined;
  }
  return agent.id;
}

/**
 * The agent that holds a lane's worktree (the one that started its last job),
 * while it may still take the run's jobs. No pinned fallback: another agent
 * doesn't have the worktree.
 */
export async function stickyHarnessId(
  db: Database,
  run: Pick<RalphRun, "organizationId">,
  lane: Pick<RalphLane, "harnessId">,
): Promise<string | undefined> {
  return usableHarnessId(db, run.organizationId, lane.harnessId);
}

/**
 * The harness a lane's jobs go to: its sticky harness while usable (see
 * `usableHarnessId`), else one its repository is pinned to, else undefined
 * (any harness of the organization may take them).
 */
export async function laneHarnessId(
  db: Database,
  run: Pick<RalphRun, "organizationId">,
  lane: Pick<RalphLane, "harnessId" | "repositoryId">,
): Promise<string | undefined> {
  return (
    (await usableHarnessId(db, run.organizationId, lane.harnessId)) ??
    (await pinnedHarnessFor(db, run.organizationId, lane.repositoryId)) ??
    undefined
  );
}

/** Ends a run that can't go on (e.g. its repository is gone), with an error in its session. */
async function failRun(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  error: string,
): Promise<AdvanceResult> {
  const failed = (await updateRun(tx, run.id, { status: "failed", waitingOn: null, error })) ?? run;
  await postActivity(
    conversationFor(run, deps),
    { type: "error", body: error },
    { event: runFailedEvent(run) },
  );
  await notifyRunThread(deps, run, { kind: "failed", error });
  return { action: "failed", run: failed };
}

/**
 * A lane's repository while it may run ralph jobs (connected, ralph enabled),
 * or why not. Without a lane: the run's main lane, which it must have.
 */
async function laneRepository(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  given?: RalphLane,
): Promise<{ repository: Repository; connection: ScmConnection; lane: RalphLane } | string> {
  const lane = given ?? (await getMainLane(tx, run));
  const repositoryId = lane?.repositoryId ?? run.repositoryId;
  const found = repositoryId ? await getRepositoryWithConnection(deps.db, repositoryId) : null;
  const main = !lane || lane.repositoryId === run.repositoryId;
  if (!found || found.repository.disconnectedAt) {
    return main
      ? "The run's repository is no longer connected, so I stopped."
      : `\`${found?.repository.fullPath ?? repositoryId}\` is no longer connected, so I stopped.`;
  }
  if (!(await resolveRepositorySwitches(deps.db, found.repository)).coding) {
    return (
      `Coding was turned off for \`${found.repository.fullPath}\`, so I stopped. Turn it on under ` +
      "**Repository › Settings › Task types** and delegate the issue again to continue."
    );
  }
  if (!lane) return "The run has no branch in its repository, so I stopped.";
  return { ...found, lane };
}

/** Why a run on the `tasks` path can't enqueue its story or request run. */
function notACodingTask(
  taskId: string,
  repository: Pick<Repository, "fullPath">,
  what: "stories" | "requests",
): string {
  return (
    `\`${repository.fullPath}\` runs its ${what} with \`${taskId}\`, which isn't a coding task ` +
    "that takes them, so I stopped. Choose another task under **Repository › Settings › Coding**."
  );
}

/** A lane's repository while it may run ralph jobs (the main lane's by default); else the run fails. */
async function usableRepository(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  lane?: RalphLane,
): Promise<{ repository: Repository; connection: ScmConnection; lane: RalphLane } | AdvanceResult> {
  const found = await laneRepository(deps, tx, run, lane);
  return typeof found === "string" ? failRun(deps, tx, run, found) : found;
}

/**
 * Enqueues one attempt at `story` in its lane (that repository, branch, base,
 * settings and quality gates): its sub-issue moves to started and a
 * `ralph.story` job goes to the lane's harness (`laneHarnessId`: the agent
 * that started the lane's last job, else the lane repository's pinned agent,
 * else any ralph agent of its organization). On the lane
 * repository's `tasks` coding path the job is a coding run of its story task
 * (trigger `linear.delegated`, the same payload as its context); attempts are
 * capped by that task.
 */
async function enqueueStory(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; story: Story; row: RalphStory },
): Promise<AdvanceResult> {
  const { epic, story, row } = input;
  // Routed to another repository whose lane couldn't be added yet (`routeStories` logged why).
  if (story.repo && !row.laneId) {
    throw new Error(`${row.identifier} has no lane in ${story.repo.name} yet`);
  }
  const lane = await storyLane(tx, run, row);
  const found = await usableRepository(deps, tx, run, lane ?? undefined);
  if ("action" in found) return found;

  const attachments = await gatherRunAttachments(deps.linear, tx, run, epic);
  const payload = buildStoryPayload({
    run,
    lane: found.lane,
    repository: found.repository,
    connection: found.connection,
    epic,
    stories: input.stories,
    story,
    row,
    attachments: payloadAttachments(attachments, story.key),
  });
  const taskId = storyTaskFor(found.repository);
  const routed = await ralphJobInput(
    RALPH_STORY_JOB_TYPE,
    found.repository,
    { taskId, trigger: "linear.delegated" },
    payload,
    organizationDefinitions(deps.db, run.organizationId),
  );
  if (!routed) return failRun(deps, tx, run, notACodingTask(taskId, found.repository, "stories"));
  const { job, created } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_STORY_JOB_TYPE,
    ...routed,
    repositoryId: found.repository.id,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetHarnessId: await laneHarnessId(deps.db, run, found.lane),
  });
  if (!created) return { action: "busy", run };

  // New work on the lane's branch: it is published again at the finish.
  if (found.lane.publish) await updateLane(tx, found.lane.id, { publish: null });
  if (run.kind !== "single" && story.status === "open") {
    await quietly(`Starting ${row.identifier} in Linear`, () =>
      deps.linear.setIssueState(row.linearIssueId, { type: "started" }),
    );
  }
  // The story's prompt carries the thread's requests as guidance: they're handled.
  await consumeStoryRequests(tx, run);
  const running = (await updateStory(tx, row.id, { status: "running", lastJobId: job.id })) ?? row;
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      iterations: run.iterations + 1,
      waitingOn: null,
      error: null,
    })) ?? run;
  await publishPlan(conversationFor(run, deps), await listStories(tx, run.id));
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `▶️ **${row.identifier}: ${row.title}** (attempt ${payload.attempt}/${(await storyLimits(found.repository, organizationDefinitions(deps.db, run.organizationId))).maxAttemptsPerStory})`,
  });
  return { action: "enqueued", run: updated, story: running, jobId: job.id };
}

/**
 * Every story is done: each lane to publish (`lanesToPublish`: those with
 * commits or a PR/MR) gets a `ralph.describe-pr` job in turn (`describeLane`),
 * whose outcome opens or updates its PR/MR (`applyPullRequestJob`). A lane
 * whose story task pushes only at the end (`pushTimingFor`) first gets a
 * `ralph.push` run that pushes its branch with the story commits of the run's
 * hidden ref (`pushLane`). Once every lane is through, `finishPublishing`
 * completes the run or, when one failed, waits for a reply. A run none of
 * whose stories committed anything, and without a PR/MR, has nothing to
 * open: it completes.
 */
async function publishLanes(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; rows: RalphStory[] },
): Promise<AdvanceResult> {
  const lanes = lanesToPublish(await listLanes(tx, run.id), input.rows, run);
  if (lanes.length === 0) return complete(deps, tx, run, input);
  const through: PublishedLane[] = [];
  for (const lane of lanes) {
    const status = lane.publish?.status ?? null;
    // Not published since its last story, just pushed, or its push or describe job was dropped (a stop).
    if (status !== "published" && status !== "failed") {
      const found = await laneRepository(deps, tx, run, lane);
      const push = status === null || status === "pushing";
      const described =
        typeof found === "string"
          ? found
          : push &&
              (await pushTimingFor(
                found.repository,
                organizationDefinitions(deps.db, run.organizationId),
              )) === "end"
            ? await pushLane(deps, tx, run, { ...input, ...found, lanes })
            : await describeLane(deps, tx, run, { ...input, ...found, lanes });
      if (typeof described !== "string") return described;
      // A lane whose repository can't take jobs any more (or describe its PR/MR) is a problem of that lane.
      const failed = await updateLane(tx, lane.id, {
        publish: { status: "failed", problem: described },
      });
      through.push({ lane: failed ?? lane, repository: await laneRepositoryName(deps, lane) });
      continue;
    }
    through.push({ lane, repository: await laneRepositoryName(deps, lane) });
  }
  const epic = { identifier: input.epic.identifier, title: input.epic.title, url: input.epic.url };
  await publishPlan(conversationFor(run, deps), input.rows);
  const finished = await finishPublishing(deps, tx, run, {
    epic,
    rows: input.rows,
    lanes: through,
  });
  return finished.status === "completed"
    ? { action: "completed", run: finished }
    : {
        action: "waiting",
        run: finished,
        waitingOn: finished.waitingOn ?? { blockers: [], manual: [] },
      };
}

/** A lane's repository's provider and full path (kept when it's disconnected). */
async function laneRepositoryName(
  deps: RalphDeps,
  lane: RalphLane,
): Promise<PublishedLane["repository"]> {
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  return found?.repository ?? { provider: "github", fullPath: lane.repositoryId };
}

/** "All 3 stories are done" (or "**ENG-1** is done" for a single issue). */
function doneNote(run: RalphRun, input: { epic: Epic; stories: Story[] }): string {
  return run.kind === "single"
    ? `**${input.epic.identifier}** is done`
    : `All ${input.stories.length} ${input.stories.length === 1 ? "story is" : "stories are"} done`;
}

/**
 * Pushes one lane's branch before it is described, for a story task that
 * pushes only at the end: a `ralph.push` coding run of the lane repository's
 * story task with no session (on the lane's harness), which prepares the
 * lane's worktree from the run's hidden ref and pushes the branch with its
 * lifecycle token. Its outcome is applied by `applyPullRequestJob`; then the
 * lane is described. Returns the lane's problem when the story task can't run it.
 */
async function pushLane(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: {
    epic: Epic;
    stories: Story[];
    rows: RalphStory[];
    lanes: RalphLane[];
    repository: Repository;
    connection: ScmConnection;
    lane: RalphLane;
  },
): Promise<AdvanceResult | string> {
  const { lane, repository, connection } = input;
  const routing = await pushJobInput(
    repository,
    buildPushPayload({ run, lane, repository, connection, hiddenRef: ralphHiddenRef(run.id) }),
    organizationDefinitions(deps.db, run.organizationId),
  );
  if (!routing) {
    return `I couldn't push \`${lane.branch}\`: ${notACodingTask(storyTaskFor(repository), repository, "stories")}`;
  }
  const { job, created } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_PUSH_JOB_TYPE,
    ...routing,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetHarnessId: await laneHarnessId(deps.db, run, lane),
  });
  if (!created) return { action: "busy", run };
  await updateLane(tx, lane.id, { publish: { status: "pushing", jobId: job.id } });
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      prJobId: job.id,
      waitingOn: null,
      error: null,
    })) ?? run;
  await publishPlan(conversationFor(run, deps), input.rows);
  const where = input.lanes.length > 1 ? ` in \`${repository.fullPath}\`` : "";
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `${doneNote(run, input)}. Pushing \`${lane.branch}\`${where}.`,
  });
  return { action: "pushing", run: updated, jobId: job.id };
}

/**
 * One lane's describe job (on the lane's harness), with the stories
 * worked in that lane: it writes the lane's PR/MR title and body. On the
 * `tasks` path a query run of the story task's `prDescriptionTaskId`
 * (`describePrJobInput`), otherwise a `ralph.describe-pr` job. Returns the
 * lane's problem when the repository's description task can't run.
 */
async function describeLane(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: {
    epic: Epic;
    stories: Story[];
    rows: RalphStory[];
    lanes: RalphLane[];
    repository: Repository;
    connection: ScmConnection;
    lane: RalphLane;
  },
): Promise<AdvanceResult | string> {
  const { lane, repository, connection } = input;
  const main = input.lanes.find((l) => l.repositoryId === run.repositoryId) ?? null;
  const term = changeRequestTerm(repository.provider);
  const routing = await describePrJobInput(
    repository,
    buildDescribePrPayload({
      run,
      lane,
      repository,
      connection,
      epic: input.epic,
      rows: laneRows(input.rows, lane, main),
    }),
    organizationDefinitions(deps.db, run.organizationId),
  );
  if (typeof routing === "string") {
    return `I couldn't open the ${term}: writing its description failed: ${routing}.`;
  }
  const { job, created } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_DESCRIBE_PR_JOB_TYPE,
    ...routing,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetHarnessId: await laneHarnessId(deps.db, run, lane),
  });
  if (!created) return { action: "busy", run };
  await updateLane(tx, lane.id, { publish: { status: "describing", jobId: job.id } });
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      prJobId: job.id,
      waitingOn: null,
      error: null,
    })) ?? run;
  await publishPlan(conversationFor(run, deps), input.rows);
  const where = input.lanes.length > 1 ? ` of \`${repository.fullPath}\`` : "";
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `${doneNote(run, input)}. Writing the ${term} description${where}.`,
  });
  return { action: "describing", run: updated, jobId: job.id };
}

/**
 * Runs an approved manual-story preparation: a `worktree.exec` system RPC (the
 * run's one job, on its lane's agent, `laneHarnessId`; on both coding paths)
 * with the story's commands as they are now and the approval they must match. Its outcome is
 * applied by `applyPreparationJob`.
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
    organizationId: run.organizationId,
    // A system RPC: no session and no pool; its token only reads the repository.
    type: WORKTREE_EXEC_JOB_TYPE,
    ...legacyJobRouting(WORKTREE_EXEC_JOB_TYPE),
    payload: buildPreparePayload({
      run,
      ...found,
      story,
      approved: { commandsHash: request.commandsHash, headSha: request.headSha },
    }),
    repositoryId: run.repositoryId,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetHarnessId: await laneHarnessId(deps.db, run, found.lane),
  });
  if (!created) return { action: "busy", run };
  const state = preparationOf(run);
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      waitingOn: null,
      preparation: { ...state, request: { ...request, jobId: job.id } },
    })) ?? run;
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `Running the preparation of **${request.identifier}: ${request.title}** on \`${found.lane.branch}\`.`,
  });
  return { action: "preparing", run: updated, jobId: job.id };
}

/**
 * Runs a lane's pending requests (cyralph's `runRequests`): a `ralph.request`
 * job in the lane's branch worktree, on the lane's harness. It resumes
 * the lane's last request conversation only when it goes to the agent that
 * holds it. Its outcome is applied by `applyRequestJob`. Request jobs don't
 * count towards the iteration cap. On the repository's `tasks` coding path
 * the job is a coding run of `requestTaskFor` (triggered by the oldest
 * request's origin, the same payload as its context).
 */
async function enqueueRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; lane: RalphLane; requests: RalphMessage[] },
): Promise<AdvanceResult> {
  const found = await usableRepository(deps, tx, run, input.lane);
  if ("action" in found) return found;
  const { lane, repository, connection } = found;
  const targetHarnessId = await laneHarnessId(deps.db, run, lane);
  const resume =
    lane.requestClaudeSessionId && targetHarnessId && lane.requestHarnessId === targetHarnessId
      ? lane.requestClaudeSessionId
      : null;
  // Attachments are Linear's; a chat run has none.
  const attachments = isLinearRun(run)
    ? await gatherRunAttachments(deps.linear, tx, run, input.epic)
    : [];
  const payload = buildRequestPayload({
    run,
    lane,
    repository,
    connection,
    epic: input.epic,
    stories: input.stories,
    requests: input.requests,
    resumeSessionId: resume,
    attachments: payloadAttachments(attachments),
    // Story commits may only be on the run's hidden ref yet: the request starts from them.
    ...((await pushTimingFor(repository, organizationDefinitions(deps.db, run.organizationId))) ===
      "end" && {
      hiddenRef: ralphHiddenRef(run.id),
    }),
  });
  const taskId = requestTaskFor(run, repository);
  const routed = await ralphJobInput(
    RALPH_REQUEST_JOB_TYPE,
    repository,
    { taskId, trigger: requestTrigger(input.requests) },
    payload,
    organizationDefinitions(deps.db, run.organizationId),
  );
  if (!routed) return failRun(deps, tx, run, notACodingTask(taskId, repository, "requests"));
  const { job, created } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_REQUEST_JOB_TYPE,
    ...routed,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetHarnessId,
  });
  if (!created) return { action: "busy", run };
  const updated = (await updateRun(tx, run.id, { status: "running", requestJobId: job.id })) ?? run;
  const other = lane.repositoryId !== run.repositoryId ? repository.fullPath : null;
  // The updated run names the new job: in chat, it starts the job's own status message.
  await postActivity(conversationFor(updated, deps), {
    type: "thought",
    body: workingOnRequestsNote(input.requests.length, other),
  });
  return { action: "requesting", run: updated, jobId: job.id };
}

/**
 * A request-mode run whose requests are all done completes with what they
 * said and its PR/MR links (cyralph's `runRequestOnly`); one that had none
 * says there was nothing to do.
 */
async function finishRequests(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<AdvanceResult> {
  const output = await takeRequestOutput(tx, run);
  const completed =
    (await updateRun(tx, run.id, { status: "completed", waitingOn: null, error: null })) ?? run;
  const lanes = await runLanes(deps, tx, run);
  await postActivity(
    conversationFor(run, deps),
    { type: "response", body: output ? withPullRequestLinks(output, lanes) : NOTHING_TO_DO },
    { event: runCompletedEvent(run) },
  );
  await notifyRunThread(deps, run, { kind: "completed", lanes });
  return { action: "completed", run: completed };
}

/** Every story is done and there is nothing to open a PR/MR for: the run completes. */
async function complete(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: Story[]; rows: RalphStory[] },
): Promise<AdvanceResult> {
  const output = await takeRequestOutput(tx, run);
  const completed =
    (await updateRun(tx, run.id, { status: "completed", waitingOn: null, error: null })) ?? run;
  await publishPlan(conversationFor(run, deps), input.rows);
  const lanes = await runLanes(deps, tx, run);
  await notifyRunThread(deps, run, { kind: "completed", lanes });
  if (output) {
    await postActivity(
      conversationFor(run, deps),
      { type: "response", body: withPullRequestLinks(output, lanes) },
      { event: runCompletedEvent(run) },
    );
    await moveCompletedEpic(deps, run);
    return { action: "completed", run: completed };
  }
  const what =
    run.kind === "single"
      ? `**${input.epic.identifier}**`
      : `all ${input.stories.length} ${input.stories.length === 1 ? "story" : "stories"} of **${input.epic.identifier}**`;
  await postActivity(
    conversationFor(run, deps),
    {
      type: "response",
      body: `Finished ${what} on \`${await mainBranch(tx, run)}\`. Nothing was committed, so there is no pull/merge request.`,
    },
    { event: runCompletedEvent(run) },
  );
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
    /** The iteration cap the run reached, else null. */
    hitCap: number | null;
  },
): Promise<AdvanceResult> {
  const { epic, stories, rows, rootBlockers, hitCap } = input;
  // What requests did while the run waits (e.g. on blockers) is told before what it waits on.
  const output = await takeRequestOutput(tx, run);
  if (output) {
    await postActivity(conversationFor(run, deps), { type: "thought", body: output });
  }
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
  await publishPlan(conversationFor(run, deps), rows);
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
  } else if (hitCap === null && stuck.length === 0 && all.length > 0) {
    body = [
      `${done}/${stories.length} stories are done; the rest are waiting on ${bold(all)}. ${automatic(all)}`,
      startAnyway,
    ].join("\n\n");
  } else {
    const feedback = new Map(rows.map((r) => [r.linearIssueId, r]));
    const lines = [
      `Paused with ${done}/${stories.length} stories complete on \`${await mainBranch(tx, run)}\`.`,
    ];
    if (hitCap !== null) {
      lines.push(
        `I reached the per-run iteration cap (${hitCap} story attempts). Reply \`/continue\` to reset it and keep going; anything after \`/continue\` is added as guidance. Or say \`stop\`.`,
      );
    }
    for (const s of stuck) {
      const row = feedback.get(s.issueId ?? s.key);
      const problem = tail(row?.lastFeedback ?? "unknown", 1500);
      lines.push(
        isBlockedFeedback(row?.lastFeedback)
          ? `**${s.storyId}: ${s.title}** is blocked:\n\n${problem}`
          : `**${s.storyId}: ${s.title}** didn't complete after ${row?.attempts ?? MAX_ATTEMPTS_PER_STORY} attempts. Last problem:\n\n${problem}`,
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
    if (hitCap === null) {
      lines.push(
        "Reply with guidance (it will be added to every story prompt) and I'll retry, or say `stop`.",
      );
    }
    body = lines.join("\n\n");
  }
  const preparable = stories.filter(
    (s) => s.manual && (s.preparation?.length ?? 0) > 0 && !isStoryDone(s),
  );
  if (preparable.length > 0) {
    const names = preparable.map((s) => `**${s.identifier ?? s.storyId}**`).join(", ");
    body += `\n\nReply \`rerun preparation\` to be asked again about running the preparation commands of ${names}.`;
  }
  await postActivity(conversationFor(run, deps), { type: "elicitation", body });
  return { action: "waiting", run: updated, waitingOn };
}
