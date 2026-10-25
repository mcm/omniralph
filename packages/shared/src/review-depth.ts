/**
 * Review depth: the three presets a repository's reviews run at. A depth sets
 * a review's model, token cap, file limit and exploration; nothing else does.
 * The UI shows each preset's `summary` first and its `details` on demand, so
 * it never hard-codes them.
 */
import { z } from "zod";
import type { ReviewProfileConfig } from "./review-job.js";

/** The review depths, from fastest to most thorough. */
export const REVIEW_DEPTH_IDS = ["quick", "standard", "deep"] as const;
export type ReviewDepth = (typeof REVIEW_DEPTH_IDS)[number];

/** The depth of a repository that never chose one. */
export const DEFAULT_REVIEW_DEPTH: ReviewDepth = "standard";

export const ReviewDepthSchema = z.enum(REVIEW_DEPTH_IDS, {
  error: "Choose a review depth: quick, standard or deep.",
});

export interface ReviewDepthPreset {
  id: ReviewDepth;
  label: string;
  /** One plain sentence: what a review at this depth does. */
  summary: string;
  /** The Claude model reviews run with. */
  model: string;
  /** Token cap of each review. */
  maxTokensPerReview: number;
  /** Most changed files a review reads; the rest are skipped. */
  maxFiles: number;
  /** The review may read files beyond the diff. */
  allowRepoExploration: boolean;
  /** The depth popover's detail rows. */
  details: {
    modelLabel: string;
    tokenCapLabel: string;
    reads: string;
    comments: string;
    typicalTime: string;
  };
}

export const REVIEW_DEPTHS: Readonly<Record<ReviewDepth, ReviewDepthPreset>> = {
  quick: {
    id: "quick",
    label: "Quick",
    summary: "Reads only the change and flags clear problems. Fastest and cheapest.",
    model: "claude-haiku-5-5",
    maxTokensPerReview: 60_000,
    maxFiles: 15,
    allowRepoExploration: false,
    details: {
      modelLabel: "Haiku 5.5",
      tokenCapLabel: "60k per review",
      reads: "The diff only",
      comments: "Inline findings plus a summary",
      typicalTime: "Shortest",
    },
  },
  standard: {
    id: "standard",
    label: "Standard",
    summary: "Reads the change and the files around it before commenting.",
    model: "claude-sonnet-5-5",
    maxTokensPerReview: 200_000,
    maxFiles: 40,
    allowRepoExploration: true,
    details: {
      modelLabel: "Sonnet 5.5",
      tokenCapLabel: "200k per review",
      reads: "The diff and related files",
      comments: "Inline findings plus a summary",
      typicalTime: "Baseline",
    },
  },
  deep: {
    id: "deep",
    label: "Deep",
    summary:
      "Reads the change and the code around it across the repo before commenting. Slowest, most thorough.",
    model: "claude-opus-5-5",
    maxTokensPerReview: 500_000,
    maxFiles: 100,
    allowRepoExploration: true,
    details: {
      modelLabel: "Opus 5.5",
      tokenCapLabel: "500k per review",
      reads: "The diff, related files and their tests across the repo",
      comments: "Inline findings plus a summary",
      typicalTime: "About 2× Standard",
    },
  },
};

/** Whether `value` is a review depth. */
export function isReviewDepth(value: unknown): value is ReviewDepth {
  return typeof value === "string" && (REVIEW_DEPTH_IDS as readonly string[]).includes(value);
}

/**
 * The `reviewConfig.profile` a review at `depth` runs with: the agent's review
 * lifecycle reads the preset through the same shape review profiles had.
 */
export function reviewProfileConfigForDepth(depth: ReviewDepth): ReviewProfileConfig {
  const preset = REVIEW_DEPTHS[depth];
  return {
    id: preset.id,
    name: preset.label,
    model: preset.model,
    maxTokensPerReview: preset.maxTokensPerReview,
    maxFiles: preset.maxFiles,
    allowRepoExploration: preset.allowRepoExploration,
  };
}
