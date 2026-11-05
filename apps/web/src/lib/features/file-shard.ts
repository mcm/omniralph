import "server-only";
import {
  getFeatureShard,
  getIntegration,
  getLatestFeatureShard,
  getRepository,
  getWorkItemMatch,
  linkFeatureEpic,
  setFeatureParentIssue,
  updateFeatureShard,
  type Database,
  type FeatureParentIssue,
  type FeatureShard,
  type FeatureShardDraft,
  type FeatureWithRepository,
  type WorkItemMatch,
} from "@omniralph/db";
import {
  hasCapability,
  requireCapability,
  TrackerCapabilityError,
  type TrackerGateway,
} from "@omniralph/tracker";
import type { FeatureShardView, FileShardBody } from "@/lib/api/feature-shards";
import { ApiRouteError } from "@/lib/api/handler";
import { getAppUrl } from "@/lib/app-url";
import type { OrgUser } from "@/lib/auth/session";
import { getTrackerGateway } from "@/lib/tracker/client";
import { trackerName } from "@/lib/tracker/adapters";
import {
  codingOffMessage,
  noWorkItemMatchMessage,
  REPOSITORY_NOT_FOUND_MESSAGE,
  trackerNotConnectedMessage,
  unknownTeamMessage,
} from "@/lib/work-items/create";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import {
  TrackerNotConnectedError,
  WorkItemProjectNotFoundError,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";
import { ARCHIVED_MESSAGE, requireFeature } from "./manage";
import { loadShardView, NO_SHARD_MESSAGE, NOT_IN_REVIEW_MESSAGE } from "./shard";

/**
 * Filing a feature's reviewed drafts as epics through the tracker gateway: each approved
 * draft becomes an epic in the team, project and labels of the chosen repo's work item match;
 * each `dependsOn` between approved drafts becomes an epic→epic blocks relation (the only
 * relations filing makes); each epic is linked to the feature (`feature_epics`) and handed to
 * triage (the triage label), whose loop gives it its tasks. With the tracker's feature mapping
 * set to `parent-issue`, the feature gets a parent issue in the tracker (once) and every epic
 * is filed under it.
 *
 * Filing is resumable: each epic is recorded on its draft as soon as it exists, and its
 * relations, parent, link and triage once they are done, so a filing that fails part way
 * (the sharding goes back to `review` with the error) finishes on the next try without filing
 * anything twice.
 */

export const UNDECIDED_MESSAGE = "Approve or remove every draft before filing them.";
export const NOTHING_APPROVED_MESSAGE = "Approve at least one draft to file.";
export const NO_PARENT_ISSUES_MESSAGE = (tracker: string) =>
  `${tracker} can't hold parent issues. Set Features to Omniralph only in Settings › Connections › ${tracker}.`;
export const filingFailedMessage = (tracker: string, why: string) =>
  `${tracker} didn't take every epic (${why}). The ones filed so far are kept: try again to file the rest.`;

export interface FileShardDeps {
  db: Database;
  /** The organization's tracker gateway (tests; default: its connected one). */
  gateway?: () => Promise<TrackerGateway>;
}

const repoName = (fullPath: string) => fullPath.split("/").pop() ?? fullPath;

/** The repo whose work item match says where the epics are filed, checked as New work item checks it. */
async function filingTarget(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<WorkItemMatch> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository || repository.disconnectedAt) {
    throw new ApiRouteError(400, REPOSITORY_NOT_FOUND_MESSAGE, "repository_not_found", {
      repositoryId: REPOSITORY_NOT_FOUND_MESSAGE,
    });
  }
  const name = repoName(repository.fullPath);
  if (!repository.codingEnabled) {
    throw new ApiRouteError(400, codingOffMessage(name), "coding_off", {
      repositoryId: codingOffMessage(name),
    });
  }
  const match = await getWorkItemMatch(db, organizationId, repository.id);
  if (!match) {
    throw new ApiRouteError(400, noWorkItemMatchMessage(name), "no_work_item_match", {
      repositoryId: noWorkItemMatchMessage(name),
    });
  }
  return match;
}

/** Saves the drafts as filing changed them. */
async function saveDrafts(db: Database, shard: FeatureShard, drafts: FeatureShardDraft[]) {
  await updateFeatureShard(db, shard.id, { drafts }, "filing");
}

/** The feature's page, for its parent issue's description; null when the app URL isn't set. */
function featureUrl(featureId: string): string | null {
  try {
    return `${getAppUrl()}/features/${featureId}`;
  } catch {
    return null;
  }
}

/** The feature's parent issue: the one it has, else a new one in the team (and project). */
async function ensureParentIssue(
  db: Database,
  gateway: TrackerGateway,
  feature: FeatureWithRepository,
  target: { teamId: string; project: string | null },
): Promise<FeatureParentIssue> {
  if (feature.parentIssue) return feature.parentIssue;
  const parentIssues = requireCapability(gateway, "parentIssues");
  const projectId = target.project
    ? (await gateway.listProjects()).find(
        (project) => project.name.toLowerCase() === target.project!.toLowerCase(),
      )?.id
    : undefined;
  const url = featureUrl(feature.id);
  const issue = await parentIssues.createParentIssue({
    teamId: target.teamId,
    title: feature.name,
    description: url
      ? `The epics of the feature [${feature.name}](${url}), planned in Omniralph.`
      : `The epics of the feature ${feature.name}, planned in Omniralph.`,
    ...(projectId && { projectId }),
  });
  const parent: FeatureParentIssue = {
    tracker: gateway.provider,
    externalId: issue.id,
    identifier: issue.identifier,
    url: issue.url,
  };
  await setFeatureParentIssue(db, feature, parent);
  return parent;
}

/**
 * Relates, files under the parent, links and triages one filed epic. Each step is safe to
 * repeat: a blocks relation the epic already has isn't made again.
 */
async function linkEpic(
  db: Database,
  context: {
    gateway: TrackerGateway;
    tracker: WorkItemTracker;
    feature: FeatureWithRepository;
    parent: FeatureParentIssue | null;
    filedByKey: Map<string, NonNullable<FeatureShardDraft["filed"]>>;
  },
  draft: FeatureShardDraft & { filed: NonNullable<FeatureShardDraft["filed"]> },
): Promise<void> {
  const { gateway, tracker, feature, parent, filedByKey } = context;
  if (parent)
    await requireCapability(gateway, "parentIssues").fileUnder(
      parent.externalId,
      draft.filed.externalId,
    );
  const blockers = new Set((await gateway.getBlockers(draft.filed.externalId)).map((b) => b.id));
  for (const key of draft.dependsOn) {
    const blocker = filedByKey.get(key);
    // Only epic→epic: a dependency on a removed draft (never filed) is dropped.
    if (!blocker || blockers.has(blocker.externalId)) continue;
    await gateway.createBlocksRelation(blocker.externalId, draft.filed.externalId);
  }
  await linkFeatureEpic(db, {
    featureId: feature.id,
    organizationId: feature.organizationId,
    tracker: draft.filed.tracker,
    externalId: draft.filed.externalId,
  });
  await tracker.startTriage(draft.filed.externalId);
}

/**
 * Files the approved drafts of the feature's sharding as epics (admins) in the team, project
 * and labels of `repositoryId`'s work item match. 409 unless it waits for review with every
 * draft decided; 400 without an approved draft or a repo that picks up work items. A tracker
 * that fails part way keeps what was filed and sends the sharding back to review with why.
 */
export async function fileShard(
  deps: FileShardDeps,
  user: OrgUser,
  featureId: string,
  body: FileShardBody,
): Promise<FeatureShardView> {
  const { db } = deps;
  const feature = await requireFeature(db, user, featureId);
  if (feature.status === "archived") throw new ApiRouteError(409, ARCHIVED_MESSAGE, "archived");
  const organizationId = feature.organizationId;
  const latest = await getLatestFeatureShard(db, organizationId, feature.id);
  if (!latest) throw ApiRouteError.notFound(NO_SHARD_MESSAGE);
  const match = await filingTarget(db, organizationId, body.repositoryId);

  const shard = await db.transaction(async (tx) => {
    const locked = await getFeatureShard(tx, organizationId, latest.id, { lock: true });
    if (locked?.status !== "review") {
      throw new ApiRouteError(409, NOT_IN_REVIEW_MESSAGE, "not_in_review");
    }
    if (locked.drafts.some((draft) => draft.decision === "pending")) {
      throw new ApiRouteError(409, UNDECIDED_MESSAGE, "undecided");
    }
    if (!locked.drafts.some((draft) => draft.decision === "approved")) {
      throw new ApiRouteError(400, NOTHING_APPROVED_MESSAGE, "nothing_approved");
    }
    return (await updateFeatureShard(
      tx,
      locked.id,
      { status: "filing", repositoryId: body.repositoryId, error: null },
      "review",
    ))!;
  });

  const name = trackerName(match.tracker);
  try {
    await fileDrafts(deps, feature, shard, match);
  } catch (error) {
    const reason =
      error instanceof ApiRouteError
        ? error.message
        : error instanceof TrackerNotConnectedError
          ? trackerNotConnectedMessage(match.tracker)
          : error instanceof TrackerCapabilityError
            ? NO_PARENT_ISSUES_MESSAGE(name)
            : error instanceof WorkItemProjectNotFoundError
              ? `${name} has no project ${error.projectName}.`
              : filingFailedMessage(name, error instanceof Error ? error.message : String(error));
    if (!(error instanceof ApiRouteError)) {
      console.error(`Filing sharding ${shard.id} of feature ${feature.id} failed`, error);
    }
    await updateFeatureShard(db, shard.id, { status: "review", error: reason }, "filing");
    throw new ApiRouteError(502, reason, "filing_failed");
  }
  await updateFeatureShard(
    db,
    shard.id,
    { status: "filed", filedAt: new Date(), filedBy: user.id, error: null },
    "filing",
  );
  return loadShardView(db, await requireFeature(db, user, featureId));
}

async function fileDrafts(
  deps: FileShardDeps,
  feature: FeatureWithRepository,
  shard: FeatureShard,
  match: WorkItemMatch,
): Promise<void> {
  const { db } = deps;
  const organizationId = feature.organizationId;
  const gateway = await (deps.gateway ?? (() => getTrackerGateway({ db, organizationId })))();
  if (gateway.provider !== match.tracker) {
    throw new TrackerNotConnectedError();
  }
  const tracker = await workItemTrackerFor({ db, organizationId, gateway });
  const team = (await tracker.teams()).find(
    (candidate) => candidate.key.toLowerCase() === match.team.toLowerCase(),
  );
  if (!team) {
    throw new ApiRouteError(400, unknownTeamMessage(match.tracker, match.team), "unknown_team");
  }
  const project = !match.withoutProject && match.project !== null ? match.project : null;

  const integration = await getIntegration(db, organizationId, gateway.provider);
  const mapping = integration?.featureMapping ?? "omniralph";
  let parent: FeatureParentIssue | null = null;
  if (mapping === "parent-issue") {
    if (!hasCapability(gateway, "parentIssues")) {
      throw new TrackerCapabilityError(gateway.provider, "parentIssues");
    }
    parent = await ensureParentIssue(db, gateway, feature, { teamId: team.id, project });
  }

  const drafts = [...shard.drafts];
  // File every approved draft not filed yet, recording each at once.
  for (const [index, draft] of drafts.entries()) {
    if (draft.decision !== "approved" || draft.filed) continue;
    const item = await tracker.create({
      teamId: team.id,
      ...(project !== null && { projectName: project }),
      ...(match.labels.length > 0 && { labels: [...match.labels] }),
      title: draft.title,
      description: draft.description,
    });
    drafts[index] = {
      ...draft,
      filed: {
        tracker: item.tracker,
        externalId: item.id,
        identifier: item.identifier,
        url: item.url,
        linked: false,
      },
    };
    await saveDrafts(db, shard, drafts);
  }

  const filedByKey = new Map(
    drafts.flatMap((draft) =>
      draft.decision === "approved" && draft.filed ? [[draft.key, draft.filed] as const] : [],
    ),
  );
  for (const [index, draft] of drafts.entries()) {
    if (draft.decision !== "approved" || !draft.filed || draft.filed.linked) continue;
    await linkEpic(
      db,
      { gateway, tracker, feature, parent, filedByKey },
      { ...draft, filed: draft.filed },
    );
    drafts[index] = { ...draft, filed: { ...draft.filed, linked: true } };
    await saveDrafts(db, shard, drafts);
  }
}
