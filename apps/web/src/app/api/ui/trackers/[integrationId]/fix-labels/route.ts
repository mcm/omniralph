import { withSettingsChanges } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { ScopedOrganization } from "@/lib/api/scope";
import { TRACKER_NOT_FOUND, trackerFor } from "@/lib/api/tracker-access";
import { fixLabelsRequestSchema, type TrackerFixLabelsView } from "@/lib/api/trackers";
import { getDb } from "@/lib/db";
import { settingsActor, trackedConnection } from "@/lib/settings-history/sections";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import {
  FixLabelsError,
  TrackerNotConnectedError,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

type Params = { integrationId: string };

async function view(
  tracker: WorkItemTracker,
  organization: ScopedOrganization,
): Promise<TrackerFixLabelsView> {
  return {
    integrationId: tracker.integrationId,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    fixLabels: await tracker.getFixLabels(),
  };
}

/**
 * A tracker connection's fix labels: a work item carrying one of them (ignoring case) is a
 * Fix, any other a Story. Any member of the connection's organization may read them.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const { tracker, organization } = await trackerFor(user, params.integrationId, "member");
    return view(tracker, organization);
  },
);

/**
 * Saves the fix labels (admins of the connection's organization), trimmed and without
 * duplicates. A blank label or an empty list answers 400. The save is recorded in the
 * connection's settings history.
 */
export const PUT = apiHandler<"member", typeof fixLabelsRequestSchema, undefined, Params>(
  { body: fixLabelsRequestSchema },
  async ({ user, params, body }) => {
    const { tracker, organization } = await trackerFor(user, params.integrationId, "admin");
    try {
      // Saved through a tracker on the transaction that records it in the change history.
      await withSettingsChanges(
        getDb(),
        settingsActor(user),
        trackedConnection(organization.id, tracker.integrationId),
        async (tx) => {
          const writer = await getWorkItemTracker({ db: tx, organizationId: organization.id });
          await writer.setFixLabels(body.fixLabels);
        },
      );
      return await view(
        await getWorkItemTracker({ db: getDb(), organizationId: organization.id }),
        organization,
      );
    } catch (error) {
      if (error instanceof FixLabelsError) {
        throw new ApiRouteError(400, error.message, "invalid_request", error.fieldErrors);
      }
      if (error instanceof TrackerNotConnectedError) {
        throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
      }
      throw error;
    }
  },
);
