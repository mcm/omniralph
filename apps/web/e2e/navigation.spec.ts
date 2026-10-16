import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

const JOBS_API = /\/api\/ui\/jobs(\?|$)/;

/** Holds the requests `route` matches until `release()`. */
function hold() {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    release,
    handler: async (route: Route) => {
      await released;
      await route.continue();
    },
  };
}

/** Opens the repositories page and waits for its first poll (so the shell is hydrated). */
async function openRepositories(page: Page) {
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/repositories(\?|$)/.test(response.url()) && response.ok(),
  );
  await page.goto("/repositories");
  await firstPoll;
}

test.describe("navigation feedback", () => {
  test("a sidebar link shows as pending while its page loads, then the page shows its skeleton", async ({
    page,
    signIn,
  }) => {
    await signIn("member");
    await openRepositories(page);

    // The Jobs page itself (its server payload) and its data both take a while.
    const pageLoad = hold();
    await page.route(
      (url) => url.pathname === "/jobs" && url.searchParams.has("_rsc"),
      pageLoad.handler,
    );
    const data = hold();
    await page.route(JOBS_API, data.handler);

    const link = page.getByRole("link", { name: "Jobs", exact: true }).first();
    await link.click();
    await expect(link.locator(".link-status[data-pending]")).toBeAttached();

    pageLoad.release();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(link.locator(".link-status[data-pending]")).not.toBeAttached();
    // The page renders at once, with its skeleton while the data loads.
    await expect(page.getByLabel("Loading jobs")).toBeVisible();

    data.release();
    await expect(page.getByLabel("Loading jobs")).not.toBeAttached();
    await expect(page.locator("main table")).toBeVisible();
  });

  test("a failed load shows in place with a retry that loads the page", async ({
    page,
    signIn,
  }) => {
    await signIn("member");
    await openRepositories(page);
    // A 4xx isn't retried in the background, so the error shows at once.
    await page.route(JOBS_API, (route) =>
      route.fulfill({ status: 400, json: { error: "The jobs couldn't be read." } }),
    );
    await page.goto("/jobs");

    const error = page.getByRole("alert").filter({ hasText: "Couldn't load jobs" });
    await expect(error).toContainText("The jobs couldn't be read.");

    await page.unroute(JOBS_API);
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(error).not.toBeAttached();
    await expect(page.locator("main table")).toBeVisible();
  });
});
