import type { Page, Route } from "@playwright/test";
import { expect, test } from "./fixtures";

const AGENTS_API = /\/api\/ui\/agents(\?|$)/;

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

/** Opens the Repos page and waits for its repo list (so the shell is hydrated). */
async function openRepos(page: Page) {
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/repositories(\?|$)/.test(response.url()) && response.ok(),
  );
  await page.goto("/repos");
  await firstPoll;
}

test.describe("navigation feedback", () => {
  test("a sidebar link shows as pending while its page loads, then the page shows its skeleton", async ({
    page,
    signIn,
  }) => {
    await signIn("member");
    await openRepos(page);

    // The Agents page itself (its server payload) and its data both take a while.
    const pageLoad = hold();
    await page.route(
      (url) => url.pathname === "/agents" && url.searchParams.has("_rsc"),
      pageLoad.handler,
    );
    const data = hold();
    await page.route(AGENTS_API, data.handler);

    const link = page.getByRole("link", { name: "Agents", exact: true }).first();
    await link.click();
    await expect(link.locator(".link-status[data-pending]")).toBeAttached();

    pageLoad.release();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(link.locator(".link-status[data-pending]")).not.toBeAttached();
    // The page renders at once, with its skeleton while the data loads.
    await expect(page.getByLabel("Loading agents")).toBeVisible();

    data.release();
    await expect(page.getByLabel("Loading agents")).not.toBeAttached();
    await expect(page.locator("main table")).toBeVisible();
  });

  test("a failed load shows in place with a retry that loads the page", async ({
    page,
    signIn,
  }) => {
    await signIn("member");
    await openRepos(page);
    // A 4xx isn't retried in the background, so the error shows at once.
    await page.route(AGENTS_API, (route) =>
      route.fulfill({ status: 400, json: { error: "The agents couldn't be read." } }),
    );
    await page.goto("/agents");

    const error = page.getByRole("alert").filter({ hasText: "Couldn't load agents" });
    await expect(error).toContainText("The agents couldn't be read.");

    await page.unroute(AGENTS_API);
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(error).not.toBeAttached();
    await expect(page.locator("main table")).toBeVisible();
  });
});
