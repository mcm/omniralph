import { z } from "zod";
import { isoDate } from "./schemas";

/**
 * A repository's work item match (saved with its Coding card, `PUT
 * /api/ui/repositories/{id}/coding`): the work items it builds. Tracker and team are required;
 * a project or "no project" and labels (any of them) are optional. Team, project and labels compare ignoring case.
 */

export const WORK_ITEM_TRACKERS = ["linear"] as const;

/** Labels as typed: trimmed, without repeats (ignoring case). */
const labelsSchema = z
  .array(
    z.string().trim().min(1, "Enter a label name.").max(200, "That's too long for a label name."),
  )
  .max(50, "Pick at most 50 labels.")
  .transform((labels) =>
    labels.filter(
      (label, i) => labels.findIndex((l) => l.toLowerCase() === label.toLowerCase()) === i,
    ),
  );

/** A match as saved, and as `POST /api/ui/routing-rules/test` applies it unsaved. */
export const workItemMatchInputSchema = z
  .strictObject({
    tracker: z.enum(WORK_ITEM_TRACKERS),
    /** The team's key (`ENG`). */
    team: z
      .string()
      .trim()
      .min(1, "Enter the team's key, e.g. ENG.")
      .max(100, "That's too long for a team key."),
    /** A project's name; null is any project (or none). */
    project: z
      .string()
      .trim()
      .min(1, "Enter a project name, or leave the project out.")
      .max(200, "That's too long for a project name.")
      .nullable()
      .default(null),
    /** Only work items with no project. */
    withoutProject: z.boolean().default(false),
    /** Any of these labels; empty is any labels. */
    labels: labelsSchema.default([]),
  })
  .refine((match) => !(match.withoutProject && match.project !== null), {
    path: ["project"],
    message: 'Choose a project or "no project", not both.',
  });
export type WorkItemMatchInput = z.infer<typeof workItemMatchInputSchema>;

/** A saved match. */
export const workItemMatchSchema = z.object({
  tracker: z.enum(WORK_ITEM_TRACKERS),
  team: z.string(),
  project: z.string().nullable(),
  withoutProject: z.boolean(),
  labels: z.array(z.string()),
  updatedAt: isoDate,
});
export type WorkItemMatchRow = z.infer<typeof workItemMatchSchema>;
