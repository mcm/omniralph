import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RoutingTestResult } from "@/lib/api/routing-rules";
import { getDb } from "@/lib/db";
import { linearRoutingRulesSchema } from "@/lib/linear/routing-fields";
import {
  hitRoutingTestLimit,
  routingLinearGateway,
  testRoutingRules,
} from "@/lib/routing/test-issue";

const bodySchema = linearRoutingRulesSchema.extend({
  identifier: z
    .string()
    .trim()
    .min(1, "Enter an issue identifier, e.g. ENG-12.")
    .max(100, "That's too long for an issue identifier."),
});

/**
 * Settings › Routing's "Test an issue" (every member): where `{ identifier }` routes under
 * `{ rules }`, the unsaved list (validated as on save), without saving anything. Answers the
 * outcome, the rule the issue matched and the route's chain; 404 for an issue Linear doesn't
 * know, 409 without a Linear workspace, 429 past `ROUTING_TEST_LIMIT` a minute per user
 * (shared with the routing preview).
 */
export const POST = apiHandler(
  { body: bodySchema },
  async ({ user, body }): Promise<RoutingTestResult> => {
    const db = getDb();
    await hitRoutingTestLimit(db, user.id);
    const linear = await routingLinearGateway(
      db,
      user.organization.id,
      "Connect Linear in Integrations to test an issue.",
    );
    return testRoutingRules(
      { db, organizationId: user.organization.id, linear },
      body.identifier,
      body.rules,
    );
  },
);
