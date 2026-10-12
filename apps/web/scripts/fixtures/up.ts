// `pnpm --filter @omniralph/web fixtures:up`: starts the fixture Postgres (or reuses the
// running one), migrates it, reseeds it and prints the environment to run the panel against
// it. The variables go to stdout (`KEY=value` lines), everything else to stderr.
import { closeDb, createDb, runMigrations } from "@omniralph/db";
import { startFixtureDatabase } from "./container";
import { FIXTURE_EMAILS } from "./ids";
import { FIXTURE_AUTH_SECRET, FIXTURE_ENCRYPTION_KEY, seedFixtures } from "./seed";

// The app package is CommonJS to tsx, so no top-level await.
async function main() {
  const container = await startFixtureDatabase();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const db = createDb(url);
  try {
    await seedFixtures(db);
  } finally {
    await closeDb(db);
  }

  const env = {
    DATABASE_URL: url,
    ENCRYPTION_KEY: FIXTURE_ENCRYPTION_KEY,
    AUTH_SECRET: FIXTURE_AUTH_SECRET,
    OMNIRALPH_DEV_SIGNIN: "1",
  };
  console.error("Fixture database is up and seeded. Run the panel with:");
  for (const [name, value] of Object.entries(env)) console.log(`${name}=${value}`);
  console.error(
    `\nthen sign in at /sign-in/dev?email=${FIXTURE_EMAILS.admin} (admin) or ${FIXTURE_EMAILS.member} (member).` +
      "\nTear it down with `pnpm --filter @omniralph/web fixtures:down`.",
  );
}

// Exit explicitly: Testcontainers keeps a Docker client open (the container keeps running).
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
