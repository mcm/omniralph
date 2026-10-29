import { closeDb, createDb, runMigrations } from "@omniralph/db";
import { startFixtureDatabase } from "./container";
import { FIXTURE_AUTH_SECRET, FIXTURE_ENCRYPTION_KEY, seedFixtures } from "./seed";

/**
 * Starts the fixture Postgres (or reuses the running one), migrates it and
 * reseeds it. Returns the environment to run the panel against it.
 */
export async function startFixtures(): Promise<Record<string, string>> {
  const container = await startFixtureDatabase();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const db = createDb(url);
  try {
    await seedFixtures(db);
  } finally {
    await closeDb(db);
  }
  return {
    DATABASE_URL: url,
    ENCRYPTION_KEY: FIXTURE_ENCRYPTION_KEY,
    AUTH_SECRET: FIXTURE_AUTH_SECRET,
    OMNIRALPH_DEV_SIGNIN: "1",
    // Linear settings pickers read the fixture workspace (`lib/linear/fixture-gateway.ts`).
    OMNIRALPH_FIXTURE_LINEAR: "1",
    // Story diffs and the add-repo picker's list of fixture connections come from the fixture
    // code host (`lib/scm/fixture-diff.ts`, `lib/scm/fixture-repositories.ts`).
    OMNIRALPH_FIXTURE_SCM: "1",
  };
}
