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
import type { TrackerGateway } from "@omniralph/tracker";
import {
  DEFAULT_TRACKER_PROVIDER,
  getTrackerGateway,
  lazyTrackerGateway,
} from "@/lib/tracker/client";
import { GatewayWorkItemTracker } from "./gateway-tracker";
import { TrackerNotConnectedError, type WorkItemTracker } from "./tracker";

export interface WorkItemTrackerOptions {
  db: Database;
  organizationId: string;
  /**
   * The organization's tracker gateway (tests; default: its connected one, the provider's
   * fixture workspace in fixture mode).
   */
  gateway?: () => Promise<TrackerGateway>;
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
 * The organization's work item tracker: its tracker connection. Throws
 * `TrackerNotConnectedError` without one. The tracker's credentials are only read (and
 * refreshed) on its first call to the tracker.
 */
export async function getWorkItemTracker(
  options: WorkItemTrackerOptions,
): Promise<WorkItemTracker> {
  const { db, organizationId } = options;
  const provider = DEFAULT_TRACKER_PROVIDER;
  const integration = await getIntegration(db, organizationId, provider);
  if (!integration) throw new TrackerNotConnectedError();
  return new GatewayWorkItemTracker({
    gateway: lazyTrackerGateway({
      db,
      organizationId,
      provider,
      // A disconnected tracker (since) fails every call with `TrackerNotConnectedError`.
      load:
        options.gateway ??
        (() => getTrackerGateway({ db, organizationId, provider, fixtures: true })),
    }),
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
 * The tracker over a gateway the caller already holds (a tracker webhook's or a
 * triage job's), with the organization's saved state mapping. When the integration row is
 * missing (gone since the gateway was made), the default mapping applies and saving a
 * mapping throws `TrackerNotConnectedError`.
 */
export async function workItemTrackerFor(options: {
  db: Database;
  organizationId: string;
  gateway: TrackerGateway;
}): Promise<WorkItemTracker> {
  const { db, organizationId, gateway } = options;
  const integration = await getIntegration(db, organizationId, gateway.provider);
  return new GatewayWorkItemTracker({
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
