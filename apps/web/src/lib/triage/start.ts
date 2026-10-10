/**
 * Starts triage for a new Linear agent session (`@omniralph /triage`): loads
 * the issue, its comments, sub-issues and blockers from Linear, refuses
 * (without touching Linear) when the issue or one of its sub-issues is in
 * progress or done, routes it to a repository the way ralph does (none is
 * fine: triage then runs without a checkout), records a `triage_runs` row and
 * enqueues a `triage.run` job on the organization's triage topic. The job's
 * outcome is applied to Linear when it finishes.
 */
import {
  createTriageRun,
  getRepositoryWithConnection,
  getTriageRunBySession,
  listRalphRepositories,
  setTriageRunJob,
  setTriageRunStatus,
  type TriageRun,
} from "@omniralph/db";
import { parseInstruction } from "@omniralph/ralph";
import {
  LINEAR_STATE_TYPES,
  TRIAGE_CAPABILITY,
  TRIAGE_RUN_JOB_TYPE,
  TriageRunPayload,
  type TriageBlocker,
  type TriageRepository,
} from "@omniralph/shared";
import type { IssueComment, IssueSummary } from "@/lib/linear/gateway";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { errorMessage, postActivity } from "@/lib/ralph/notify";
import { describeRoute, routeIssue } from "@/lib/ralph/routing";
import type { RalphDeps } from "@/lib/ralph/run";
import { jobRepository } from "@/lib/scm/adapters";

export type SessionCreatedEvent = Extract<LinearWebhookEvent, { kind: "session_created" }>;

export type TriageDeps = Pick<
  RalphDeps,
  "db" | "organizationId" | "linear" | "dispatcher" | "adapterFor"
>;

export type StartTriageOutcome =
  /** A redelivered event: the session already has its triage run. */
  | { status: "exists"; run: TriageRun }
  | { status: "load_failed"; error: string }
  /** The issue or one of its sub-issues is in progress or done: nothing changed. */
  | { status: "in_progress"; issues: string[] }
  /** Another session is triaging the issue right now. */
  | { status: "already_running"; run: TriageRun }
  | { status: "failed"; error: string }
  | { status: "queued"; run: TriageRun; jobId: string; repository: TriageRepository | null };

/** Issue states triage never changes anything in. */
const LOCKED_STATE_TYPES = new Set(["started", "completed"]);

/** Limits of `TriageRunPayload` (longer text is cut, longer lists keep their newest entries). */
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
export function lockedMessage(issue: Pick<IssueSummary, "identifier">, locked: string[]): string {
  const which =
    locked.length === 1 && locked[0] === issue.identifier
      ? `**${issue.identifier}** is already in progress or done`
      : `${locked.map((id) => `**${id}**`).join(", ")} ${locked.length === 1 ? "is" : "are"} already in progress or done`;
  return (
    `${which}, so I didn't triage **${issue.identifier}** and changed nothing in Linear. ` +
    "Triage only rewrites issues whose work hasn't started; edit the PRD by hand, or move those issues back to Backlog or Todo and ask again."
  );
}

/** The thought posted once the triage job is queued. */
export function queuedMessage(
  issue: Pick<IssueSummary, "identifier">,
  repository: { fullPath: string; routedBy: string; defaultBranch: string } | null,
): string {
  return repository
    ? `Triaging **${issue.identifier}**, reading \`${repository.fullPath}\` (routed by ${repository.routedBy}) at \`${repository.defaultBranch}\`.`
    : `Triaging **${issue.identifier}**. No repository routes it, so I'll work from Linear alone and ask which repository it belongs in.`;
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
    for (const b of await deps.linear.getBlockers(issue.id)) {
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

/** The routed repository at its default branch, or null when no repository routes the issue. */
async function resolveRepository(
  deps: TriageDeps,
  issue: IssueSummary,
): Promise<{ payload: TriageRepository; fullPath: string; routedBy: string } | null> {
  const route = routeIssue(issue, await listRalphRepositories(deps.db, deps.organizationId));
  if (!route) return null;
  const found = await getRepositoryWithConnection(deps.db, route.repository.id);
  if (!found) throw new Error(`repository ${route.repository.fullPath} is gone`);
  const defaultBranch = await deps.adapterFor(deps.db, found.connection).getDefaultBranch({
    fullPath: found.repository.fullPath,
    externalId: found.repository.externalId,
  });
  return {
    payload: {
      repositoryId: found.repository.id,
      repository: jobRepository(found.repository, found.connection),
      defaultBranch,
    },
    fullPath: found.repository.fullPath,
    routedBy: describeRoute(route),
  };
}

export interface StartTriageOptions {
  /**
   * The run created for this session already (the `ralph:triage` label
   * trigger creates it before the session): it is used instead of a new
   * one, and ends `stopped` or `failed` when triage doesn't start.
   */
  run?: TriageRun;
}

/**
 * Handles `AgentSessionEvent.created` whose instruction asks for `/triage`,
 * or the session the `ralph:triage` label opened (with its `run`).
 */
export async function startTriage(
  event: SessionCreatedEvent,
  deps: TriageDeps,
  options: StartTriageOptions = {},
): Promise<StartTriageOutcome> {
  const { db, linear } = deps;
  const sessionId = event.sessionId;
  const given = options.run;

  if (!given) {
    const existing = await getTriageRunBySession(db, sessionId);
    if (existing) return { status: "exists", run: existing };
  }
  /** Ends the given run when triage doesn't start. */
  const endGiven = async (status: "stopped" | "failed") => {
    if (given) await setTriageRunStatus(db, given.id, status);
  };

  let issue: IssueSummary;
  let children: IssueSummary[];
  let issueComments: IssueComment[];
  let blockers: TriageBlocker[];
  try {
    issue = await linear.getIssue(event.issueId);
    children = await linear.getChildren(issue.id);
    const locked = lockedIssues(issue, children);
    if (locked.length > 0) {
      await endGiven("stopped");
      await postActivity(linear, sessionId, {
        type: "response",
        body: lockedMessage(issue, locked),
      });
      return { status: "in_progress", issues: locked };
    }
    issueComments = await linear.getComments(issue.id);
    blockers = await loadBlockers(deps, [issue, ...children]);
  } catch (error) {
    await endGiven("failed");
    await postActivity(linear, sessionId, {
      type: "error",
      body: `I couldn't load the issue from Linear: ${errorMessage(error)}`,
    });
    return { status: "load_failed", error: errorMessage(error) };
  }

  let repository: Awaited<ReturnType<typeof resolveRepository>>;
  try {
    repository = await resolveRepository(deps, issue);
  } catch (error) {
    await endGiven("failed");
    await postActivity(linear, sessionId, {
      type: "error",
      body: `I couldn't read the repository this issue routes to: ${errorMessage(error)}`,
    });
    return { status: "failed", error: errorMessage(error) };
  }

  const { run, created } = given
    ? { run: given, created: true }
    : await createTriageRun(db, {
        organizationId: deps.organizationId,
        linearIssueId: issue.id,
        linearAgentSessionId: sessionId,
        trigger: "mention",
      });
  if (!created) {
    if (run.linearAgentSessionId === sessionId) return { status: "exists", run };
    await postActivity(linear, sessionId, {
      type: "response",
      body: `**${issue.identifier}** is already being triaged in another session.`,
    });
    return { status: "already_running", run };
  }

  const reply = parseInstruction(event.commentBody).text;
  const payload = TriageRunPayload.parse({
    triageRunId: run.id,
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: cut(issue.title, MAX_TITLE),
      description: cut(issue.description, MAX_DOCUMENT),
      stateType: stateType(issue.stateType),
      creator: issue.creator ? { id: issue.creator.id, name: cut(issue.creator.name, 200) } : null,
      url: issue.url || null,
    },
    comments: comments(issueComments),
    children: children.slice(0, MAX_ITEMS).map((c) => ({
      id: c.id,
      identifier: c.identifier,
      title: cut(c.title, MAX_TITLE),
      description: cut(c.description, MAX_DOCUMENT),
      stateType: stateType(c.stateType),
      priority: c.priority,
    })),
    blockers,
    repository: repository?.payload ?? null,
    // What the mention says besides `/triage` guides the triage like a reply.
    reply: reply ? cut(reply, MAX_COMMENT) : null,
  });

  let jobId: string;
  try {
    const { job } = await deps.dispatcher.createAndPublish({
      organizationId: deps.organizationId,
      capability: TRIAGE_CAPABILITY,
      type: TRIAGE_RUN_JOB_TYPE,
      payload,
      repositoryId: repository?.payload.repositoryId ?? null,
      dedupeKey: `triage:${run.id}`,
    });
    jobId = job.id;
    await setTriageRunJob(db, run.id, job.id);
  } catch (error) {
    await setTriageRunStatus(db, run.id, "failed");
    await postActivity(linear, sessionId, {
      type: "error",
      body: `I couldn't queue the triage: ${errorMessage(error)}`,
    });
    return { status: "failed", error: errorMessage(error) };
  }

  await postActivity(linear, sessionId, {
    type: "thought",
    body: queuedMessage(
      issue,
      repository && {
        fullPath: repository.fullPath,
        routedBy: repository.routedBy,
        defaultBranch: repository.payload.defaultBranch,
      },
    ),
  });
  return {
    status: "queued",
    run: { ...run, currentJobId: jobId },
    jobId,
    repository: repository?.payload ?? null,
  };
}
