import { z } from "zod";

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export const FindingSeverity = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

/**
 * One review finding as produced by the model and stored in `findings`.
 * Lines are 1-based head-side line numbers (base side for deleted files).
 */
export const Finding = z
  .object({
    path: z.string().min(1),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    severity: FindingSeverity,
    category: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10_000),
    suggestion: z.string().max(10_000).optional(),
    confidence: z.number().min(0).max(1),
  })
  .refine((f) => f.endLine >= f.startLine, {
    message: "endLine must be >= startLine",
    path: ["endLine"],
  });
export type Finding = z.infer<typeof Finding>;

export const FindingList = z.array(Finding);
export type FindingList = z.infer<typeof FindingList>;
