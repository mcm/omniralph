import { eq } from "drizzle-orm";
import { insertJob, jobs, type Database } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { expect, FIXTURE_IDS, test } from "./fixtures";

/** A new queued job of the fixture organization: the newest, so first on the Jobs page. */
async function queuedJob(db: Database) {
  const { job } = await insertJob(db, {
    organizationId: FIXTURE_IDS.organizations.main,
    type: "review.run",
    taskType: "review",
  });
  return job;
}

/** Opens the Jobs page and waits for its first poll, so `next dev` has compiled the route. */
async function openJobs(page: Page) {
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/jobs(\?|$)/.test(response.url()) && response.ok(),
  );
  await page.goto("/jobs");
  await firstPoll;
}

test.describe("jobs", () => {
  test("a job moved from queued to running to succeeded in the database updates on the open list", async ({
    db,
    page,
    signIn,
  }) => {
    const job = await queuedJob(db);
    await signIn("member");
    await openJobs(page);

    const status = page.locator(`#job-${job.id} td`).nth(3);
    await expect(status).toContainText("Queued");

    await db
      .update(jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await expect(status).toContainText("Running", { timeout: 5_000 });

    await db
      .update(jobs)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await expect(status).toContainText("Completed", { timeout: 5_000 });
  });

  test("cancelling a running job shows it requested until the agent confirms, then canceled", async ({
    db,
    page,
    signIn,
  }) => {
    const job = await queuedJob(db);
    await db
      .update(jobs)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await signIn("admin");
    await openJobs(page);

    const status = page.locator(`#job-${job.id} td`).nth(3);
    await expect(status).toContainText("Running");
    await page
      .locator(`#job-${job.id}`)
      .getByRole("button", { name: /^Cancel job / })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel job" }).click();
    await expect(status).toContainText("Cancel requested");
    // Shown at once; the server marks it cancel-requested.
    await expect
      .poll(async () => (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0])
      .toMatchObject({ status: "running", cancelRequested: true });
    await expect(status).toContainText("Cancel requested");

    // Its agent stops it after the next heartbeat.
    await db
      .update(jobs)
      .set({ status: "canceled", finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await expect(status).toContainText("Canceled", { timeout: 5_000 });
  });

  test("a status filter shows its results and stays in the URL", async ({ db, page, signIn }) => {
    const job = await queuedJob(db);
    await signIn("member");
    await openJobs(page);
    await expect(page.locator(`#job-${job.id}`)).toBeVisible();

    await page.getByLabel("Filter by status").selectOption("failed");
    await expect(page.getByLabel("Filter by status")).toHaveValue("failed");
    await expect(page).toHaveURL(/\/jobs\?status=failed$/);
    await expect(page.locator(`#job-${job.id}`)).toHaveCount(0);

    await page.goBack();
    await expect(page.getByLabel("Filter by status")).toHaveValue("");
    await expect(page.locator(`#job-${job.id}`)).toBeVisible();
  });
});
