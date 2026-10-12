// `pnpm --filter @omniralph/web fixtures:down`: stops and removes the fixture Postgres.
import { removeFixtureDatabases } from "./container";

// The app package is CommonJS to tsx, so no top-level await.
async function main() {
  const removed = await removeFixtureDatabases();
  console.error(removed ? "Fixture database removed." : "No fixture database was running.");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
