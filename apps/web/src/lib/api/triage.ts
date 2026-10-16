import { TRIAGE_OUTCOME_KINDS, TRIAGE_SIZES, TriageOutcome } from "@omniralph/shared";
import { z } from "zod";
import {
  TRIAGE_RUN_STATUSES,
  type TriageRunDetailView,
  type TriageRunRow,
} from "@/lib/triage/display";
import { JOB_STATUSES } from "./jobs";
import { isoDate } from "./schemas";

/** Wire formats of the triage run endpoints under `/api/ui`. */

const agent = z.object({ id: z.string(), name: z.string() });

/** `TriageRunRow` on the wire: a run on the Triage list. */
export const triageRunRowSchema = z.object({
  id: z.string(),
  status: z.enum(TRIAGE_RUN_STATUSES),
  trigger: z.enum(["mention", "label"]),
  issue: z
    .object({ identifier: z.string(), title: z.string().nullable(), url: z.string().nullable() })
    .nullable(),
  repository: z
    .object({ provider: z.enum(["github", "gitlab"]), fullPath: z.string(), url: z.string() })
    .nullable(),
  outcome: z.enum(TRIAGE_OUTCOME_KINDS).nullable(),
  size: z.enum(TRIAGE_SIZES).nullable(),
  openQuestions: z.number().nullable(),
  error: z.string().nullable(),
  agent: agent.nullable(),
  jobCount: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate,
}) satisfies z.ZodType<TriageRunRow>;

/** `GET /api/ui/triage?status=&page=`: a page of triage runs, newest first. */
export const triageRunListSchema = z.object({
  runs: z.array(triageRunRowSchema),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Runs matching the filter across all pages. */
  total: z.number(),
});
export type TriageRunList = z.infer<typeof triageRunListSchema>;

/** `TriageRunDetailView` on the wire: everything a triage run's page shows. */
export const triageRunDetailSchema = triageRunRowSchema.extend({
  linearAgentSessionId: z.string(),
  branch: z.string().nullable(),
  pendingReply: z.string().nullable(),
  // Kept as the run's last result was validated when it was written.
  result: z
    .object({
      summary: z.string(),
      error: z.string().nullable(),
      outcome: TriageOutcome.nullable(),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
      durationMs: z.number(),
    })
    .nullable(),
  jobs: z.array(
    z.object({
      id: z.string(),
      status: z.enum(JOB_STATUSES),
      cancelRequested: z.boolean(),
      deliveryCount: z.number(),
      error: z.string().nullable(),
      agent: agent.nullable(),
      reply: z.string().nullable(),
      createdAt: isoDate,
      finishedAt: isoDate.nullable(),
    }),
  ),
  activities: z.array(
    z.object({
      id: z.string(),
      jobId: z.string(),
      type: z.enum(["thought", "action"]),
      body: z.string(),
      parameter: z.string().nullable(),
      createdAt: isoDate,
    }),
  ),
}) satisfies z.ZodType<TriageRunDetailView>;

/** `GET /api/ui/triage/{id}?next=`: a triage run of the active organization, polled by its page. */
export const triageRunDetailResponseSchema = z.object({ run: triageRunDetailSchema });
export type TriageRunDetail = z.infer<typeof triageRunDetailResponseSchema>;
