// Runs the Runs and Inbox specs create in the fixture database, as the dispatcher and the
// agents would leave them. Each has a title no other run has, so a spec finds its rows.
import { eq } from "drizzle-orm";
import {
  createReview,
  createReviewRun,
  createTriageRun,
  findings,
  insertJob,
  jobs,
  reviewRuns,
  reviews,
  triageRuns,
  type Database,
} from "@omniralph/db";
import type { Page } from "@playwright/test";
import { FIXTURE_IDS } from "./fixtures";

const organizationId = FIXTURE_IDS.organizations.main;

/** A suffix no other run of this e2e run has. */
function unique(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
}

export type TriageRunStatus = "running" | "completed" | "failed";

/**
 * A triage run of the fixture organization with one `triage.run` attempt, both in `status`
 * (a running attempt for a running run). Its title is the work item's: `{prefix} {unique}`.
 */
export async function triageRun(db: Database, prefix: string, status: TriageRunStatus) {
  const key = unique();
  const title = `${prefix} ${key}`;
  const { run } = await createTriageRun(db, {
    organizationId,
    linearIssueId: `e2e-issue-${key}`,
    linearAgentSessionId: `e2e-session-${key}`,
    trigger: "mention",
  });
  const { job } = await insertJob(db, {
    organizationId,
    type: "triage.run",
    taskType: "query",
    triageRunId: run.id,
    payload: {
      trigger: {
        kind: "linear.triage",
        context: {
          triageRunId: run.id,
          issue: { identifier: `E2E-${key.slice(-5)}`, title },
        },
      },
    },
  });
  await db
    .update(jobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(jobs.id, job.id));
  await db.update(triageRuns).set({ status: "running" }).where(eq(triageRuns.id, run.id));
  if (status === "completed") await finishTriage(db, run.id, job.id);
  if (status === "failed") {
    await db
      .update(jobs)
      .set({ status: "failed", finishedAt: new Date(), error: "The agent went away." })
      .where(eq(jobs.id, job.id));
    await db.update(triageRuns).set({ status: "failed" }).where(eq(triageRuns.id, run.id));
  }
  return { runId: run.id, jobId: job.id, title };
}

/** What a triage that wrote a PRD without open questions keeps (`TriageRunResult`). */
const PRD_RESULT = {
  summary: "Wrote a PRD with one story.",
  error: null,
  outcome: {
    outcome: "prd",
    size: "M",
    title: "E2E PRD",
    description: "## Problem\n\nLive.",
    openQuestions: [],
    stories: [],
    subIssueUpdates: [],
  },
  usage: { inputTokens: 1000, outputTokens: 200 },
  durationMs: 30_000,
};

/**
 * Finishes a triage run's attempt and the run with a PRD and no open questions, as the
 * agent and the result sink do: the run is finished, and its PRD is ready in the Inbox.
 */
export async function finishTriage(db: Database, runId: string, jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(jobs.id, jobId));
  await db
    .update(triageRuns)
    .set({ status: "completed", lastResult: PRD_RESULT, updatedAt: new Date() })
    .where(eq(triageRuns.id, runId));
}

/**
 * A running review run of a fixture repository with one running pass, titled
 * `{prefix} {unique}` (the PR/MR's title). Returns the pass's ID: its step's.
 */
export async function runningReview(db: Database, prefix: string) {
  const key = unique();
  const title = `${prefix} ${key}`;
  const prNumber = 10_000 + Math.floor(Math.random() * 90_000);
  const headSha = key.replace(/\D/g, "").padEnd(40, "e").slice(0, 40);
  const run = await createReviewRun(db, {
    organizationId,
    repositoryId: FIXTURE_IDS.repositories.controlPanel,
    prNumber,
    headSha,
    baseSha: "f".repeat(40),
    trigger: "webhook",
    mode: "full",
    depth: "standard",
  });
  const pass = await createReview(db, {
    reviewRunId: run.id,
    repositoryId: FIXTURE_IDS.repositories.controlPanel,
    prNumber,
    prTitle: title,
    headSha,
    baseSha: "f".repeat(40),
    trigger: "webhook",
    depth: "standard",
    model: null,
    budget: 100_000,
  });
  await db.update(reviews).set({ status: "running" }).where(eq(reviews.id, pass.id));
  await db.update(reviewRuns).set({ status: "running" }).where(eq(reviewRuns.id, run.id));
  return { runId: run.id, passId: pass.id, title };
}

/** A finding of the pass `reviewId`, without a thread on the code host. */
export async function addFinding(db: Database, reviewId: string, title: string): Promise<void> {
  await db.insert(findings).values({
    reviewId,
    path: "src/cache.ts",
    startLine: 12,
    endLine: 14,
    severity: "high",
    category: "correctness",
    title,
    body: "The cache is never invalidated.",
    confidence: 0.9,
  });
}

/** Opens `path` and waits for the first answer of `api`, so `next dev` compiled the route. */
export async function open(page: Page, path: string, api: RegExp): Promise<void> {
  const loaded = page.waitForResponse((response) => api.test(response.url()) && response.ok());
  await page.goto(path);
  await loaded;
}
