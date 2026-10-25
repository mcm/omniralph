/**
 * Change recording for the control panel's live updates. Write functions call
 * `recordChange` after a write that changes what a screen shows; the change is
 * added to the request's `ChangeCollector` (AsyncLocalStorage), which the web
 * app opens per request and publishes after the response
 * (`apps/web/src/lib/live`). A change recorded on a transaction is kept only
 * once that transaction commits (`withChangeScopes`): a rolled-back write
 * publishes nothing. Outside a collector, recording is a no-op.
 *
 * Changes carry IDs only, never content: a subscriber refetches through the
 * normal, authorized endpoints.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** What changed; the web app's event catalogue (`lib/live/events.ts`) mirrors this list. */
export const CHANGE_RESOURCES = [
  "run",
  "transcript",
  "pull_request",
  "inbox_state",
  "webhook_event",
  "settings",
  "agent",
  "repository",
  "connection",
  "organization",
] as const;
export type ChangeResource = (typeof CHANGE_RESOURCES)[number];

export interface Change {
  resource: ChangeResource;
  /** The changed rows' IDs (for an attempt's change: the job's ID, with `runId` its run). */
  ids: readonly string[];
  organizationId: string;
  /** The run the change belongs to (a run's own change, an attempt's, a transcript's). */
  runId?: string | null;
  /** The settings section (`settings`). */
  section?: string;
  /** The settings section's subject (e.g. the repository), when it has one. */
  subjectId?: string | null;
  /** Per-user state: the change goes on this user's channel instead of the organization's. */
  userId?: string;
}

/** A recorded change, with when it was recorded. */
export interface RecordedChange extends Omit<Change, "ids" | "runId" | "subjectId"> {
  ids: string[];
  runId?: string;
  subjectId?: string;
  at: Date;
}

/** What makes two changes the same event (all but `ids` and `at`, which are merged). */
function changeKey(change: RecordedChange): string {
  return JSON.stringify([
    change.userId ?? null,
    change.organizationId,
    change.resource,
    change.runId ?? null,
    change.section ?? null,
    change.subjectId ?? null,
  ]);
}

/**
 * The changes one request (or cron run, or webhook delivery) committed, de-duplicated:
 * changes that differ only in their IDs are merged into one with every ID.
 */
export class ChangeCollector {
  private readonly pending = new Map<string, RecordedChange>();
  private listener: (() => void) | undefined;

  add(change: RecordedChange): void {
    const key = changeKey(change);
    const existing = this.pending.get(key);
    if (existing) {
      for (const id of change.ids) if (!existing.ids.includes(id)) existing.ids.push(id);
      if (change.at > existing.at) existing.at = change.at;
    } else {
      this.pending.set(key, { ...change, ids: [...new Set(change.ids)] });
    }
    this.listener?.();
  }

  /** Whether changes are waiting to be taken. */
  get size(): number {
    return this.pending.size;
  }

  /** Takes the changes recorded since the last call. */
  drain(): RecordedChange[] {
    const changes = [...this.pending.values()];
    this.pending.clear();
    return changes;
  }

  /** Calls `listener` on every change added from now on (e.g. a late write after the flush). */
  onAdd(listener: (() => void) | undefined): void {
    this.listener = listener;
  }
}

/** An open transaction (or savepoint) whose changes wait for its commit. */
interface TransactionScope {
  tx: unknown;
  changes: RecordedChange[];
  /** Where the changes go on commit: the enclosing transaction for a savepoint, else the collector. */
  commitTo: TransactionScope | undefined;
  /** The scope this one was opened in (for finding a transaction's scope by its object). */
  outer: TransactionScope | undefined;
}

interface Store {
  collector: ChangeCollector;
  scope: TransactionScope | undefined;
}

const storage = new AsyncLocalStorage<Store>();

/** Runs `fn` with `collector` collecting every change recorded in it. */
export function runWithChangeCollector<T>(collector: ChangeCollector, fn: () => T): T {
  return storage.run({ collector, scope: undefined }, fn);
}

/**
 * Runs `fn` in a fresh collector and returns what it committed (for tests and
 * callers that publish on their own).
 */
export async function captureChanges<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; changes: RecordedChange[] }> {
  const collector = new ChangeCollector();
  const result = await runWithChangeCollector(collector, fn);
  return { result, changes: collector.drain() };
}

/** The collector of the current request, if one is open. */
export function currentChangeCollector(): ChangeCollector | undefined {
  return storage.getStore()?.collector;
}

/**
 * Records a change written on `db` (the client or the transaction the write used).
 * Written on an open transaction, it is kept only when the transaction commits.
 * A no-op without a collector, or for a change with no IDs.
 */
export function recordChange(db: unknown, change: Change): void {
  const store = storage.getStore();
  if (!store || change.ids.length === 0) return;
  const recorded: RecordedChange = {
    resource: change.resource,
    ids: [...change.ids],
    organizationId: change.organizationId,
    ...(change.runId ? { runId: change.runId } : {}),
    ...(change.section ? { section: change.section } : {}),
    ...(change.subjectId ? { subjectId: change.subjectId } : {}),
    ...(change.userId ? { userId: change.userId } : {}),
    at: new Date(),
  };
  for (let scope = store.scope; scope; scope = scope.outer) {
    if (scope.tx === db) {
      scope.changes.push(recorded);
      return;
    }
  }
  // Written outside any transaction this request opened: it is committed already.
  store.collector.add(recorded);
}

type TransactionFn = (fn: (tx: never) => Promise<unknown>, ...rest: never[]) => Promise<unknown>;

/**
 * Makes `db.transaction` (and its transactions' savepoints) scope the changes
 * recorded on them: a transaction's changes reach the collector when it commits,
 * a savepoint's reach its transaction when it is released, and a rollback drops
 * them. `createDb` applies it to every client.
 */
export function withChangeScopes<D extends object>(db: D): D {
  const target = db as unknown as { transaction: TransactionFn };
  target.transaction = scoped(target.transaction.bind(db), undefined);
  return db;
}

function scoped(original: TransactionFn, owner: TransactionScope | undefined) {
  return ((fn: (tx: never) => Promise<unknown>, ...rest: never[]) => {
    const store = storage.getStore();
    if (!store) return original(fn, ...rest);
    // A savepoint's changes go to its transaction's scope; a top-level one's to the collector.
    const scope: TransactionScope = {
      tx: undefined,
      changes: [],
      commitTo: owner,
      outer: store.scope,
    };
    return original(
      (tx: never) => {
        scope.tx = tx;
        const nested = tx as unknown as { transaction: TransactionFn };
        nested.transaction = scoped(nested.transaction.bind(tx), scope);
        return storage.run({ collector: store.collector, scope }, () => fn(tx));
      },
      ...rest,
    ).then((result) => {
      // Committed (or released): a failed commit rejects and the changes are dropped.
      if (scope.commitTo) scope.commitTo.changes.push(...scope.changes);
      else for (const change of scope.changes) store.collector.add(change);
      return result;
    });
  }) as TransactionFn;
}
