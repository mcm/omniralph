import { eq } from "drizzle-orm";
import { createTriageRun, insertJob, jobs, triageRuns, type Database } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { expect, FIXTURE_IDS, test } from "./fixtures";

const organizationId = FIXTURE_IDS.organizations.main;

/** A running triage run of the fixture organization, its `triage.run` job running. */
async function runningTriage(db: Database, prefix: string) {
  const key = `${prefix}-${Date.now()}`;
  const identifier = `TRI-${Date.now() % 100_000}`;
  const title = `Live triage ${key}`;
  const { run } = await createTriageRun(db, {
    organizationId,
    linearIssueId: key,
    linearAgentSessionId: `${key}-session`,
    trigger: "mention",
  });
  const { job } = await insertJob(db, {
    organizationId,
    type: "triage.run",
    taskType: "query",
    pool: "short",
    payload: {
      trigger: {
        kind: "linear.triage",
        context: { triageRunId: run.id, issue: { identifier, title } },
      },
    },
  });
  await db
    .update(jobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(jobs.id, job.id));
  await db.update(triageRuns).set({ status: "running" }).where(eq(triageRuns.id, run.id));
  return { run, jobId: job.id, title };
}

/** What a finished triage keeps (`TriageRunResult`). */
const RESULT = {
  summary: "Wrote a PRD with one story.",
  error: null,
  outcome: {
    outcome: "prd",
    size: "M",
    title: "Live triage PRD",
    description: "## Problem\n\nLive.",
    openQuestions: ["Which formats?"],
    stories: [],
    subIssueUpdates: [],
  },
  usage: { inputTokens: 1000, outputTokens: 200 },
  durationMs: 30_000,
};

/** Opens `path` and waits for the first poll of `api`, so `next dev` has compiled the route. */
async function open(page: Page, path: string, api: RegExp) {
  const firstPoll = page.waitForResponse((response) => api.test(response.url()) && response.ok());
  await page.goto(path);
  await firstPoll;
}

test.describe("triage runs", () => {
  test("a triage finished in the database shows its result on the open run", async ({
    db,
    page,
    signIn,
  }) => {
    const { run, jobId } = await runningTriage(db, "e2e-triage-detail");
    await signIn("member");
    await open(page, `/triage/${run.id}`, /\/api\/ui\/triage\/[\w-]+(\?|$)/);

    const jobRow = page.locator("main table tr", { hasText: jobId.slice(0, 8) });
    await expect(jobRow).toContainText("Running");
    await expect(page.getByText("Wrote a PRD with one story.")).toHaveCount(0);

    // The harness finishes the job, and the sink keeps its result.
    await db
      .update(jobs)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(jobs.id, jobId));
    await db
      .update(triageRuns)
      .set({ status: "completed", lastResult: RESULT, updatedAt: new Date() })
      .where(eq(triageRuns.id, run.id));

    await expect(page.getByText("Wrote a PRD with one story.")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Which formats?")).toBeVisible();
    await expect(jobRow).toContainText("Completed");
  });

  test("the list shows a run's new status, and a status filter shows its results", async ({
    db,
    page,
    signIn,
  }) => {
    const { run, title } = await runningTriage(db, "e2e-triage-list");
    await signIn("member");
    await open(page, "/triage", /\/api\/ui\/triage(\?|$)/);

    const row = page.locator("main table tr", { hasText: title });
    await expect(row).toContainText("Running");
    await db
      .update(triageRuns)
      .set({ status: "completed", lastResult: RESULT, updatedAt: new Date() })
      .where(eq(triageRuns.id, run.id));
    await expect(row).toContainText("Completed", { timeout: 5_000 });
    await expect(row).toContainText("New PRD · M");

    await page.getByLabel("Filter by status").selectOption("completed");
    await expect(page.getByLabel("Filter by status")).toHaveValue("completed");
    await expect(page).toHaveURL(/\/triage\?status=completed$/);
    await expect(row).toBeVisible();
    await page.getByLabel("Filter by status").selectOption("running");
    await expect(page).toHaveURL(/\/triage\?status=running$/);
    await expect(row).toHaveCount(0);

    // Back: the URL's filter shows again.
    await page.goBack();
    await expect(page).toHaveURL(/\/triage\?status=completed$/);
    await expect(page.getByLabel("Filter by status")).toHaveValue("completed");
    await expect(row).toBeVisible();
  });
});
