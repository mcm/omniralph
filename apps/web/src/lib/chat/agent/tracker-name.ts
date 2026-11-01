import "server-only";
import type { Database } from "@omniralph/db";
import { trackerName } from "@/lib/tracker/adapters";
import { getConnectedTrackerProvider } from "@/lib/tracker/client";
import type { WorkItemTracker } from "@/lib/work-items/tracker";

/**
 * The name of the organization's connected tracker for Om's prompt and tools, or null when
 * none is connected. `tracker` replaces how the tracker is found (a test's tracker).
 */
export async function connectedTrackerName(
  db: Database,
  organizationId: string,
  tracker?: () => Promise<WorkItemTracker>,
): Promise<string | null> {
  if (tracker) {
    const connected = await tracker().catch(() => null);
    return connected ? trackerName(connected.kind) : null;
  }
  const provider = await getConnectedTrackerProvider(db, organizationId);
  return provider ? trackerName(provider) : null;
}
