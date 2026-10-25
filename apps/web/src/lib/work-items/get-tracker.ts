import "server-only";
import { getIntegration, setIntegrationStateMapping, type Database } from "@omniralph/db";
import { getLinearGateway, lazyLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@/lib/linear/fixture-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import { LinearWorkItemTracker } from "./linear";
import { TrackerNotConnectedError, type WorkItemTracker } from "./tracker";

export interface WorkItemTrackerOptions {
  db: Database;
  organizationId: string;
  /** The Linear gateway for an access token (tests; default: the SDK gateway). */
  createGateway?: (accessToken: string) => LinearGateway;
  /** Encryption key override (tests). */
  key?: string | Buffer;
}

/**
 * The organization's work item tracker: its Linear connection. Throws
 * `TrackerNotConnectedError` without one. The workspace's token is only read (and
 * refreshed) on the tracker's first call to Linear.
 */
export async function getWorkItemTracker(
  options: WorkItemTrackerOptions,
): Promise<WorkItemTracker> {
  const { db, organizationId, key } = options;
  const integration = await getIntegration(db, organizationId, "linear");
  if (!integration) throw new TrackerNotConnectedError();
  const createGateway =
    options.createGateway ?? (fixtureLinearEnabled() ? fixtureLinearGateway : undefined);
  return new LinearWorkItemTracker({
    gateway: lazyLinearGateway(() =>
      getLinearGateway({ db, organizationId, key, ...(createGateway && { createGateway }) }).catch(
        (error: unknown) => {
          // Disconnected since.
          throw error instanceof LinearNotConnectedError ? new TrackerNotConnectedError() : error;
        },
      ),
    ),
    integrationId: integration.id,
    stateMapping: integration.stateMapping,
    saveStateMapping: async (mapping) => {
      if (!(await setIntegrationStateMapping(db, integration.id, mapping))) {
        throw new TrackerNotConnectedError();
      }
    },
  });
}
