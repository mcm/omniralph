import { eq } from "drizzle-orm";
import { harnesses } from "@omniralph/db";
import { createEnrollmentToken, enrollHarness, expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/** The fleet table's row of the harness named `name` (behind the dialog too). */
const fleetRow = (page: Page, name: string) => page.locator("main table tr", { hasText: name });

/** Opens the enrollment dialog, generates a token for `name` and returns it. */
async function generateToken(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "Enroll harness" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  // The dialog starts polling the enrollment once it shows the token: wait for the first
  // answer, so the route is compiled (`next dev`) before the harness enrolls.
  const firstPoll = page.waitForResponse(
    (response) => /\/api\/ui\/harness-enrollments\/[\w-]+$/.test(response.url()) && response.ok(),
  );
  await dialog.getByRole("button", { name: "Generate token" }).click();
  const token = (await dialog.getByLabel("Token").textContent())?.trim() ?? "";
  expect(token).toMatch(/^ore_/);
  await firstPoll;
  return token;
}

test.describe("harnesses", () => {
  test("the enrollment dialog shows the harness that enrolled with its token", async ({
    page,
    request,
    signIn,
  }) => {
    await signIn("admin");
    await page.goto("/harnesses");
    await expect(page.getByRole("heading", { level: 1, name: "Harnesses" })).toBeVisible();
    const name = `e2e-enroll-${Date.now()}`;
    const token = await generateToken(page, name);
    await expect(page.getByText("Waiting for the harness to enroll…")).toBeVisible();

    const { harnessId } = await enrollHarness(request, token, "host");

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `${name} connected` })).toBeVisible({
      timeout: 5_000,
    });
    await expect(dialog.getByRole("link", { name: `Open ${name}` })).toHaveAttribute(
      "href",
      `/harnesses/${harnessId}`,
    );
    // The list behind the dialog already shows it, without a reload.
    await expect(fleetRow(page, name)).toHaveCount(1, { timeout: 1_000 });
  });

  test("a harness enrolling after the dialog closed appears in the list", async ({
    page,
    request,
    signIn,
  }) => {
    await signIn("admin");
    await page.goto("/harnesses");
    const name = `e2e-later-${Date.now()}`;
    const token = await generateToken(page, name);
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await enrollHarness(request, token, "host");
    await expect(fleetRow(page, name)).toHaveCount(1, { timeout: 5_000 });
  });

  test("a heartbeat flips a harness from offline to online", async ({
    db,
    page,
    request,
    signIn,
  }) => {
    const name = `e2e-heartbeat-${Date.now()}`;
    const { harnessId } = await enrollHarness(request, await createEnrollmentToken(db), name);
    await db
      .update(harnesses)
      .set({ lastHeartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(harnesses.id, harnessId));

    await signIn("member");
    await page.goto("/harnesses");
    const row = fleetRow(page, name);
    await expect(row).toContainText("Offline");

    await db
      .update(harnesses)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(harnesses.id, harnessId));
    await expect(row).toContainText("Online", { timeout: 5_000 });
    await expect(row).not.toContainText("Offline");
  });
});
