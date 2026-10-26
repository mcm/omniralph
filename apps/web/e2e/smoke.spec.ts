import { eq } from "drizzle-orm";
import { agents } from "@omniralph/db";
import { createEnrollmentToken, enrollAgent, expect, FIXTURE_IDS, test } from "./fixtures";

test.describe("smoke", () => {
  test("an admin signs in and opens the repos", async ({ page, signIn }) => {
    await signIn("admin");
    await page.goto("/repos");
    await expect(page.getByRole("heading", { level: 1, name: "Repos" })).toBeVisible();
  });

  test("a member signs in and opens the repos", async ({ page, signIn }) => {
    await signIn("member");
    await page.goto("/repos");
    await expect(page.getByRole("heading", { level: 1, name: "Repos" })).toBeVisible();
  });

  test("an agent enrolls through the API with a token from the database", async ({
    db,
    request,
  }) => {
    const token = await createEnrollmentToken(db);
    const name = `e2e-smoke-${Date.now()}`;
    const { agentId } = await enrollAgent(request, token, name);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toMatchObject({ name, organizationId: FIXTURE_IDS.organizations.main });
  });
});
