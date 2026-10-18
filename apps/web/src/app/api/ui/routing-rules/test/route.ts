import { z } from "zod";
import { ApiRouteError, apiHandler } from "@/lib/api/handler";
import type { RoutingTestResult } from "@/lib/api/routing-rules";
import { getDb } from "@/lib/db";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@/lib/linear/fixture-gateway";
import { linearRoutingRulesSchema } from "@/lib/linear/routing-fields";
import { hitRateLimit } from "@/lib/rate-limit";
import { ROUTING_TEST_LIMIT, testRoutingRules } from "@/lib/routing/test-issue";

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
 * know, 409 without a Linear workspace, 429 past `ROUTING_TEST_LIMIT` a minute per user.
 */
export const POST = apiHandler(
  { body: bodySchema },
  async ({ user, body }): Promise<RoutingTestResult> => {
    const db = getDb();
    const limit = await hitRateLimit(db, {
      key: `routing_test:user:${user.id}`,
      limit: ROUTING_TEST_LIMIT,
      windowSeconds: 60,
    });
    if (limit.limited) {
      throw new ApiRouteError(
        429,
        `That's a lot of tests in a minute. Try again in ${limit.retryAfterSeconds} seconds.`,
        "rate_limited",
      );
    }
    let linear;
    try {
      linear = await getLinearGateway({
        db,
        organizationId: user.organization.id,
        ...(fixtureLinearEnabled() && { createGateway: fixtureLinearGateway }),
      });
    } catch (error) {
      if (error instanceof LinearNotConnectedError) {
        throw new ApiRouteError(
          409,
          "Connect Linear in Integrations to test an issue.",
          "linear_not_connected",
        );
      }
      throw error;
    }
    return testRoutingRules(
      { db, organizationId: user.organization.id, linear },
      body.identifier,
      body.rules,
    );
  },
);
