import { eq } from "drizzle-orm";
import { harnesses } from "@omniralph/db";
import { createEnrollmentToken, enrollHarness, expect, FIXTURE_IDS, test } from "./fixtures";

test.describe("smoke", () => {
  test("an admin signs in and opens the repositories", async ({ page, signIn }) => {
    await signIn("admin");
    await page.goto("/repositories");
    await expect(page.getByRole("heading", { level: 1, name: "Repositories" })).toBeVisible();
  });

  test("a member signs in and opens the repositories", async ({ page, signIn }) => {
    await signIn("member");
    await page.goto("/repositories");
    await expect(page.getByRole("heading", { level: 1, name: "Repositories" })).toBeVisible();
  });

  test("a harness enrolls through the API with a token from the database", async ({
    db,
    request,
  }) => {
    const token = await createEnrollmentToken(db);
    const name = `e2e-smoke-${Date.now()}`;
    const { harnessId } = await enrollHarness(request, token, name);

    const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
    expect(row).toMatchObject({ name, organizationId: FIXTURE_IDS.organizations.main });
  });
});
