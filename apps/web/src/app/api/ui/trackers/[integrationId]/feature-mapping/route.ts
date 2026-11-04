import {
  getIntegrationById,
  setIntegrationFeatureMapping,
  withSettingsChanges,
  type Integration,
} from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { ScopedOrganization } from "@/lib/api/scope";
import { TRACKER_NOT_FOUND, trackerFor } from "@/lib/api/tracker-access";
import {
  featureMappingRequestSchema,
  NO_PARENT_ISSUES,
  type TrackerFeatureMappingView,
} from "@/lib/api/trackers";
import { getDb } from "@/lib/db";
import { settingsActor, trackedConnection } from "@/lib/settings-history/sections";
import { trackerProviderCapabilities } from "@/lib/tracker/adapters";

type Params = { integrationId: string };

async function integrationOf(integrationId: string): Promise<Integration> {
  const integration = await getIntegrationById(getDb(), integrationId);
  if (!integration) throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
  return integration;
}

function view(
  integration: Integration,
  organization: ScopedOrganization,
): TrackerFeatureMappingView {
  return {
    integrationId: integration.id,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    featureMapping: integration.featureMapping,
    parentIssues: trackerProviderCapabilities(integration.provider).includes("parentIssues"),
  };
}

/**
 * A tracker connection's feature mapping: whether features exist only in Omniralph or also as
 * a parent issue in the tracker that their epics are filed under. Any member of the
 * connection's organization may read it.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const { organization } = await trackerFor(user, params.integrationId, "member");
    return view(await integrationOf(params.integrationId), organization);
  },
);

/**
 * Saves the feature mapping (admins of the connection's organization). An unknown mapping, or
 * `parent-issue` for a tracker that can't hold parent issues, answers 400. The save is
 * recorded in the connection's settings history.
 */
export const PUT = apiHandler<"member", typeof featureMappingRequestSchema, undefined, Params>(
  { body: featureMappingRequestSchema },
  async ({ user, params, body }) => {
    const { organization } = await trackerFor(user, params.integrationId, "admin");
    const current = view(await integrationOf(params.integrationId), organization);
    if (body.featureMapping === "parent-issue" && !current.parentIssues) {
      throw new ApiRouteError(400, NO_PARENT_ISSUES, "invalid_request", {
        featureMapping: NO_PARENT_ISSUES,
      });
    }
    const saved = await withSettingsChanges(
      getDb(),
      settingsActor(user),
      trackedConnection(organization.id, params.integrationId),
      (tx) => setIntegrationFeatureMapping(tx, params.integrationId, body.featureMapping),
    );
    if (!saved) throw ApiRouteError.notFound(TRACKER_NOT_FOUND);
    return view(saved, organization);
  },
);
