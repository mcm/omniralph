/**
 * The repository question (ported from cyralph's `EpicEngine.resolveRepo` and
 * the selection answer in `SessionManager.onPrompted`): when routing finds no
 * repository for a delegated issue, its run waits without one, with
 * `pending_elicitation` listing the offered repositories, and a `select`
 * elicitation asks which to use. The answer (matched by `matchSelection`)
 * sets the run's repository, which later re-routing keeps.
 */
import {
  getRepository,
  getRepositoryWithConnection,
  listRalphRepositories,
  lockRun,
  updateRun,
  type RalphRun,
  type RalphTransaction,
  type Repository,
  type ScmProvider,
} from "@omniralph/db";
import { parseRepoTags } from "@omniralph/ralph";
import type { LinearGateway } from "@/lib/linear/gateway";
import { errorMessage, postActivity, quietly } from "./notify";
import { changeRequestTerm } from "./publish";
import { matchSelection } from "./routing";
import { advanceRun, type AdvanceResult, type RalphDeps } from "./run";

/** `routed_by` of a repository a person picked: later re-routing keeps it. */
export const ROUTED_BY_SELECTION = "your selection";

/** cyralph's question, with Omniralph's routing settings in the hint. */
export const REPOSITORY_QUESTION =
  "Which repository should I work in for this issue?\n\n" +
  "(Add a `[repo=owner/name]` tag to the issue description, or this issue's label, project or " +
  "team to a repository's routing under **Repository › Settings › Ralph**, to skip this next time.)";

/** The repositories a run asks to choose from, or null when it isn't asking. */
export function repositorySelectionOf(run: Pick<RalphRun, "pendingElicitation">): string[] | null {
  const pending = run.pendingElicitation;
  return pending?.kind === "repository" ? pending.repositoryIds : null;
}

/** Posts the repository question (a `select` elicitation of the repositories' full paths). */
export async function askForRepository(
  linear: LinearGateway,
  sessionId: string,
  candidates: readonly Pick<Repository, "fullPath">[],
  body: string = REPOSITORY_QUESTION,
): Promise<void> {
  await postActivity(
    linear,
    sessionId,
    { type: "elicitation", body },
    {
      signal: "select",
      signalMetadata: { options: candidates.map((r) => ({ value: r.fullPath })) },
    },
  );
}

/** The question for an issue routing found no repository for (says why when a tag missed). */
export function repositoryQuestionFor(description: string | null | undefined): string {
  const tags = parseRepoTags(description);
  if (tags.length === 0) return REPOSITORY_QUESTION;
  const named = tags.map((t) => `\`${t}\``).join(", ");
  return `Its \`[repo=…]\` tag (${named}) names no repository with ralph enabled.\n\n${REPOSITORY_QUESTION}`;
}

/** The work a run left in the repository it worked in before re-routing moved it. */
export interface LeftBehind {
  fullPath: string;
  provider: ScmProvider;
  branch: string | null;
  prUrl: string | null;
}

/** cyralph's note when re-routing moves an issue to another repository. */
export function leftBehindNote(left: LeftBehind, newPath: string): string {
  const from = `\`${left.fullPath}\``;
  const term = changeRequestTerm(left.provider);
  const work = [
    left.branch && `branch \`${left.branch}\``,
    left.prUrl && `${term[0]!.toUpperCase()}${term.slice(1)} ${left.prUrl}`,
  ].filter(Boolean);
  return (
    `Routing now sends this to \`${newPath}\` instead of ${from}, so I'm working there.` +
    (work.length > 0
      ? ` The earlier work in ${from} stays as it is (${work.join(", ")}); I won't touch it again.`
      : "")
  );
}

/** The work an earlier run left in its repository, for `leftBehindNote` (null if it's gone). */
export async function leftBehind(
  deps: Pick<RalphDeps, "db">,
  previous: Pick<RalphRun, "repositoryId" | "branch" | "prUrl">,
): Promise<LeftBehind | null> {
  if (!previous.repositoryId) return null;
  const repository = await getRepository(deps.db, previous.repositoryId);
  if (!repository) return null;
  return {
    fullPath: repository.fullPath,
    provider: repository.provider,
    branch: previous.branch,
    prUrl: previous.prUrl,
  };
}

/** The offered repositories still enabled for ralph, in the offered order (else all enabled ones). */
async function selectionCandidates(
  deps: Pick<RalphDeps, "db">,
  offered: readonly string[],
): Promise<Repository[]> {
  const enabled = await listRalphRepositories(deps.db);
  const kept = offered
    .map((id) => enabled.find((r) => r.id === id))
    .filter((r): r is Repository => !!r);
  return kept.length > 0 ? kept : enabled;
}

export type RepositoryAnswer =
  /** The reply matched no repository: the question was asked again. */
  | { status: "unmatched" }
  /** The run's repository is set and the run advanced. */
  | { status: "selected"; repository: Repository; advanced: AdvanceResult }
  /** The question was answered meanwhile, or the default branch couldn't be read. */
  | { status: "ignored" };

/**
 * A reply to the repository question: the matched repository becomes the
 * run's (`routed_by` "your selection", base branch its default branch), the
 * issue moves to started and the run advances. An unmatched reply asks again.
 */
export async function answerRepositorySelection(
  deps: RalphDeps,
  run: RalphRun,
  offered: readonly string[],
  text: string,
): Promise<RepositoryAnswer> {
  const candidates = await selectionCandidates(deps, offered);
  const repository = matchSelection(text, candidates);
  if (!repository) {
    await askForRepository(
      deps.linear,
      run.linearAgentSessionId,
      candidates,
      `I couldn't match "${text}" to a repository. Which one should I use?`,
    );
    return { status: "unmatched" };
  }

  let baseBranch: string;
  try {
    const found = await getRepositoryWithConnection(deps.db, repository.id);
    if (!found) throw new Error(`repository ${repository.fullPath} is gone`);
    baseBranch = await deps.adapterFor(deps.db, found.connection).getDefaultBranch({
      fullPath: found.repository.fullPath,
      externalId: found.repository.externalId,
    });
  } catch (error) {
    await postActivity(deps.linear, run.linearAgentSessionId, {
      type: "error",
      body: `I couldn't read the default branch of \`${repository.fullPath}\`: ${errorMessage(error)}. Reply with the repository again to retry.`,
    });
    return { status: "ignored" };
  }

  const chosen = await lockRun(deps.db, run.id, async (tx, current) => {
    if (current.repositoryId || !repositorySelectionOf(current)) return null;
    return updateRun(tx, current.id, {
      repositoryId: repository.id,
      routedBy: ROUTED_BY_SELECTION,
      baseBranch,
      pendingElicitation: null,
      waitingOn: null,
      status: "pending",
      error: null,
    });
  });
  if (!chosen) return { status: "ignored" };

  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `Using \`${repository.fullPath}\`. Building on branch \`${chosen.branch}\`, based on \`${baseBranch}\`.`,
  });
  await quietly(`Moving ${run.linearIdentifier} to started`, async () => {
    const issue = await deps.linear.getIssue(run.linearIssueId);
    if (!["started", "completed", "canceled"].includes(issue.stateType)) {
      await deps.linear.setIssueState(issue.id, { type: "started" });
    }
  });
  return { status: "selected", repository, advanced: await advanceRun(run.id, deps) };
}

/**
 * `advanceRun` for a run without a repository (inside its lock): it waits on
 * the question, which is asked again when it isn't open (e.g. the run was
 * stopped and resumed). Returns `failed` when no repository has ralph
 * enabled, so the run can't go on.
 */
export async function awaitRepository(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<RalphRun | { failed: string }> {
  if (run.status === "waiting" && repositorySelectionOf(run)) return run;
  const candidates = await listRalphRepositories(tx);
  if (candidates.length === 0) {
    return {
      failed:
        "No repository has ralph enabled, so I can't build this. Enable ralph on one under " +
        "**Repository › Settings › Ralph** and delegate the issue again.",
    };
  }
  const updated =
    (await updateRun(tx, run.id, {
      status: "waiting",
      waitingOn: null,
      pendingElicitation: { kind: "repository", repositoryIds: candidates.map((r) => r.id) },
    })) ?? run;
  await askForRepository(deps.linear, run.linearAgentSessionId, candidates);
  return updated;
}
