import { z } from "zod";

/**
 * Wire formats shared by the `/api/ui` route handlers (`./handler.ts`) and the panel's
 * client (`./client.ts`). Each area adds its own request and response schemas next to
 * these; dates cross the wire as ISO strings (`isoDate`).
 */

/** A timestamp on the wire: an ISO 8601 string, as `Date#toISOString` writes it. */
export const isoDate = z.iso.datetime({ offset: true });

/** The body of every non-2xx response. */
export const apiErrorBodySchema = z.object({
  /** Shown to the user as is (same wording as the server actions' `ActionResult` errors). */
  error: z.string(),
  /** Machine-readable reason, e.g. `organization_switched`. */
  code: z.string().optional(),
  /** Form validation errors by field path (see `fieldErrors` in `@omniralph/shared`), shown inline. */
  fieldErrors: z.record(z.string(), z.string()).optional(),
  /**
   * With `code: ENTER_ORGANIZATION`: the resource belongs to another of the user's
   * organizations, which this (signed) path switches to before opening it.
   */
  enterPath: z.string().optional(),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/**
 * The body of a successful mutation. `warning` is shown instead of the default success
 * toast, as a warning (like `ActionResult`'s). Mutations that return more (a created ID)
 * extend it.
 */
export const mutationResultSchema = z.object({
  ok: z.literal(true),
  warning: z.string().optional(),
});
export type MutationResult = z.infer<typeof mutationResultSchema>;

/**
 * Header the client sends with the organization its cache is for (the first element of
 * every query key). A handler refuses a request whose organization isn't the active one
 * (another tab switched), so data never lands under another organization's keys.
 */
export const ORGANIZATION_HEADER = "x-omniralph-organization";

/** `code` of the refusal above. */
export const ORGANIZATION_SWITCHED = "organization_switched";

/**
 * `code` of a 409 for a resource of another of the user's organizations: the client opens
 * the response's `enterPath`, which switches to it and comes back (like the detail pages did).
 */
export const ENTER_ORGANIZATION = "enter_organization";

/**
 * The connected Linear workspace's values the settings pickers offer (`LinearSettingsOptions`):
 * a repository's Coding tab and Settings › Routing.
 */
export const linearSettingsOptionsSchema = z.object({
  teams: z.array(z.object({ key: z.string(), name: z.string() })),
  labels: z.array(z.string()),
  projects: z.array(z.string()),
  states: z.array(z.string()),
  projectMilestones: z.array(z.string()),
  cycles: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      name: z.string().nullable(),
      teamKey: z.string(),
    }),
  ),
  users: z.array(z.object({ id: z.string(), name: z.string() })),
});
