import "server-only";
import {
  getAllowedTaskTypeDefaults,
  getRepositoryWithConnection,
  getWorkItemMatch,
  listHarnessOverview,
  listReportedModels,
  listRepositoryCodingHarnessIds,
  listRepositoryPinnedHarnessIds,
  listRoutingRules,
  repositorySwitchOverrides,
} from "@omniralph/db";
import { parseRalphSettings, ralphSettingsFormValues } from "@omniralph/shared";
import { ApiRouteError } from "@/lib/api/handler";
import type { CodingLinear, RepositoryCoding, RepositoryDetail } from "@/lib/api/repositories";
import { getDb } from "@/lib/db";
import {
  CORRELATION_TASKS,
  listTaskChoices,
  listTaskDefinitions,
  REQUEST_TASKS,
  REVIEW_TASKS,
  STORY_TASKS,
} from "@/lib/definitions";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { withLastSeen } from "@/lib/harnesses/last-seen";
import { harnessRow } from "@/lib/harnesses/rows";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { getLinearSettingsOptions } from "@/lib/linear/settings-options";
import { repositoryManualLabels } from "@/lib/ralph/epic-loader";
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
  const [
    harnesses,
    organizationVersion,
    pinnedHarnessIds,
    reviewTasks,
    correlationTasks,
    allowedTaskTypes,
    workItemMatch,
    rules,
  ] = await Promise.all([
    listHarnessOverview(db, organizationId).then(withLastSeen),
    organizationHarnessVersion(db, organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
    listRepositoryPinnedHarnessIds(db, id),
    listTaskDefinitions(db, organizationId, REVIEW_TASKS),
    listTaskChoices(db, organizationId, CORRELATION_TASKS),
    getAllowedTaskTypeDefaults(db, organizationId),
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
      reviewTaskIds: repository.reviewTaskIds,
      correlationTaskId: repository.correlationTaskId,
    },
    reviewTasks: reviewTasks.map(({ definition, builtin }) => ({
      id: definition.id,
      name: definition.name,
      description: definition.description,
      builtin,
    })),
    correlationTasks,
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
    taskTypes: {
      overrides: repositorySwitchOverrides(repository),
      inherited: {
        query: allowedTaskTypes.includes("query"),
        review: allowedTaskTypes.includes("review"),
        coding: allowedTaskTypes.includes("coding"),
      },
    },
    workItemMatch: workItemMatch ? workItemMatchRow(workItemMatch) : null,
    routingRules: rules.flatMap((rule, index) =>
      rule.repositoryId === id
        ? [{ position: index + 1, description: describeQuery(rule.query, LINEAR_ROUTING_FIELDS) }]
        : [],
    ),
  };
}

/**
 * The Coding tab's settings and its pickers' choices from the database: the coding tasks, the
 * models of the harnesses that may run the repository's coding jobs (its pinned ones, else
 * every harness accepting coding), and the organization's routing rules that target it.
 */
export async function loadRepositoryCoding(
  organizationId: string,
  id: string,
): Promise<RepositoryCoding> {
  const db = getDb();
  const { repository } = await connectedRepository(organizationId, id);
  const [storyTasks, requestTasks, { pinned, harnessIds }, rules] = await Promise.all([
    listTaskChoices(db, organizationId, STORY_TASKS),
    listTaskChoices(db, organizationId, REQUEST_TASKS),
    listRepositoryCodingHarnessIds(db, organizationId, id),
    listRoutingRules(db, organizationId),
  ]);
  const models = await listReportedModels(db, organizationId, { harnessIds });
  return {
    settings: {
      storyTaskId: repository.storyTaskId,
      requestTaskId: repository.requestTaskId,
      ...ralphSettingsFormValues(parseRalphSettings(repository.ralphSettings)),
      manualLabels: repositoryManualLabels(repository),
    },
    tasks: { story: storyTasks, request: requestTasks },
    models,
    harnessCount: harnessIds.length,
    pinned,
    routingRules: rules.flatMap((rule, index) =>
      rule.repositoryId === id
        ? [{ number: index + 1, summary: describeQuery(rule.query, LINEAR_ROUTING_FIELDS) }]
        : [],
    ),
  };
}

/** The organization's Linear workspace the Coding tab's Linear fields pick from (calls Linear). */
export async function loadCodingLinear(organizationId: string): Promise<CodingLinear> {
  return getLinearSettingsOptions(organizationId).then(
    (options): CodingLinear =>
      options ? { status: "connected", options } : { status: "disconnected" },
    (error: unknown): CodingLinear => {
      console.error("Loading the Linear settings options failed", error);
      return { status: "unavailable" };
    },
  );
}
