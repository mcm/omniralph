import "server-only";
import {
  getIntegration,
  listOrganizationsForUser,
  type Database,
  type WorkItemKey,
} from "@omniralph/db";
import { isTrackerProvider } from "@omniralph/tracker";
import { ApiRouteError } from "@/lib/api/handler";
import { membership, type ScopedOrganization } from "@/lib/api/scope";
import type { OrgUser } from "@/lib/auth/session";
import { trackerName } from "@/lib/tracker/adapters";
import { getWorkItemTracker } from "./get-tracker";
import {
  TrackerNotConnectedError,
  WorkItemNotFoundError,
  type TrackerKind,
  type WorkItem,
  type WorkItemTracker,
} from "./tracker";

/**
 * Finding a work item by its URL ID (`<tracker>-<issue id>`) for the item endpoints: the item
 * belongs to the organization whose tracker has it (a tracker workspace is connected to one
 * organization), and only members of that organization may see it.
 */

export const WORK_ITEM_NOT_FOUND_MESSAGE = "That work item doesn't exist.";

/** Shown when the tracker failed while reading or changing an item. */
export const trackerFailedMessage = (tracker: TrackerKind) =>
  `${trackerName(tracker)} didn't answer. Try again in a moment.`;

/** A work item URL ID's tracker and the item's ID there, or null when it isn't one. */
export function parseWorkItemId(id: string): { tracker: TrackerKind; externalId: string } | null {
  const match = /^([a-z]+)-([A-Za-z0-9_-]{1,100})$/.exec(id);
  if (!match || !isTrackerProvider(match[1])) return null;
  return { tracker: match[1], externalId: match[2]! };
}

/** A work item a member opened: its organization, tracker and current state. */
export interface ResolvedWorkItem {
  organization: ScopedOrganization;
  tracker: WorkItemTracker;
  item: WorkItem;
  key: WorkItemKey;
}

export interface ResolveWorkItemDeps {
  db: Database;
  /** The organization's tracker (default `getWorkItemTracker`). */
  getTracker?: (organizationId: string) => Promise<WorkItemTracker>;
}

/**
 * The work item `id` among the user's organizations: in `organizationId` only when given
 * (which must be one of theirs), else in each organization with a tracker connected, the
 * active one first. Not found (404) when it isn't an item of any of them. A tracker that
 * fails answers 502.
 */
export async function resolveWorkItem(
  deps: ResolveWorkItemDeps,
  user: OrgUser,
  id: string,
  organizationId?: string,
): Promise<ResolvedWorkItem> {
  const parsed = parseWorkItemId(id);
  if (!parsed) throw ApiRouteError.notFound(WORK_ITEM_NOT_FOUND_MESSAGE);
  const getTracker =
    deps.getTracker ??
    ((orgId: string) => getWorkItemTracker({ db: deps.db, organizationId: orgId }));

  let candidates: ScopedOrganization[];
  if (organizationId) {
    const found = await membership(user, organizationId);
    if (!found) throw ApiRouteError.notFound(WORK_ITEM_NOT_FOUND_MESSAGE);
    candidates = [found];
  } else {
    const all = await listOrganizationsForUser(deps.db, user.id);
    const others = all
      .filter((org) => org.id !== user.organization.id)
      .map(({ id: orgId, name, role }) => ({ id: orgId, name, role }));
    const active = { id: user.organization.id, name: user.organization.name, role: user.role };
    const connected = await Promise.all(
      others.map(async (org) =>
        (await getIntegration(deps.db, org.id, parsed.tracker)) ? org : null,
      ),
    );
    candidates = [active, ...connected.filter((org) => org !== null)];
  }

  let failure: unknown;
  for (const organization of candidates) {
    try {
      const tracker = await getTracker(organization.id);
      const item = await tracker.get(parsed.externalId);
      // A ref may be an identifier too: only the item's own ID opens it.
      if (item.id !== parsed.externalId) continue;
      return {
        organization,
        tracker,
        item,
        key: { organizationId: organization.id, tracker: parsed.tracker, externalId: item.id },
      };
    } catch (error) {
      if (error instanceof TrackerNotConnectedError || error instanceof WorkItemNotFoundError) {
        continue;
      }
      console.error(`Reading work item ${id} in organization ${organization.id} failed`, error);
      failure ??= error;
    }
  }
  if (failure) {
    throw new ApiRouteError(502, trackerFailedMessage(parsed.tracker), "tracker_failed");
  }
  throw ApiRouteError.notFound(WORK_ITEM_NOT_FOUND_MESSAGE);
}

/** Runs a call to `tracker` for an action: a failure answers 502 (an unknown item 404). */
export async function trackerCall<T>(
  tracker: Pick<WorkItemTracker, "kind">,
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiRouteError) throw error;
    if (error instanceof WorkItemNotFoundError || error instanceof TrackerNotConnectedError) {
      throw ApiRouteError.notFound(WORK_ITEM_NOT_FOUND_MESSAGE);
    }
    console.error(`${what} failed`, error);
    throw new ApiRouteError(502, trackerFailedMessage(tracker.kind), "tracker_failed");
  }
}
