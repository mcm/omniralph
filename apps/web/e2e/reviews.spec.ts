import { eq } from "drizzle-orm";
import { createReview, findings, reviews, type Database } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { expect, FIXTURE_IDS, test } from "./fixtures";

/** A running review of a fixture repository, under a title no other review has. */
async function runningReview(db: Database, prefix: string) {
  const title = `${prefix} ${Date.now()}`;
  const review = await createReview(db, {
    repositoryId: FIXTURE_IDS.repositories.controlPanel,
    prNumber: 9000 + (Date.now() % 1000),
    prTitle: title,
    headSha: "e".repeat(40),
    baseSha: "f".repeat(40),
    trigger: "webhook",
    depth: "standard",
    model: null,
    budget: 100_000,
  });
  await db.update(reviews).set({ status: "running" }).where(eq(reviews.id, review.id));
  return { review, title };
}

/** A finding of `reviewId` without a thread on the code host. */
async function addFinding(db: Database, reviewId: string, title: string) {
  const [row] = await db
    .insert(findings)
    .values({
      reviewId,
      path: "src/cache.ts",
      startLine: 12,
      endLine: 14,
      severity: "high",
      category: "correctness",
      title,
      body: "The cache is never invalidated.",
      confidence: 0.9,
    })
    .returning();
  return row!;
}

/** Opens `path` and waits for the first poll of `api`, so `next dev` has compiled the route. */
async function open(page: Page, path: string, api: RegExp) {
  const firstPoll = page.waitForResponse((response) => api.test(response.url()) && response.ok());
  await page.goto(path);
  await firstPoll;
}

test.describe("reviews", () => {
  test("findings appear on the open review when it completes", async ({ db, page, signIn }) => {
    const { review } = await runningReview(db, "Live review");
    await signIn("member");
    await open(page, `/reviews/${review.id}`, /\/api\/ui\/reviews\/[\w-]+(\?|$)/);
    await expect(page.getByText("Findings appear here when the review completes.")).toBeVisible();

    // The agent reports a finding and the review completes.
    await addFinding(db, review.id, "Stale cache entries");
    await db
      .update(reviews)
      .set({ status: "completed", durationMs: 42_000 })
      .where(eq(reviews.id, review.id));

    await expect(page.getByRole("heading", { name: "Stale cache entries" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText("Not finished yet")).toBeHidden();
    await expect(page.locator(".page-header")).toContainText("Completed");
  });

  test("the list shows a review's new status, and a status filter shows its results", async ({
    db,
    page,
    signIn,
  }) => {
    const { review, title } = await runningReview(db, "Listed review");
    await signIn("member");
    await open(page, "/reviews", /\/api\/ui\/reviews(\?|$)/);

    const row = page.locator("main table tr", { hasText: title });
    await expect(row).toContainText("Running");
    await db
      .update(reviews)
      .set({ status: "failed", error: "The agent went away." })
      .where(eq(reviews.id, review.id));
    await expect(row).toContainText("Failed", { timeout: 5_000 });

    await page.getByLabel("Filter by status").selectOption("failed");
    await expect(page.getByLabel("Filter by status")).toHaveValue("failed");
    await expect(page).toHaveURL(/\/reviews\?status=failed$/);
    await expect(row).toBeVisible();
  });
});
