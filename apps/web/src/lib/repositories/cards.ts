import "server-only";
import { isDeepStrictEqual } from "node:util";
import {
  deleteWorkItemMatch,
  filterActiveAgentIds,
  getIntegration,
  getRepository,
  getWorkItemMatch,
  listRepositoryPinnedAgentIds,
  pinRepositoryToAgent,
  saveWorkItemMatch,
  setRepositorySwitches,
  unpinRepositoryFromAgent,
  updateRepositoryCoding,
  updateRepositoryPlaybookBindings,
  updateRepositorySettings,
  withSettingsChanges,
  type Database,
  type Repository,
  type SettingsActor,
  type WorkItemMatchFields,
} from "@omniralph/db";
import { recordChange } from "@omniralph/db/changes";
import type { FieldErrors } from "@omniralph/shared";
import type { ActionResult } from "@/lib/action-result";
import { ApiRouteError } from "@/lib/api/handler";
import type {
  AgentsCard,
  AgentsCardInput,
  AskCard,
  AskCardInput,
  CodingCardInput,
  CodingCardSaveResult,
  CodingMatchCheck,
  PlaybooksCard,
  PlaybooksCardInput,
  ReviewsCard,
  ReviewsCardInput,
} from "@/lib/api/repositories";
import { bumpAgentHeartbeat } from "@/lib/agents/heartbeat-cache";
import { enqueueRepoSync } from "@/lib/agents/pins";
import type { JobDispatcher } from "@/lib/dispatch";
import {
  getPlaybookChoice,
  REPOSITORY_BINDING_ROLES,
  type RepositoryBinding,
} from "@/lib/playbooks";
import type { WorkItemMatchInput } from "@/lib/api/work-item-matches";
import {
  trackedRepositoryAgents,
  trackedRepositoryAsk,
  trackedRepositoryCoding,
  trackedRepositoryPlaybooks,
  trackedRepositoryReviews,
} from "@/lib/settings-history/sections";
import { askCard, loadAgentsCard, loadCodingCard, loadPlaybooksCard, reviewsCard } from "./detail";
import {
  ADD_WORK_ITEM_MATCH_FIRST,
  matchConflicts,
  refusingCodingWithoutMatch,
  TRACKER_NOT_CONNECTED,
  TURN_OFF_CODING_FIRST,
} from "./work-item-match";

/**
 * The Repos page's card saves: Reviews, Coding, Ask, Agents and Playbooks. Each saves its whole card
 * in one transaction that records one change-history entry of the card's section
 * (`withSettingsChanges`) and the repo's live `repository` change (which refreshes its rail
 * row and detail), and answers the saved card in the detail's shape. A save that changes
 * nothing writes, records and publishes nothing. The caller has checked that the user is an
 * admin of `repository`'s organization (`requireRepositoryAccess`).
 */

export type CardSaved<T> = { ok: true; card: T };

/** The repository as the save's transaction sees it; a disconnected one is not found. */
async function connected(tx: Database, repository: Repository): Promise<Repository> {
  const current = await getRepository(tx, repository.id, repository.organizationId);
  if (!current || current.disconnectedAt) throw ApiRouteError.notFound();
  return current;
}

/**
 * Records the repo's live change (its rail row and detail), and `others`' (of its
 * organization), kept once `tx` commits.
 */
function recordRepositoryChanged(
  tx: Database,
  repository: Repository,
  others: readonly string[] = [],
): void {
  recordChange(tx, {
    resource: "repository",
    ids: [repository.id, ...others],
    organizationId: repository.organizationId,
  });
}

// ── Reviews ─────────────────────────────────────────────────────────────────

/** Saves the Reviews card: the switch, triggers, depth, skip paths and reviewer instructions. */
export async function saveReviewsCard(
  db: Database,
  actor: SettingsActor,
  repository: Repository,
  input: ReviewsCardInput,
): Promise<CardSaved<ReviewsCard>> {
  const wanted: ReviewsCard = {
    enabled: input.reviewsEnabled,
    triggers: input.triggers,
    depth: input.depth,
    pathExcludes: input.pathExcludes,
    reviewerInstructions: input.reviewerInstructions.trim(),
  };
  const saved = await withSettingsChanges(
    db,
    actor,
    trackedRepositoryReviews(repository),
    async (tx) => {
      const current = await connected(tx, repository);
      if (isDeepStrictEqual(reviewsCard(current), wanted)) return current;
      await updateRepositorySettings(tx, current.organizationId, current.id, {
        depth: wanted.depth,
        triggers: wanted.triggers,
        pathExcludes: wanted.pathExcludes,
        customInstructions: wanted.reviewerInstructions,
      });
      if (current.reviewsEnabled !== wanted.enabled) {
        await setRepositorySwitches(tx, current.organizationId, current.id, {
          reviews: wanted.enabled,
        });
      }
      recordRepositoryChanged(tx, current);
      return connected(tx, repository);
    },
  );
  return { ok: true, card: reviewsCard(saved) };
}

// ── Coding ──────────────────────────────────────────────────────────────────

/** A match's conditions, as compared and saved (a project only without "no project"). */
function matchFields(match: WorkItemMatchFields): WorkItemMatchFields {
  return {
    tracker: match.tracker,
    team: match.team,
    project: match.withoutProject ? null : match.project,
    withoutProject: match.withoutProject,
    labels: [...match.labels],
  };
}

/**
 * Saves the Coding card: the switch, work item match (null clears it) and coding policy, in
 * one transaction. Coding off is applied before the match is removed, and the match is set
 * before Coding on, so that turning Coding on with a new match, or off while clearing the
 * match, saves. The rules hold on the final state (409, saving nothing): Coding on needs a
 * match ("Add a work item match…"), and clearing the match needs Coding off ("Turn off
 * Coding…"); a repo that had Coding on before work item matches keeps it without one. A
 * changed match needs its tracker connected (409). Answers the saved card and each other repo
 * whose match conflicts with it; when the match changed, those repos' (and the ones that
 * conflicted with the old match) change too.
 */
export async function saveCodingCard(
  db: Database,
  actor: SettingsActor,
  repository: Repository,
  input: CodingCardInput,
): Promise<CodingCardSaveResult> {
  const wantedMatch = input.workItemMatch ? matchFields(input.workItemMatch) : null;
  const instructions = input.codingInstructions?.trim() ?? "";
  const saved = await refusingCodingWithoutMatch(() =>
    withSettingsChanges(db, actor, trackedRepositoryCoding(repository), async (tx) => {
      const current = await connected(tx, repository);
      const stored = await getWorkItemMatch(tx, current.organizationId, current.id);
      const savedMatch = stored ? matchFields(stored) : null;
      const matchChanged = !isDeepStrictEqual(savedMatch, wantedMatch);
      const policy = {
        codingInstructions: instructions,
        openPullRequestEarly: input.openPullRequestEarly,
        historyRewrite: input.historyRewrite,
        respondToReviewsAndCi: input.respondToReviewsAndCi,
      };
      const policyChanged = !isDeepStrictEqual(policy, {
        codingInstructions: current.codingInstructions ?? "",
        openPullRequestEarly: current.openPullRequestEarly,
        historyRewrite: current.historyRewrite,
        respondToReviewsAndCi: current.respondToReviewsAndCi,
      });
      const switchChanged = current.codingEnabled !== input.codingEnabled;
      if (!matchChanged && !policyChanged && !switchChanged) return current;

      if (input.codingEnabled && !wantedMatch) {
        if (savedMatch) throw new ApiRouteError(409, TURN_OFF_CODING_FIRST, "coding_enabled");
        if (!current.codingEnabled) {
          throw new ApiRouteError(409, ADD_WORK_ITEM_MATCH_FIRST, "work_item_match_required");
        }
      }
      if (
        wantedMatch &&
        matchChanged &&
        !(await getIntegration(tx, current.organizationId, wantedMatch.tracker))
      ) {
        throw new ApiRouteError(409, TRACKER_NOT_CONNECTED, "tracker_not_connected");
      }

      // Coding off first, so the match can go; the match next, so Coding can come on.
      const update = { ...policy, codingEnabled: input.codingEnabled };
      if (!input.codingEnabled) await updateRepositoryCoding(tx, current.id, update);
      if (matchChanged) {
        if (wantedMatch) {
          const written = await saveWorkItemMatch(tx, {
            organizationId: current.organizationId,
            repositoryId: current.id,
            userId: actor.userId,
            match: wantedMatch,
          });
          if (!written) throw ApiRouteError.notFound();
        } else {
          await deleteWorkItemMatch(tx, current.organizationId, current.id);
        }
      }
      if (input.codingEnabled) await updateRepositoryCoding(tx, current.id, update);

      // A changed match changes the conflicts the old and new ones had with other repos.
      const conflicted = new Set<string>();
      for (const match of matchChanged ? [savedMatch, wantedMatch] : []) {
        if (!match) continue;
        const warnings = await matchConflicts(tx, current.organizationId, current.id, match);
        for (const warning of warnings) conflicted.add(warning.id);
      }
      recordRepositoryChanged(tx, current, [...conflicted]);
      return connected(tx, repository);
    }),
  );
  const [card, warnings] = await Promise.all([
    loadCodingCard(db, saved),
    wantedMatch ? matchConflicts(db, saved.organizationId, saved.id, wantedMatch) : [],
  ]);
  return { ok: true, card, warnings };
}

/**
 * The conflicts an unsaved match of `repository` would have (`matchConflicts`, as the Coding
 * save answers them). Writes and publishes nothing.
 */
export async function checkCodingMatch(
  db: Database,
  repository: Repository,
  match: WorkItemMatchInput,
): Promise<CodingMatchCheck> {
  const current = await connected(db, repository);
  return {
    warnings: await matchConflicts(db, current.organizationId, current.id, matchFields(match)),
  };
}

// ── Ask ─────────────────────────────────────────────────────────────────────

/** Saves the Ask card: whether Om answers questions about the repo's code. */
export async function saveAskCard(
  db: Database,
  actor: SettingsActor,
  repository: Repository,
  input: AskCardInput,
): Promise<CardSaved<AskCard>> {
  const saved = await withSettingsChanges(
    db,
    actor,
    trackedRepositoryAsk(repository.organizationId, repository.id),
    async (tx) => {
      const current = await connected(tx, repository);
      if (current.askEnabled === input.askEnabled) return current;
      await setRepositorySwitches(tx, current.organizationId, current.id, {
        ask: input.askEnabled,
      });
      recordRepositoryChanged(tx, current);
      return connected(tx, repository);
    },
  );
  return { ok: true, card: askCard(saved) };
}

// ── Agents ──────────────────────────────────────────────────────────────────

const UNKNOWN_AGENTS = "Some selected agents don't exist or were revoked.";

/** Rolls an Agents save back: a newly pinned agent isn't one the repo may pin. */
class UnknownAgentsError extends Error {}

/**
 * Saves the Agents card: pins the newly listed agents and unpins the ones left out (none
 * pinned: any agent). A newly pinned agent must be one of the organization's, not revoked or
 * deleted (400 otherwise, saving nothing). Each newly pinned agent gets a `repo.sync` job once
 * the save commits, so it clones the repo before its first run.
 */
export async function saveAgentsCard(
  db: Database,
  dispatcher: JobDispatcher,
  actor: SettingsActor,
  repository: Repository,
  input: AgentsCardInput,
): Promise<CardSaved<AgentsCard> | ActionResult> {
  const wanted = [...new Set(input.pinnedAgentIds)];
  let saved;
  try {
    saved = await withSettingsChanges(
      db,
      actor,
      trackedRepositoryAgents(repository.organizationId, repository.id),
      async (tx) => {
        const current = await connected(tx, repository);
        const pinned = await listRepositoryPinnedAgentIds(tx, current.id);
        const added = wanted.filter((id) => !pinned.includes(id));
        const removed = pinned.filter((id) => !wanted.includes(id));
        const active = await filterActiveAgentIds(tx, current.organizationId, added);
        if (added.some((id) => !active.has(id))) throw new UnknownAgentsError();
        if (added.length === 0 && removed.length === 0) return { current, added, removed };
        for (const agentId of added) {
          const result = await pinRepositoryToAgent(tx, { agentId, repositoryId: current.id });
          if (result === "unknown_repository") throw ApiRouteError.notFound();
          if (result === "unknown_agent") throw new UnknownAgentsError();
        }
        for (const agentId of removed) {
          await unpinRepositoryFromAgent(tx, { agentId, repositoryId: current.id });
        }
        recordRepositoryChanged(tx, current);
        return { current, added, removed };
      },
    );
  } catch (error) {
    if (!(error instanceof UnknownAgentsError)) throw error;
    return { ok: false, error: UNKNOWN_AGENTS, fieldErrors: { pinnedAgentIds: UNKNOWN_AGENTS } };
  }
  // The pins are visible now: the agents' next heartbeats carry them, and new pins clone.
  for (const agentId of [...saved.added, ...saved.removed]) await bumpAgentHeartbeat(agentId);
  for (const agentId of saved.added) {
    await enqueueRepoSync(db, dispatcher, { agentId, repositoryId: saved.current.id });
  }
  return { ok: true, card: await loadAgentsCard(db, saved.current) };
}

// ── Playbooks ───────────────────────────────────────────────────────────────

/** Why a binding can't use the playbooks given (one of the organization's, of a role it takes). */
const BINDING_ERRORS: Record<RepositoryBinding, string> = {
  review: "Choose review or review-summary playbooks of this organization.",
  correlation: "Choose a playbook of this organization that combines review findings.",
  story: "Choose a stories playbook of this organization.",
  request: "Choose a requests playbook of this organization.",
};

/**
 * Field errors (`bindings.<binding>`) of `bindings`: every playbook must be one of the
 * organization's (built-in or its own) with a role its binding takes (`REPOSITORY_BINDING_ROLES`).
 */
async function bindingErrors(
  db: Database,
  organizationId: string,
  bindings: PlaybooksCardInput["bindings"],
): Promise<FieldErrors> {
  const ids: Record<RepositoryBinding, readonly string[]> = {
    review: bindings.review,
    correlation: [bindings.correlation],
    story: [bindings.story],
    request: [bindings.request],
  };
  const errors: FieldErrors = {};
  for (const binding of Object.keys(ids) as RepositoryBinding[]) {
    const roles = REPOSITORY_BINDING_ROLES[binding];
    const found = await Promise.all(
      ids[binding].map((id) => getPlaybookChoice(db, organizationId, id, { roles })),
    );
    if (!found.every(Boolean)) errors[`bindings.${binding}`] = BINDING_ERRORS[binding];
  }
  return errors;
}

/**
 * Saves the Playbooks card: the playbook each of the repo's runs uses. Each playbook's role
 * must suit its binding (400 otherwise, saving nothing). Nothing else is required: the
 * viewer's "Show advanced settings" preference only shows or hides the card.
 */
export async function savePlaybooksCard(
  db: Database,
  actor: SettingsActor,
  repository: Repository,
  input: PlaybooksCardInput,
): Promise<CardSaved<PlaybooksCard> | ActionResult> {
  const errors = await bindingErrors(db, repository.organizationId, input.bindings);
  if (Object.keys(errors).length > 0) {
    return { ok: false, error: Object.values(errors)[0]!, fieldErrors: errors };
  }
  const { bindings } = input;
  const saved = await withSettingsChanges(
    db,
    actor,
    trackedRepositoryPlaybooks(repository.organizationId, repository.id),
    async (tx) => {
      const current = await connected(tx, repository);
      const unchanged =
        isDeepStrictEqual(current.reviewPlaybookIds, bindings.review) &&
        current.correlationPlaybookId === bindings.correlation &&
        current.storyPlaybookId === bindings.story &&
        current.requestPlaybookId === bindings.request;
      if (unchanged) return current;
      await updateRepositoryPlaybookBindings(tx, current.organizationId, current.id, {
        reviewPlaybookIds: bindings.review,
        correlationPlaybookId: bindings.correlation,
        storyPlaybookId: bindings.story,
        requestPlaybookId: bindings.request,
      });
      recordRepositoryChanged(tx, current);
      return connected(tx, repository);
    },
  );
  return { ok: true, card: await loadPlaybooksCard(db, saved) };
}
