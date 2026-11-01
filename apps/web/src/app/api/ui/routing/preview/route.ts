import { listRoutingRules } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { routingPreviewRequestSchema, type RoutingPreview } from "@/lib/api/routing-rules";
import { getDb } from "@/lib/db";
import { hitRoutingTestLimit, routeIssues, routingTrackerGateway } from "@/lib/routing/test-issue";

/**
 * Where work items route under the organization's saved rules (every member), and why:
 * `{ identifiers }` (1–50) answer one result each, in order, with the outcome, the repo and
 * its coding switch, the rule matched, the route's chain and, when Om already started one,
 * the work item's latest run and its `routed_by`. An issue the tracker doesn't know is a
 * `not_found` result. 409 without a tracker connected; one request counts once against the
 * "Test where a work item would go" rate limit (429).
 */
export const POST = apiHandler(
  { body: routingPreviewRequestSchema },
  async ({ user, body }): Promise<RoutingPreview> => {
    const db = getDb();
    const organizationId = user.organization.id;
    await hitRoutingTestLimit(db, user.id);
    const tracker = await routingTrackerGateway(
      db,
      organizationId,
      "Connect a tracker to preview where work items route.",
    );
    const rules = await listRoutingRules(db, organizationId);
    return {
      results: await routeIssues({ db, organizationId, tracker }, body.identifiers, rules),
    };
  },
);
