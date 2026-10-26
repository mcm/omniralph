import { TRIAGE_SIZES } from "@omniralph/shared";
import { z } from "zod";
import { RUN_STATUSES, organizationRefSchema, repositoryRefSchema } from "./runs";
import { isoDate } from "./schemas";

/** Wire formats of work items (`/api/ui/work-items`, and the Backlog's rows). */

/** The Backlog's groups: Ready to start and Needs refining. */
export const WORK_ITEM_GROUPS = ["ready", "refine"] as const;
export type WorkItemGroup = (typeof WORK_ITEM_GROUPS)[number];

/** Where a work item comes from: its tracker project, or its team when it has none. */
export const workItemSourceSchema = z.object({
  kind: z.enum(["project", "team"]),
  /** The project's or team's ID in the tracker (a project without one: its name). */
  id: z.string(),
  /** The project's name, or the team's key (`SOC`). */
  name: z.string(),
});
export type WorkItemSource = z.infer<typeof workItemSourceSchema>;

/** One work item of the Backlog (and Up next): typed references, never preformatted text. */
export const workItemRowSchema = z.object({
  /** The work item's URL ID: its tracker and its ID there (`linear-<issue id>`). */
  id: z.string(),
  tracker: z.literal("linear"),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  organization: organizationRefSchema,
  /** The repo it routes to; null while routing asks (a tie: "no repo yet"). */
  repository: repositoryRefSchema.nullable(),
  /** From its newest triage; null when no triage sized it. */
  size: z.enum(TRIAGE_SIZES).nullable(),
  group: z.enum(WORK_ITEM_GROUPS),
  /** Open work items block it. */
  blocked: z.boolean(),
  source: workItemSourceSchema,
});
export type WorkItemRow = z.infer<typeof workItemRowSchema>;

/**
 * A source's filter value (`?source=`): the tracker, the kind and the ID, e.g.
 * `linear:project:<id>` or `linear:team:<id>`.
 */
export function workItemSourceValue(row: Pick<WorkItemRow, "tracker" | "source">): string {
  return `${row.tracker}:${row.source.kind}:${row.source.id}`;
}

// ── The work item detail and its actions (`/api/ui/work-items/{id}`) ────────────────────────

/** A work item's state in its tracker. */
const workItemStateSchema = z.object({
  category: z.enum(["triage", "backlog", "todo", "in_progress", "done", "canceled"]),
  name: z.string(),
});

/** An open work item that blocks this one. */
export const workItemBlockerSchema = z.object({
  identifier: z.string(),
  /** In the tracker; null when it can't be told. */
  url: z.string().nullable(),
  /** Its URL ID when the Backlog lists it (links to `/backlog/{id}`), else null. */
  backlogId: z.string().nullable(),
});

/** How the work item routes: "Routes to <repo> via <project, team, label…>". */
export const workItemRouteSchema = z.object({
  /** `repository`: builds there; `manual`: its repo has Coding off; `ask`: routing ties. */
  outcome: z.enum(["repository", "manual", "ask"]),
  /** The repo it routes to (Coding on or off); null when routing asks. */
  repository: repositoryRefSchema.nullable(),
  /** What decided it; null when routing asks. */
  via: z
    .object({
      kind: z.enum(["project", "team", "label", "parent", "follow_up", "rule", "choice"]),
      /** `Omniralph project`, `SOC team`, `label product:portal`, `parent SOC-400`, `rule 2`, `your choice`. */
      label: z.string(),
    })
    .nullable(),
  /** The route in full, as a run's `routed_by` reads it; null when nothing routes it. */
  by: z.string().nullable(),
});
export type WorkItemRoute = z.infer<typeof workItemRouteSchema>;

/** One of its stories: a sub-issue, or a story its PRD lists (no identifier, state or URL). */
export const workItemStorySchema = z.object({
  identifier: z.string().nullable(),
  title: z.string(),
  state: workItemStateSchema.nullable(),
  url: z.string().nullable(),
  /** A step for a person (the manual label). */
  manual: z.boolean(),
});

/** What happened to it, in a plain sentence, newest first. */
export const workItemActivitySchema = z.object({
  id: z.string(),
  /** Where it comes from: an action in Omniralph, a triage run, or a tracker comment. */
  source: z.enum(["event", "triage", "comment"]),
  /** "Om triaged it (size M)", "Steve changed the repo to customer-portal". */
  text: z.string(),
  at: isoDate,
});

/** What the user can do with the item now (any member may; these follow its state). */
export const workItemActionsSchema = z.object({
  /** Start epic: Ready to start, with no run. */
  start: z.boolean(),
  /** Triage now: no triage queued or running, and no run. */
  triage: z.boolean(),
  /** Edit PRD: no run queued, running or waiting. */
  editPrd: z.boolean(),
  /** Change repo…: no run. */
  changeRepo: z.boolean(),
  /** Move to Needs refining: Ready to start, with no run. */
  move: z.boolean(),
  /** Remove from backlog…: no run queued, running or waiting. */
  cancel: z.boolean(),
});
export type WorkItemActions = z.infer<typeof workItemActionsSchema>;

/** `GET /api/ui/work-items/{id}`: the row, plus its PRD, route, stories, activity and run. */
export const workItemDetailSchema = workItemRowSchema.extend({
  /** Its Backlog group; null when its state is neither Ready to start nor Needs refining. */
  group: z.enum(WORK_ITEM_GROUPS).nullable(),
  state: workItemStateSchema,
  /** Markdown: the PRD. */
  description: z.string(),
  /** When it last changed in the tracker: the PRD save's `baseUpdatedAt`. */
  updatedAt: z.string(),
  blockedBy: z.array(workItemBlockerSchema),
  route: workItemRouteSchema,
  stories: z.array(workItemStorySchema),
  activity: z.array(workItemActivitySchema),
  /** Om is triaging it (a triage queued or running). */
  triageRunning: z.boolean(),
  /** Its latest run, if one exists. */
  run: z.object({ id: z.string(), status: z.enum(RUN_STATUSES) }).nullable(),
  actions: workItemActionsSchema,
});
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

/**
 * The item endpoints' query: the item's organization when the caller knows it (else each of
 * the user's organizations is looked in, the active one first).
 */
export const workItemQuerySchema = z.object({
  organization: z.uuid({ error: "Unknown organization." }).optional(),
});

/** `PUT /api/ui/work-items/{id}/prd`. */
export const workItemPrdBodySchema = z.object({
  markdown: z.string().max(200_000, { error: "The PRD is too long." }),
  /** The `updatedAt` the edit started from: a newer edit in the tracker is a conflict. */
  baseUpdatedAt: z.string().min(1),
});
export const workItemPrdResultSchema = z.object({ updatedAt: z.string() });

/** `PUT /api/ui/work-items/{id}/repository`: a repo with Coding on, or null for the rules. */
export const workItemRepositoryBodySchema = z.object({
  repositoryId: z.uuid({ error: "Choose a repo." }).nullable(),
});
export const workItemRepositoryResultSchema = z.object({
  /** The chosen repo; null when the routing rules route it again. */
  repository: repositoryRefSchema.nullable(),
});

/** `POST /api/ui/work-items/{id}/move`. */
export const workItemMoveBodySchema = z.object({ to: z.literal("needs_refining") });

// ── New work item (`POST /api/ui/work-items`) ──────────────────────────────────────────────

/** `POST /api/ui/work-items`: a work item for a repo with Coding on and a work item match. */
export const createWorkItemBodySchema = z.object({
  repositoryId: z.uuid({ error: "Choose a repo." }),
  /** Required, at most 255 characters (checked by the service). */
  title: z.string().max(10_000, { error: "The title is too long." }),
  /** Markdown; optional. */
  description: z.string().max(200_000, { error: "The description is too long." }).default(""),
  /** Triage now: Om turns it into a PRD and sizes it. */
  triageNow: z.boolean().default(true),
});
export const createWorkItemResultSchema = z.object({
  /** The new item's row, for the Backlog to insert without a refetch. */
  item: workItemRowSchema,
  /** `started`, `failed` (the item was created; `triageError` says why) or null (not asked). */
  triage: z.enum(["started", "failed"]).nullable(),
  triageError: z.string().optional(),
});
export type CreateWorkItemResponse = z.infer<typeof createWorkItemResultSchema>;
