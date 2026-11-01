import { z } from "zod";

/**
 * Wire format of `GET /api/ui/nav-indicators?organization=`: what the Fleet and Settings
 * nav entries' coral dots count. The Inbox count and the Runs dot come from
 * `GET /api/ui/inbox/counts`.
 */

/** Its query: the organization scope Fleet counts (`all`, an organization's ID, or the active one). */
export const navIndicatorsQuerySchema = z.object({
  organization: z
    .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
    .optional(),
});

export const navIndicatorsSchema = z.object({
  /**
   * The scope's non-revoked agents that need attention: `offline` (not live online), and
   * `updateFailed` (online, whose update to the version they should run failed). An agent
   * counts once, so their sum is the number of agents.
   */
  fleet: z.object({
    offline: z.number().int().nonnegative(),
    updateFailed: z.number().int().nonnegative(),
  }),
  /**
   * The active organization's failed deliveries not yet replayed (within the retention, no
   * replay pointing at them), in all and per connection (a code-host connection or tracker
   * integration ID; connections without any are left out).
   */
  settings: z.object({
    failedDeliveries: z.number().int().nonnegative(),
    byConnection: z.array(z.object({ id: z.string(), failed: z.number().int().positive() })),
  }),
});
export type NavIndicators = z.infer<typeof navIndicatorsSchema>;
