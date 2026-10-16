// What the specs import instead of `@playwright/test`: its `test` with the fixture database
// (`db`) and the dev sign-in (`signIn`), plus helpers that play a harness, a webhook or a cron.
import { test as base, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { closeDb, createDb, createHarnessEnrollment, type Database } from "@omniralph/db";
import { FIXTURE_EMAILS, FIXTURE_IDS } from "../scripts/fixtures/ids";

export { expect } from "@playwright/test";
export { FIXTURE_EMAILS, FIXTURE_IDS };

/** A fixture user (`FIXTURE_EMAILS`): `admin` or `member`. */
export type FixtureUser = keyof typeof FIXTURE_EMAILS;

/**
 * Signs `context` in as a fixture user with the dev sign-in. Its pages and `context.request`
 * (the panel's `/api/ui/*`) then share the session cookie.
 */
export async function signIn(context: BrowserContext, user: FixtureUser): Promise<void> {
  const response = await context.request.get(
    `/sign-in/dev?email=${encodeURIComponent(FIXTURE_EMAILS[user])}&callbackUrl=/`,
    { maxRedirects: 0 },
  );
  if (response.status() !== 307 && response.status() !== 302) {
    throw new Error(
      `dev sign-in as ${user} failed: HTTP ${response.status()} ${await response.text()}`,
    );
  }
}

/** Creates a one-time enrollment token, as the enrollment dialog does. */
export async function createEnrollmentToken(
  db: Database,
  organizationId: string = FIXTURE_IDS.organizations.main,
): Promise<string> {
  const { token } = await createHarnessEnrollment(db, { organizationId });
  return token;
}

/**
 * Enrolls a harness with `token` through `POST /api/harness/enroll`, as a harness on another
 * machine does. Returns its id and refresh token.
 */
export async function enrollHarness(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ harnessId: string; refreshToken: string }> {
  const response = await request.post("/api/harness/enroll", {
    data: { enrollmentToken: token, name, version: "0.0.0-e2e" },
  });
  if (!response.ok()) {
    throw new Error(`enroll failed: HTTP ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as { harnessId: string; refreshToken: string };
}

export const test = base.extend<
  {
    /** Signs the test's browser context (`page`, `context.request`) in as a fixture user. */
    signIn: (user?: FixtureUser) => Promise<void>;
  },
  {
    /** The fixture database (`@omniralph/db`), to read and write rows directly. */
    db: Database;
  }
>({
  // `provide` rather than Playwright's usual `use`, which the React hooks lint takes for a hook.
  signIn: async ({ context }, provide) => {
    await provide((user = "admin") => signIn(context, user));
  },
  db: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures destructure their dependencies.
    async ({}, provide) => {
      const db = createDb(process.env.DATABASE_URL);
      await provide(db);
      await closeDb(db);
    },
    { scope: "worker" },
  ],
});
