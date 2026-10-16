// `pnpm --filter @omniralph/web e2e`: runs the end-to-end specs (../../e2e/*.spec.ts) against
// the fixture database. Starts the fixture Postgres and `next dev` (../browser/environment.ts,
// shared with verify:screens), bundles the specs with esbuild (workspace packages from source,
// so specs can use `@omniralph/db`), runs `playwright test` on them in the
// mcr.microsoft.com/playwright container, copies the failure artifacts out and stops
// everything. A fake GitLab instance (./fake-gitlab.ts) runs alongside for the specs that
// connect GitLab. See ../../README.md.
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { build } from "esbuild";
import {
  buildWorkspacePackages,
  containerUrl,
  log,
  packageDir,
  playwrightImage,
  runInPlaywrightContainer,
  runMain,
  stageWorkDir,
  startFixturePanel,
  WEB_DIR,
  type Cleanups,
} from "../browser/environment";
import { startFakeGitLab } from "./fake-gitlab";
import { parseE2eOptions, playwrightArgs, USAGE, type E2eOptions } from "./options";

const SPECS_DIR = join(WEB_DIR, "e2e");
/** Provided by the container's `node_modules`; everything else is bundled. */
const EXTERNAL = ["@playwright/test", "playwright", "playwright-core", "pg-native"];

async function main(cleanups: Cleanups): Promise<number> {
  let options: E2eOptions;
  try {
    options = parseE2eOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const work = await stageWorkDir(cleanups, "omniralph-e2e");
  const specs = await bundleSpecs(join(work, "e2e"));
  if (specs === 0) {
    console.error(`No specs in ${relative(process.cwd(), SPECS_DIR)}.`);
    return 2;
  }
  await copyPlaywright(join(work, "node_modules"));

  if (!options.skipBuild) await buildWorkspacePackages();
  const gitlab = await startFakeGitLab();
  cleanups.push(() => gitlab.close());
  const panel = await startFixturePanel(cleanups);

  const outDir = join(WEB_DIR, ".e2e", new Date().toISOString().replace(/[:.]/g, "-"));
  log(`Running ${specs} spec file(s) in ${playwrightImage()}…`);
  const code = await runInPlaywrightContainer({
    cleanups,
    name: "omniralph-e2e",
    work,
    command: [
      "node",
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "e2e/playwright.config.js",
      ...playwrightArgs(options),
    ],
    env: {
      E2E_BASE_URL: panel.browserBaseUrl,
      DATABASE_URL: containerUrl(panel.fixtureEnv.DATABASE_URL!, panel.host),
      ENCRYPTION_KEY: panel.fixtureEnv.ENCRYPTION_KEY!,
      // The panel (on this host) calls it; specs type it into Connect GitLab.
      E2E_FAKE_GITLAB_URL: gitlab.url,
      CI: "1",
    },
    outputs: [{ from: "/work/test-results", to: outDir }],
  });

  if (code === 0) {
    await rm(outDir, { recursive: true, force: true }); // nothing in it but `.last-run.json`
    log("\ne2e: all specs passed.");
  } else {
    log(
      `\ne2e: FAILED (playwright test exited with ${code}). Traces and screenshots of the failed ` +
        `tests: ${relative(process.cwd(), outDir) || "."} (open a trace with ` +
        "`pnpm --filter @omniralph/web exec playwright show-trace <trace.zip>`).",
    );
  }
  return code;
}

/**
 * Bundles each `*.spec.ts` and the config into `outDir` (CommonJS, sources mapped), with the
 * workspace packages from source (`@omniralph/source`). Returns the number of specs. The
 * bundles are built as if next to their sources, so the source maps (and the reported test
 * locations) read `smoke.spec.ts:6`, not a path on the host.
 */
async function bundleSpecs(outDir: string): Promise<number> {
  const specs = (await readdir(SPECS_DIR, { recursive: true }))
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => join(SPECS_DIR, file));
  if (specs.length === 0) return 0;
  const { outputFiles } = await build({
    entryPoints: [join(SPECS_DIR, "playwright.config.ts"), ...specs],
    outbase: SPECS_DIR,
    outdir: SPECS_DIR,
    write: false,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    conditions: ["@omniralph/source"],
    external: EXTERNAL,
    sourcemap: "inline",
    tsconfig: join(WEB_DIR, "tsconfig.json"),
    logLevel: "warning",
    // ESM sources (`@omniralph/db` resolves its migrations folder from `import.meta.url`).
    define: { "import.meta.url": "__importMetaUrl" },
    banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  });
  for (const file of outputFiles) {
    const path = join(outDir, relative(SPECS_DIR, file.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
  }
  return specs.length;
}

/** `@playwright/test` and its `playwright` and `playwright-core` (no other dependencies). */
async function copyPlaywright(nodeModules: string): Promise<void> {
  const testDir = packageDir("@playwright/test");
  const playwrightDir = dirname(require.resolve("playwright/package.json", { paths: [testDir] }));
  for (const [name, dir] of [
    ["@playwright/test", testDir],
    ["playwright", playwrightDir],
    ["playwright-core", packageDir("playwright-core")],
  ] as const) {
    await cp(dir, join(nodeModules, name), {
      recursive: true,
      dereference: true,
      // pnpm links each package's own dependencies under it; they're copied flat instead.
      filter: (source) => !relative(dir, source).startsWith("node_modules"),
    });
  }
  // The specs are CommonJS bundles.
  await writeFile(join(nodeModules, "..", "package.json"), JSON.stringify({ private: true }));
}

runMain(main);
