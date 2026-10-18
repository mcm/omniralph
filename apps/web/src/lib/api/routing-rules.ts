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

/** `POST /api/ui/routing-rules/test`'s body: an issue and the rules to route it by (unsaved). */
export const routingTestRequestSchema = z.object({
  identifier: z.string(),
  rules: z.array(z.object({ repositoryId: z.string(), query: z.custom<RoutingQuery>() })),
});
export type RoutingTestRequest = z.infer<typeof routingTestRequestSchema>;

/** Where `POST /api/ui/routing-rules/test`'s issue routes under the rules it was sent. */
export const routingTestResultSchema = z.object({
  issue: z.object({ identifier: z.string(), title: z.string() }),
  /** `repository` builds there (coding on), `manual` is for a person (coding off), `ask` asks. */
  outcome: z.enum(["repository", "manual", "ask"]),
  repository: z.object({ id: z.string(), fullPath: z.string() }).nullable(),
  /** The rule the issue itself matched: a custom one (1-based) or a default one (1–3). */
  rule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("custom"), number: z.number(), summary: z.string() }),
    z.object({
      kind: z.literal("default"),
      number: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    }),
  ]),
  /** The route's `routed_by`, e.g. `sub-issue of ENG-10 → rule 2 (Team is ENG)`; null when it asks. */
  by: z.string().nullable(),
});
export type RoutingTestResult = z.infer<typeof routingTestResultSchema>;
