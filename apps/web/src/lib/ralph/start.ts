/**
 * Starts a ralph run for a new Linear agent session (ported from cyralph's
 * `SessionManager.onCreated` and the start of `EpicEngine.run`): tells a
 * delegation from a mention, loads (and materializes) the epic, routes it to a
 * repository (or, when routing finds none, asks which to use and waits for the
 * answer), creates the run and its stories (carrying over the branch, PR,
 * guidance and progress of an earlier run of the same issue), moves the epic
 * to started and hands the run to `advanceRun`.
 */
import {
  copyLanes,
  createRun,
  getMainLane,
  getRepositoryWithConnection,
  getRunByIssue,
  getRunBySession,
  linearSessionOf,
  listActiveRunJobIds,
  listRalphRepositories,
  listStories,
  lockRun,
  moveToRepository,
  updateLane,
  updateRun,
  updateStory,
  takeChatLinearDelegation,
  type RalphLane,
  type RalphRun,
  type RalphRunMode,
  type RalphTransaction,
  type Repository,
  type RepositoryWithSwitches,
} from "@omniralph/db";
import {
  hasOpenQuestions,
  parseInstruction,
  parseShipRequest,
  SHIP_REQUEST_TEXT,
  type Epic,
} from "@omniralph/ralph";
import { bumpHarnessHeartbeat } from "@/lib/harnesses/heartbeat-cache";
import type { ActivityContent, IssueSummary } from "@/lib/linear/gateway";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { createRouter, routedRepository, type Router } from "@/lib/routing/resolve";
import { blockedLabelsMessage, blockingLabels } from "./blocked-labels";
import { notifyRunThread } from "./chat-notify";
import { linearConversation } from "./conversation";
import {
  loadEpic,
  repositoryAllowsPreparation,
  repositoryManualLabels,
  type LoadedEpic,
} from "./epic-loader";
import { routeStories } from "./lanes";
import { applyGuidance, deliverToRunningJob } from "./messages";
import { postActivity, quietly } from "./notify";
import { preparationOf } from "./preparation";
import {
  askForRepository,
  leftBehind,
  leftBehindNote,
  ROUTED_BY_SELECTION,
} from "./repository-selection";
import { addInstruction, NOTHING_TO_DO, PASSED_TO_RUNNING_JOB } from "./requests";
import { markRalphActive } from "./active";
import { advanceRun, FINISHED_RUN_STATUSES, syncStories, type RalphDeps } from "./run";

export type SessionCreatedEvent = Extract<LinearWebhookEvent, { kind: "session_created" }>;

export type StartRunDeps = RalphDeps;

/**
 * Linear always fills `agentSession.comment.body`; for a delegation (not an
 * @mention) it holds a system note containing this marker (cyralph and Cyrus
 * tell the two apart the same way).
 */
export const AGENT_SESSION_MARKER = "This thread is for an agent session";

/** The acknowledgement posted before the webhook responds. */
export const ACKNOWLEDGEMENT = "On it…";

/** Whether a new agent session comes from a mention rather than a delegation. */
export function isMention(event: Pick<SessionCreatedEvent, "commentBody">): boolean {
  const body = event.commentBody?.trim();
  return !!body && !body.includes(AGENT_SESSION_MARKER);
}

export type StartOutcome =
  /** A mention without a request: nothing to do. */
  | { status: "nothing" }
  /** A mention handed to the issue's run (its running job, or its pending requests). */
  | { status: "delivered"; run: RalphRun; live: boolean }
  | { status: "load_failed"; error: string }
  /** An epic-mode start on an issue (or epic) whose PRD still has open questions: no run. */
  | { status: "open_questions"; identifier: string }
  /** The issue (or its epic) has a label its repository's blocked labels name: no run. */
  | { status: "blocked_labels"; labels: string[] }
  /** No ralph-enabled repository at all. */
  | { status: "unroutable" }
  /** The issue routes to a repository with coding off: it's for a person, so no run. */
  | { status: "manual"; repository: string }
  /** Routing found no repository: the run waits for a person to pick one. */
  | { status: "selecting"; run: RalphRun }
  | { status: "already_running"; run: RalphRun }
  | { status: "failed"; error: string }
  | { status: "started"; run: RalphRun; created: boolean };

/** Posts to a Linear agent session (a new one may not be its run's), logging a failure. */
async function post(deps: RalphDeps, sessionId: string, content: ActivityContent): Promise<void> {
  await postActivity(linearConversation(deps.linear, sessionId), content);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The error for an issue no repository can build: none has coding on. */
export function unroutableMessage(epic: Pick<Epic, "identifier">): string {
  return [
    `I can't build **${epic.identifier}**: no repository has coding on.`,
    "Turn coding on for a repository under **Repository › Settings › Task types** (and add a " +
      "rule that routes this issue to it under **Settings › Routing**). Then delegate it to me again.",
  ].join("\n\n");
}

/** The response refusing to build an issue that routes to a repository with coding off. */
export function manualRouteMessage(route: ManualRoute): string {
  const how = route.rule !== undefined ? `rule ${route.rule}` : route.by;
  return `This routes to \`${route.manual.fullPath}\` (${how}), which has coding off, so it's for a person.`;
}

/** The response refusing to build an issue whose PRD still has open questions. */
export function openQuestionsMessage(
  issue: Pick<IssueSummary, "identifier">,
  epic?: boolean,
  then = "Then delegate it to me again.",
): string {
  const what = epic ? `the epic **${issue.identifier}**` : `**${issue.identifier}**`;
  return [
    `I won't build this yet: the PRD of ${what} still has open questions (its \`## Open Questions\` section).`,
    "Answer them in the description (and remove the section), or reply in the triage session so " +
      `triage folds the answers into the PRD. ${then}`,
  ].join("\n\n");
}

/**
 * Before an epic-mode run starts: the issue whose description (or, for a
 * sub-issue, whose parent epic's description) still has open questions. Null
 * when neither has any. Throws when Linear can't be read, so callers refuse
 * rather than start a PRD whose questions went unchecked.
 */
export async function withOpenQuestions(
  deps: Pick<RalphDeps, "linear">,
  issueId: string,
): Promise<{ issue: IssueSummary; epic: boolean } | null> {
  const issue = await deps.linear.getIssue(issueId);
  if (hasOpenQuestions(issue.description)) return { issue, epic: false };
  if (!issue.parentId) return null;
  const parent = await deps.linear.getIssue(issue.parentId);
  return hasOpenQuestions(parent.description) ? { issue: parent, epic: true } : null;
}

/** The error posted when the open-questions check can't read Linear. */
export function openQuestionsCheckFailedMessage(error: unknown, then: string): string {
  return `I couldn't check the issue for open questions in Linear, so I didn't start: ${message(error)}. ${then}`;
}

/** Refuses an epic-mode start while open questions remain (posting why); null when it may start. */
async function refuseOpenQuestions(
  deps: RalphDeps,
  event: SessionCreatedEvent,
): Promise<StartOutcome | null> {
  let found: Awaited<ReturnType<typeof withOpenQuestions>>;
  try {
    found = await withOpenQuestions(deps, event.issueId);
  } catch (error) {
    console.error(`Checking open questions of ${event.issueId} failed`, error);
    await post(deps, event.sessionId, {
      type: "error",
      body: openQuestionsCheckFailedMessage(error, "Delegate or mention me again to retry."),
    });
    return { status: "load_failed", error: message(error) };
  }
  if (!found) return null;
  await post(deps, event.sessionId, {
    type: "response",
    body: openQuestionsMessage(found.issue, found.epic),
  });
  return { status: "open_questions", identifier: found.issue.identifier };
}

/**
 * Refuses a new run of an issue that routes to a repository with coding off,
 * or that carries (itself, or through its epic) a blocked label of the
 * repository it routes to (posting why). Unrouted, the repositories that don't
 * block it are the ones a person may pick, and it's refused when every one
 * does. Throws when Linear can't be read.
 */
async function refuseUnbuildable(
  deps: RalphDeps,
  event: SessionCreatedEvent,
  repositories: readonly RepositoryWithSwitches[],
  router: Router,
): Promise<{ refused: StartOutcome } | { candidates: RepositoryWithSwitches[] }> {
  const issue = await deps.linear.getIssue(event.issueId);
  const parent = issue.parentId ? await deps.linear.getIssue(issue.parentId) : null;
  const root = parent ?? issue;
  const issues = parent ? [issue, parent] : [issue];
  const previous = await getRunByIssue(deps.db, deps.organizationId, root.id);
  const chosen = await chooseRepository(root, repositories, previous, router);
  if (chosen && "manual" in chosen) return { refused: await refuseManual(deps, event, chosen) };
  if (repositories.length === 0) return { candidates: [] };
  const refuse = async (labels: string[], repositoryPath?: string) => {
    await post(deps, event.sessionId, {
      type: "response",
      body: blockedLabelsMessage(issue, labels, repositoryPath),
    });
    return { refused: { status: "blocked_labels", labels } as StartOutcome };
  };
  if (chosen) {
    const labels = blockingLabels(issues, chosen.repository);
    return labels.length > 0
      ? refuse(labels, chosen.repository.fullPath)
      : { candidates: [...repositories] };
  }
  const candidates = repositories.filter((r) => blockingLabels(issues, r).length === 0);
  if (candidates.length > 0) return { candidates };
  return refuse(blockingLabels(issues, repositories[0]!));
}

/** Posts why an issue that routes to a repository with coding off isn't built. */
async function refuseManual(
  deps: RalphDeps,
  event: SessionCreatedEvent,
  route: ManualRoute,
): Promise<StartOutcome> {
  await post(deps, event.sessionId, { type: "response", body: manualRouteMessage(route) });
  return { status: "manual", repository: route.manual.fullPath };
}

/** The repository a run works in and how it was chosen. */
export interface ChosenRepository {
  repository: Repository;
  routedBy: string;
}

/** The issue routes to a repository with coding off (`rule`: the custom rule that matched). */
export interface ManualRoute {
  manual: Repository;
  by: string;
  rule?: number;
}

/**
 * The repository for a (re-)delegated issue (cyralph's `resolveRepo`): one a
 * person picked for the previous run stays while it has ralph enabled; else
 * routing decides (`resolveRoute`), possibly that it's manual; else (routing
 * would have to ask) the previous run's repository stays. Null: nothing
 * decides, so a person is asked.
 */
export async function chooseRepository(
  root: Pick<IssueSummary, "id">,
  repositories: readonly RepositoryWithSwitches[],
  previous: Pick<RalphRun, "repositoryId" | "routedBy"> | null,
  router: Router,
): Promise<ChosenRepository | ManualRoute | null> {
  const current = previous?.repositoryId
    ? repositories.find((r) => r.id === previous.repositoryId)
    : undefined;
  if (current && previous?.routedBy === ROUTED_BY_SELECTION) {
    return { repository: current, routedBy: ROUTED_BY_SELECTION };
  }
  const route = await router.resolve(root.id);
  if ("repository" in route) return { repository: route.repository, routedBy: route.by };
  if ("manual" in route) return route;
  if (current) return { repository: current, routedBy: previous?.routedBy ?? "the previous run" };
  return null;
}

/** The thought describing what the run will do (cyralph's `describeEpic`). */
export function describeRun(
  loaded: LoadedEpic,
  chosen: ChosenRepository,
  lane: Pick<RalphLane, "branch" | "baseBranch" | "prUrl">,
  carriedOver: boolean,
): string {
  const { epic } = loaded;
  const done = epic.stories.filter((s) => s.status === "completed" || s.status === "cancelled");
  const kind =
    epic.kind === "single"
      ? "a single issue, so I'll treat it as one story"
      : `an epic with ${epic.stories.length} ${epic.stories.length === 1 ? "story" : "stories"} (${done.length} already done)`;
  const lines = [
    `**${epic.identifier}** is ${kind}. Building it in \`${chosen.repository.fullPath}\` ` +
      `(routed by ${chosen.routedBy}) on branch \`${lane.branch}\`, ` +
      `based on \`${lane.baseBranch}\`.`,
  ];
  if (loaded.materialized > 0) {
    lines.push(`Created ${loaded.materialized} story sub-issues from the PRD in the description.`);
  }
  if (loaded.focusStoryId) {
    const story = epic.stories.find((s) => s.issueId === loaded.focusStoryId);
    lines.push(
      `This issue is one story of the epic, so I'll start with ${story?.storyId ?? "it"}.`,
    );
  }
  if (carriedOver) {
    lines.push(
      `Picking up where the previous session for this issue left off` +
        `${lane.prUrl ? ` (${lane.prUrl})` : ""}, with its guidance.`,
    );
  }
  const open = epic.stories.filter((s) => s.status !== "completed" && s.status !== "cancelled");
  for (const s of open.filter((x) => x.repo && !x.manual)) {
    lines.push(
      `**${s.storyId}** belongs in \`${s.repo?.name}\` (routed by ${s.repo?.routedBy}), so I'll ` +
        "work it there, on its own branch and its own pull/merge request.",
    );
  }
  for (const s of open.filter((x) => x.elsewhere)) {
    lines.push(
      `**${s.storyId}** isn't built here (${s.elsewhere}), so I'll treat it like a ` +
        "manual step: I won't work it, and stories that depend on it wait until it's done.",
    );
  }
  const manual = open.filter((s) => s.manual && !s.elsewhere);
  if (manual.length > 0) {
    lines.push(
      `Manual steps for a person: ${manual.map((s) => `**${s.storyId}**${s.repo ? ` (in \`${s.repo.name}\`)` : ""}`).join(", ")}. ` +
        "I won't work them, and stories that depend on them wait until they're done.",
    );
  }
  return lines.join("\n\n");
}

/**
 * Stops an unfinished run of the same issue from another agent session (the
 * issue was delegated again) the way a stop reply does (running stories back
 * to pending, the PR step and preparation question dropped), cancels its jobs
 * and points its session at the new one.
 */
async function supersede(deps: RalphDeps, previous: RalphRun, sessionId: string): Promise<void> {
  const jobIds = await lockRun(deps.db, previous.id, async (tx, run) => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return null;
    const state = preparationOf(run);
    await updateRun(tx, run.id, {
      status: "stopped",
      waitingOn: null,
      pendingElicitation: null,
      prJobId: null,
      requestJobId: null,
      preparation: { ...state, request: null },
      error: `Superseded by agent session ${sessionId}`,
    });
    for (const story of await listStories(tx, run.id)) {
      if (story.status === "running") await updateStory(tx, story.id, { status: "pending" });
    }
    return listActiveRunJobIds(tx, run.id);
  });
  if (!jobIds) return;
  for (const jobId of jobIds) {
    await quietly(`Canceling job ${jobId} of coding task ${previous.id}`, () =>
      deps.dispatcher.cancel(jobId),
    );
  }
  const prUrl = (await getMainLane(deps.db, previous))?.prUrl;
  const pr = prUrl ? ` The open draft stays where it is: ${prUrl}` : "";
  const previousSessionId = linearSessionOf(previous);
  if (previousSessionId === null) return;
  await post(deps, previousSessionId, {
    type: "response",
    body: `This issue was delegated to me again, so I stopped here and continue in the new session.${pr}`,
  });
}

/**
 * A new run takes over the previous run's guidance, progress and lanes (its
 * branches and PRs/MRs), except the lane in `exceptRepositoryId`.
 */
async function carryOver(
  tx: RalphTransaction,
  run: RalphRun,
  previous: RalphRun | null,
  exceptRepositoryId?: string | null,
): Promise<RalphRun> {
  if (!previous) return run;
  await copyLanes(tx, previous.id, run.id, { exceptRepositoryId });
  return (
    (await updateRun(tx, run.id, {
      guidance: previous.guidance,
      progress: previous.progress,
    })) ?? run
  );
}

/**
 * Routing found no repository (cyralph's repository question): the run is
 * created waiting, without a repository, with the ralph-enabled repositories
 * as its `pending_elicitation`, and a `select` elicitation asks which to use.
 * The answer (`answerRepositorySelection`) starts it.
 */
async function askForRepositoryFirst(
  deps: StartRunDeps,
  input: {
    event: SessionCreatedEvent;
    loaded: LoadedEpic;
    previous: RalphRun | null;
    repositories: readonly RepositoryWithSwitches[];
    start: StartOptions;
  },
): Promise<StartOutcome> {
  const { event, loaded, previous, repositories, start } = input;
  const { epic, root } = loaded;
  const { run, created } = await deps.db.transaction(async (tx) => {
    const result = await createRun(tx, {
      organizationId: deps.organizationId,
      linearIssueId: root.id,
      linearIdentifier: root.identifier,
      linearTitle: root.title,
      linearUrl: root.url,
      linearAgentSessionId: event.sessionId,
      kind: loaded.kind,
      mode: start.mode,
      focusStoryId: loaded.focusStoryId ?? null,
      // The main lane is added with the repository.
      repositoryId: null,
      status: "waiting",
      pendingElicitation: { kind: "repository", repositoryIds: repositories.map((r) => r.id) },
      chatThreadId: await delegatingThread(tx, deps, event),
    });
    if (!result.created) return result;
    // Like v2a, the previous main lane's PR/MR isn't carried over to a repository a person picks.
    const run = await carryOver(tx, result.run, previous, previous?.repositoryId);
    await syncStories(tx, run.id, epic);
    await addStartInstruction(tx, run, start);
    return { run, created: true };
  });
  await markRalphActive();
  if (!created) {
    if (run.linearAgentSessionId === event.sessionId) await advanceRun(run.id, deps);
    else {
      await post(deps, event.sessionId, {
        type: "response",
        body: `**${root.identifier}** is already being built in another session.`,
      });
      return { status: "already_running", run };
    }
    return { status: "started", run, created: false };
  }
  await askForRepository(linearConversation(deps.linear, event.sessionId), repositories);
  await notifyRunThread(deps, run, { kind: "started" });
  return { status: "selecting", run };
}

/**
 * The chat thread that delegated the issue (`delegate_linear_issue`, or the
 * issue card's **Create and delegate**) within the last hour, taken so only
 * this run is tied to it. Null for a mention, or a delegation made in Linear.
 */
async function delegatingThread(
  tx: RalphTransaction,
  deps: StartRunDeps,
  event: SessionCreatedEvent,
): Promise<string | null> {
  if (isMention(event)) return null;
  const delegation = await takeChatLinearDelegation(tx, {
    organizationId: deps.organizationId,
    linearIssueId: event.issueId,
  });
  return delegation?.threadId ?? null;
}

/** How a new run starts: a delegation (or `/coding`) builds the epic; a mention does what it asks. */
interface StartOptions {
  mode: RalphRunMode;
  /** The mention's instruction (without `/coding` and the leading `@name`; `ship` for `/ship`). */
  instruction?: { text: string; author: string | null; wantsLoop: boolean; ship?: boolean };
}

/** A mention's instruction becomes the new run's first pending request (and guidance with `/coding`). */
async function addStartInstruction(
  tx: RalphTransaction,
  run: RalphRun,
  start: StartOptions,
): Promise<void> {
  if (!start.instruction?.text) return;
  await addInstruction(
    tx,
    run,
    { ...start.instruction, wantsLoop: false, trigger: "linear.mention" },
    applyGuidance,
  );
}

/** Handles `AgentSessionEvent.created` (after the acknowledgement was posted). */
export async function startRun(
  event: SessionCreatedEvent,
  deps: StartRunDeps,
): Promise<StartOutcome> {
  const { db } = deps;

  // A redelivered or repeated event: the session already has its run.
  const existing = await getRunBySession(db, event.sessionId);
  if (existing) {
    await advanceRun(existing.id, deps);
    return { status: "started", run: existing, created: false };
  }
  if (isMention(event)) return startMention(event, deps);
  const refused = await refuseOpenQuestions(deps, event);
  if (refused) return refused;
  return startNewRun(event, deps, { mode: "epic" });
}

/**
 * An @mention (cyralph's `onCreated`): like Cyrus, it addresses its comment.
 * A bare mention does nothing. On an issue whose run is working right now,
 * the text goes to that run: into its running job's live session, or else as
 * a request (or `/coding`) for it, and that session answers. Otherwise a new
 * run starts in request mode (`/coding`: epic mode, the text as guidance),
 * carrying over the issue's earlier run.
 */
async function startMention(event: SessionCreatedEvent, deps: StartRunDeps): Promise<StartOutcome> {
  const parsed = parseInstruction(event.commentBody);
  const { wantsLoop } = parsed;
  // `/ship [notes]`: a ship request, never handed to a running session.
  const shipNotes = wantsLoop ? null : parseShipRequest(parsed.text);
  const ship = shipNotes !== null;
  const text = ship ? shipNotes || SHIP_REQUEST_TEXT : parsed.text;
  const author = event.creatorName ?? null;
  if (!text && !wantsLoop) {
    await post(deps, event.sessionId, { type: "response", body: NOTHING_TO_DO });
    return { status: "nothing" };
  }
  let root: IssueSummary;
  try {
    // Only to find the issue's run: a mention never creates story issues here.
    root = (await loadEpic(deps.linear, event.issueId, { materialize: false })).root;
  } catch (error) {
    await post(deps, event.sessionId, {
      type: "error",
      body: `I couldn't load the issue from Linear: ${message(error)}`,
    });
    return { status: "load_failed", error: message(error) };
  }
  const active = await getRunByIssue(deps.db, deps.organizationId, root.id, {
    activeOnly: true,
  });
  if (active) {
    // `/coding` on a mention's run switches it to the story loop: an epic-mode start.
    if (wantsLoop && active.mode === "request") {
      const refused = await refuseOpenQuestions(deps, event);
      if (refused) return refused;
    }
    const handed = await lockRun(deps.db, active.id, async (tx, run) => {
      if (FINISHED_RUN_STATUSES.has(run.status)) return null;
      // The epic is being worked right now: hand the mention to that live agent.
      const delivered =
        text && !wantsLoop && !ship
          ? await deliverToRunningJob(tx, run, text, author ?? undefined, "linear.mention")
          : null;
      if (delivered) return { live: true, harnessId: delivered.harnessId };
      await addInstruction(
        tx,
        run,
        { text, author, wantsLoop, ship, trigger: "linear.mention" },
        applyGuidance,
      );
      return { live: false, harnessId: null };
    });
    if (handed) {
      if (handed.live) await bumpHarnessHeartbeat(handed.harnessId);
      await post(deps, event.sessionId, {
        type: "response",
        body: handed.live
          ? PASSED_TO_RUNNING_JOB
          : `Added this to the run that's already working on **${root.identifier}**; it will answer in that session.`,
      });
      if (!handed.live) await advanceRun(active.id, deps);
      return { status: "delivered", run: active, live: handed.live };
    }
  }
  if (wantsLoop) {
    const refused = await refuseOpenQuestions(deps, event);
    if (refused) return refused;
  }
  return startNewRun(event, deps, {
    mode: wantsLoop ? "epic" : "request",
    instruction: { text, author, wantsLoop, ship },
  });
}

/**
 * Starts a run for a new agent session: a delegation, or a mention when the
 * issue has no unfinished run.
 */
async function startNewRun(
  event: SessionCreatedEvent,
  deps: StartRunDeps,
  start: StartOptions,
): Promise<StartOutcome> {
  const { db, linear } = deps;
  const sessionId = event.sessionId;
  const epicMode = start.mode === "epic";

  const [repositories, router] = await Promise.all([
    listRalphRepositories(db, deps.organizationId),
    createRouter(deps),
  ]);
  // Before loading: loading a PRD epic creates its story issues.
  let candidates: RepositoryWithSwitches[];
  try {
    const blocked = await refuseUnbuildable(deps, event, repositories, router);
    if ("refused" in blocked) return blocked.refused;
    candidates = blocked.candidates;
  } catch (error) {
    await post(deps, sessionId, {
      type: "error",
      body: `I couldn't load the issue from Linear: ${message(error)}`,
    });
    return { status: "load_failed", error: message(error) };
  }
  let loaded: LoadedEpic;
  try {
    // An issue that was never run may hold a PRD whose materialization stopped half way.
    const completePrd = epicMode && !(await getRunByIssue(db, deps.organizationId, event.issueId));
    // Which stories are manual depends on the repository the epic routes to.
    const manualLabels = async (root: IssueSummary) => {
      const repository = routedRepository(await router.resolve(root.id));
      return repository ? repositoryManualLabels(repository) : [];
    };
    const allowPreparation = async (root: IssueSummary) => {
      const repository = routedRepository(await router.resolve(root.id));
      return repository ? repositoryAllowsPreparation(repository) : true;
    };
    loaded = await loadEpic(linear, event.issueId, {
      completePrd,
      manualLabels,
      allowPreparation,
      // A mention only reads the epic for context; it never creates story issues.
      materialize: epicMode,
    });
  } catch (error) {
    await post(deps, sessionId, {
      type: "error",
      body: `I couldn't load the issue from Linear: ${message(error)}`,
    });
    return { status: "load_failed", error: message(error) };
  }
  const { epic, root } = loaded;
  if (repositories.length === 0) {
    await post(deps, sessionId, { type: "error", body: unroutableMessage(epic) });
    return { status: "unroutable" };
  }

  // Re-delegation: carry over the latest run of the issue (cyralph's behaviour).
  const previous = await getRunByIssue(db, deps.organizationId, root.id);
  if (previous && !FINISHED_RUN_STATUSES.has(previous.status)) {
    if (loaded.focusStoryId) {
      // A story of an epic that is being built already: its run covers the story.
      await post(deps, sessionId, {
        type: "response",
        body: `**${root.identifier}** is already being built in another session, which covers this story.`,
      });
      return { status: "already_running", run: previous };
    }
    await supersede(deps, previous, sessionId);
  }

  const chosen = await chooseRepository(root, repositories, previous, router);
  if (chosen && "manual" in chosen) return refuseManual(deps, event, chosen);
  if (!chosen) {
    // Only the repositories whose blocked labels let it in are offered.
    return askForRepositoryFirst(deps, {
      event,
      loaded,
      previous,
      repositories: candidates,
      start,
    });
  }

  let baseBranch: string;
  try {
    const found = await getRepositoryWithConnection(db, chosen.repository.id);
    if (!found) throw new Error(`repository ${chosen.repository.fullPath} is gone`);
    baseBranch = await deps.adapterFor(db, found.connection).getDefaultBranch({
      fullPath: found.repository.fullPath,
      externalId: found.repository.externalId,
    });
  } catch (error) {
    await post(deps, sessionId, {
      type: "error",
      body: `I couldn't read the default branch of \`${chosen.repository.fullPath}\`: ${message(error)}`,
    });
    return { status: "failed", error: message(error) };
  }

  const { run, created, lane, left } = await db.transaction(async (tx) => {
    // The run continues the previous one (in its repository, with its lanes), then moves to the chosen repository.
    const result = await createRun(tx, {
      organizationId: deps.organizationId,
      linearIssueId: root.id,
      linearIdentifier: root.identifier,
      linearTitle: root.title,
      linearUrl: root.url,
      linearAgentSessionId: sessionId,
      kind: loaded.kind,
      mode: start.mode,
      focusStoryId: loaded.focusStoryId ?? null,
      repositoryId: previous?.repositoryId ?? null,
      routedBy: chosen.routedBy,
      chatThreadId: await delegatingThread(tx, deps, event),
    });
    if (!result.created) return { ...result, lane: null, left: null };
    let run = await carryOver(tx, result.run, previous);
    // Re-routing moved the issue to another repository: its earlier work there stays as it is.
    const moved = await moveToRepository(tx, run.id, chosen.repository.id, {
      branch: epic.branchName,
      baseBranch,
    });
    if (!moved) throw new Error(`Run ${run.id} is gone`);
    const lane = (await updateLane(tx, moved.lane.id, { baseBranch })) ?? moved.lane;
    run = { ...run, repositoryId: chosen.repository.id };
    await syncStories(tx, run.id, epic, await routeStories(deps, tx, run, epic));
    await addStartInstruction(tx, run, start);
    return { run, created: true, lane, left: moved.left };
  });
  await markRalphActive();
  if (!created) {
    // Another delivery started this session's (or this issue's) run first.
    if (run.linearAgentSessionId === sessionId) await advanceRun(run.id, deps);
    else {
      await post(deps, sessionId, {
        type: "response",
        body: `**${root.identifier}** is already being built in another session.`,
      });
      return { status: "already_running", run };
    }
    return { status: "started", run, created: false };
  }

  const note = await leftBehind(deps, left);
  if (note) {
    await post(deps, sessionId, {
      type: "thought",
      body: leftBehindNote(note, chosen.repository.fullPath),
    });
  }
  // Request mode changes nothing in Linear; it just does what the mention asks.
  if (epicMode && !["started", "completed", "canceled"].includes(root.stateType)) {
    try {
      await linear.setIssueState(root.id, { type: "started" });
    } catch (error) {
      console.warn(`Moving ${root.identifier} to started failed`, error);
    }
  }
  if (epicMode) {
    await post(deps, sessionId, {
      type: "thought",
      body: describeRun(loaded, chosen, lane!, !!previous),
    });
  }
  await notifyRunThread(deps, run, { kind: "started" });
  await advanceRun(run.id, deps);
  return { status: "started", run, created: true };
}
