import { z } from "zod";
import {
  RALPH_MESSAGE_STATES,
  RALPH_RUN_STATUSES,
  RALPH_STORY_STATUSES,
  type RalphRunDetailView,
  type RalphRunRow,
} from "@/lib/ralph/display";
import { isoDate } from "./schemas";

/** Wire formats of the coding run endpoints under `/api/ui`. */

const repositoryRef = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab"]),
  fullPath: z.string(),
});
const pullRequest = z.object({ number: z.number(), url: z.string(), label: z.string() });
const agent = z.object({ id: z.string(), name: z.string() });
const issueRef = z.object({ identifier: z.string(), title: z.string() });
const rounds = z.object({ done: z.number(), max: z.number().nullable() });
const jobStatus = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  "skipped",
]);

/** The fields a run's list row and detail share (`RalphRunRow` but its story counts). */
const runBase = {
  id: z.string(),
  origin: z.enum(["linear", "chat"]),
  linearIdentifier: z.string().nullable(),
  linearTitle: z.string().nullable(),
  linearUrl: z.string().nullable(),
  chatThread: z
    .object({ platform: z.enum(["slack", "discord"]), channelId: z.string() })
    .nullable(),
  repository: repositoryRef.nullable(),
  status: z.enum(RALPH_RUN_STATUSES),
  branch: z.string().nullable(),
  pullRequest: pullRequest.nullable(),
  agent: agent.nullable(),
  error: z.string().nullable(),
  updatedAt: isoDate,
};

/** `RalphRunRow` on the wire: a run on the Coding tasks list. */
export const ralphRunRowSchema = z.object({
  ...runBase,
  stories: z.object({ total: z.number(), completed: z.number() }),
}) satisfies z.ZodType<RalphRunRow>;

/** `GET /api/ui/runs?status=&repository=&page=`: a page of runs, newest first. */
export const runListSchema = z.object({
  runs: z.array(ralphRunRowSchema),
  /** The repositories the list can be filtered by. */
  repositories: z.array(repositoryRef),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Runs matching the filters across all pages. */
  total: z.number(),
  /** False while no Linear workspace is connected: no runs can start. */
  linearConnected: z.boolean(),
});
export type RunList = z.infer<typeof runListSchema>;

/** `RalphRunDetailView` on the wire: everything a run's page shows. */
export const ralphRunDetailSchema = z.object({
  ...runBase,
  kind: z.enum(["children", "prd", "single"]),
  baseBranch: z.string().nullable(),
  lanes: z.array(
    z.object({
      id: z.string(),
      repository: repositoryRef,
      main: z.boolean(),
      branch: z.string(),
      baseBranch: z.string(),
      pullRequest: pullRequest.nullable(),
      cleanup: z.string().nullable(),
      reviewRounds: rounds,
      ciFixRounds: rounds,
    }),
  ),
  waitingOn: z.object({ blockers: z.array(issueRef), manual: z.array(issueRef) }).nullable(),
  // Stored in the run's JSON columns: kept as written.
  guidance: z.array(z.object({ text: z.string(), at: z.string() })),
  progress: z.string(),
  iterations: z.number(),
  maxAttemptsPerStory: z.number(),
  storyCounts: z.object({ total: z.number(), completed: z.number() }),
  stories: z.array(
    z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      status: z.enum(RALPH_STORY_STATUSES),
      attempts: z.number(),
      lastFeedback: z.string().nullable(),
      commitSha: z.string().nullable(),
      lastJobId: z.string().nullable(),
      laneId: z.string().nullable(),
      elsewhere: z.string().nullable(),
      recommendations: z.array(
        z.object({ title: z.string(), description: z.string(), at: z.string() }),
      ),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      status: jobStatus,
      cancelRequested: z.boolean(),
      deliveryCount: z.number(),
      error: z.string().nullable(),
      agent: agent.nullable(),
      createdAt: isoDate,
      finishedAt: isoDate.nullable(),
    }),
  ),
  pendingRequests: z.array(
    z.object({
      id: z.string(),
      laneId: z.string().nullable(),
      text: z.string(),
      author: z.string().nullable(),
      createdAt: isoDate,
    }),
  ),
  messages: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["guidance", "request"]),
      text: z.string(),
      author: z.string().nullable(),
      job: z.object({ id: z.string(), type: z.string(), status: jobStatus }),
      state: z.enum(RALPH_MESSAGE_STATES),
      createdAt: isoDate,
      deliveredAt: isoDate.nullable(),
      consumedAt: isoDate.nullable(),
    }),
  ),
  messageLimit: z.number(),
  createdAt: isoDate,
}) satisfies z.ZodType<RalphRunDetailView>;

/** `GET /api/ui/runs/{id}?next=`: a run of the active organization, polled by its page. */
export const runDetailSchema = z.object({
  run: ralphRunDetailSchema,
  /** False while no Linear workspace is connected. */
  linearConnected: z.boolean(),
});
export type RunDetail = z.infer<typeof runDetailSchema>;
