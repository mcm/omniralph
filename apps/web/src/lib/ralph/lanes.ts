/**
 * The lanes of a ralph run (cyralph's `RepoLane`): one per repository the run
 * works in, each with its own branch and PR/MR. The lane of the run's
 * repository is its main lane; stories of a sub-issue epic that the routing
 * rules send elsewhere get a lane in that repository (cyralph's
 * `routeStories`), and stories that route to a repository with coding off are
 * treated as manual.
 */
import {
  ensureLane,
  getLane,
  getLaneByRepository,
  getMainLane,
  getRepositoryWithConnection,
  listFollowUps,
  type Database,
  type RalphLane,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import { withManualOptions, type Epic } from "@omniralph/ralph";
import { organizationPlaybooks } from "@/lib/playbooks";
import { createRouter, routedRepository } from "@/lib/routing/resolve";
import { organizationManualLabels, repositoryAllowsPreparation } from "./epic-loader";
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
 * Routes each story of a sub-issue epic with the organization's routing rules
 * (`createRouter`), changing `epic`'s stories. A story with no rule of its own
 * routes as its parent, the epic, and stays in the main lane; a follow-up routes
 * as its source story, so it joins that story's lane. One that routes to
 * another repository with coding on gets `repo` and a lane there (created with
 * the main lane's branch and that repository's default branch as its base), and
 * is prepared by its story playbook's `allowPreparation` instead of the main
 * repository's. One that routes to a
 * repository with coding off becomes manual with `elsewhere` set (and no
 * preparation), like a manual-labelled story. Other epics' stories stay in the
 * main lane. Returns every story's lane.
 */
export async function routeStories(
  deps: Pick<RalphDeps, "db" | "adapterFor" | "linear">,
  tx: RalphTransaction,
  run: Pick<RalphRun, "id" | "organizationId" | "repositoryId" | "linearIdentifier">,
  epic: Epic,
): Promise<StoryLanes> {
  const main = await getMainLane(tx, run);
  const lanes: StoryLanes = new Map();
  const key = (s: Epic["stories"][number]) => s.issueId ?? s.key;
  for (const s of epic.stories) lanes.set(key(s), { laneId: main?.id ?? null, elsewhere: null });
  if (epic.kind !== "children" || !main) return lanes;

  // In the transaction, so the epic routes to this run's repository even before it commits.
  const router = await createRouter({
    db: tx,
    organizationId: run.organizationId,
    linear: deps.linear,
  });
  // Without routing rules or work item matches every story routes as the epic (the main lane) but follow-ups, which
  // route as their source.
  const issueIds = epic.stories.flatMap((s) => (s.issueId ? [s.issueId] : []));
  const toRoute = router.hasCustomRoutes
    ? new Set(issueIds)
    : await listFollowUps(tx, run.organizationId, issueIds);
  if (toRoute.size === 0) return lanes;

  const byRepository = new Map<string, RalphLane | null>();
  for (const [i, s] of epic.stories.entries()) {
    if (!s.issueId || !toRoute.has(s.issueId)) continue;
    const route = await router.resolve(s.issueId);
    const repository = routedRepository(route);
    // Asking, or the epic's own repository (as its parent, or by a rule): the main lane.
    if (!repository || "ask" in route || repository.id === main.repositoryId) continue;
    if ("manual" in route) {
      const reason = `it routes to \`${repository.fullPath}\` by ${route.by}, and coding is off there`;
      s.manual = true;
      s.elsewhere = reason;
      // Nothing is built for it there, so there's nothing to prepare.
      delete s.preparation;
      lanes.set(key(s), { laneId: null, elsewhere: reason });
      continue;
    }
    // Its repository's preparation setting applies, not the main one's.
    const routed = withManualOptions(s, {
      manualLabels: await organizationManualLabels(tx, run.organizationId),
      allowPreparation: await repositoryAllowsPreparation(
        repository,
        organizationPlaybooks(deps.db, run.organizationId),
      ),
    });
    routed.repo = { id: repository.id, name: repository.fullPath, routedBy: route.by };
    epic.stories[i] = routed;
    if (!byRepository.has(repository.id)) {
      byRepository.set(repository.id, await laneIn(deps, tx, run, main, repository.id));
    }
    lanes.set(key(s), { laneId: byRepository.get(repository.id)?.id ?? null, elsewhere: null });
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
