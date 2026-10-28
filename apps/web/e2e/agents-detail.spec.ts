import { eq } from "drizzle-orm";
import { agents, type Database } from "@omniralph/db";
import { createEnrollmentToken, enrollAgent, expect, test } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";

/** An agent of the fixture organization under pm2, as if it heartbeat just now. */
async function liveAgent(db: Database, request: APIRequestContext, prefix: string) {
  const name = `${prefix}-${Date.now()}`;
  const { agentId } = await enrollAgent(request, await createEnrollmentToken(db), name);
  await db
    .update(agents)
    .set({
      selfUpdate: "supported",
      reportedVersion: "1.0.0",
      lastHeartbeatAt: new Date(),
    })
    .where(eq(agents.id, agentId));
  return { agentId, name };
}

/** Opens an agent tab and waits for its first poll, so `next dev` has compiled the route. */
async function open(page: Page, path: string) {
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/agents\/[\w-]+(\?|$)/.test(response.url()) && response.ok(),
  );
  await page.goto(path);
  await firstPoll;
}

test.describe("agent detail", () => {
  test("deleting goes back to an agent list without the agent", async ({
    db,
    page,
    request,
    signIn,
  }) => {
    const { agentId, name } = await liveAgent(db, request, "e2e-delete");
    await signIn("admin");
    await open(page, `/agents/${agentId}`);
    await page.getByRole("button", { name: "Delete agent" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();

    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    await expect(page.locator("main table tr", { hasText: name })).toHaveCount(0);
  });
});
