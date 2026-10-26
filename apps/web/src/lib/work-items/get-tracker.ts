import "server-only";
import {
  DEFAULT_TRACKER_STATE_MAPPING,
  getActiveTriageRun,
  getIntegration,
  getRunByIssue,
  getTrackerLabels,
  setIntegrationStateMapping,
  type Database,
} from "@omniralph/db";
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

/** Whether the organization has a ralph or triage run of the issue that isn't over. */
const activeRunCheck =
  (db: Database, organizationId: string) =>
  async (issueId: string): Promise<boolean> =>
    !!(await getRunByIssue(db, organizationId, issueId, { activeOnly: true })) ||
    !!(await getActiveTriageRun(db, organizationId, issueId));

/** The organization's manual labels (its `tracker.labels`); the adapter's default when none. */
const manualLabels = (db: Database, organizationId: string) => async (): Promise<string[]> =>
  (await getTrackerLabels(db, organizationId)).manualLabels;

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
    hasActiveRun: activeRunCheck(db, organizationId),
    manualLabels: manualLabels(db, organizationId),
  });
}

/**
 * The tracker over a Linear gateway the caller already holds (a Linear webhook's or a
 * triage job's), with the organization's saved state mapping. When the integration row is
 * missing (gone since the gateway was made), the default mapping applies and saving a
 * mapping throws `TrackerNotConnectedError`.
 */
export async function workItemTrackerFor(options: {
  db: Database;
  organizationId: string;
  gateway: LinearGateway;
}): Promise<WorkItemTracker> {
  const { db, organizationId, gateway } = options;
  const integration = await getIntegration(db, organizationId, "linear");
  return new LinearWorkItemTracker({
    gateway,
    integrationId: integration?.id ?? "",
    stateMapping: integration?.stateMapping ?? structuredClone(DEFAULT_TRACKER_STATE_MAPPING),
    saveStateMapping: async (mapping) => {
      if (!integration || !(await setIntegrationStateMapping(db, integration.id, mapping))) {
        throw new TrackerNotConnectedError();
      }
    },
    hasActiveRun: activeRunCheck(db, organizationId),
    manualLabels: manualLabels(db, organizationId),
  });
}
