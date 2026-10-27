import "server-only";
import { latestWorkItemRuns, type Database } from "@omniralph/db";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import {
  TrackerNotConnectedError,
  type TrackerKind,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

/**
 * The work items an Om message mentions: identifiers such as `ENG-12` in its text that the
 * organization's tracker recognizes, each with its URL and the newest run of that work item.
 * The tracker is asked once per message for the identifiers it wasn't asked about in the
 * last {@link WORK_ITEMS_CACHE_TTL_MS} (per organization); runs are read fresh.
 */

/** What a work item identifier looks like in a message: `ENG-12`, `TOOL-639`. */
export const WORK_ITEM_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/g;

/** How long the tracker's answer about an identifier (found or not) is reused. */
export const WORK_ITEMS_CACHE_TTL_MS = 10 * 60_000;

/** A work item an Om message mentions. */
export interface AskWorkItem {
  tracker: TrackerKind;
  identifier: string;
  url: string;
  /** The newest run of the work item in the organization (`runHref`), or null. */
  runId: string | null;
}

/** The distinct work item identifiers in a message's text, in the order they first appear. */
export function workItemIdentifiers(markdown: string): string[] {
  return [...new Set(markdown.match(WORK_ITEM_IDENTIFIER_PATTERN) ?? [])];
}

/** What the tracker said about an identifier: the item, or null when it doesn't know it. */
interface CachedWorkItem {
  item: { tracker: TrackerKind; identifier: string; url: string; externalId: string } | null;
  at: number;
}

export interface WorkItemResolverDeps {
  db: Database;
  /** The organization's tracker; throws `TrackerNotConnectedError` without one. */
  getTracker?: (organizationId: string) => Promise<WorkItemTracker>;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export interface WorkItemResolver {
  /** The work items among `identifiers` the organization's tracker recognizes, in their order. */
  resolve(organizationId: string, identifiers: readonly string[]): Promise<AskWorkItem[]>;
}

export function createWorkItemResolver(deps: WorkItemResolverDeps): WorkItemResolver {
  const { db } = deps;
  const getTracker =
    deps.getTracker ?? ((organizationId: string) => getWorkItemTracker({ db, organizationId }));
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;
  const cache = new Map<string, Map<string, CachedWorkItem>>();

  /** The tracker's answers for `identifiers`, asking it (once) for those not cached. */
  async function lookUp(
    organizationId: string,
    identifiers: readonly string[],
  ): Promise<Map<string, CachedWorkItem> | null> {
    let known = cache.get(organizationId);
    if (!known) cache.set(organizationId, (known = new Map()));
    const at = now();
    for (const [identifier, entry] of known) {
      if (at - entry.at >= WORK_ITEMS_CACHE_TTL_MS) known.delete(identifier);
    }
    const missing = identifiers.filter((identifier) => !known.has(identifier));
    if (missing.length > 0) {
      let found;
      try {
        found = await (await getTracker(organizationId)).findByIdentifiers(missing);
      } catch (error) {
        // No tracker: nothing is a work item. A tracker that failed: try again next time.
        if (!(error instanceof TrackerNotConnectedError)) {
          logger.warn("Looking up the work items a chat message mentions failed", {
            organizationId,
            error,
          });
        }
        return null;
      }
      const byIdentifier = new Map(found.map((item) => [item.identifier.toUpperCase(), item]));
      for (const identifier of missing) {
        const item = byIdentifier.get(identifier);
        known.set(identifier, {
          item: item
            ? {
                tracker: item.tracker,
                identifier: item.identifier,
                url: item.url,
                externalId: item.id,
              }
            : null,
          at,
        });
      }
    }
    return known;
  }

  return {
    async resolve(organizationId, identifiers) {
      const wanted = [...new Set(identifiers)];
      if (wanted.length === 0) return [];
      const known = await lookUp(organizationId, wanted);
      if (!known) return [];
      const items = wanted.flatMap((identifier) => {
        const item = known.get(identifier)?.item;
        return item ? [item] : [];
      });
      if (items.length === 0) return [];
      const runs = await latestWorkItemRuns(
        db,
        organizationId,
        items.map((item) => item.externalId),
      );
      return items.map((item) => ({
        tracker: item.tracker,
        identifier: item.identifier,
        url: item.url,
        runId: runs.get(item.externalId) ?? null,
      }));
    },
  };
}

let shared: { db: Database; resolver: WorkItemResolver } | null = null;

/** The process's resolver over `db` (its cache is shared by every request). */
export function askWorkItemResolver(db: Database): WorkItemResolver {
  if (shared?.db !== db) shared = { db, resolver: createWorkItemResolver({ db }) };
  return shared.resolver;
}
