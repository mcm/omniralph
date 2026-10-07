/**
 * The lanes of a ralph run (cyralph's `RepoLane`): one per repository the run
 * works in, each with its own branch and PR/MR. The lane of the run's
 * repository is its main lane; stories of a sub-issue epic whose own routing
 * signals send them elsewhere get a lane in that repository (cyralph's
 * `routeStories`), and stories that belong in a repository Omniralph doesn't
 * have are treated as manual.
 */
import {
  ensureLane,
  getLane,
  getLaneByRepository,
  getMainLane,
  getRepositoryWithConnection,
  listRalphRepositories,
  type Database,
  type RalphLane,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import type { Epic } from "@omniralph/ralph";
import { describeRoute, routeStory } from "./routing";
import type { RalphDeps } from "./run";

type Executor = Database | RalphTransaction;

/** The run's main branch (its main lane's), or "" while it has no repository. */
export async function mainBranch(
  db: Executor,
  run: Pick<RalphRun, "id" | "repositoryId">,
): Promise<string> {
  return (await getMainLane(db, run))?.branch ?? "";
}

/** The lane a story runs in: its own, else the run's main lane. */
export async function storyLane(
  db: Executor,
  run: Pick<RalphRun, "id" | "repositoryId">,
  story: Pick<RalphStory, "laneId">,
): Promise<RalphLane | null> {
  return (story.laneId ? await getLane(db, story.laneId) : null) ?? getMainLane(db, run);
}

/** Where each story runs, by its Linear issue ID: its lane, or why it's manual. */
export type StoryLanes = Map<string, { laneId: string | null; elsewhere: string | null }>;

/**
 * Routes each story of a sub-issue epic on its own signals (`routeStory`),
 * changing `epic`'s stories: one that belongs in another ralph-enabled
 * repository gets `repo` and a lane there (created with the main lane's branch
 * and that repository's default branch as its base); one that belongs in a
 * repository Omniralph doesn't have becomes manual with `elsewhere` set. Other
 * epics, and manual stories, stay in the main lane. Returns every story's lane.
 */
export async function routeStories(
  deps: Pick<RalphDeps, "db" | "adapterFor">,
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "organizationId" | "repositoryId" | "linearIdentifier">,
  epic: Epic,
): Promise<StoryLanes> {
  const main = await getMainLane(tx, run);
  const lanes: StoryLanes = new Map();
  const key = (s: Epic["stories"][number]) => s.issueId ?? s.key;
  for (const s of epic.stories) lanes.set(key(s), { laneId: main?.id ?? null, elsewhere: null });
  if (epic.kind !== "children" || !main) return lanes;

  const repositories = await listRalphRepositories(tx, run.organizationId);
  const byRepository = new Map<string, RalphLane | null>();
  for (const s of epic.stories) {
    if (s.manual) continue;
    const route = routeStory(
      repositories,
      {
        description: s.sourceText ?? null,
        labels: s.labels ?? [],
        projectName: s.projectName ?? null,
        teamKey: s.teamKey ?? null,
      },
      epic,
    );
    if (route.type === "unroutable") {
      s.manual = true;
      s.elsewhere = route.reason;
      lanes.set(key(s), { laneId: null, elsewhere: route.reason });
    } else if (route.type === "selected" && route.repository.id !== main.repositoryId) {
      const { repository } = route;
      s.repo = { id: repository.id, name: repository.fullPath, routedBy: describeRoute(route) };
      if (!byRepository.has(repository.id)) {
        byRepository.set(repository.id, await laneIn(deps, tx, run, main, repository.id));
      }
      lanes.set(key(s), { laneId: byRepository.get(repository.id)?.id ?? null, elsewhere: null });
    }
  }
  return lanes;
}

/**
 * The run's lane in another repository, created on the main lane's branch and
 * based on the repository's default branch. Null when the default branch can't
 * be read (logged; the next `advanceRun` tries again).
 */
async function laneIn(
  deps: Pick<RalphDeps, "db" | "adapterFor">,
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "linearIdentifier">,
  main: RalphLane,
  repositoryId: string,
): Promise<RalphLane | null> {
  const existing = await getLaneByRepository(tx, run.id, repositoryId);
  if (existing) return existing;
  try {
    const found = await getRepositoryWithConnection(deps.db, repositoryId);
    if (!found) throw new Error(`repository ${repositoryId} is gone`);
    const baseBranch = await deps.adapterFor(deps.db, found.connection).getDefaultBranch({
      fullPath: found.repository.fullPath,
      externalId: found.repository.externalId,
    });
    return await ensureLane(tx, { runId: run.id, repositoryId, branch: main.branch, baseBranch });
  } catch (error) {
    console.error(
      `Adding a lane of ${run.linearIdentifier} in repository ${repositoryId} failed`,
      error,
    );
    return null;
  }
}
