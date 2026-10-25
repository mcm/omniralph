import "server-only";
import {
  filterActiveHarnessIds,
  getRepository,
  listRepositoryPinnedHarnessIds,
  unpinRepositoryFromHarness,
  updateRepositorySettings,
  type Database,
  type Repository,
} from "@omniralph/db";
import {
  DEFAULT_BLOCKED_LABELS,
  parseRalphSettings,
  type FieldErrors,
  type RalphSettingsInput,
  type RepositorySettingsInput,
} from "@omniralph/shared";
import {
  getPlaybookChoice,
  REPOSITORY_BINDING_ROLES,
  type RepositoryBinding,
} from "@/lib/playbooks";
import { pinRepository } from "@/lib/harnesses/pins";
import { bumpHarnessHeartbeat } from "@/lib/harnesses/heartbeat-cache";
import { getLinearSettingsOptions } from "@/lib/linear/settings-options";
import { unknownLinearValues } from "@/lib/linear/settings-values";
import { repositoryManualLabels } from "@/lib/ralph/epic-loader";
import type { JobDispatcher } from "@/lib/dispatch";

export type SaveRepositorySettingsResult =
  | {
      status: "saved";
      pinnedHarnessIds: string[];
      unpinnedHarnessIds: string[];
      /** `repo.sync` jobs enqueued for the newly pinned harnesses. */
      syncJobIds: string[];
    }
  | { status: "unknown_repository" }
  | { status: "unknown_agents"; harnessIds: string[] }
  | { status: "invalid_bindings"; fieldErrors: FieldErrors };

/** Why a repository role can't be bound to these playbooks (one of the organization's, of a role it takes). */
const BINDING_ERRORS: Record<RepositoryBinding, string> = {
  review: "Choose review or review-summary playbooks of this organization.",
  correlation: "Choose a correlation playbook of this organization.",
  story: "Choose a story playbook of this organization.",
  request: "Choose a request playbook of this organization.",
};

/** Whether each of `ids` is a playbook of the organization whose role `binding` takes. */
async function bindsTo(
  db: Database,
  organizationId: string,
  binding: RepositoryBinding,
  ids: readonly string[],
): Promise<boolean> {
  const roles = REPOSITORY_BINDING_ROLES[binding];
  const found = await Promise.all(
    ids.map((id) => getPlaybookChoice(db, organizationId, id, { roles })),
  );
  return found.every(Boolean);
}

/**
 * Field errors of a repository's playbook bindings (`reviewPlaybookIds`, `correlationPlaybookId`,
 * `storyPlaybookId`, `requestPlaybookId`; each left out stays as it is): every playbook must be
 * one of the organization's (built-in or its own) with a role the binding takes
 * (`REPOSITORY_BINDING_ROLES`).
 */
export async function repositoryBindingErrors(
  db: Database,
  organizationId: string,
  input: {
    reviewPlaybookIds?: readonly string[];
    correlationPlaybookId?: string;
    storyPlaybookId?: string;
    requestPlaybookId?: string;
  },
): Promise<FieldErrors> {
  const checks: [keyof typeof input, RepositoryBinding, readonly string[] | undefined][] = [
    ["reviewPlaybookIds", "review", input.reviewPlaybookIds],
    [
      "correlationPlaybookId",
      "correlation",
      input.correlationPlaybookId === undefined ? undefined : [input.correlationPlaybookId],
    ],
    [
      "storyPlaybookId",
      "story",
      input.storyPlaybookId === undefined ? undefined : [input.storyPlaybookId],
    ],
    [
      "requestPlaybookId",
      "request",
      input.requestPlaybookId === undefined ? undefined : [input.requestPlaybookId],
    ],
  ];
  const errors: FieldErrors = {};
  for (const [field, binding, ids] of checks) {
    if (ids && !(await bindsTo(db, organizationId, binding, ids))) {
      errors[field] = BINDING_ERRORS[binding];
    }
  }
  return errors;
}

/**
 * Saves a repository's review settings, its review depth among them (a repository of the
 * organization, validated with `RepositorySettingsInput`), and the review and correlation
 * playbooks its review runs use when they're given (`repositoryBindingErrors`), and reconciles
 * its agent pins: newly pinned agents go through `pinRepository`, which enqueues a `repo.sync`
 * job for that agent. The next review job enqueued for the repository picks the settings up.
 */
export async function saveRepositorySettings(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  repositoryId: string,
  input: RepositorySettingsInput,
): Promise<SaveRepositorySettingsResult> {
  // Only the organization's repositories.
  if (!(await getRepository(db, repositoryId, organizationId))) {
    return { status: "unknown_repository" };
  }
  const bindingErrors = await repositoryBindingErrors(db, organizationId, input);
  if (Object.keys(bindingErrors).length > 0) {
    return { status: "invalid_bindings", fieldErrors: bindingErrors };
  }

  const wanted = [...new Set(input.pinnedHarnessIds)];
  const current = await listRepositoryPinnedHarnessIds(db, repositoryId);
  const added = wanted.filter((id) => !current.includes(id));
  const active = await filterActiveHarnessIds(db, organizationId, added);
  const unknown = added.filter((id) => !active.has(id));
  if (unknown.length > 0) return { status: "unknown_agents", harnessIds: unknown };

  const saved = await updateRepositorySettings(db, organizationId, repositoryId, {
    depth: input.depth,
    triggers: input.triggers,
    pathExcludes: input.pathExcludes,
    customInstructions: input.customInstructions,
    reviewPlaybookIds: input.reviewPlaybookIds,
    correlationPlaybookId: input.correlationPlaybookId,
  });
  if (!saved) return { status: "unknown_repository" };

  const syncJobIds: string[] = [];
  for (const harnessId of added) {
    const { result, syncJobId } = await pinRepository(db, dispatcher, { harnessId, repositoryId });
    if (result === "unknown_agent") return { status: "unknown_agents", harnessIds: [harnessId] };
    if (result === "unknown_repository") return { status: "unknown_repository" };
    if (syncJobId) syncJobIds.push(syncJobId);
  }
  const removed = current.filter((id) => !wanted.includes(id));
  for (const harnessId of removed) {
    if (await unpinRepositoryFromHarness(db, { harnessId, repositoryId })) {
      await bumpHarnessHeartbeat(harnessId);
    }
  }
  return { status: "saved", pinnedHarnessIds: added, unpinnedHarnessIds: removed, syncJobIds };
}

/** The Linear values a repository has saved, as the Coding tab shows them. */
type SavedLinearValues = Pick<Repository, "ralphSettings">;

/** `values` not in `saved`, ignoring case. */
function newValues(values: readonly string[], saved: readonly string[]): string[] {
  const have = new Set(saved.map((v) => v.toLowerCase()));
  return values.filter((v) => !have.has(v.toLowerCase()));
}

function notInWorkspace(values: readonly string[], what: string): string {
  const list = values.map((v) => `“${v}”`).join(", ");
  return values.length === 1
    ? `${list} isn't a ${what} in your Linear workspace.`
    : `${list} aren't ${what}s in your Linear workspace.`;
}

/**
 * Field errors of a Coding form's Linear values: each manual and blocked label and the epic completed state must exist in the organization's connected Linear workspace.
 * Values the repository already has saved are kept even when they went stale (a renamed label
 * stays until a person removes it); only new ones are checked. Without a connected workspace
 * nothing is checked. `"unavailable"` when the workspace couldn't be read.
 */
export async function ralphLinearErrors(
  organizationId: string,
  saved: SavedLinearValues,
  input: Pick<RalphSettingsInput, "manualLabels" | "blockedLabels" | "epicCompletedState">,
): Promise<FieldErrors | "unavailable"> {
  const savedSettings = parseRalphSettings(saved.ralphSettings);
  const savedEpicState = savedSettings.epicCompletedState ?? "";
  const epicState = input.epicCompletedState.trim();
  const added = {
    manualLabels: newValues(input.manualLabels, repositoryManualLabels(saved)),
    // The default blocked labels are always accepted: one missing from the workspace never matches.
    blockedLabels: newValues(input.blockedLabels, [
      ...savedSettings.blockedLabels,
      ...DEFAULT_BLOCKED_LABELS,
    ]),
    epicCompletedState:
      epicState.toLowerCase() === savedEpicState.trim().toLowerCase() ? null : epicState,
  };
  const anyAdded =
    added.manualLabels.length + added.blockedLabels.length > 0 || Boolean(added.epicCompletedState);
  if (!anyAdded) return {};
  let options;
  try {
    options = await getLinearSettingsOptions(organizationId);
  } catch {
    return "unavailable";
  }
  if (!options) return {};
  const unknown = unknownLinearValues(options, added);
  return {
    ...(unknown.manualLabels.length > 0 && {
      manualLabels: notInWorkspace(unknown.manualLabels, "label"),
    }),
    ...(unknown.blockedLabels.length > 0 && {
      blockedLabels: notInWorkspace(unknown.blockedLabels, "label"),
    }),
    ...(unknown.epicCompletedState && {
      epicCompletedState: `“${unknown.epicCompletedState}” isn't a workflow state in your Linear workspace.`,
    }),
  };
}
