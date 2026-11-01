/**
 * Starts triage for a new Linear agent session (`@omniralph /triage`): loads
 * the issue, its comments, sub-issues and blockers from Linear, refuses
 * (without touching Linear) when the issue or one of its sub-issues is in
 * progress or done, routes it to a repository the way ralph does (none is
 * fine: triage then runs without a checkout), records a `triage_runs` row and
 * enqueues a run of the built-in query task `builtin:triage` (job type
 * `triage.run`) any of the organization's agents may claim. Its `triage`
 * sink (`lib/sinks/triage.ts`) applies the outcome to Linear when it finishes.
 */
import {
  createTriageRun,
  getRepositoryWithConnection,
  getTriageRunBySession,
  setTriageRunJob,
  setTriageRunStatus,
  type TriageRun,
} from "@omniralph/db";
import { parseInstruction, triageTemplateContext } from "@omniralph/ralph";
import {
  LINEAR_STATE_TYPES,
  TRIAGE_RUN_JOB_TYPE,
  type TriageBlocker,
  type TriageOutcome,
  type TriageRepository,
} from "@omniralph/shared";
import type {
  IssueComment,
  IssueSummary,
  SessionStartedEvent,
  TrackerGateway,
} from "@omniralph/tracker";
import { errorMessage, postActivity } from "@/lib/ralph/notify";
import { trackerConversation } from "@/lib/ralph/conversation";
import { trackerName } from "@/lib/tracker/adapters";
import { resolveRoute, routedRepository } from "@/lib/routing/resolve";
import type { RalphDeps } from "@/lib/ralph/run";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import { jobRepository } from "@/lib/scm/adapters";
import type { TriageRunContext } from "./apply";
import { fetchDefaultBranch } from "@/lib/repositories/default-branch";

export type SessionCreatedEvent = SessionStartedEvent;

export type TriageDeps = Pick<RalphDeps, "db" | "organizationId" | "dispatcher" | "adapterFor"> & {
  tracker: TrackerGateway;
};

export type StartTriageOutcome =
  /** A redelivered event: the session already has its triage run. */
  | { status: "exists"; run: TriageRun }
  | { status: "load_failed"; error: string }
  /** The issue or one of its sub-issues is in progress or done: nothing changed. */
  | { status: "in_progress"; issues: string[] }
  /** Another session is triaging the issue right now. */
  | { status: "already_running"; run: TriageRun }
  | { status: "failed"; error: string }
  /**
   * The issue routes to a repository whose query tasks are turned off: nothing was enqueued
   * and nothing posted.
   */
  | { status: "query_disabled"; repository: string }
  | { status: "queued"; run: TriageRun; jobId: string; repository: TriageRepository | null };

/** Issue states triage never changes anything in. */
const LOCKED_STATE_TYPES = new Set(["started", "completed"]);

export const TRIAGE_TASK_ID = "builtin:triage";

/** Limits of the trigger context (longer text is cut, longer lists keep their newest entries). */
const MAX_TITLE = 1000;
const MAX_DOCUMENT = 200_000;
const MAX_COMMENT = 20_000;
const MAX_ITEMS = 500;

type StateType = (typeof LINEAR_STATE_TYPES)[number];
const stateType = (type: string): StateType =>
  (LINEAR_STATE_TYPES as readonly string[]).includes(type) ? (type as StateType) : "unstarted";

const cut = (text: string, n: number) => (text.length > n ? text.slice(0, n) : text);

/**
 * The issue and sub-issues that are in progress or done (canceled sub-issues
 * don't count), as identifiers: triage leaves the issue alone when there are any.
 */
export function lockedIssues(issue: IssueSummary, children: readonly IssueSummary[]): string[] {
  return [issue, ...children]
    .filter((i) => LOCKED_STATE_TYPES.has(i.stateType))
    .map((i) => i.identifier);
}

/** The response when triage refuses an issue that is in progress or done. */
export function lockedMessage(
  issue: Pick<IssueSummary, "identifier">,
  locked: string[],
  tracker: string,
): string {
  const which =
    locked.length === 1 && locked[0] === issue.identifier
      ? `**${issue.identifier}** is already in progress or done`
      : `${locked.map((id) => `**${id}**`).join(", ")} ${locked.length === 1 ? "is" : "are"} already in progress or done`;
  return (
    `${which}, so I didn't triage **${issue.identifier}** and changed nothing in ${tracker}. ` +
    "Triage only rewrites issues whose work hasn't started; edit the PRD by hand, or move those issues back to Backlog or Todo and ask again."
  );
}

/** The thought posted once the triage job is queued. */
export function queuedMessage(
  issue: Pick<IssueSummary, "identifier">,
  repository: { fullPath: string; routedBy: string; defaultBranch: string } | null,
  tracker: string,
): string {
  return repository
    ? `Triaging **${issue.identifier}**, reading \`${repository.fullPath}\` (routed by ${repository.routedBy}) at \`${repository.defaultBranch}\`.`
    : `Triaging **${issue.identifier}**. No repository routes it, so I'll work from ${tracker} alone and ask which repository it belongs in.`;
}

function comments(list: readonly IssueComment[]) {
  return list.slice(-MAX_ITEMS).map((c) => ({
    author: c.author?.trim() ? cut(c.author.trim(), 200) : null,
    body: cut(c.body, MAX_COMMENT),
    createdAt: c.createdAt ?? "",
  }));
}

/** The issue's and its sub-issues' blockers. */
async function loadBlockers(
  deps: TriageDeps,
  issues: readonly IssueSummary[],
): Promise<TriageBlocker[]> {
  const blockers: TriageBlocker[] = [];
  for (const issue of issues) {
    for (const b of await deps.tracker.getBlockers(issue.id)) {
      blockers.push({
        identifier: b.identifier,
        title: cut(b.title ?? "", MAX_TITLE),
        stateType: stateType(b.stateType),
        blocks: issue.identifier,
      });
    }
  }
  return blockers.slice(0, MAX_ITEMS);
}

/**
 * The routed repository at its default branch (whatever its coding switch: triage only reads
 * it), null when routing would ask, or `query_disabled` when the routed repository's query
 * tasks are turned off.
 */
async function resolveRepository(
  deps: TriageDeps,
  issue: IssueSummary,
): Promise<
  | { payload: TriageRepository; fullPath: string; routedBy: string }
  | { status: "query_disabled"; repository: string }
  | null
> {
  const route = await resolveRoute(deps, issue.id);
  if ("ask" in route) return null;
  const routed = routedRepository(route)!;
  const found = await getRepositoryWithConnection(deps.db, routed.id);
  if (!found) throw new Error(`repository ${routed.fullPath} is gone`);
  if (!found.repository.askEnabled) {
    return { status: "query_disabled", repository: found.repository.fullPath };
  }
  const defaultBranch = await fetchDefaultBranch(deps, found.connection, found.repository);
  return {
    payload: {
      repositoryId: found.repository.id,
      repository: jobRepository(found.repository, found.connection),
      defaultBranch,
    },
    fullPath: found.repository.fullPath,
    routedBy: route.by,
  };
}

export interface StartTriageOptions {
  /**
   * The run created for this session already (the triage label
   * trigger creates it before the session): it is used instead of a new
   * one, and ends `stopped` or `failed` when triage doesn't start.
   */
  run?: TriageRun;
  /**
   * A delegation of a work item that needs refining: the session first says why it is
   * triaged, and the delegation's comment (a system note) guides nothing.
   */
  delegation?: { identifier: string };
}

/** The first activity of triage a delegation started because its item needs refining. */
export function needsRefiningMessage(identifier: string): string {
  return `${identifier} needs refining, so Om is triaging it first.`;
}

/** What triage reads from Linear and the repository before a job. */
export interface TriageContext {
  issue: IssueSummary;
  children: IssueSummary[];
  comments: IssueComment[];
  blockers: TriageBlocker[];
  repository: Exclude<Awaited<ReturnType<typeof resolveRepository>>, { status: "query_disabled" }>;
}

/**
 * Loads what a triage job needs, or, when it can't run (the issue or a
 * sub-issue is in progress or done, or a load failed), says so in the session
 * and returns why (calling `end` with the status the run should end in). When
 * the issue routes to a repository whose query tasks are turned off, the run
 * ends `stopped` without posting anything.
 */
export async function prepareTriage(
  deps: TriageDeps,
  issueId: string,
  sessionId: string,
  end: (status: "stopped" | "failed") => Promise<void>,
): Promise<
  | { status: "ready"; context: TriageContext }
  | Extract<
      StartTriageOutcome,
      { status: "load_failed" | "in_progress" | "failed" | "query_disabled" }
    >
> {
  const { tracker } = deps;
  let issue: IssueSummary;
  let children: IssueSummary[];
  let issueComments: IssueComment[];
  let blockers: TriageBlocker[];
  try {
    issue = await tracker.getIssue(issueId);
    children = await tracker.getChildren(issue.id);
    const locked = lockedIssues(issue, children);
    if (locked.length > 0) {
      await end("stopped");
      await postActivity(trackerConversation(tracker, sessionId, issueId), {
        type: "response",
        body: lockedMessage(issue, locked, trackerName(tracker.provider)),
      });
      return { status: "in_progress", issues: locked };
    }
    issueComments = await tracker.getComments(issue.id);
    blockers = await loadBlockers(deps, [issue, ...children]);
  } catch (error) {
    await end("failed");
    await postActivity(trackerConversation(tracker, sessionId, issueId), {
      type: "error",
      body: `I couldn't load the issue from ${trackerName(tracker.provider)}: ${errorMessage(error)}`,
    });
    return { status: "load_failed", error: errorMessage(error) };
  }

  let repository: Awaited<ReturnType<typeof resolveRepository>>;
  try {
    repository = await resolveRepository(deps, issue);
  } catch (error) {
    await end("failed");
    await postActivity(trackerConversation(tracker, sessionId, issueId), {
      type: "error",
      body: `I couldn't read the repository this issue routes to: ${errorMessage(error)}`,
    });
    return { status: "failed", error: errorMessage(error) };
  }
  if (repository && "status" in repository) {
    await end("stopped");
    return repository;
  }
  return {
    status: "ready",
    context: { issue, children, comments: issueComments, blockers, repository },
  };
}

/**
 * Enqueues the run's next `triage.run` job (a `builtin:triage` run) over `context` (with the session's
 * reply and the run's previous triage, if any), records it as the run's
 * current job and posts the "Triaging …" thought. An enqueue failure ends the
 * run `failed`.
 */
export async function enqueueTriage(
  deps: TriageDeps,
  run: TriageRun,
  context: TriageContext,
  options: { reply?: string | null; previousResult?: TriageOutcome | null } = {},
): Promise<Extract<StartTriageOutcome, { status: "queued" | "failed" }>> {
  const { db, tracker } = deps;
  const { issue, children, repository } = context;
  const sessionId = run.trackerSessionId;
  const reply = options.reply?.trim();
  const definitions = organizationPlaybooks(db, deps.organizationId);
  const task = await getPlaybookTask(definitions, TRIAGE_TASK_ID);
  if (!task) throw new Error(`the built-in task ${TRIAGE_TASK_ID} is missing`);
  const trigger = {
    triageRunId: run.id,
    ...triageTemplateContext({
      issue: {
        identifier: issue.identifier,
        title: cut(issue.title, MAX_TITLE),
        description: cut(issue.description, MAX_DOCUMENT),
        stateType: stateType(issue.stateType),
        creator: issue.creator ? { name: cut(issue.creator.name, 200) } : null,
        url: issue.url || null,
      },
      comments: comments(context.comments),
      children: children.slice(0, MAX_ITEMS).map((c) => ({
        id: c.id,
        identifier: c.identifier,
        title: cut(c.title, MAX_TITLE),
        description: cut(c.description, MAX_DOCUMENT),
        stateType: stateType(c.stateType),
        priority: c.priority,
      })),
      blockers: context.blockers,
      repository: repository && {
        repository: { fullPath: repository.payload.repository.fullPath },
        defaultBranch: repository.payload.defaultBranch,
      },
      // The newest part of a long reply is kept.
      reply: reply ? (reply.length > MAX_COMMENT ? reply.slice(-MAX_COMMENT) : reply) : null,
      previousResult: options.previousResult ?? null,
    }),
  } satisfies TriageRunContext & Record<string, unknown>;

  let jobId: string;
  try {
    const { job } = await deps.dispatcher.createAndPublish({
      organizationId: deps.organizationId,
      type: TRIAGE_RUN_JOB_TYPE,
      ...(await taskJobInput(definitions, task, {
        trigger: { kind: "linear.triage", context: trigger },
        // Without a routed repository the run has no checkout; a default branch that doesn't
        // exist yet (an empty repository) runs without one too.
        ...(repository && {
          repositoryId: repository.payload.repositoryId,
          ref: repository.payload.defaultBranch,
        }),
      })),
      triageRunId: run.id,
      dedupeKey: `triage:${run.id}`,
    });
    jobId = job.id;
    await setTriageRunJob(db, run.id, job.id);
  } catch (error) {
    await setTriageRunStatus(db, run.id, "failed");
    await postActivity(trackerConversation(tracker, sessionId, run.trackerIssueId), {
      type: "error",
      body: `I couldn't queue the triage: ${errorMessage(error)}`,
    });
    return { status: "failed", error: errorMessage(error) };
  }

  await postActivity(trackerConversation(tracker, sessionId, run.trackerIssueId), {
    type: "thought",
    body: queuedMessage(
      issue,
      repository && {
        fullPath: repository.fullPath,
        routedBy: repository.routedBy,
        defaultBranch: repository.payload.defaultBranch,
      },
      trackerName(tracker.provider),
    ),
  });
  return {
    status: "queued",
    run: { ...run, currentJobId: jobId },
    jobId,
    repository: repository?.payload ?? null,
  };
}

/**
 * Handles `AgentSessionEvent.created` whose instruction asks for `/triage`, a
 * delegation of a work item that needs refining (`delegation`), or the session the
 * triage label opened (with its `run`).
 */
export async function startTriage(
  event: SessionCreatedEvent,
  deps: TriageDeps,
  options: StartTriageOptions = {},
): Promise<StartTriageOutcome> {
  const { db, tracker } = deps;
  const sessionId = event.sessionId;
  const given = options.run;

  if (!given) {
    const existing = await getTriageRunBySession(db, sessionId);
    if (existing) return { status: "exists", run: existing };
  }
  if (options.delegation) {
    await postActivity(trackerConversation(tracker, sessionId, event.issueId), {
      type: "thought",
      body: needsRefiningMessage(options.delegation.identifier),
    });
  }
  /** Ends the given run when triage doesn't start. */
  const endGiven = async (status: "stopped" | "failed") => {
    if (given) await setTriageRunStatus(db, given.id, status);
  };

  const prepared = await prepareTriage(deps, event.issueId, sessionId, endGiven);
  if (prepared.status !== "ready") return prepared;
  const { issue } = prepared.context;

  const { run, created } = given
    ? { run: given, created: true }
    : await createTriageRun(db, {
        organizationId: deps.organizationId,
        trackerIssueId: issue.id,
        trackerSessionId: sessionId,
        trigger: "mention",
      });
  if (!created) {
    if (run.trackerSessionId === sessionId) return { status: "exists", run };
    await postActivity(trackerConversation(tracker, sessionId, event.issueId), {
      type: "response",
      body: `**${issue.identifier}** is already being triaged in another session.`,
    });
    return { status: "already_running", run };
  }

  // What the mention says besides `/triage` guides the triage like a reply.
  const reply = options.delegation ? null : parseInstruction(event.commentBody).text;
  return enqueueTriage(deps, run, prepared.context, { reply });
}
