import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RoutingTestResult } from "@/lib/api/routing-rules";
import { getDb } from "@/lib/db";
import { workItemMatchInputSchema } from "@/lib/api/work-item-matches";
import { routingRulesBodySchema } from "@/lib/routing/fields";
import {
  hitRoutingTestLimit,
  routingTrackerGateway,
  testRoutingRules,
} from "@/lib/routing/test-issue";

const bodySchema = routingRulesBodySchema.extend({
  /** The unsaved rules to route by; left out, the saved ones. */
  rules: routingRulesBodySchema.shape.rules.optional(),
  identifier: z
    .string()
    .trim()
    .min(1, "Enter an issue identifier, e.g. ENG-12.")
    .max(100, "That's too long for an issue identifier."),
  /** A repository's unsaved work item match (null: cleared), applied to the saved ones. */
  workItemMatch: z
    .object({ repositoryId: z.uuid(), match: workItemMatchInputSchema.nullable() })
    .optional(),
});

/**
 * Settings › Advanced › Routing rules' "Test where an issue would go" (every member): where `{ identifier }` routes under
 * `{ rules }`, the unsaved list (validated as on save; left out, the saved rules), and the
 * work item matches with `{ workItemMatch }` (one repository's unsaved match) applied,
 * without saving anything.
 * Answers the outcome, what the issue matched (`matched`, and `rule`), the route's chain and
 * the work item's latest run (`run`, with its repo); 404 for an issue Linear doesn't know, 409 without a Linear workspace, 429 past
 * `ROUTING_TEST_LIMIT` a minute per user (shared with the routing preview).
 */
export const POST = apiHandler(
  { body: bodySchema },
  async ({ user, body }): Promise<RoutingTestResult> => {
    const db = getDb();
    await hitRoutingTestLimit(db, user.id);
    const tracker = await routingTrackerGateway(
      db,
      user.organization.id,
      "Connect Linear to test where an issue would go.",
    );
    return testRoutingRules(
      { db, organizationId: user.organization.id, tracker },
      body.identifier,
      body.rules,
      body.workItemMatch,
    );
  },
);
