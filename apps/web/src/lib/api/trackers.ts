import type { TrackerProvider } from "@omniralph/tracker";
import { z } from "zod";
import { READINESS_STATE_TYPES, stateMappingSchema } from "@/lib/work-items/readiness";
import type { TrackerWorkflowState, WorkItemStateCategory } from "@/lib/work-items/tracker";
import { CONNECTION_PROVIDER_LABELS } from "./connections";
import { organizationRefSchema } from "./runs";
import { WORK_ITEM_TRACKERS } from "./work-item-matches";

/** Wire formats of a work item tracker's readiness state mapping: `/api/ui/trackers/{id}/state-mapping`. */

const STATE_CATEGORIES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const satisfies readonly WorkItemStateCategory[];

export const trackerWorkflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The tracker's state type, which the mapping's `types` match. */
  type: z.string(),
  category: z.enum(STATE_CATEGORIES),
}) satisfies z.ZodType<TrackerWorkflowState>;

/** The body of `PUT`: the whole mapping. */
export const stateMappingRequestSchema = stateMappingSchema;

/** `GET` and `PUT`: the mapping, and every team's workflow states to choose overrides from. */
export const trackerStateMappingSchema = z.object({
  integrationId: z.string(),
  tracker: z.enum(WORK_ITEM_TRACKERS),
  organization: organizationRefSchema,
  mapping: stateMappingSchema,
  /** The state types a readiness may use. */
  stateTypes: z.array(z.enum(READINESS_STATE_TYPES)),
  teams: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      states: z.array(trackerWorkflowStateSchema),
    }),
  ),
});
export type TrackerStateMappingView = z.infer<typeof trackerStateMappingSchema>;

/** Wire format of the organization's tracker labels: `/api/ui/trackers/labels`. */

/** At most this many labels in each list. */
export const MAX_TRACKER_LABELS = 50;

const labelListSchema = (field: string) =>
  z
    .array(
      z
        .string()
        .trim()
        .min(1, `${field} can't be blank.`)
        .max(100, `${field} can be at most 100 characters.`),
    )
    .max(MAX_TRACKER_LABELS, `Use at most ${MAX_TRACKER_LABELS} labels.`);

/**
 * `GET`, the body of `PUT` and its answer: labels matched ignoring case. `manualLabels` mark a
 * story as a manual step (Om files manual steps with the first), so it needs at least one;
 * `blockedLabels` keep Om off a work item (and its sub-issues) whichever repo it routes to.
 */
export const trackerLabelsSchema = z.strictObject({
  manualLabels: labelListSchema("Manual labels").min(1, "Add at least one manual label."),
  blockedLabels: labelListSchema("Blocked labels"),
});
export type TrackerLabelsView = z.infer<typeof trackerLabelsSchema>;

/**
 * A tracker provider's name as people read it, for general surfaces that name the
 * tracker a work item comes from.
 */
export function trackerLabel(provider: TrackerProvider): string {
  return CONNECTION_PROVIDER_LABELS[provider];
}
