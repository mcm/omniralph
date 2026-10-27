import type { RoutingQuery } from "@omniralph/shared";
import { z } from "zod";
import { isoDate, linearSettingsOptionsSchema } from "./schemas";
import { settingsHistoryEntrySchema } from "./settings-history";
import type { WorkItemMatchInput } from "./work-item-matches";

/** Settings › Advanced › Routing rules (`/api/ui/routing-rules`: members read, admins save). */

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
      /** Its code host, for its `RepoBadge`. */
      provider: z.enum(["github", "gitlab"]),
      fullPath: z.string(),
      /** Off: issues routed here are manual. */
      codingEnabled: z.boolean(),
    }),
  ),
  /** The rules' latest recorded change (section `routing_rules`); null before any. */
  history: settingsHistoryEntrySchema.nullable(),
});
export type RoutingRules = z.infer<typeof routingRulesSchema>;

/** The answer to `PUT /api/ui/routing-rules`: the saved list. */
export const savedRoutingRulesSchema = z.object({
  ok: z.literal(true),
  rules: z.array(routingRuleRowSchema),
});
export type SavedRoutingRules = z.infer<typeof savedRoutingRulesSchema>;

/**
 * `POST /api/ui/routing-rules/test`'s body: an issue, the rules to route it by (unsaved; left
 * out, the saved ones) and, optionally, a repository's unsaved work item match (null: cleared)
 * applied to the saved ones.
 */
export const routingTestRequestSchema = z.object({
  identifier: z.string(),
  rules: z
    .array(z.object({ repositoryId: z.string(), query: z.custom<RoutingQuery>() }))
    .optional(),
  workItemMatch: z
    .object({ repositoryId: z.string(), match: z.custom<WorkItemMatchInput>().nullable() })
    .optional(),
});
export type RoutingTestRequest = z.infer<typeof routingTestRequestSchema>;

/** Where `POST /api/ui/routing-rules/test`'s issue routes under the rules it was sent. */
export const routingTestResultSchema = z.object({
  issue: z.object({ identifier: z.string(), title: z.string() }),
  /** `repository` builds there (coding on), `manual` is for a person (coding off), `ask` asks. */
  outcome: z.enum(["repository", "manual", "ask"]),
  repository: z.object({ id: z.string(), fullPath: z.string() }).nullable(),
  /**
   * What the issue itself matched: a routing rule, a work item match (or a tie of the most
   * specific ones, which asks) or a default rule.
   */
  matched: z.enum(["rule", "match", "default"]),
  /**
   * The rule the issue itself matched: a custom one (1-based) or a default one (1–3); null for
   * a work item match.
   */
  rule: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("custom"), number: z.number(), summary: z.string() }),
      z.object({
        kind: z.literal("default"),
        number: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    ])
    .nullable(),
  /**
   * The route's `routed_by`, e.g. `sub-issue of ENG-10 → rule 2 (Team is ENG)`; null when it
   * asks, except for a tie of work item matches, which names their repositories.
   */
  by: z.string().nullable(),
});
export type RoutingTestResult = z.infer<typeof routingTestResultSchema>;

/** Most work items one `POST /api/ui/routing/preview` routes. */
export const ROUTING_PREVIEW_MAX = 50;

/** `POST /api/ui/routing/preview`'s body: the work items to route by the saved rules. */
export const routingPreviewRequestSchema = z.object({
  identifiers: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Enter an issue identifier, e.g. ENG-12.")
        .max(100, "That's too long for an issue identifier."),
    )
    .min(1, "Enter at least one issue identifier.")
    .max(ROUTING_PREVIEW_MAX, `Preview at most ${ROUTING_PREVIEW_MAX} work items at once.`),
});
export type RoutingPreviewRequest = z.infer<typeof routingPreviewRequestSchema>;

/** Where one work item routes under the saved rules, or that Linear doesn't know it. */
export const routingPreviewItemSchema = z.union([
  routingTestResultSchema.extend({
    /** The identifier as it was sent. */
    identifier: z.string(),
    repository: z
      .object({
        id: z.string(),
        fullPath: z.string(),
        /** The repo's coding switch: off makes the work item manual. */
        codingEnabled: z.boolean(),
      })
      .nullable(),
    /** The work item's latest run, when Om already started one, and how it was routed. */
    run: z.object({ id: z.string(), routedBy: z.string().nullable() }).nullable(),
  }),
  z.object({
    identifier: z.string(),
    outcome: z.literal("not_found"),
    /** Why there's no result, in plain language. */
    message: z.string(),
  }),
]);
export type RoutingPreviewItem = z.infer<typeof routingPreviewItemSchema>;

/** `POST /api/ui/routing/preview`: one result per identifier, in the order sent. */
export const routingPreviewSchema = z.object({ results: z.array(routingPreviewItemSchema) });
export type RoutingPreview = z.infer<typeof routingPreviewSchema>;
