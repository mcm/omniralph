/**
 * Dismissing a finding as feedback for the reviewer: the control panel's
 * Dismiss dialog validates with this before submitting, and the server action
 * validates again.
 */
import { z } from "zod";

export const FEEDBACK_REASONS = ["false_positive", "wont_fix", "not_relevant", "other"] as const;
export type FeedbackReasonValue = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABELS: Record<FeedbackReasonValue, string> = {
  false_positive: "False positive",
  wont_fix: "Won't fix",
  not_relevant: "Not relevant",
  other: "Other",
};

export const MAX_FEEDBACK_NOTE_LENGTH = 1000;

export const DismissFindingInput = z.object({
  reason: z.enum(FEEDBACK_REASONS, { error: "Pick a reason." }),
  note: z
    .string()
    .trim()
    .max(MAX_FEEDBACK_NOTE_LENGTH, `Notes can be at most ${MAX_FEEDBACK_NOTE_LENGTH} characters.`)
    .optional(),
});
export type DismissFindingInput = z.infer<typeof DismissFindingInput>;
