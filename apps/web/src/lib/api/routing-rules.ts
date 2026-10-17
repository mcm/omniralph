import type { RoutingQuery } from "@omniralph/shared";
import { z } from "zod";
import { isoDate, linearSettingsOptionsSchema } from "./schemas";

/** Settings › Routing (`/api/ui/routing-rules`: members read, admins save). */

/** A saved rule: its condition and target, in evaluation order (`position`, from 0). */
export const routingRuleRowSchema = z.object({
  id: z.string(),
  position: z.number(),
  repositoryId: z.string(),
  /** react-querybuilder's `RuleGroupType`, as validated on save. */
  query: z.custom<RoutingQuery>(),
  updatedAt: isoDate,
});
export type RoutingRuleRow = z.infer<typeof routingRuleRowSchema>;

const fieldValueSchema = z.object({ value: z.string(), label: z.string() });

/** A field of the catalog (`LINEAR_ROUTING_FIELDS`). */
export const routingFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["text", "one-of", "many-of", "number", "date"]),
  operators: z.array(z.object({ name: z.string(), label: z.string() })),
  options: z
    .union([
      z.object({
        source: z.enum([
          "teams",
          "projects",
          "projectMilestones",
          "cycles",
          "states",
          "labels",
          "users",
        ]),
      }),
      z.object({ values: z.array(fieldValueSchema) }),
    ])
    .nullable(),
});

/** The connected Linear workspace's values the value pickers offer, or why there are none. */
export const routingLinearSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connected"), options: linearSettingsOptionsSchema }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("unavailable") }),
]);

/** `GET /api/ui/routing-rules`. */
export const routingRulesSchema = z.object({
  rules: z.array(routingRuleRowSchema),
  /** The fields rules can test. */
  fields: z.array(routingFieldSchema),
  linear: routingLinearSchema,
  /** The organization's connected repositories rules can target, by path. */
  repositories: z.array(
    z.object({
      id: z.string(),
      fullPath: z.string(),
      /** Off: issues routed here are manual. */
      codingEnabled: z.boolean(),
    }),
  ),
});
export type RoutingRules = z.infer<typeof routingRulesSchema>;

/** The answer to `PUT /api/ui/routing-rules`: the saved list. */
export const savedRoutingRulesSchema = z.object({
  ok: z.literal(true),
  rules: z.array(routingRuleRowSchema),
});
export type SavedRoutingRules = z.infer<typeof savedRoutingRulesSchema>;
