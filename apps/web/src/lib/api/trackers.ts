import { z } from "zod";
import { READINESS_STATE_TYPES, stateMappingSchema } from "@/lib/work-items/readiness";
import type { TrackerWorkflowState, WorkItemStateCategory } from "@/lib/work-items/tracker";
import { organizationRefSchema } from "./runs";

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
  tracker: z.literal("linear"),
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
