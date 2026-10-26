import { eq } from "drizzle-orm";
import { agents } from "@omniralph/db";
import { createEnrollmentToken, enrollAgent, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** The fleet table's row of the agent named `name` (behind the dialog too). */
const fleetRow = (page: Page, name: string) => page.locator("main table tr", { hasText: name });

/** Opens the enrollment dialog, generates a token for `name` and returns it. */
async function generateToken(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Enroll agent" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  // The dialog starts polling the enrollment once it shows the token: wait for the first
  // answer, so the route is compiled (`next dev`) before the agent enrolls.
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/agent-enrollments\/[\w-]+$/.test(response.url()) && response.ok(),
  );
  await dialog.getByRole("button", { name: "Generate token" }).click();
  const token = (await dialog.getByLabel("Token").textContent())?.trim() ?? "";
  expect(token).toMatch(/^ore_/);
  await firstPoll;
  return token;
}

test.describe("agents", () => {
  test("the enrollment dialog shows the agent that enrolled with its token", async ({
    page,
    request,
    signIn,
  }) => {
    await signIn("admin");
    await page.goto("/agents");
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    const name = `e2e-enroll-${Date.now()}`;
    const token = await generateToken(page, name);
    await expect(page.getByText("Waiting for the agent to enroll…")).toBeVisible();

    const { agentId } = await enrollAgent(request, token, "host");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `${name} connected` })).toBeVisible({
      timeout: 5_000,
    });
    await expect(dialog.getByRole("link", { name: `Open ${name}` })).toHaveAttribute(
      "href",
      `/agents/${agentId}`,
    );
    // The list behind the dialog already shows it, without a reload.
    await expect(fleetRow(page, name)).toHaveCount(1, { timeout: 1_000 });
  });

  test("an agent enrolling after the dialog closed appears in the list", async ({
    page,
    request,
    signIn,
  }) => {
    await signIn("admin");
    await page.goto("/agents");
    const name = `e2e-later-${Date.now()}`;
    const token = await generateToken(page, name);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await enrollAgent(request, token, "host");
    await expect(fleetRow(page, name)).toHaveCount(1, { timeout: 5_000 });
  });

  test("a heartbeat flips an agent from offline to online", async ({
    db,
    page,
    request,
    signIn,
  }) => {
    const name = `e2e-heartbeat-${Date.now()}`;
    const { agentId } = await enrollAgent(request, await createEnrollmentToken(db), name);
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(agents.id, agentId));

    await signIn("member");
    await page.goto("/agents");
    const row = fleetRow(page, name);
    await expect(row).toContainText("Offline");

    await db.update(agents).set({ lastHeartbeatAt: new Date() }).where(eq(agents.id, agentId));
    await expect(row).toContainText("Online", { timeout: 5_000 });
    await expect(row).not.toContainText("Offline");
  });
});
