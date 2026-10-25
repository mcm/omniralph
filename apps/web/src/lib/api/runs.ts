import type { RunKind, RunOrigin, RunStatus } from "@omniralph/db";
import { z } from "zod";
import { isoDate } from "./schemas";

/** Wire formats of the unified run endpoints under `/api/ui/runs`. */

/** Client-safe copies of the run read model's values (`run-index.ts` in `@omniralph/db`). */
export const RUN_KINDS = [
  "epic",
  "request",
  "review",
  "triage",
  "ask",
] as const satisfies readonly RunKind[];
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
  "skipped",
] as const satisfies readonly RunStatus[];
export const RUN_ORIGINS = [
  "linear",
  "linear_mention",
  "chat",
  "pr_webhook",
  "pr_mention",
  "manual",
  "triage_label",
  "triage_mention",
] as const satisfies readonly RunOrigin[];

/** Default and largest page of `GET /api/ui/runs`. */
export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 100;

const provider = z.enum(["github", "gitlab"]);

/** The organization a row belongs to, and the user's role there. */
export const organizationRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
});
export const repositoryRefSchema = z.object({ id: z.string(), provider, fullPath: z.string() });
export const workItemRefSchema = z.object({
  tracker: z.literal("linear"),
  identifier: z.string(),
  url: z.string().nullable(),
});
export const pullRequestRefSchema = z.object({
  provider,
  number: z.number(),
  url: z.string().nullable(),
});
export const agentRefSchema = z.object({ id: z.string(), name: z.string() });

/** A row of the unified run list: kind, status, title and typed references. */
export const runRowSchema = z.object({
  id: z.string(),
  kind: z.enum(RUN_KINDS),
  status: z.enum(RUN_STATUSES),
  origin: z.enum(RUN_ORIGINS),
  organization: organizationRefSchema,
  title: z.string(),
  workItem: workItemRefSchema.nullable(),
  repository: repositoryRefSchema.nullable(),
  branch: z.string().nullable(),
  pullRequest: pullRequestRefSchema.nullable(),
  agent: agentRefSchema.nullable(),
  /** Steps done of all; null for single-step runs. */
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  tokens: z.object({ in: z.number(), out: z.number() }),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  updatedAt: isoDate,
});
export type RunRow = z.infer<typeof runRowSchema>;

/**
 * `GET /api/ui/runs?kind=&status=&repository=&origin=&agent=&organization=&cursor=&limit=`:
 * a page of runs, newest first. `nextCursor` is null on the last page.
 */
export const runListSchema = z.object({
  runs: z.array(runRowSchema),
  nextCursor: z.string().nullable(),
});
export type RunList = z.infer<typeof runListSchema>;
