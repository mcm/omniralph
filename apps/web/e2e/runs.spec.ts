import { eq } from "drizzle-orm";
import { jobs, reviewRuns, reviews } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addFinding, finishTriage, open, runningReview, triageRun } from "./runs";

const RUN_LIST_API = /\/api\/ui\/runs(\?|$)/;
const RUN_DETAIL_API = /\/api\/ui\/runs\/[\w-]+(\?|$)/;

// Wide enough for the rail and the open run side by side (`SplitView`, 880 px of content).
test.use({ viewport: { width: 1440, height: 900 } });

/** The rail's row of the run titled `title`. */
const runRow = (page: Page, title: string) =>
  page.getByRole("list", { name: "Runs" }).getByRole("listitem").filter({ hasText: title });

/** The open run's pane. */
const runPane = (page: Page) => page.getByRole("region", { name: "Run" });

/** Whether the URL's `/runs` filters are exactly `filters`. */
const hasFilters =
  (path: RegExp, filters: Record<string, string[]>) =>
  (url: URL): boolean =>
    path.test(url.pathname) &&
    ["kind", "status", "repository"].every(
      (key) => url.searchParams.getAll(key).join(",") === (filters[key] ?? []).join(","),
    );

/** Opens a filter button's menu, checks `option`, and closes the menu. */
async function chooseFilter(page: Page, button: string, option: string) {
  await page.getByRole("button", { name: button }).click();
  await page.getByRole("menu").getByRole("menuitemcheckbox", { name: option }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test.describe("runs", () => {
  test("a run's status changed in the database updates the open list and detail", async ({
    db,
    page,
    signIn,
  }) => {
    const { runId, jobId, title } = await triageRun(db, "Live triage", "running");
    await signIn("member");
    await open(page, `/runs/${runId}`, RUN_DETAIL_API);

    const row = runRow(page, title);
    await expect(row).toContainText("Triage · running");
    await expect(row).toHaveAttribute("aria-current", "true");
    const pane = runPane(page);
    await expect(pane.getByRole("heading", { name: title })).toBeVisible();
    await expect(pane.getByRole("status", { name: "Running", exact: true })).toBeVisible();

    // The agent finishes the attempt, and the result sink the run.
    await finishTriage(db, runId, jobId);

    await expect(row).toContainText("Triage · finished");
    await expect(pane.getByRole("status", { name: "Finished", exact: true })).toBeVisible();
    await expect(row).not.toContainText("Triage · running");
  });

  test("the Kind and Status filters show their runs and stay in the URL", async ({
    db,
    page,
    signIn,
  }) => {
    const running = await triageRun(db, "Filtered running triage", "running");
    const failed = await triageRun(db, "Filtered failed triage", "failed");
    await signIn("member");
    await open(page, "/runs", RUN_LIST_API);
    await expect(runRow(page, running.title)).toBeVisible();
    await expect(runRow(page, failed.title)).toBeVisible();

    await chooseFilter(page, "Kind: All", "Triage");
    await expect(page).toHaveURL(hasFilters(/^\/runs$/, { kind: ["triage"] }));
    await chooseFilter(page, "Status: All", "Running");
    await expect(page).toHaveURL(hasFilters(/^\/runs$/, { kind: ["triage"], status: ["running"] }));
    await expect(page.getByRole("button", { name: "Kind: Triage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Status: Running" })).toBeVisible();
    await expect(runRow(page, running.title)).toBeVisible();
    await expect(runRow(page, failed.title)).toHaveCount(0);

    // Opening a run keeps the rail's filters.
    await runRow(page, running.title).getByRole("link", { name: running.title }).click();
    const runPath = new RegExp(`^/runs/${running.runId}$`);
    await expect(page).toHaveURL(hasFilters(runPath, { kind: ["triage"], status: ["running"] }));
    await expect(runPane(page).getByRole("heading", { name: running.title })).toBeVisible();
    await expect(page.getByRole("button", { name: "Kind: Triage" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Status: Running" })).toBeVisible();
    await expect(runRow(page, failed.title)).toHaveCount(0);

    // A reload reads the filters from the URL.
    await page.reload();
    await expect(page.getByRole("button", { name: "Status: Running" })).toBeVisible();
    await expect(runRow(page, running.title)).toHaveAttribute("aria-current", "true");
    await expect(runRow(page, failed.title)).toHaveCount(0);

    // Back to the list without filters: both runs show again.
    await page.goto("/runs");
    await expect(page.getByRole("button", { name: "Kind: All" })).toBeVisible();
    await expect(runRow(page, failed.title)).toBeVisible();
  });

  test("Cancel attempt shows Cancel requested until the agent confirms", async ({
    db,
    page,
    signIn,
  }) => {
    const { runId, jobId } = await triageRun(db, "Canceled triage", "running");
    await signIn("admin");
    await open(page, `/runs/${runId}?tab=attempts`, RUN_DETAIL_API);

    const attempts = runPane(page).getByRole("list", { name: "Attempts" });
    await expect(attempts.getByRole("img", { name: "Running" })).toBeVisible();
    await attempts.getByRole("button", { name: "Cancel attempt" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Cancel this attempt?" });
    await dialog.getByRole("button", { name: "Cancel attempt" }).click();
    await expect(attempts).toContainText("Cancel requested");
    await expect(attempts.getByRole("button", { name: "Cancel attempt" })).toHaveCount(0);

    // The server asked the agent to stop; the attempt runs until its next heartbeat.
    await expect
      .poll(async () => (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0])
      .toMatchObject({ status: "running", cancelRequested: true });
    // It still reads so after the run is read again.
    await page.reload();
    await expect(attempts).toContainText("Cancel requested");
    await expect(attempts.getByRole("img", { name: "Running" })).toBeVisible();

    // The agent stops it.
    await db
      .update(jobs)
      .set({ status: "canceled", finishedAt: new Date() })
      .where(eq(jobs.id, jobId));
    await expect(attempts.getByRole("img", { name: "Canceled" })).toBeVisible();
    await expect(attempts).not.toContainText("Cancel requested");
  });

  test("a review pass's findings show on its Findings tab once the pass completes", async ({
    db,
    page,
    signIn,
  }) => {
    const { runId, passId, title } = await runningReview(db, "Live review");
    await signIn("member");
    await open(page, `/runs/${runId}?step=${passId}&tab=findings`, RUN_DETAIL_API);

    const pane = runPane(page);
    await expect(pane.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      pane.getByRole("status", { name: "Running · pull request open", exact: true }),
    ).toBeVisible();
    await expect(pane.getByRole("tab", { name: /Findings/, selected: true })).toBeVisible();
    await expect(pane.getByText("Findings appear here when the pass finishes.")).toBeVisible();

    // The agent reports a finding and the pass completes.
    await addFinding(db, passId, "Stale cache entries");
    await db
      .update(reviews)
      .set({ status: "completed", durationMs: 42_000 })
      .where(eq(reviews.id, passId));
    await db.update(reviewRuns).set({ status: "completed" }).where(eq(reviewRuns.id, runId));

    await expect(pane.getByRole("heading", { name: "Stale cache entries" })).toBeVisible();
    await expect(pane.getByRole("region", { name: "src/cache.ts" })).toBeVisible();
    await expect(pane.getByText("Findings appear here when the pass finishes.")).toHaveCount(0);
    await expect(
      pane.getByRole("status", { name: "Finished · pull request open", exact: true }),
    ).toBeVisible();
  });
});
