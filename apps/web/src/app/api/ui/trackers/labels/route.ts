import { getTrackerLabels, setTrackerLabels, withSettingsChanges } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { trackerLabelsSchema, type TrackerLabelsView } from "@/lib/api/trackers";
import { getDb } from "@/lib/db";
import { settingsActor, trackedTrackerLabels } from "@/lib/settings-history/sections";

/**
 * The organization's tracker labels: `manualLabels` mark a story as a manual step and
 * `blockedLabels` keep Om off a work item, whichever repo it routes to. Any member may read
 * them; nothing saved reads as the defaults.
 */
export const GET = apiHandler({}, async ({ user }): Promise<TrackerLabelsView> =>
  getTrackerLabels(getDb(), user.organization.id),
);

/**
 * Saves both lists (admins). Labels are trimmed; a blank label, a list that isn't one of
 * strings or an empty manual list answers 400. The save is recorded in the routing history.
 */
export const PUT = apiHandler(
  { access: "admin", body: trackerLabelsSchema },
  async ({ user, body }): Promise<TrackerLabelsView> => {
    const db = getDb();
    const organizationId = user.organization.id;
    await withSettingsChanges(db, settingsActor(user), trackedTrackerLabels(organizationId), (tx) =>
      setTrackerLabels(tx, organizationId, body, user.id),
    );
    return getTrackerLabels(db, organizationId);
  },
);
