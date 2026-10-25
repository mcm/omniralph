/**
 * The playbook resolver: an organization's playbooks are the built-ins (in
 * code, `@omniralph/tasks`, IDs `builtin:<name>`) plus its own (`playbooks`
 * rows, UUIDs). A `builtin:` ID is only ever resolved from code and a UUID only
 * from the organization's rows; a stored playbook that no longer parses is
 * unresolvable. Everything that resolves, enqueues or claims runs goes through
 * `PlaybookSource`, so built-in and custom playbooks share one path.
 */
import { getStoredPlaybook, listStoredPlaybooks, type StoredPlaybook } from "@omniralph/db";
import {
  BUILTIN_PLAYBOOKS,
  deriveHarnessRequirements,
  getBuiltinPlaybook,
  isBuiltinId,
  Playbook,
  PLAYBOOK_ROLES,
  playbookRunSpec,
  TaskRequirements,
  type PlaybookRole,
  type TaskDefinition,
  type TaskType,
  type TriggerKind,
} from "@omniralph/tasks";
import type { RunSpecJobPayload } from "@omniralph/shared";
import { runSpecJobInput } from "@/lib/runs/job";

type Queryable = Parameters<typeof getStoredPlaybook>[0];
type MaybePromise<T> = T | Promise<T>;

/** A playbook, where it comes from and what its runs need. */
export interface ResolvedPlaybook {
  playbook: Playbook;
  /** Defined in code (read-only); otherwise one of the organization's rows. */
  builtin: boolean;
  /** The requirements stored with a custom playbook when it was saved; null for a built-in. */
  requirements: TaskRequirements | null;
}

/** A stored playbook as the row holds it: its definition with the columns' ID, name and role. */
export function storedPlaybookInput(row: StoredPlaybook): Record<string, unknown> {
  return { ...row.definition, id: row.id, name: row.name, role: row.role };
}

function parseStoredPlaybook(row: StoredPlaybook): ResolvedPlaybook | null {
  const parsed = Playbook.safeParse(storedPlaybookInput(row));
  const requirements = TaskRequirements.safeParse(row.requirements);
  if (!parsed.success || !requirements.success) {
    console.warn("unresolvable stored playbook", {
      organizationId: row.organizationId,
      playbookId: row.id,
      error: (parsed.error ?? requirements.error)?.message,
    });
    return null;
  }
  // A built-in-only role is never a custom playbook's (its sink is tied to the built-in's output).
  if (PLAYBOOK_ROLES[parsed.data.role].builtinOnly) return null;
  return { playbook: parsed.data, builtin: false, requirements: requirements.data };
}

function builtin(playbook: Playbook): ResolvedPlaybook {
  return { playbook, builtin: true, requirements: null };
}

/**
 * Playbook `id` of the organization (a built-in, or one of its rows); null when
 * unknown or unresolvable.
 */
export async function getPlaybook(
  db: Queryable,
  organizationId: string,
  id: string,
): Promise<ResolvedPlaybook | null> {
  if (isBuiltinId(id)) {
    const playbook = getBuiltinPlaybook(id);
    return playbook && builtin(playbook);
  }
  const row = await getStoredPlaybook(db, organizationId, id);
  return row && parseStoredPlaybook(row);
}

export interface PlaybookFilter {
  /** Only playbooks of one of these roles. */
  roles?: readonly PlaybookRole[];
  /** Only playbooks whose role has this task type (or one of these). */
  taskType?: TaskType | readonly TaskType[];
  /** Only playbooks whose role accepts this trigger kind. */
  trigger?: TriggerKind;
}

/** Whether `playbook` passes `filter` (by its role's task type and triggers). */
export function matchesPlaybookFilter(
  playbook: Pick<Playbook, "role">,
  filter: PlaybookFilter,
): boolean {
  const role = PLAYBOOK_ROLES[playbook.role];
  if (filter.roles && !filter.roles.includes(playbook.role)) return false;
  const types = filter.taskType === undefined ? null : [filter.taskType].flat();
  if (types && !types.includes(role.taskType)) return false;
  return (
    filter.trigger === undefined || (role.triggers as readonly string[]).includes(filter.trigger)
  );
}

/**
 * The organization's playbooks passing `filter`: the built-ins, then its own
 * by name (unresolvable ones left out).
 */
export async function listPlaybooks(
  db: Queryable,
  organizationId: string,
  filter: PlaybookFilter = {},
): Promise<ResolvedPlaybook[]> {
  const rows = await listStoredPlaybooks(db, organizationId);
  return [
    ...BUILTIN_PLAYBOOKS.map(builtin),
    ...rows.map(parseStoredPlaybook).filter((playbook) => playbook !== null),
  ].filter(({ playbook }) => matchesPlaybookFilter(playbook, filter));
}

/** A playbook a settings picker offers. */
export interface PlaybookChoice {
  id: string;
  name: string;
  builtin: boolean;
}

/** What a picker of the organization's playbooks passing `filter` offers (built-ins first). */
export async function listPlaybookChoices(
  db: Queryable,
  organizationId: string,
  filter: PlaybookFilter,
): Promise<PlaybookChoice[]> {
  const playbooks = await listPlaybooks(db, organizationId, filter);
  return playbooks.map(({ playbook, builtin }) => ({
    id: playbook.id,
    name: playbook.name,
    builtin,
  }));
}

/**
 * A repository's playbook bindings and the roles each takes: its review runs
 * fan out to review and review-summary playbooks, merge them with a correlation
 * playbook, and its coding runs are story and request playbooks.
 */
export const REPOSITORY_BINDING_ROLES = {
  review: ["review", "review-summary"],
  correlation: ["correlation"],
  story: ["story"],
  request: ["request"],
} as const satisfies Record<string, readonly PlaybookRole[]>;
export type RepositoryBinding = keyof typeof REPOSITORY_BINDING_ROLES;

/**
 * Playbook `id` of the organization when it passes `filter`; null when it is
 * unknown, unresolvable or doesn't pass (a binding's server check).
 */
export async function getPlaybookChoice(
  db: Queryable,
  organizationId: string,
  id: string,
  filter: PlaybookFilter,
): Promise<ResolvedPlaybook | null> {
  const resolved = await getPlaybook(db, organizationId, id);
  return resolved && matchesPlaybookFilter(resolved.playbook, filter) ? resolved : null;
}

/**
 * Where the run plumbing (run specs, sinks, ralph's coding runs) looks
 * playbooks up by ID. `organizationPlaybooks` is the one real source; tests
 * pass their own.
 */
export interface PlaybookSource {
  getPlaybook(id: string): MaybePromise<Playbook | null>;
  /** The requirements stored with a custom playbook; null (or absent) for a built-in. */
  getPlaybookRequirements?(id: string): MaybePromise<TaskRequirements | null>;
}

/**
 * The playbooks of an organization (built-ins from code, its own from its
 * rows), each looked up at most once per source.
 */
export function organizationPlaybooks(db: Queryable, organizationId: string): PlaybookSource {
  const found = new Map<string, Promise<ResolvedPlaybook | null>>();
  const resolve = (id: string) => {
    let resolved = found.get(id);
    if (!resolved) found.set(id, (resolved = getPlaybook(db, organizationId, id)));
    return resolved;
  };
  return {
    getPlaybook: async (id) => (await resolve(id))?.playbook ?? null,
    getPlaybookRequirements: async (id) => (await resolve(id))?.requirements ?? null,
  };
}

/** The built-ins alone, for tests (real code resolves through `organizationPlaybooks`). */
export const BUILTIN_PLAYBOOK_SOURCE: PlaybookSource = {
  getPlaybook: (id) => getBuiltinPlaybook(id),
  getPlaybookRequirements: () => null,
};

/**
 * The run spec task of playbook `id` (`playbookRunSpec`: its role's task type,
 * triggers and sink, its prompt and settings), for code that reads those; null
 * when `playbooks` doesn't resolve it.
 */
export async function getPlaybookTask(
  playbooks: PlaybookSource,
  id: string,
): Promise<TaskDefinition | null> {
  const playbook = await playbooks.getPlaybook(id);
  return playbook && playbookRunSpec(playbook).task;
}

/**
 * What runs of `task` (a playbook's run spec task) need from a harness as
 * `playbooks` resolve it (the `requirements` of `runSpecJobInput`): a custom
 * playbook's at least the harness version stored with it, and every
 * playbook's installables and host tools derived from it as it is now
 * (`deriveHarnessRequirements` of its run spec).
 */
export async function taskRunRequirements(
  playbooks: PlaybookSource,
  task: TaskDefinition,
): Promise<TaskRequirements> {
  const [stored, playbook] = await Promise.all([
    playbooks.getPlaybookRequirements?.(task.id),
    playbooks.getPlaybook(task.id),
  ]);
  return {
    minHarnessVersion: stored?.minHarnessVersion ?? null,
    ...deriveHarnessRequirements(task, playbook && playbookRunSpec(playbook).agent),
  };
}

/** `runSpecJobInput` for `task` with the `taskRunRequirements` `playbooks` resolve. */
export async function taskJobInput(
  playbooks: PlaybookSource,
  task: TaskDefinition,
  payload: RunSpecJobPayload,
): Promise<ReturnType<typeof runSpecJobInput>> {
  return runSpecJobInput(task, payload, await taskRunRequirements(playbooks, task));
}
