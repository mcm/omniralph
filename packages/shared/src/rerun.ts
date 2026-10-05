import { z } from "zod";

/** Re-run › Incremental reviews the whole diff for new issues; Fresh from scratch. */
export const RERUN_MODES = ["incremental", "fresh"] as const;
export type RerunMode = (typeof RERUN_MODES)[number];

/** Built-in profiles Re-run can pick instead of the repository's default. */
export const RERUN_PROFILES = ["quick", "standard", "deep"] as const;

/** The Re-run dialog: a mode and a profile (null keeps the repository's default). */
export const RerunReviewInput = z.object({
  mode: z.enum(RERUN_MODES),
  profileId: z.enum(RERUN_PROFILES).nullable(),
});
export type RerunReviewInput = z.infer<typeof RerunReviewInput>;
