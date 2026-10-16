import { eq } from "drizzle-orm";
import { connectRepository, repositories, scmConnections } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { FAKE_GITLAB_TOKEN } from "./fake-gitlab";
import { expect, FIXTURE_IDS, test } from "./fixtures";

/** The connected repositories table's row of `fullPath`. */
const repositoryRow = (page: Page, fullPath: string) =>
  page.locator("main table tr", { hasText: fullPath });

/** `next dev` compiles a page on its first visit. */
const COMPILE_TIMEOUT_MS = 120_000;

test.describe("repositories", () => {
  test("a GitLab project picked and saved is on the repositories page on arrival", async ({
    page,
    signIn,
    db,
  }) => {
    const gitlabUrl = process.env.E2E_FAKE_GITLAB_URL;
    expect(gitlabUrl, "E2E_FAKE_GITLAB_URL (set by the e2e runner)").toBeTruthy();
    await signIn("admin");
    await page.goto("/repositories");
    await expect(page.getByRole("heading", { level: 1, name: "Repositories" })).toBeVisible();
    // Everything from here on is client-side: no page load.
    let loads = 0;
    page.on("load", () => (loads += 1));

    const connect = page.getByRole("button", { name: "Connect GitLab" });
    await expect(connect).toBeEnabled();
    await connect.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/GitLab URL/).fill(gitlabUrl!);
    await dialog.getByLabel(/Access token/).fill(FAKE_GITLAB_TOKEN);
    await dialog.getByRole("button", { name: "Connect" }).click();

    // The project picker, listing the fake instance's projects.
    await expect(page).toHaveURL(/\/repositories\/gitlab\/[\w-]+$/, {
      timeout: COMPILE_TIMEOUT_MS,
    });
    const project = page.getByRole("checkbox", { name: "e2e-group/picked-project" });
    await expect(project).toBeVisible({ timeout: COMPILE_TIMEOUT_MS });
    await project.check();
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page).toHaveURL(/\/repositories$/, { timeout: COMPILE_TIMEOUT_MS });
    // Refetched before the navigation: there on arrival, not after a poll.
    await expect(repositoryRow(page, "e2e-group/picked-project")).toBeVisible({ timeout: 2_000 });
    await expect(repositoryRow(page, "e2e-group/other-project")).toHaveCount(0);
    expect(loads).toBe(0);

    await db.delete(scmConnections).where(eq(scmConnections.baseUrl, gitlabUrl!));
  });

  test("a repository added by another session appears on an open repositories page within 5s", async ({
    page,
    signIn,
    db,
  }) => {
    await signIn("member");
    // Wait for the first poll's answer, so the route is compiled before the change is timed.
    const firstPoll = page.waitForResponse(
      (response) => /\/api\/ui\/repositories(\?|$)/.test(response.url()) && response.ok(),
    );
    await page.goto("/repositories");
    await firstPoll;

    // Sorted first, so it's on the first page.
    const fullPath = `aaa-e2e/live-${Date.now()}`;
    const repo = await connectRepository(db, {
      connectionId: FIXTURE_IDS.scmConnections.github,
      provider: "github",
      externalId: `e2e-${Date.now()}`,
      fullPath,
    });
    try {
      await expect(repositoryRow(page, fullPath)).toBeVisible({ timeout: 5_000 });
    } finally {
      await db.delete(repositories).where(eq(repositories.id, repo.id));
    }
  });
});
