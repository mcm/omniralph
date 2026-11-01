import "server-only";
import {
  getIntegration,
  getRepositoryWithConnection,
  getWorkItemMatch,
  listAgentOverview,
  listRepositoryPinnedAgentIds,
  listRoutingRules,
  type AgentOverview,
  type Database,
  type Repository,
} from "@omniralph/db";
import { REVIEW_DEPTH_IDS, REVIEW_DEPTHS } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type {
  AgentsCard,
  AskCard,
  CodingCard,
  PlaybooksCard,
  RepositoryAgentState,
  RepositoryDetail,
  RepositoryTracker,
  ReviewDepthOption,
  ReviewsCard,
} from "@/lib/api/repositories";
import type { ScopedOrganization } from "@/lib/api/scope";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import { WORK_ITEM_TRACKERS } from "@/lib/api/work-item-matches";
import { hasRole } from "@/lib/auth/roles";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { agentRow } from "@/lib/agents/rows";
import { LINEAR_ROUTING_FIELDS } from "@/lib/tracker/linear/routing-fields";
import type { SettingsSection } from "@/lib/live/events";
import {
  listPlaybooks,
  matchesPlaybookFilter,
  organizationPlaybooks,
  REPOSITORY_BINDING_ROLES,
  type RepositoryBinding,
} from "@/lib/playbooks";
import { storyCodingSettings } from "@/lib/ralph/coding";
import { describeQuery } from "@/lib/routing/describe";
import { loadSettingsHistory } from "@/lib/settings-history/history";
import { splitRepositoryPath } from "./list";
import { loadRepositoryStatuses } from "./status";
import { repositoryWebUrl } from "./web-url";
import { workItemMatchRow } from "./work-item-match";

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

// ── The Repos page's repo detail ────────────────────────────────────────────────────────────

/** The Reviews card of `repository`. */
export function reviewsCard(repository: Repository): ReviewsCard {
  return {
    enabled: repository.reviewsEnabled,
    triggers: {
      onOpen: repository.triggers.onOpen,
      onPush: repository.triggers.onPush,
      drafts: repository.triggers.drafts,
    },
    depth: repository.reviewDepth,
    pathExcludes: repository.pathExcludes,
    reviewerInstructions: repository.customInstructions ?? "",
  };
}

/** The Ask card of `repository`. */
export function askCard(repository: Repository): AskCard {
  return { enabled: repository.askEnabled };
}

/**
 * The Coding card of `repository`: its policy, work item match, story playbook round limits
 * and every routing rule of its organization that targets it.
 */
export async function loadCodingCard(db: Database, repository: Repository): Promise<CodingCard> {
  const { organizationId, id } = repository;
  const [settings, match, rules] = await Promise.all([
    storyCodingSettings(repository, organizationPlaybooks(db, organizationId)),
    getWorkItemMatch(db, organizationId, id),
    listRoutingRules(db, organizationId),
  ]);
  return {
    enabled: repository.codingEnabled,
    workItemMatch: match ? workItemMatchRow(match) : null,
    codingInstructions: repository.codingInstructions ?? "",
    openPullRequestEarly: repository.openPullRequestEarly,
    historyRewrite: repository.historyRewrite,
    respondToReviewsAndCi: repository.respondToReviewsAndCi,
    roundLimits: { review: settings.maxReviewRounds, fix: settings.maxFixRounds },
    routingRules: rules.flatMap((rule, index) =>
      rule.repositoryId === id
        ? [{ position: index + 1, description: describeQuery(rule.query, LINEAR_ROUTING_FIELDS) }]
        : [],
    ),
  };
}

/** A pinned agent's state: see `REPOSITORY_AGENT_STATES`. */
function pinnedAgentState(
  agent: AgentOverview,
  runningForRepo: number,
  now: Date,
  organizationVersion: string | null,
): RepositoryAgentState {
  const row = agentRow(agent, now, organizationVersion);
  if (row.revoked) return "revoked";
  if (!row.online) return "offline";
  if (runningForRepo > 0) return "running";
  if (row.updateStatus === "updating") return "updating";
  return "idle";
}

/**
 * The Agents card of `repository`: its pinned agents with their state and running attempts
 * of its runs, and the organization's agents it may pin (not pinned, revoked or deleted).
 */
export async function loadAgentsCard(
  db: Database,
  repository: Repository,
  now: Date = new Date(),
): Promise<AgentsCard> {
  const [agents, organizationVersion, pinnedIds] = await Promise.all([
    listAgentOverview(db, repository.organizationId),
    organizationAgentVersion(db, repository.organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
    listRepositoryPinnedAgentIds(db, repository.id),
  ]);
  const pinned = new Set(pinnedIds);
  return {
    // Deleted agents aren't listed, so their pins (if any are left) don't show.
    pinned: agents
      .filter((agent) => pinned.has(agent.id))
      .map((agent) => {
        const runningForRepo = agent.runningJobs.filter(
          (job) => job.runId !== null && job.repository?.id === repository.id,
        ).length;
        return {
          id: agent.id,
          name: agent.name,
          state: pinnedAgentState(agent, runningForRepo, now, organizationVersion.version),
          runningForRepo,
        };
      }),
    pinnable: agents
      .filter((agent) => !pinned.has(agent.id) && agent.revokedAt === null)
      .map((agent) => ({ id: agent.id, name: agent.name })),
  };
}

const BINDINGS = Object.keys(REPOSITORY_BINDING_ROLES) as RepositoryBinding[];

/** The Playbooks card of `repository`: its bindings, and the playbooks each may use. */
export async function loadPlaybooksCard(
  db: Database,
  repository: Repository,
): Promise<PlaybooksCard> {
  const playbooks = await listPlaybooks(db, repository.organizationId);
  const choices = (binding: RepositoryBinding) =>
    playbooks
      .filter(({ playbook }) =>
        matchesPlaybookFilter(playbook, { roles: REPOSITORY_BINDING_ROLES[binding] }),
      )
      .map(({ playbook, builtin }) => ({ id: playbook.id, name: playbook.name, builtin }));
  return {
    bindings: {
      review: repository.reviewPlaybookIds,
      correlation: repository.correlationPlaybookId,
      story: repository.storyPlaybookId,
      request: repository.requestPlaybookId,
    },
    choices: Object.fromEntries(
      BINDINGS.map((binding) => [binding, choices(binding)]),
    ) as PlaybooksCard["choices"],
  };
}

/** Each card's settings section. */
const CARD_SECTIONS = {
  reviews: "repository.reviews",
  coding: "repository.coding",
  ask: "repository.ask",
  agents: "repository.agents",
  playbooks: "repository.playbooks",
} as const satisfies Record<keyof RepositoryDetail["history"], SettingsSection>;

/** The latest change of `section` of `repositoryId`, with the runs since, or null. */
export async function latestRepositoryChange(
  db: Database,
  organization: ScopedOrganization,
  repositoryId: string,
  section: SettingsSection,
): Promise<SettingsHistoryEntry | null> {
  const history = await loadSettingsHistory(db, [organization], {
    section,
    subject: repositoryId,
    limit: 1,
  });
  return history.latest;
}

async function loadCardHistory(
  db: Database,
  organization: ScopedOrganization,
  repositoryId: string,
): Promise<RepositoryDetail["history"]> {
  const cards = Object.keys(CARD_SECTIONS) as (keyof typeof CARD_SECTIONS)[];
  const latest = await Promise.all(
    cards.map((card) =>
      latestRepositoryChange(db, organization, repositoryId, CARD_SECTIONS[card]),
    ),
  );
  return Object.fromEntries(
    cards.map((card, i) => [card, latest[i]]),
  ) as RepositoryDetail["history"];
}

/** Every review depth, fastest first, as the Depth control and its popover show them. */
export function reviewDepthOptions(): ReviewDepthOption[] {
  return REVIEW_DEPTH_IDS.map((id) => {
    const { label, summary, details } = REVIEW_DEPTHS[id];
    return {
      id,
      label,
      summary,
      details: {
        model: details.modelLabel,
        tokenCap: details.tokenCapLabel,
        reads: details.reads,
        comments: details.comments,
        typicalTime: details.typicalTime,
      },
    };
  });
}

/** The organization's connected trackers, with their workspace names. */
async function loadTrackers(db: Database, organizationId: string): Promise<RepositoryTracker[]> {
  const found = await Promise.all(
    WORK_ITEM_TRACKERS.map(async (tracker) => {
      const integration = await getIntegration(db, organizationId, tracker);
      return integration ? { tracker, id: integration.id, workspaceName: integration.name } : null;
    }),
  );
  return found.filter((tracker) => tracker !== null);
}

/**
 * Everything the Repos page shows for `repositoryId` of `organization` (the user's
 * membership, from `requireRepositoryAccess`): its header, status, every card and each
 * card's latest change. A disconnected repo is not found. Nothing depends on the viewer
 * beyond their role.
 */
export async function loadRepositoryDetail(
  db: Database,
  organization: ScopedOrganization,
  repositoryId: string,
  now: Date = new Date(),
): Promise<RepositoryDetail> {
  const found = await getRepositoryWithConnection(db, repositoryId, organization.id);
  if (!found || found.repository.disconnectedAt) throw ApiRouteError.notFound();
  const { repository, connection } = found;
  const [statuses, coding, trackers, agents, playbooks, history] = await Promise.all([
    loadRepositoryStatuses(
      db,
      [{ id: repository.id, organizationId: repository.organizationId, connection }],
      now,
    ),
    loadCodingCard(db, repository),
    loadTrackers(db, organization.id),
    loadAgentsCard(db, repository, now),
    loadPlaybooksCard(db, repository),
    loadCardHistory(db, organization, repository.id),
  ]);
  return {
    repository: {
      id: repository.id,
      organization: { id: organization.id, name: organization.name, role: organization.role },
      provider: repository.provider,
      fullPath: repository.fullPath,
      ...splitRepositoryPath(repository.fullPath),
      webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
      defaultBranch: repository.defaultBranch,
    },
    canEdit: hasRole(organization, "admin"),
    status: statuses.get(repository.id)!,
    reviews: reviewsCard(repository),
    depths: reviewDepthOptions(),
    coding,
    trackers,
    ask: askCard(repository),
    agents,
    playbooks,
    history,
  };
}
