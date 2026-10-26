import type { RuleInput } from "@omniralph/shared";
import { z } from "zod";
import type { RuleView } from "@/lib/rules/display";
import { isoDate } from "./schemas";

/** Wire formats of Repository › Rules under `/api/ui/repositories/{id}/rules`. */

/** `RuleView` on the wire: a custom or learned rule of a repository. */
export const ruleViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["custom", "learned"]),
  text: z.string(),
  enabled: z.boolean(),
  createdAt: isoDate,
  createdBy: z.string().nullable(),
  sourceFinding: z
    .object({ href: z.string().nullable(), title: z.string(), path: z.string() })
    .nullable(),
}) satisfies z.ZodType<RuleView>;

/**
 * `GET /api/ui/repositories/{id}/rules?next=`: a connected repository with its rules, polled.
 * A repository of another of the user's organizations answers 409 `enter_organization`.
 */
export const repositoryRulesSchema = z.object({
  repository: z.object({
    id: z.string(),
    provider: z.enum(["github", "gitlab"]),
    fullPath: z.string(),
    webUrl: z.string(),
  }),
  rules: z.array(ruleViewSchema),
});
export type RepositoryRules = z.infer<typeof repositoryRulesSchema>;

/**
 * The body of `PATCH /api/ui/repositories/{id}/rules/{ruleId}`: a new text (`RuleInput`) or
 * the rule switched on or off. (`POST …/rules` takes a `RuleInput`.)
 */
export type RuleChange = RuleInput | { enabled: boolean };
