/**
 * Serves the agent page in fixture mode (`fixture.ts`) until SIGINT or SIGTERM:
 *
 *   OMNIRALPH_AGENT_UI_FIXTURE=1 pnpm --filter @omniralph/agent exec \
 *     tsx --conditions=@omniralph/source scripts/ui-fixture/serve.ts [--port <n>] [--allowed-host <name>]
 *
 * (no package script: the published package.json must not name it).
 * Needs the built page (`pnpm --filter @omniralph/agent build:ui`). Prints one JSON line on
 * stdout, `{ url, link, routes }` (`link` signs a browser in, `routes` are the screens
 * `verify:screens` captures), and logs to stderr.
 */
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startAgentUiFixture } from "./fixture.js";
import { AGENT_SCREEN_ROUTES } from "./routes.js";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    "allowed-host": { type: "string", multiple: true },
  },
});

try {
  const fixture = await startAgentUiFixture({
    env: process.env,
    bundleDir: fileURLToPath(new URL("../../dist/ui/", import.meta.url)),
    port: values.port === undefined ? 0 : Number(values.port),
    allowedHosts: values["allowed-host"] ?? [],
  });
  process.stdout.write(
    `${JSON.stringify({ url: fixture.server.url, link: fixture.link, routes: AGENT_SCREEN_ROUTES })}\n`,
  );
  const stop = () => void fixture.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
