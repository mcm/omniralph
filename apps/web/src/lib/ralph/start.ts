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
  createRun,
  getRepositoryWithConnection,
  getRunByIssue,
  getRunBySession,
  listActiveRunJobIds,
  listRalphRepositories,
  listStories,
  lockRun,
  updateRun,
  updateStory,
  type RalphRun,
  type RalphTransaction,
  type Repository,
} from "@omniralph/db";
import type { Epic } from "@omniralph/ralph";
import type { ActivityContent, IssueSummary } from "@/lib/linear/gateway";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import {
  loadEpic,
  repositoryAllowsPreparation,
  repositoryManualLabels,
  type LoadedEpic,
} from "./epic-loader";
import { quietly } from "./notify";
import { preparationOf } from "./preparation";
import {
  askForRepository,
  leftBehind,
  leftBehindNote,
  repositoryQuestionFor,
  ROUTED_BY_SELECTION,
} from "./repository-selection";
import { routeIssue, type RouteMatch } from "./routing";
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

export const MENTION_RESPONSE =
  "I only build issues that are delegated to me for now: delegate this issue (or its epic) to me " +
  "to build it story by story. Mentions aren't supported yet.";

/** Whether a new agent session comes from a mention rather than a delegation. */
export function isMention(event: Pick<SessionCreatedEvent, "commentBody">): boolean {
  const body = event.commentBody?.trim();
  return !!body && !body.includes(AGENT_SESSION_MARKER);
}

export type StartOutcome =
  | { status: "mention" }
  | { status: "load_failed"; error: string }
  /** No ralph-enabled repository at all. */
  | { status: "unroutable" }
  /** Routing found no repository: the run waits for a person to pick one. */
  | { status: "selecting"; run: RalphRun }
  | { status: "already_running"; run: RalphRun }
  | { status: "failed"; error: string }
  | { status: "started"; run: RalphRun; created: boolean };

async function post(deps: RalphDeps, sessionId: string, content: ActivityContent): Promise<void> {
  try {
    await deps.linear.createActivity(sessionId, content);
  } catch (error) {
    console.error(
      `Posting a Linear ${content.type} activity to session ${sessionId} failed`,
      error,
    );
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The error for an issue no repository can build: none has ralph enabled. */
export function unroutableMessage(epic: Pick<Epic, "identifier">): string {
  return [
    `I can't build **${epic.identifier}**: no repository has ralph enabled.`,
    "Enable ralph on a repository under **Repository › Settings › Ralph** (and add this issue's " +
      "label, project or team to its Linear routing, or a `[repo=<owner/name>]` tag to the issue " +
      "description). Then delegate it to me again.",
  ].join("\n\n");
}

const RULE_LABEL: Record<RouteMatch<Repository>["rule"], string> = {
  tag: "`[repo=…]` tag",
  label: "label",
  project: "project",
  team: "team",
};

/** How a route chose its repository, as `routed_by` stores it (e.g. "team `ENG`"). */
export function describeRoute(route: RouteMatch<Repository>): string {
  return `${RULE_LABEL[route.rule]} \`${route.value}\``;
}

/** The repository a run works in and how it was chosen. */
export interface ChosenRepository {
  repository: Repository;
  routedBy: string;
}

/**
 * The repository for a (re-)delegated issue (cyralph's `resolveRepo`): one a
 * person picked for the previous run stays while it has ralph enabled; else
 * routing decides; else (routing would have to ask) the previous run's
 * repository stays. Null: nothing decides, so a person is asked.
 */
export function chooseRepository(
  root: IssueSummary,
  repositories: readonly Repository[],
  previous: Pick<RalphRun, "repositoryId" | "routedBy"> | null,
): ChosenRepository | null {
  const current = previous?.repositoryId
    ? repositories.find((r) => r.id === previous.repositoryId)
    : undefined;
  if (current && previous?.routedBy === ROUTED_BY_SELECTION) {
    return { repository: current, routedBy: ROUTED_BY_SELECTION };
  }
  const route = routeIssue(root, repositories);
  if (route) return { repository: route.repository, routedBy: describeRoute(route) };
  if (current) return { repository: current, routedBy: previous?.routedBy ?? "the previous run" };
  return null;
}

/** The thought describing what the run will do (cyralph's `describeEpic`). */
export function describeRun(
  loaded: LoadedEpic,
  chosen: ChosenRepository,
  run: Pick<RalphRun, "branch" | "baseBranch" | "prUrl">,
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
      `(routed by ${chosen.routedBy}) on branch \`${run.branch}\`, ` +
      `based on \`${run.baseBranch}\`.`,
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
        `${run.prUrl ? ` (${run.prUrl})` : ""}, with its guidance.`,
    );
  }
  const manual = epic.stories.filter(
    (s) => s.manual && s.status !== "completed" && s.status !== "cancelled",
  );
  if (manual.length > 0) {
    lines.push(
      `Manual steps for a person: ${manual.map((s) => `**${s.storyId}**`).join(", ")}. ` +
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
    await quietly(`Canceling job ${jobId} of ralph run ${previous.id}`, () =>
      deps.dispatcher.cancel(jobId),
    );
  }
  const pr = previous.prUrl ? ` The open draft stays where it is: ${previous.prUrl}` : "";
  await post(deps, previous.linearAgentSessionId, {
    type: "response",
    body: `This issue was delegated to me again, so I stopped here and continue in the new session.${pr}`,
  });
}

/** A new run takes over the previous run's guidance and progress, and its PR/MR in the same repository. */
async function carryOver(
  tx: RalphTransaction,
  run: RalphRun,
  previous: RalphRun | null,
  sameRepository: boolean,
): Promise<RalphRun> {
  if (!previous) return run;
  return (
    (await updateRun(tx, run.id, {
      guidance: previous.guidance,
      progress: previous.progress,
      ...(sameRepository && { prNumber: previous.prNumber, prUrl: previous.prUrl }),
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
    repositories: readonly Repository[];
  },
): Promise<StartOutcome> {
  const { event, loaded, previous, repositories } = input;
  const { epic, root } = loaded;
  const { run, created } = await deps.db.transaction(async (tx) => {
    const result = await createRun(tx, {
      linearIssueId: root.id,
      linearIdentifier: root.identifier,
      linearTitle: root.title,
      linearUrl: root.url,
      linearAgentSessionId: event.sessionId,
      kind: loaded.kind,
      focusStoryId: loaded.focusStoryId ?? null,
      repositoryId: null,
      branch: previous?.branch ?? epic.branchName,
      // Set with the repository.
      baseBranch: "",
      status: "waiting",
      pendingElicitation: { kind: "repository", repositoryIds: repositories.map((r) => r.id) },
    });
    if (!result.created) return result;
    const run = await carryOver(tx, result.run, previous, false);
    await syncStories(tx, run.id, epic);
    return { run, created: true };
  });
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
  await askForRepository(
    deps.linear,
    event.sessionId,
    repositories,
    repositoryQuestionFor(root.description),
  );
  return { status: "selecting", run };
}

/** Handles `AgentSessionEvent.created` (after the acknowledgement was posted). */
export async function startRun(
  event: SessionCreatedEvent,
  deps: StartRunDeps,
): Promise<StartOutcome> {
  const { db, linear } = deps;
  const sessionId = event.sessionId;

  // A redelivered or repeated event: the session already has its run.
  const existing = await getRunBySession(db, sessionId);
  if (existing) {
    await advanceRun(existing.id, deps);
    return { status: "started", run: existing, created: false };
  }

  if (isMention(event)) {
    await post(deps, sessionId, { type: "response", body: MENTION_RESPONSE });
    return { status: "mention" };
  }

  const repositories = await listRalphRepositories(db);
  let loaded: LoadedEpic;
  try {
    // An issue that was never run may hold a PRD whose materialization stopped half way.
    const completePrd = !(await getRunByIssue(db, event.issueId));
    // Which stories are manual depends on the repository the epic routes to.
    const manualLabels = (root: IssueSummary) => {
      const route = routeIssue(root, repositories);
      return route ? repositoryManualLabels(route.repository) : [];
    };
    const allowPreparation = (root: IssueSummary) => {
      const route = routeIssue(root, repositories);
      return route ? repositoryAllowsPreparation(route.repository) : true;
    };
    loaded = await loadEpic(linear, event.issueId, {
      completePrd,
      manualLabels,
      allowPreparation,
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
  const previous = await getRunByIssue(db, root.id);
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

  const chosen = chooseRepository(root, repositories, previous);
  if (!chosen) return askForRepositoryFirst(deps, { event, loaded, previous, repositories });

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

  // Re-routing moved the issue to another repository: its earlier work there stays as it is.
  const moved = !!previous?.repositoryId && previous.repositoryId !== chosen.repository.id;
  const sameRepository = previous?.repositoryId === chosen.repository.id;
  const branch = (sameRepository && previous?.branch) || epic.branchName;
  const { run, created } = await db.transaction(async (tx) => {
    const result = await createRun(tx, {
      linearIssueId: root.id,
      linearIdentifier: root.identifier,
      linearTitle: root.title,
      linearUrl: root.url,
      linearAgentSessionId: sessionId,
      kind: loaded.kind,
      focusStoryId: loaded.focusStoryId ?? null,
      repositoryId: chosen.repository.id,
      routedBy: chosen.routedBy,
      branch,
      baseBranch,
    });
    if (!result.created) return result;
    const run = await carryOver(tx, result.run, previous, sameRepository);
    await syncStories(tx, run.id, epic);
    return { run, created: true };
  });
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

  if (moved) {
    const left = await leftBehind(deps, previous!);
    if (left) {
      await post(deps, sessionId, {
        type: "thought",
        body: leftBehindNote(left, chosen.repository.fullPath),
      });
    }
  }
  if (!["started", "completed", "canceled"].includes(root.stateType)) {
    try {
      await linear.setIssueState(root.id, { type: "started" });
    } catch (error) {
      console.warn(`Moving ${root.identifier} to started failed`, error);
    }
  }
  await post(deps, sessionId, {
    type: "thought",
    body: describeRun(loaded, chosen, run, !!previous),
  });
  await advanceRun(run.id, deps);
  return { status: "started", run, created: true };
}
