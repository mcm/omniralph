import { z } from "zod";
import { organizationRefSchema, scmProviderSchema } from "./runs";
import { WORK_ITEM_TRACKERS } from "./work-item-matches";
import { workItemRowSchema, workItemSourceSchema } from "./work-items";

/** Wire formats of the Backlog endpoints under `/api/ui/backlog`. */

const organization = z
  .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
  .optional();

/**
 * `GET /api/ui/backlog`'s query: the organization scope and the filters (a value the list
 * doesn't have matches nothing).
 */
export const backlogQuerySchema = z.object({
  organization,
  /** A source's value (`workItemSourceValue`). */
  source: z.string().max(300).optional(),
  /** A repository ID. */
  repo: z.string().max(100).optional(),
});
export type BacklogQuery = z.infer<typeof backlogQuerySchema>;

/** `GET /api/ui/backlog/counts`' and `/up-next`'s query. */
export const backlogScopeQuerySchema = z.object({ organization });

/** A Source filter option: a tracker project or team the listed items come from. */
export const backlogSourceOptionSchema = workItemSourceSchema.extend({
  /** The `source` query value. */
  value: z.string(),
  tracker: z.enum(WORK_ITEM_TRACKERS),
});

/** A Repo filter option: a repo the listed items route to. */
export const backlogRepoOptionSchema = z.object({
  /** The `repo` query value (the repository ID). */
  value: z.string(),
  provider: scmProviderSchema,
  fullPath: z.string(),
});

export const backlogSchema = z.object({
  /** Each group in list order: tracker priority (Urgent first, No priority last), then most recently updated. */
  groups: z.object({
    readyToStart: z.array(workItemRowSchema),
    needsRefining: z.array(workItemRowSchema),
  }),
  /** The filters' options: the values of the unfiltered list. */
  filters: z.object({
    sources: z.array(backlogSourceOptionSchema),
    repos: z.array(backlogRepoOptionSchema),
  }),
  /** Organizations whose tracker couldn't be read; the others still load. */
  unavailable: z.array(
    z.object({
      organization: organizationRefSchema,
      tracker: z.enum(WORK_ITEM_TRACKERS),
      reason: z.string(),
    }),
  ),
  /** Whether an organization had more candidates than the Backlog reads. */
  truncated: z.boolean(),
  /** The organizations whose list was cut ("Showing the first 500 work items from …"). */
  truncatedOrganizations: z.array(organizationRefSchema),
  /**
   * What an empty list means: `no_tracker` (no organization in scope has a tracker connected:
   * "Connect a tracker to see its work items"), `no_work_item_match` (no repo with Coding on
   * picks up work items: "No repo picks up work items yet"), else `ready`.
   */
  setup: z.enum(["ready", "no_tracker", "no_work_item_match"]),
});
export type Backlog = z.infer<typeof backlogSchema>;

export const backlogCountsSchema = z.object({
  readyToStart: z.number().int(),
  needsRefining: z.number().int(),
  total: z.number().int(),
});
export type BacklogCounts = z.infer<typeof backlogCountsSchema>;

/** Up next in the empty Inbox: the first Ready to start and Needs refining rows. */
export const backlogUpNextSchema = z.object({
  readyToStart: z.array(workItemRowSchema).max(3),
  needsRefining: z.array(workItemRowSchema).max(2),
});
export type BacklogUpNext = z.infer<typeof backlogUpNextSchema>;
