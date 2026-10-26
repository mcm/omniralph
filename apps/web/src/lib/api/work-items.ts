import { TRIAGE_SIZES } from "@omniralph/shared";
import { z } from "zod";
import { organizationRefSchema, repositoryRefSchema } from "./runs";

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
