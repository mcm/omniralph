import { eq } from "drizzle-orm";
import { connectRepository, repositories, scmConnections } from "@omniralph/db";
import type { Page } from "@playwright/test";
import { FAKE_GITLAB_TOKEN } from "./fake-gitlab";
import { expect, FIXTURE_IDS, test } from "./fixtures";

/** `next dev` compiles a page on its first visit. */
const COMPILE_TIMEOUT_MS = 120_000;

const CONTROL_PANEL = FIXTURE_IDS.repositories.controlPanel;

/** The repo list rail's row of `fullPath` (its badges show the group and the name apart). */
const railRow = (page: Page, fullPath: string) =>
  page
    .getByRole("list", { name: "Repos" })
    .getByRole("listitem")
    .filter({ hasText: fullPath.slice(fullPath.lastIndexOf("/") + 1) });

/** Opens `path` and waits for the repo list's first answer (so the screen is hydrated). */
async function openRepos(page: Page, path: string) {
  const list = page.waitForResponse(
    (response) => /\/api\/ui\/repositories(\?|$)/.test(response.url()) && response.ok(),
    { timeout: COMPILE_TIMEOUT_MS },
  );
  await page.goto(path);
  await list;
}

test.describe("repos", () => {
  test("an admin opens a repo, stages a Reviews change and saves it", async ({
    page,
    signIn,
    db,
  }) => {
    const [before] = await db
      .select({ triggers: repositories.triggers })
      .from(repositories)
      .where(eq(repositories.id, CONTROL_PANEL));
    expect(before, "the seeded control panel repo").toBeTruthy();
    const drafts = !before!.triggers.drafts;

    await signIn("admin");
    await openRepos(page, `/repos/${CONTROL_PANEL}`);
    await expect(page.getByRole("heading", { level: 1, name: "Repos" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

    const reviews = page.locator("section#reviews");
    await expect(reviews.getByRole("heading", { name: "Reviews" })).toBeVisible();
    await reviews.getByRole("checkbox", { name: "Drafts too" }).setChecked(drafts);

    // The save bar lists the change with its effect.
    const bar = reviews.getByRole("region", { name: "Unsaved changes" });
    await expect(bar).toContainText("Drafts too");
    await expect(bar).toContainText(
      drafts ? "Draft pull requests are reviewed too." : "Draft pull requests aren't reviewed.",
    );

    try {
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/api/ui/repositories/${CONTROL_PANEL}/reviews`),
      );
      await bar.getByRole("button", { name: "Save 1 change" }).click();
      expect((await saved).ok()).toBe(true);

      // The view shows the saved state at once, and the database has it.
      await expect(bar).toHaveCount(0);
      await expect(reviews.getByRole("checkbox", { name: "Drafts too" })).toBeChecked({
        checked: drafts,
      });
      const [after] = await db
        .select({ triggers: repositories.triggers })
        .from(repositories)
        .where(eq(repositories.id, CONTROL_PANEL));
      expect(after!.triggers.drafts).toBe(drafts);
    } finally {
      await db
        .update(repositories)
        .set({ triggers: before!.triggers })
        .where(eq(repositories.id, CONTROL_PANEL));
    }
  });

  test("a GitLab project picked in the add-repo sheet opens on arrival", async ({
    page,
    signIn,
    db,
  }) => {
    const gitlabUrl = process.env.E2E_FAKE_GITLAB_URL;
    expect(gitlabUrl, "E2E_FAKE_GITLAB_URL (set by the e2e runner)").toBeTruthy();
    await signIn("admin");
    await openRepos(page, "/repos");
    // Everything from here on is client-side: no page load.
    let loads = 0;
    page.on("load", () => (loads += 1));

    try {
      await page.getByRole("button", { name: "Add repo" }).click();
      const sheet = page.getByRole("dialog", { name: "Add repos" });
      const connect = sheet.getByRole("button", { name: "Connect GitLab" });
      await expect(connect).toBeEnabled();
      await connect.click();
      const form = sheet.getByRole("form", { name: "Connect GitLab" });
      await form.getByLabel("GitLab URL").fill(gitlabUrl!);
      await form.getByLabel("Access token").fill(FAKE_GITLAB_TOKEN);
      await form.getByRole("button", { name: "Connect" }).click();

      // The new connection's picker, listing the fake instance's projects.
      const project = sheet.getByRole("checkbox", { name: /e2e-group\/picked-project/ });
      await expect(project).toBeVisible({ timeout: COMPILE_TIMEOUT_MS });
      await project.check();
      await sheet.getByRole("button", { name: "Add 1 repo" }).click();

      await expect(page).toHaveURL(/\/repos\/[\w-]+$/, { timeout: COMPILE_TIMEOUT_MS });
      await expect(sheet).toHaveCount(0);
      await expect(railRow(page, "e2e-group/picked-project")).toBeVisible({ timeout: 2_000 });
      await expect(railRow(page, "e2e-group/other-project")).toHaveCount(0);
      expect(loads).toBe(0);
    } finally {
      await db.delete(scmConnections).where(eq(scmConnections.baseUrl, gitlabUrl!));
    }
  });

  test("a repo added by another session appears on an open Repos page", async ({
    page,
    signIn,
    db,
  }) => {
    await signIn("member");
    await openRepos(page, "/repos");

    const fullPath = `aaa-e2e/live-${Date.now()}`;
    const repo = await connectRepository(db, {
      connectionId: FIXTURE_IDS.scmConnections.github,
      provider: "github",
      externalId: `e2e-${Date.now()}`,
      fullPath,
    });
    try {
      // A change event, or the live layer's fallback poll (10 s) without realtime.
      await expect(railRow(page, fullPath)).toBeVisible({ timeout: 15_000 });
    } finally {
      await db.delete(repositories).where(eq(repositories.id, repo.id));
    }
  });
});
