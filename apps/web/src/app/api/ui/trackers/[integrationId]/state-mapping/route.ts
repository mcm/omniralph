import { getIntegrationById } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess, type ScopedOrganization } from "@/lib/api/scope";
import { stateMappingRequestSchema, type TrackerStateMappingView } from "@/lib/api/trackers";
import type { Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import { READINESS_STATE_TYPES } from "@/lib/work-items/readiness";
import {
  StateMappingError,
  TrackerNotConnectedError,
  type WorkItemTracker,
} from "@/lib/work-items/tracker";

type Params = { integrationId: string };

const NOT_FOUND = "That tracker connection doesn't exist.";

/** The tracker of `integrationId` in any of the user's organizations, with at least `role`. */
async function trackerFor(
  user: OrgUser,
  integrationId: string,
  role: Role,
): Promise<{ tracker: WorkItemTracker; organization: ScopedOrganization }> {
  if (!z.uuid().safeParse(integrationId).success) throw ApiRouteError.notFound(NOT_FOUND);
  const db = getDb();
  const integration = await getIntegrationById(db, integrationId);
  const organization = await requireOrganizationAccess(user, integration?.organizationId ?? null, {
    role,
    notFoundMessage: NOT_FOUND,
  });
  try {
    const tracker = await getWorkItemTracker({ db, organizationId: organization.id });
    if (tracker.integrationId !== integrationId) throw ApiRouteError.notFound(NOT_FOUND);
    return { tracker, organization };
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) throw ApiRouteError.notFound(NOT_FOUND);
    throw error;
  }
}

async function view(
  tracker: WorkItemTracker,
  organization: ScopedOrganization,
): Promise<TrackerStateMappingView> {
  const [mapping, teams] = await Promise.all([tracker.getStateMapping(), tracker.listTeams()]);
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
      await tracker.setStateMapping(body);
    } catch (error) {
      if (error instanceof StateMappingError) {
        throw new ApiRouteError(400, error.message, "invalid_request", error.fieldErrors);
      }
      if (error instanceof TrackerNotConnectedError) throw ApiRouteError.notFound(NOT_FOUND);
      throw error;
    }
    return view(tracker, organization);
  },
);
