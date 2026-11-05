import "server-only";
import {
  createFeatureShard,
  getFeatureDocument,
  getFeatureShard,
  getIntegration,
  getLatestFeatureShard,
  listRunIterations,
  updateFeatureShard,
  type Database,
  type FeatureShard,
  type FeatureWithRepository,
  type RunIteration,
} from "@omniralph/db";
import { planSections } from "@omniralph/planning";
import { ShardRound } from "@omniralph/shared";
import type {
  FeatureShardRound,
  FeatureShardRow,
  FeatureShardView,
  UpdateShardDraftBody,
} from "@/lib/api/feature-shards";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrgUser } from "@/lib/auth/session";
import type { JobDispatcher } from "@/lib/dispatch";
import { DEFAULT_TRACKER_PROVIDER } from "@/lib/tracker/client";
import { ARCHIVED_MESSAGE, requireFeature } from "./manage";
import { roundFindings, roundPassed, shardLoopRun, startShardLoop } from "./shard-loop";

/**
 * Sharding a feature's Plan into epics, as the `/api/ui/features/{id}/shard/**` handlers see
 * it: start a sharding (a loop drafts the epics: `./shard-loop.ts`), read it with its rounds,
 * then edit, remove or approve each draft before filing the approved ones (`./file-shard.ts`).
 */

export const NO_PLAN_MESSAGE = "Write the Plan before sharding it into epics.";
export const NO_SECTIONS_MESSAGE =
  "Give each part of the Plan its own ## heading, so Om can map every epic to the sections it covers.";
export const SHARD_ACTIVE_MESSAGE =
  "This feature is being sharded already. Review or discard those drafts first.";
export const NOT_IN_REVIEW_MESSAGE = "These drafts aren't waiting for review anymore.";
export const NO_SHARD_MESSAGE = "This feature has no drafts to review.";
export const UNKNOWN_DRAFT_MESSAGE = "That draft doesn't exist.";
export const FILED_DRAFT_MESSAGE = "That epic is filed already: change it in the tracker.";
export const SHARD_FAILED_MESSAGE = "Om couldn't start sharding the Plan. Try again in a moment.";

/** The rounds of the sharding's loop as the page shows them. */
function roundRows(iterations: readonly RunIteration[]): FeatureShardRound[] {
  return iterations.map((iteration) => {
    const round = ShardRound.safeParse(iteration.details);
    const passed =
      iteration.status === "done" && round.success && round.data.draft
        ? round.data.verification || !round.data.check.passed
          ? roundPassed(round.data)
          : null
        : iteration.status === "failed"
          ? false
          : null;
    const problems = round.success ? roundFindings(round.data) : [];
    return {
      number: iteration.number,
      status: iteration.status,
      passed,
      summary:
        iteration.error ?? iteration.summary ?? (problems.length > 0 ? problems.join(" ") : null),
    };
  });
}

export function shardRow(
  shard: FeatureShard,
  iterations: readonly RunIteration[],
): FeatureShardRow {
  return {
    id: shard.id,
    status: shard.status,
    planVersion: shard.planVersion,
    sections: shard.sections,
    drafts: shard.drafts.map((draft) => ({
      key: draft.key,
      title: draft.title,
      description: draft.description,
      covers: draft.covers,
      dependsOn: draft.dependsOn,
      notes: draft.notes,
      decision: draft.decision,
      edited: draft.edited,
      filed: draft.filed ? { identifier: draft.filed.identifier, url: draft.filed.url } : null,
    })),
    exempt: shard.exempt,
    summary: shard.summary,
    leftovers: shard.leftovers,
    error: shard.error,
    rounds: roundRows(iterations),
    maxRounds: iterations[0]?.maxIterations ?? null,
    repositoryId: shard.repositoryId,
    createdAt: shard.createdAt.toISOString(),
    filedAt: shard.filedAt?.toISOString() ?? null,
  };
}

/** The feature's sharding view: its newest sharding, the tracker's feature mapping and its parent issue. */
export async function loadShardView(
  db: Database,
  feature: Pick<FeatureWithRepository, "id" | "organizationId" | "parentIssue">,
): Promise<FeatureShardView> {
  const shard = await getLatestFeatureShard(db, feature.organizationId, feature.id);
  const integration = await getIntegration(db, feature.organizationId, DEFAULT_TRACKER_PROVIDER);
  return {
    shard: shard ? shardRow(shard, await listRunIterations(db, shardLoopRun(shard))) : null,
    featureMapping: integration?.featureMapping ?? null,
    parentIssue: feature.parentIssue
      ? { identifier: feature.parentIssue.identifier, url: feature.parentIssue.url }
      : null,
  };
}

export async function getShardView(
  db: Database,
  user: OrgUser,
  featureId: string,
): Promise<FeatureShardView> {
  return loadShardView(db, await requireFeature(db, user, featureId));
}

/**
 * Starts sharding the feature's latest Plan (admins): 409 when the feature is archived or a
 * sharding is active already, 400 when the Plan is empty or has no `##` sections. Its first
 * round's worker job is queued and its agents woken.
 */
export async function startShard(
  db: Database,
  dispatcher: Pick<JobDispatcher, "republish">,
  user: OrgUser,
  featureId: string,
): Promise<FeatureShardView> {
  const feature = await requireFeature(db, user, featureId);
  if (feature.status === "archived") throw new ApiRouteError(409, ARCHIVED_MESSAGE, "archived");
  const organizationId = feature.organizationId;
  const plan = await getFeatureDocument(db, organizationId, feature.id, "plan");
  if (!plan?.body.trim()) throw new ApiRouteError(400, NO_PLAN_MESSAGE, "no_plan");
  const sections = planSections(plan.body);
  if (sections.length === 0) throw new ApiRouteError(400, NO_SECTIONS_MESSAGE, "no_sections");
  const prfaq = await getFeatureDocument(db, organizationId, feature.id, "prfaq");

  const { shard, created } = await createFeatureShard(db, {
    organizationId,
    featureId: feature.id,
    planVersion: plan.version,
    sections,
    createdBy: user.id,
  });
  if (!created) throw new ApiRouteError(409, SHARD_ACTIVE_MESSAGE, "shard_active");
  let jobId: string;
  try {
    jobId = await startShardLoop(db, shard, feature, {
      prfaq: prfaq?.body ?? null,
      plan: plan.body,
    });
  } catch (error) {
    console.error(`Starting sharding ${shard.id} of feature ${feature.id} failed`, error);
    await updateFeatureShard(
      db,
      shard.id,
      { status: "failed", error: SHARD_FAILED_MESSAGE },
      "drafting",
    );
    throw new ApiRouteError(500, SHARD_FAILED_MESSAGE, "shard_failed");
  }
  await dispatcher.republish(jobId);
  return loadShardView(db, feature);
}

/**
 * Edits, removes or approves one draft of the feature's sharding while it waits for review
 * (admins). Editing a title or description marks the draft `edited`; a filed draft can't change.
 */
export async function updateShardDraft(
  db: Database,
  user: OrgUser,
  featureId: string,
  key: string,
  body: UpdateShardDraftBody,
): Promise<FeatureShardView> {
  const feature = await requireFeature(db, user, featureId);
  if (feature.status === "archived") throw new ApiRouteError(409, ARCHIVED_MESSAGE, "archived");
  const latest = await getLatestFeatureShard(db, feature.organizationId, feature.id);
  if (!latest) throw ApiRouteError.notFound(NO_SHARD_MESSAGE);
  await db.transaction(async (tx) => {
    const shard = await getFeatureShard(tx, feature.organizationId, latest.id, { lock: true });
    if (shard?.status !== "review") {
      throw new ApiRouteError(409, NOT_IN_REVIEW_MESSAGE, "not_in_review");
    }
    const index = shard.drafts.findIndex((draft) => draft.key === key);
    if (index === -1) throw ApiRouteError.notFound(UNKNOWN_DRAFT_MESSAGE);
    const draft = shard.drafts[index]!;
    if (draft.filed) throw new ApiRouteError(409, FILED_DRAFT_MESSAGE, "filed");
    const title = body.title ?? draft.title;
    const description = body.description ?? draft.description;
    const drafts = shard.drafts.with(index, {
      ...draft,
      title,
      description,
      decision: body.decision ?? draft.decision,
      edited: draft.edited || title !== draft.title || description !== draft.description,
    });
    await updateFeatureShard(tx, shard.id, { drafts }, "review");
  });
  return loadShardView(db, feature);
}

/**
 * Discards the feature's active sharding (admins): it ends `canceled`, and a round still
 * drafting has its jobs canceled. Epics already filed stay filed. 409 without one.
 */
export async function discardShard(
  db: Database,
  dispatcher: Pick<JobDispatcher, "cancel">,
  user: OrgUser,
  featureId: string,
): Promise<FeatureShardView> {
  const feature = await requireFeature(db, user, featureId);
  const latest = await getLatestFeatureShard(db, feature.organizationId, feature.id);
  if (!latest) throw ApiRouteError.notFound(NO_SHARD_MESSAGE);
  const discarded = await updateFeatureShard(db, latest.id, { status: "canceled" }, [
    "drafting",
    "review",
  ]);
  if (!discarded) throw new ApiRouteError(409, NOT_IN_REVIEW_MESSAGE, "not_in_review");
  if (latest.status === "drafting") {
    const last = (await listRunIterations(db, shardLoopRun(latest))).at(-1);
    for (const jobId of [last?.workerJobId, last?.verifierJobId]) {
      if (!jobId) continue;
      try {
        await dispatcher.cancel(jobId);
      } catch (error) {
        console.error(`Canceling job ${jobId} of discarded sharding ${latest.id} failed`, error);
      }
    }
  }
  return loadShardView(db, feature);
}
