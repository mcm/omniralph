import { z } from "zod";
import { ReviewDepthSchema } from "./review-depth.js";

/** Re-run › Incremental reviews the whole diff for new issues; Fresh from scratch. */
export const RERUN_MODES = ["incremental", "fresh"] as const;
export type RerunMode = (typeof RERUN_MODES)[number];

/** A re-review: a mode and a depth (null keeps the repository's depth). */
export const RerunReviewInput = z.object({
  mode: z.enum(RERUN_MODES),
  depth: ReviewDepthSchema.nullable(),
});
export type RerunReviewInput = z.infer<typeof RerunReviewInput>;
