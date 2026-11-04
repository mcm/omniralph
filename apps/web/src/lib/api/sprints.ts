import { z } from "zod";
import { isoDate } from "./schemas";

/**
 * Sprints (`/api/ui/sprints/**`: members read, admins create, rename, reorder and delete
 * drafts): ordered queues of epics in one repo. Safe to import in the browser.
 */

export const SPRINT_STATUSES = ["draft", "running", "paused", "done", "canceled"] as const;
export type SprintStatusValue = (typeof SPRINT_STATUSES)[number];

export const SPRINT_EPIC_STATES = ["queued", "running", "merged", "stalled"] as const;
export type SprintEpicStateValue = (typeof SPRINT_EPIC_STATES)[number];

export const SPRINT_NAME_MAX_LENGTH = 100;
/** The most epics one sprint holds. */
export const SPRINT_MAX_EPICS = 50;

/** One epic of a sprint, at its 0-based `position`. */
export const sprintEpicRowSchema = z.object({
  /** The work item's URL ID (`<tracker>-<issue id>`). */
  workItemId: z.string(),
  /** The work item's identifier and title when the sprint's epics were last saved. */
  identifier: z.string(),
  title: z.string(),
  position: z.number(),
  state: z.enum(SPRINT_EPIC_STATES),
});
export type SprintEpicRow = z.infer<typeof sprintEpicRowSchema>;

export const sprintRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  repository: z.object({ id: z.string(), fullPath: z.string() }),
  mergeTogether: z.boolean(),
  status: z.enum(SPRINT_STATUSES),
  /** Why the sprint is paused: a person paused it, or an epic was refused or stalled. */
  pausedReason: z.string().nullable(),
  /** The branch the epics' PRs target (merge-together sprints, once started). */
  sprintBranch: z.string().nullable(),
  epics: z.array(sprintEpicRowSchema),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type SprintRow = z.infer<typeof sprintRowSchema>;

/** `GET /api/ui/sprints`: the organization's sprints, newest first. */
export const sprintListSchema = z.object({ sprints: z.array(sprintRowSchema) });
export type SprintList = z.infer<typeof sprintListSchema>;

/** The answer to a create or a save. */
export const savedSprintSchema = z.object({ ok: z.literal(true), sprint: sprintRowSchema });
export type SavedSprint = z.infer<typeof savedSprintSchema>;

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: "Name the sprint." })
  .max(SPRINT_NAME_MAX_LENGTH, {
    error: `Keep the name to ${SPRINT_NAME_MAX_LENGTH} characters.`,
  });

/** The sprint's epics in order, by work item URL ID, each once. */
const epicsSchema = z
  .array(z.string().min(1).max(120))
  .max(SPRINT_MAX_EPICS, { error: `A sprint holds at most ${SPRINT_MAX_EPICS} epics.` })
  .refine((ids) => new Set(ids).size === ids.length, {
    error: "Add each epic to the sprint once.",
  });

/** `POST /api/ui/sprints`: a new draft sprint. */
export const createSprintBodySchema = z.strictObject({
  repositoryId: z.uuid({ error: "Choose a repo." }),
  name: nameSchema,
  mergeTogether: z.boolean().default(false),
  epics: epicsSchema.default([]),
});
export type CreateSprintBody = z.input<typeof createSprintBodySchema>;

/** `PATCH /api/ui/sprints/{id}`: renames a draft, switches merge together, or saves its order. */
export const updateSprintBodySchema = z
  .strictObject({
    name: nameSchema.optional(),
    mergeTogether: z.boolean().optional(),
    epics: epicsSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.mergeTogether !== undefined || body.epics, {
    error: "Nothing to change.",
  });
export type UpdateSprintBody = z.input<typeof updateSprintBodySchema>;

/** `POST /api/ui/sprints/{id}/{action}` (admins): a sprint's status changes. */
export const SPRINT_ACTION_NAMES = ["start", "pause", "resume", "cancel"] as const;
export type SprintActionName = (typeof SPRINT_ACTION_NAMES)[number];
