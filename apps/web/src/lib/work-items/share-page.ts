import "server-only";
import { findActiveWorkItemShareLink, type Database } from "@omniralph/db";
import type { TrackerProvider } from "@omniralph/tracker";
import { getWorkItemTracker } from "./get-tracker";
import { hashShareToken, isShareToken, verifyShareAccess } from "./share-links";
import { TrackerNotConnectedError, WorkItemNotFoundError, type WorkItemTracker } from "./tracker";

/**
 * What the public review page (`/share/{token}`) shows. The item is read live through the
 * tracker interface on every visit, so the page always has the current PRD.
 */
export type SharedWorkItemPage =
  /** Unknown, revoked or expired (or the item is gone): one page for all of them. */
  | { kind: "gone" }
  /** Protected and this browser hasn't given the password. */
  | { kind: "locked" }
  /** The tracker (`tracker`, the item's) didn't answer. */
  | { kind: "unavailable"; tracker: TrackerProvider }
  | {
      kind: "open";
      /** The tracker the item is in. */
      tracker: TrackerProvider;
      identifier: string;
      title: string;
      /** Markdown. */
      description: string;
      stories: SharedStory[];
      /** The creator's name; null once the user is deleted. */
      sharedBy: string | null;
      expiresAt: Date;
    };

export interface SharedStory {
  /** The sub-issue's identifier; null for a story the PRD lists. */
  identifier: string | null;
  title: string;
  /** The sub-issue's state name; null for a PRD story. */
  state: string | null;
  manual: boolean;
}

export interface LoadSharedWorkItemDeps {
  db: Database;
  /** The organization's tracker (default `getWorkItemTracker`). */
  getTracker?: (organizationId: string) => Promise<WorkItemTracker>;
  now?: Date;
}

/** The page for `token`, given the browser's access cookie (`SHARE_ACCESS_COOKIE`). */
export async function loadSharedWorkItem(
  deps: LoadSharedWorkItemDeps,
  token: string,
  accessCookie: string | undefined,
): Promise<SharedWorkItemPage> {
  const now = deps.now ?? new Date();
  if (!isShareToken(token)) return { kind: "gone" };
  const link = await findActiveWorkItemShareLink(deps.db, hashShareToken(token), now);
  if (!link) return { kind: "gone" };
  if (link.passwordHash !== null && !verifyShareAccess(link.id, accessCookie, now)) {
    return { kind: "locked" };
  }
  const getTracker =
    deps.getTracker ??
    ((organizationId: string) => getWorkItemTracker({ db: deps.db, organizationId }));
  try {
    const tracker = await getTracker(link.organizationId);
    const [item, stories] = await Promise.all([
      tracker.get(link.externalId),
      tracker.stories(link.externalId),
    ]);
    return {
      kind: "open",
      tracker: link.tracker,
      identifier: item.identifier,
      title: item.title,
      description: item.description,
      stories: stories.map((story) => ({
        identifier: story.identifier,
        title: story.title,
        state: story.state?.name ?? null,
        manual: story.manual,
      })),
      sharedBy: link.createdByName,
      expiresAt: link.expiresAt,
    };
  } catch (error) {
    if (error instanceof WorkItemNotFoundError || error instanceof TrackerNotConnectedError) {
      return { kind: "gone" };
    }
    console.error(`Reading shared work item ${link.externalId} failed`, error);
    return { kind: "unavailable", tracker: link.tracker };
  }
}
