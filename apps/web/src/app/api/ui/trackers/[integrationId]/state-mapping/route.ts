import { withSettingsChanges } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { ScopedOrganization } from "@/lib/api/scope";
import { TRACKER_NOT_FOUND, trackerFor } from "@/lib/api/tracker-access";
import { stateMappingRequestSchema, type TrackerStateMappingView } from "@/lib/api/trackers";
import { getDb } from "@/lib/db";
import { settingsActor, trackedConnection } from "@/lib/settings-history/sections";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import { READINESS_STATE_TYPES } from "@/lib/work-items/readiness";
import {
  StateMappingError,
  TrackerNotConnectedError,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

type Params = { integrationId: string };

async function view(
  tracker: WorkItemTracker,
  organization: ScopedOrganization,
): Promise<TrackerStateMappingView> {
  const [mapping, teams] = await Promise.all([tracker.getStateMapping(), tracker.teams()]);
  return {
    integrationId: tracker.integrationId,
    tracker: tracker.kind,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    mapping,
    stateTypes: [...READINESS_STATE_TYPES],
    teams: await Promise.all(
      teams.map(async (team) => ({ ...team, states: await tracker.listWorkflowStates(team.id) })),
    ),
  };
}

/**
 * A tracker connection's readiness state mapping (which workflow states mean "Ready to
 * start" and "Needs refining"), with every team's workflow states. Any member of the
 * connection's organization may read it.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const { tracker, organization } = await trackerFor(user, params.integrationId, "member");
    return view(tracker, organization);
  },
);

/** Saves the mapping (admins of the connection's organization). Invalid states answer 400. */
export const PUT = apiHandler<"member", typeof stateMappingRequestSchema, undefined, Params>(
  { body: stateMappingRequestSchema },
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
          await writer.setStateMapping(body);
        },
      );
      return await view(
        await getWorkItemTracker({ db: getDb(), organizationId: organization.id }),
        organization,
      );
    } catch (error) {
      if (error instanceof StateMappingError) {
        throw new ApiRouteError(400, error.message, "invalid_request", error.fieldErrors);
      }
      if (error instanceof TrackerNotConnectedError)
        throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
      throw error;
    }
  },
);
