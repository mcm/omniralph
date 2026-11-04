import "server-only";
import {
  finishSprint,
  getRepositoryWithConnection,
  getRunByIssue,
  getSprint,
  isTrackerRun,
  listLanes,
  pauseSprint,
  setSprintPullRequest,
  type Sprint,
  type SprintWithEpics,
} from "@omniralph/db";
import type { ScmProvider } from "@omniralph/scm";
import { fetchDefaultBranch } from "@/lib/repositories/default-branch";
import { prepareSprintBranch } from "./branch";
import type { SprintRunDeps } from "./run";

/**
 * A merge-together sprint's PR/MR: once every epic merged into the sprint branch, Om opens one
 * PR/MR from the sprint branch to the repo's default branch, titled with the sprint's name and
 * listing each epic with its work item and PR/MR (`openSprintPullRequest`). Om never approves
 * or merges it: a person does, and reviews run on it like on any PR/MR (the code host's open
 * webhook). Its merge makes the sprint `done`; closing it without merging pauses the sprint,
 * and resuming opens a new one (`settleSprintPullRequest`, from the close webhook, and the
 * sprint check through `openSprintPullRequest`).
 */

/** "PR" (GitHub) or "MR" (GitLab). */
const shortTerm = (provider: ScmProvider) => (provider === "gitlab" ? "MR" : "PR");

/** The pause reason of a sprint whose sprint PR/MR closed without merging. */
export const sprintPullRequestClosedReason = (name: string, provider: ScmProvider = "github") =>
  `The ${shortTerm(provider)} of ${name} was closed without merging. Reopen it, or resume the sprint to open a new one.`;

/** The pause reason of a sprint whose sprint PR/MR Om couldn't open. */
export const sprintPullRequestFailedReason = (why: string, provider: ScmProvider = "github") =>
  `Om couldn't open the sprint ${shortTerm(provider)} (${why}). Resume the sprint to try again.`;

/** One epic as the sprint PR/MR lists it. */
export interface SprintPullRequestEpic {
  identifier: string;
  title: string;
  /** The work item in its tracker, when known. */
  url: string | null;
  /** The epic's PRs/MRs into the sprint branch. */
  pullRequests: { number: number; url: string }[];
}

/** One line of tracker text: whitespace collapsed, link brackets escaped. */
const oneLine = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([[\]<>])/g, "\\$1");

/** The sprint PR/MR's description: what it lands, and each epic with its work item and PR/MR. */
export function sprintPullRequestBody(input: {
  name: string;
  branch: string;
  defaultBranch: string;
  provider: ScmProvider;
  epics: readonly SprintPullRequestEpic[];
}): string {
  const term = shortTerm(input.provider);
  const marker = input.provider === "gitlab" ? "!" : "#";
  const lines = input.epics.map((epic, index) => {
    const item = epic.url ? `[${epic.identifier}](${epic.url})` : epic.identifier;
    const prs =
      epic.pullRequests.length > 0
        ? epic.pullRequests.map((pr) => `[${marker}${pr.number}](${pr.url})`).join(", ")
        : `no ${term}`;
    return `${index + 1}. ${item} ${oneLine(epic.title)}: ${prs}`;
  });
  return [
    `Lands the sprint **${oneLine(input.name)}** on \`${input.defaultBranch}\`: every epic below merged into \`${input.branch}\`.`,
    "",
    "## Epics",
    "",
    ...lines,
    "",
    `Om opened this ${term} and won't approve or merge it: a person reviews and merges it. Merging it finishes the sprint; closing it pauses the sprint.`,
  ].join("\n");
}

/** Each epic of the sprint with its work item and its PRs/MRs into the sprint's repo. */
async function sprintEpicsForBody(
  deps: SprintRunDeps,
  sprint: SprintWithEpics,
): Promise<SprintPullRequestEpic[]> {
  const epics: SprintPullRequestEpic[] = [];
  for (const epic of sprint.epics) {
    const run = await getRunByIssue(deps.db, deps.organizationId, epic.externalId);
    const tracked = run && isTrackerRun(run) ? run : null;
    const lanes = tracked ? await listLanes(deps.db, tracked.id) : [];
    epics.push({
      identifier: epic.identifier,
      title: epic.title,
      url: tracked?.trackerUrl ?? null,
      pullRequests: lanes
        .filter(
          (lane) =>
            lane.repositoryId === sprint.repositoryId &&
            lane.prNumber !== null &&
            lane.prUrl !== null &&
            !(lane.prClosed && !lane.prMerged),
        )
        .map((lane) => ({ number: lane.prNumber!, url: lane.prUrl! })),
    });
  }
  return epics;
}

export type SprintPullRequestResult =
  /** Not a running merge-together sprint whose epics all merged: nothing to open. */
  | { status: "skipped" }
  /** Om opened it now, or found it open already. */
  | { status: "open"; number: number; url: string; created: boolean }
  /** It had merged already: the sprint is done. */
  | { status: "done" }
  /** It had closed without merging, or Om couldn't open it: the sprint paused with `reason`. */
  | { status: "paused"; reason: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Opens a running merge-together sprint's PR/MR once all its epics merged (after its last epic
 * merged, and from the sprint check). One recorded already is checked instead: open, it is
 * kept; merged, the sprint is done; closed without merging, a new one opens (a person resumed
 * the sprint). The sprint branch is brought up to date with the default branch first, when it
 * can be (a conflict shows on the PR/MR). A failure pauses the sprint with the reason.
 */
export async function openSprintPullRequest(
  deps: SprintRunDeps,
  sprintId: string,
): Promise<SprintPullRequestResult> {
  const { db, organizationId } = deps;
  const sprint = await getSprint(db, organizationId, sprintId);
  if (
    !sprint?.mergeTogether ||
    sprint.status !== "running" ||
    !sprint.sprintBranch ||
    sprint.epics.length === 0 ||
    !sprint.epics.every((epic) => epic.state === "merged")
  ) {
    return { status: "skipped" };
  }
  const branch = sprint.sprintBranch;
  const found = await getRepositoryWithConnection(db, sprint.repositoryId);
  const provider = found?.repository.provider ?? "github";
  const pause = async (why: string): Promise<SprintPullRequestResult> => {
    const reason = sprintPullRequestFailedReason(why, provider);
    await pauseSprint(db, organizationId, sprintId, reason);
    return { status: "paused", reason };
  };
  if (!found || found.repository.disconnectedAt) {
    return pause(`${sprint.repositoryFullPath} isn't connected.`);
  }
  const { repository, connection } = found;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  try {
    const adapter = deps.adapterFor(db, connection);
    if (sprint.sprintPrNumber !== null) {
      const state = await adapter.getChangeRequestState(repo, sprint.sprintPrNumber);
      if (state.state === "open") {
        return {
          status: "open",
          number: sprint.sprintPrNumber,
          url: sprint.sprintPrUrl ?? "",
          created: false,
        };
      }
      if (state.state === "merged") {
        await finishSprint(db, organizationId, sprintId);
        return { status: "done" };
      }
      // Closed without merging, and the sprint resumed since: a new one opens.
    }
    const defaultBranch = await fetchDefaultBranch(deps, connection, repository);
    const updated = await prepareSprintBranch(deps, sprint);
    if (updated.status === "failed") {
      console.warn(`Updating sprint branch ${branch} before its PR failed`, updated.reason);
    }
    const created = await adapter.createChangeRequest(repo, {
      sourceBranch: branch,
      targetBranch: defaultBranch,
      title: sprint.name,
      body: sprintPullRequestBody({
        name: sprint.name,
        branch,
        defaultBranch,
        provider: repository.provider,
        epics: await sprintEpicsForBody(deps, sprint),
      }),
      draft: false,
    });
    await setSprintPullRequest(db, organizationId, sprintId, {
      number: created.number,
      url: created.url,
    });
    return { status: "open", number: created.number, url: created.url, created: created.created };
  } catch (error) {
    console.error(`Opening the sprint PR of ${branch} in ${repository.fullPath} failed`, error);
    return pause(errorText(error));
  }
}

export type SprintPullRequestSettled =
  | { status: "open" }
  /** It merged: the sprint is done. */
  | { status: "done" }
  /** It closed without merging: the sprint paused. */
  | { status: "paused"; reason: string };

/**
 * A started sprint's PR/MR was seen closed (its close or merge webhook): checked with the code
 * host, a merge makes the sprint `done`, a close without merging pauses it.
 */
export async function settleSprintPullRequest(
  deps: Pick<SprintRunDeps, "db" | "organizationId" | "adapterFor">,
  sprint: Pick<Sprint, "id" | "name" | "repositoryId" | "sprintPrNumber">,
): Promise<SprintPullRequestSettled> {
  const { db, organizationId } = deps;
  if (sprint.sprintPrNumber === null) return { status: "open" };
  const found = await getRepositoryWithConnection(db, sprint.repositoryId);
  if (!found || found.repository.disconnectedAt) return { status: "open" };
  const { repository, connection } = found;
  const state = await deps
    .adapterFor(db, connection)
    .getChangeRequestState(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      sprint.sprintPrNumber,
    );
  if (state.state === "open") return { status: "open" };
  if (state.state === "merged") {
    await finishSprint(db, organizationId, sprint.id);
    return { status: "done" };
  }
  const reason = sprintPullRequestClosedReason(sprint.name, repository.provider);
  await pauseSprint(db, organizationId, sprint.id, reason, { alsoPaused: true });
  return { status: "paused", reason };
}
