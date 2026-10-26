import "server-only";
import {
  loadRepositoryStatusFacts,
  type ConnectedRepository,
  type Database,
  type RepositoryStatusFacts,
  type StatusAgent,
} from "@omniralph/db";
import { isAgentOnline } from "@/lib/agents/display";
import { connectionHealth, WEBHOOK_PROBLEM_CODES } from "@/lib/connections/health";
import { agentHref } from "@/lib/runs/hrefs";

/** What a problem's button does: a `POST` to an endpoint, or a link to a page. */
export type RepositoryProblemAction =
  { type: "post"; label: string; path: string } | { type: "link"; label: string; href: string };

export type RepositoryProblemCode = "webhook" | "sync_failed" | "no_agent_online" | "connection";

/** Something wrong with a repo, in the order `REPOSITORY_PROBLEM_ORDER`. */
export interface RepositoryProblem {
  code: RepositoryProblemCode;
  message: string;
  action?: RepositoryProblemAction;
}

/** Whether something is running on a repo (its rail dot) and what is wrong with it. */
export interface RepositoryStatus {
  /** Its runs with unified status `queued` or `running`. */
  running: number;
  problems: RepositoryProblem[];
}

/** The order problems are listed in. */
export const REPOSITORY_PROBLEM_ORDER: readonly RepositoryProblemCode[] = [
  "webhook",
  "sync_failed",
  "no_agent_online",
  "connection",
];

/** The repo fields its status needs. */
export type StatusRepository = Pick<ConnectedRepository, "id" | "organizationId" | "connection">;

function isOnline(agent: StatusAgent, now: Date): boolean {
  return !agent.revoked && isAgentOnline(agent.lastHeartbeatAt, now);
}

/** The most recently heard-from of `agents`, else the first. */
function lastSeen(agents: StatusAgent[]): StatusAgent | undefined {
  return [...agents].sort(
    (a, b) => (b.lastHeartbeatAt?.getTime() ?? 0) - (a.lastHeartbeatAt?.getTime() ?? 0),
  )[0];
}

function openAgent(agent: StatusAgent | undefined): RepositoryProblemAction | undefined {
  return agent && { type: "link", label: "Open agent", href: agentHref(agent.id) };
}

/** One repo's status from the facts loaded for it (`loadRepositoryStatusFacts`). */
export function repositoryStatus(
  repository: StatusRepository,
  facts: RepositoryStatusFacts,
  now: Date = new Date(),
): RepositoryStatus {
  const problems: RepositoryProblem[] = [];
  const health = connectionHealth(repository.connection, now);

  for (const problem of health.problems) {
    if (problem.repositoryId === repository.id && WEBHOOK_PROBLEM_CODES.includes(problem.code)) {
      problems.push({
        code: "webhook",
        message: problem.sentence,
        action: {
          type: "post",
          label: "Recreate webhook",
          path: `/api/ui/repositories/${repository.id}/webhook`,
        },
      });
    }
  }

  const sync = facts.latestSync.get(repository.id);
  if (sync?.status === "failed") {
    problems.push({
      code: "sync_failed",
      message: sync.agent
        ? `Couldn't update this repo's checkout on ${sync.agent.name}.`
        : "Couldn't update this repo's checkout.",
      action: { type: "post", label: "Retry", path: `/api/ui/jobs/${sync.jobId}/rerun` },
    });
  }

  const organizationAgents = facts.agents.filter(
    (agent) => agent.organizationId === repository.organizationId,
  );
  const pinnedIds = new Set(facts.pins.get(repository.id) ?? []);
  const pinned = organizationAgents.filter((agent) => pinnedIds.has(agent.id));
  const candidates =
    pinnedIds.size > 0 ? pinned : organizationAgents.filter((agent) => !agent.revoked);
  if (!candidates.some((agent) => isOnline(agent, now))) {
    const action = openAgent(pinnedIds.size > 0 ? pinned[0] : lastSeen(candidates));
    problems.push({
      code: "no_agent_online",
      message: "No agent online",
      ...(action && { action }),
    });
  }

  if (health.state === "needs_attention") {
    for (const problem of health.problems) {
      if (problem.repositoryId === undefined) {
        problems.push({ code: "connection", message: problem.sentence });
      }
    }
  }

  return { running: facts.running.get(repository.id) ?? 0, problems };
}

/**
 * The status of each of `repositories`, by ID, from batched queries: the same number of
 * queries for one repository as for many.
 */
export async function loadRepositoryStatuses(
  db: Database,
  repositories: readonly StatusRepository[],
  now: Date = new Date(),
): Promise<Map<string, RepositoryStatus>> {
  const facts = await loadRepositoryStatusFacts(db, {
    organizationIds: [...new Set(repositories.map((r) => r.organizationId))],
    repositoryIds: repositories.map((r) => r.id),
  });
  return new Map(repositories.map((r) => [r.id, repositoryStatus(r, facts, now)]));
}
