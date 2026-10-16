import { eq } from "drizzle-orm";
import {
  createRun,
  insertJob,
  jobs,
  updateRun,
  updateStory,
  upsertStories,
  type Database,
} from "@omniralph/db";
import type { Page } from "@playwright/test";
import { expect, FIXTURE_IDS, test } from "./fixtures";

const organizationId = FIXTURE_IDS.organizations.main;

/** A running coding run of the fixture organization: two stories, the first one's job running. */
async function runningRun(db: Database, prefix: string) {
  const key = `${prefix}-${Date.now()}`;
  const { run } = await createRun(db, {
    organizationId,
    linearIssueId: key,
    linearIdentifier: `E2E-${Date.now() % 100_000}`,
    linearTitle: `Live run ${key}`,
    linearUrl: null,
    linearAgentSessionId: `${key}-session`,
    kind: "children",
    repositoryId: FIXTURE_IDS.repositories.controlPanel,
    branch: key,
    baseBranch: "main",
  });
  const [first, second] = await upsertStories(db, run.id, [
    { linearIssueId: `${key}-1`, identifier: "E2E-1", title: `First story ${key}` },
    { linearIssueId: `${key}-2`, identifier: "E2E-2", title: `Second story ${key}` },
  ]);
  const { job } = await insertJob(db, {
    organizationId,
    type: "ralph.story",
    taskType: "coding",
    pool: "long",
    ralphRunId: run.id,
  });
  await db
    .update(jobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(jobs.id, job.id));
  await updateStory(db, first!.id, { status: "running", lastJobId: job.id });
  await updateRun(db, run.id, { status: "running" });
  return { run, first: first!, second: second!, jobId: job.id };
}

/** Opens `path` and waits for the first poll of `api`, so `next dev` has compiled the route. */
async function open(page: Page, path: string, api: RegExp) {
  const firstPoll = page.waitForResponse((response) => api.test(response.url()) && response.ok());
  await page.goto(path);
  await firstPoll;
}

test.describe("coding runs", () => {
  test("a story marked done and a job finished in the database appear on the open run", async ({
    db,
    page,
    signIn,
  }) => {
    const { run, first, jobId } = await runningRun(db, "e2e-run-detail");
    await signIn("admin");
    await open(page, `/coding/${run.id}`, /\/api\/ui\/runs\/[\w-]+(\?|$)/);

    const storyRow = page.locator("main table tr", { hasText: first.title });
    const jobRow = page.locator("main table tr", { hasText: "ralph.story" });
    await expect(storyRow).toContainText("Running");
    await expect(jobRow).toContainText("Running");

    // The harness finishes the story's job, and the run marks the story done.
    await db
      .update(jobs)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(jobs.id, jobId));
    await updateStory(db, first.id, { status: "completed", commitSha: "c0ffee".repeat(6) });
    await updateRun(db, run.id, { progress: "## E2E-1 done" });

    await expect(storyRow).toContainText("Completed", { timeout: 5_000 });
    await expect(jobRow).toContainText("Completed", { timeout: 5_000 });
    await expect(page.getByText("## E2E-1 done")).toBeVisible({ timeout: 5_000 });
  });

  test("the list shows a run's new status, and a status filter shows its results", async ({
    db,
    page,
    signIn,
  }) => {
    const { run } = await runningRun(db, "e2e-run-list");
    await signIn("member");
    await open(page, "/coding", /\/api\/ui\/runs(\?|$)/);

    const row = page.locator("main table tr", { hasText: run.linearTitle! });
    await expect(row).toContainText("Running");
    await updateRun(db, run.id, { status: "waiting" });
    await expect(row).toContainText("Waiting", { timeout: 5_000 });

    await page.getByLabel("Filter by status").selectOption("waiting");
    await expect(page.getByLabel("Filter by status")).toHaveValue("waiting");
    await expect(page).toHaveURL(/\/coding\?status=waiting$/);
    await expect(row).toBeVisible();
  });
});
