import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";

/** Labels the fixture database's container, so `fixtures:down` finds it. */
const FIXTURE_LABEL = "dev.omniralph.fixtures";
const IMAGE = "postgres:17-alpine";

/**
 * Starts the fixture database, or returns the running one. A reused container
 * isn't tied to this process (no Ryuk session label), so it outlives it.
 */
export function startFixtureDatabase(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGE)
    .withDatabase("omniralph_fixtures")
    .withUsername("fixtures")
    .withPassword("fixtures")
    .withLabels({ [FIXTURE_LABEL]: "web" })
    .withReuse()
    .start();
}

/** Stops and removes every fixture database container; returns how many there were. */
export async function removeFixtureDatabases(): Promise<number> {
  const client = await getContainerRuntimeClient();
  let removed = 0;
  for (;;) {
    const container = await client.container.fetchByLabel(FIXTURE_LABEL, "web", {
      status: ["created", "restarting", "running", "paused", "exited"],
    });
    if (!container) return removed;
    await client.container.stop(container);
    await client.container.remove(container, { removeVolumes: true });
    removed++;
  }
}
