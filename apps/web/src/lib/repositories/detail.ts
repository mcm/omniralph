import "server-only";
import {
  getRepositoryWithConnection,
  getWorkItemMatch,
  listHarnessOverview,
  listRepositoryPinnedHarnessIds,
  listRoutingRules,
  repositorySwitches,
  type Database,
  type Repository,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import type {
  RepositoryCoding,
  RepositoryDetail,
  RepositoryTaskTypes,
} from "@/lib/api/repositories";
import { getDb } from "@/lib/db";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { withLastSeen } from "@/lib/harnesses/last-seen";
import { harnessRow } from "@/lib/harnesses/rows";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { organizationPlaybooks } from "@/lib/playbooks";
import { storyCodingSettings } from "@/lib/ralph/coding";
import { describeQuery } from "@/lib/routing/describe";
import { repositoryWebUrl } from "./web-url";
import { workItemMatchRow } from "./work-item-match";

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

/** The organization's connected repository `id`; a disconnected or missing one is not found. */
async function connectedRepository(organizationId: string, id: string) {
  const found = await getRepositoryWithConnection(getDb(), id, organizationId);
  if (!found || found.repository.disconnectedAt) throw ApiRouteError.notFound();
  return found;
}

/** A repository with what its Review settings and Harnesses tabs show (`repositoryDetailSchema`). */
export async function loadRepositoryDetail(
  organizationId: string,
  id: string,
): Promise<RepositoryDetail> {
  const db = getDb();
  const { repository, connection } = await connectedRepository(organizationId, id);
  const [harnesses, organizationVersion, pinnedHarnessIds, workItemMatch, rules] =
    await Promise.all([
      listHarnessOverview(db, organizationId).then(withLastSeen),
      organizationHarnessVersion(db, organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
      listRepositoryPinnedHarnessIds(db, id),
      getWorkItemMatch(db, organizationId, id),
      listRoutingRules(db, organizationId),
    ]);
  const now = new Date();
  return {
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
      webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
    },
    settings: {
      depth: repository.reviewDepth,
      triggers: repository.triggers,
      pathExcludes: repository.pathExcludes,
      customInstructions: repository.customInstructions ?? "",
      pinnedHarnessIds,
      reviewPlaybookIds: repository.reviewPlaybookIds,
      correlationPlaybookId: repository.correlationPlaybookId,
      storyPlaybookId: repository.storyPlaybookId,
      requestPlaybookId: repository.requestPlaybookId,
    },
    harnesses: harnesses.map((harness) => {
      const row = harnessRow(harness, now, organizationVersion.version);
      return {
        id: row.id,
        name: row.name,
        lastHeartbeatAt: row.lastHeartbeatAt,
        online: row.online,
        revoked: row.revoked,
        updating: row.updateStatus === "updating",
        acceptedTaskTypes: row.acceptedTaskTypes,
      };
    }),
    taskTypes: repositorySwitches(repository),
    workItemMatch: workItemMatch ? workItemMatchRow(workItemMatch) : null,
    routingRules: rules.flatMap((rule, index) =>
      rule.repositoryId === id
        ? [{ position: index + 1, description: describeQuery(rule.query, LINEAR_ROUTING_FIELDS) }]
        : [],
    ),
  };
}

/** A repository's coding policy on the wire, with its story playbook's round limits. */
export async function repositoryCoding(
  db: Database,
  repository: Repository,
): Promise<RepositoryCoding> {
  const settings = await storyCodingSettings(
    repository,
    organizationPlaybooks(db, repository.organizationId),
  );
  return {
    codingEnabled: repository.codingEnabled,
    codingInstructions: repository.codingInstructions,
    openPullRequestEarly: repository.openPullRequestEarly,
    historyRewrite: repository.historyRewrite,
    respondToReviewsAndCi: repository.respondToReviewsAndCi,
    roundLimits: { maxReviewRounds: settings.maxReviewRounds, maxFixRounds: settings.maxFixRounds },
  };
}

/** The organization's connected repository's switches (`repositoryTaskTypesSchema`). */
export async function loadRepositoryTaskTypes(
  organizationId: string,
  id: string,
): Promise<RepositoryTaskTypes> {
  const { repository } = await connectedRepository(organizationId, id);
  return repositorySwitches(repository);
}

/** The organization's connected repository's coding policy (`repositoryCodingSchema`). */
export async function loadRepositoryCoding(
  organizationId: string,
  id: string,
): Promise<RepositoryCoding> {
  const { repository } = await connectedRepository(organizationId, id);
  return repositoryCoding(getDb(), repository);
}
