import { z } from "zod";
import type { JobRow } from "@/lib/harnesses/rows";
import { isoDate } from "./schemas";

/** Wire formats of the job endpoints under `/api/ui`. */

export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  "skipped",
] as const satisfies readonly JobRow["status"][];

/** `JobRow` on the wire: a job on the Jobs list. */
export const jobRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  taskType: z.string(),
  status: z.enum(JOB_STATUSES),
  deliveryCount: z.number(),
  cancelRequested: z.boolean(),
  error: z.string().nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
  target: z.object({ label: z.string(), url: z.string().nullable() }).nullable(),
  triageRun: z.object({ id: z.string(), label: z.string() }).nullable(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
}) satisfies z.ZodType<JobRow>;

/** `GET /api/ui/jobs?status=&page=&job=`: a page of jobs, newest first. */
export const jobListSchema = z.object({
  jobs: z.array(jobRowSchema),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Jobs matching the filter across all pages. */
  total: z.number(),
  /** The `?job=` job when this is the page holding it (unfiltered lists only). */
  targetJobId: z.string().nullable(),
});
export type JobList = z.infer<typeof jobListSchema>;
