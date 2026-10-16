// `pnpm --filter @omniralph/web verify:screens`: screenshots every panel route against the
// fixture database. Starts the fixture Postgres and `next dev`, runs Playwright in the
// mcr.microsoft.com/playwright container (`--network host`, opening `host.docker.internal`
// on Docker Desktop; files in and out with `docker cp`, no bind mounts, so a remote Docker
// daemon works), runs `impeccable detect` on each captured page when the CLI is available,
// and stops everything. See ../../README.md.
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  buildWorkspacePackages,
  log,
  packageDir,
  playwrightImage,
  run,
  runInPlaywrightContainer,
  runMain,
  stageWorkDir,
  startFixturePanel,
  WEB_DIR,
  type Cleanups,
} from "../browser/environment";
import { FIXTURE_EMAILS } from "../fixtures/ids";
import { parseScreensOptions, USAGE, VIEWPORTS, type ScreensOptions } from "./options";
import { routeMatches, SCREEN_ROUTES } from "./routes";

/** A row of the capture script's `results.json`. */
interface CaptureResult {
  route: string;
  path: string;
  viewport: string;
  width: number;
  theme: string;
  status: number | null;
  finalPath: string | null;
  scrollWidth: number | null;
  overflow: boolean;
  /** The visible text around each "Ralph" on the page (none expected). */
  retiredWording: string[];
  consoleErrors: string[];
  /** Why the page never showed its content (still loading, or its error boundary). */
  notRendered: string | null;
  /** The in-place errors on the page (failed loads), e.g. a code host the fixtures can't reach. */
  loadErrors: string[];
  error: string | null;
  screenshot: string | null;
  html: string | null;
}

async function main(cleanups: Cleanups): Promise<number> {
  let options: ScreensOptions;
  try {
    options = parseScreensOptions(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const routes = SCREEN_ROUTES.filter(
    (route) => options.routes === null || routeMatches(route, options.routes),
  );
  if (routes.length === 0) {
    console.error(`No route matches --routes ${options.routes}.`);
    return 2;
  }

  const image = playwrightImage();
  const outDir = join(WEB_DIR, ".screens", new Date().toISOString().replace(/[:.]/g, "-"));

  if (!options.skipBuild) await buildWorkspacePackages();
  const panel = await startFixturePanel(cleanups);

  log(
    `Capturing ${routes.length} route(s) × ${options.viewports.length} viewport(s) × ${options.themes.length} theme(s) in ${image}…`,
  );
  await capture({
    cleanups,
    outDir,
    config: {
      baseUrl: panel.browserBaseUrl,
      signInPath: `/sign-in/dev?email=${encodeURIComponent(FIXTURE_EMAILS.admin)}&callbackUrl=/`,
      routes: routes.map(({ name, path, auth, steps, viewportOnly }) => ({
        name,
        path,
        auth,
        steps,
        viewportOnly,
      })),
      themes: options.themes,
      viewports: Object.fromEntries(options.viewports.map((name) => [name, VIEWPORTS[name]])),
      outDir: "/work/out",
    },
  });

  const results = JSON.parse(
    await readFile(join(outDir, "results.json"), "utf8"),
  ) as CaptureResult[];
  await detect(outDir, results);
  return report(outDir, results, options.strict);
}

/**
 * Runs capture.mjs in the Playwright container: the script, its config and
 * playwright-core go in with `docker cp`, the screenshots come out the same way.
 */
async function capture({
  cleanups,
  outDir,
  config,
}: {
  cleanups: Cleanups;
  outDir: string;
  config: Record<string, unknown>;
}): Promise<void> {
  const work = await stageWorkDir(cleanups, "omniralph-screens");
  await cp(join(__dirname, "capture.mjs"), join(work, "capture.mjs"));
  await cp(packageDir("playwright-core"), join(work, "node_modules", "playwright-core"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(work, "config.json"), JSON.stringify(config));
  const code = await runInPlaywrightContainer({
    cleanups,
    name: "omniralph-screens",
    work,
    command: ["node", "/work/capture.mjs", "/work/config.json"],
    outputs: [{ from: "/work/out", to: outDir }],
  });
  if (code !== 0) throw new Error(`capture.mjs exited with ${code}`);
}

/** The impeccable CLI: `$IMPECCABLE_CLI`, `impeccable` on PATH, or the Claude plugin's launcher. */
async function findImpeccable(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.IMPECCABLE_CLI) candidates.push(process.env.IMPECCABLE_CLI);
  candidates.push("impeccable");
  candidates.push(...(await findPluginLaunchers(join(homedir(), ".claude", "plugins"))));
  for (const candidate of candidates) {
    try {
      await run(candidate, ["detect", "--help"], { timeout: 60_000 });
      return candidate;
    } catch {
      // not this one
    }
  }
  return null;
}

/** `<plugin>/skills/impeccable/scripts/impeccable` under the Claude plugins directory. */
async function findPluginLaunchers(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (path.endsWith(join("skills", "impeccable", "scripts"))) {
        found.push(join(path, "impeccable"));
      } else {
        found.push(...(await findPluginLaunchers(path, depth + 1)));
      }
    }
  }
  return found;
}

/** Runs `impeccable detect --json` on each HTML snapshot, into `<screen>.impeccable.json`. */
async function detect(outDir: string, results: CaptureResult[]): Promise<void> {
  const cli = await findImpeccable();
  if (!cli) {
    log(
      "impeccable CLI not found (set IMPECCABLE_CLI or put `impeccable` on PATH): skipping detect.",
    );
    return;
  }
  log(`Running impeccable detect (${cli})…`);
  for (const result of results) {
    if (!result.html) continue;
    const htmlPath = join(outDir, result.html);
    const findingsPath = htmlPath.replace(/\.html$/, ".impeccable.json");
    // Exit 2 means findings; only 1 (or a crash) is a failed scan.
    const { stdout, failure } = await run(cli, ["detect", "--json", htmlPath], {
      cwd: WEB_DIR,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    }).then(
      ({ stdout }) => ({ stdout, failure: null }),
      (error: Error & { code?: number; stdout?: string; stderr?: string }) =>
        error.code === 2
          ? { stdout: error.stdout ?? "[]", failure: null }
          : { stdout: "", failure: error.stderr || error.message },
    );
    await writeFile(findingsPath, failure ? JSON.stringify({ error: failure }, null, 2) : stdout);
  }
}

/** Prints the screenshots (stdout) and a summary (stderr); returns the exit code. */
async function report(outDir: string, results: CaptureResult[], strict: boolean): Promise<number> {
  const summary: string[] = [];
  const failed = results.filter((r) => r.error);
  const overflowing = results.filter((r) => r.overflow);
  const retired = results.filter((r) => r.retiredWording.length > 0);
  const serverErrors = results.filter((r) => r.status !== null && r.status >= 500);
  const redirected = results.filter((r) => r.finalPath && r.finalPath !== r.path);
  const notRendered = results.filter((r) => r.notRendered);
  const loadErrors = results.filter((r) => r.loadErrors.length > 0);

  for (const result of results) {
    if (result.screenshot) console.log(join(outDir, result.screenshot));
  }
  summary.push(
    `\n${results.length - failed.length}/${results.length} screenshots in ${relative(process.cwd(), outDir) || "."}`,
  );
  if (overflowing.length > 0) {
    summary.push(`\nWider than the viewport (scrollWidth > viewport width):`);
    for (const r of overflowing) {
      summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.scrollWidth}px > ${r.width}px`);
    }
  } else {
    summary.push("No route is wider than its viewport.");
  }
  if (retired.length > 0) {
    summary.push(`\nShows "Ralph" (say "Coding" instead):`);
    for (const r of retired) {
      for (const text of r.retiredWording) {
        summary.push(`  ${r.route} ${r.viewport} ${r.theme}: …${text}…`);
      }
    }
  } else {
    summary.push('No route shows "Ralph".');
  }
  if (serverErrors.length > 0) {
    summary.push(`\nServer errors:`);
    for (const r of serverErrors)
      summary.push(`  ${r.route} ${r.viewport} ${r.theme}: HTTP ${r.status}`);
  }
  if (redirected.length > 0) {
    summary.push(`\nRedirected:`);
    for (const r of redirected)
      summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.path} → ${r.finalPath}`);
  }
  if (notRendered.length > 0) {
    summary.push(`\nNot rendered:`);
    for (const r of notRendered)
      summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.notRendered}`);
  } else {
    summary.push("Every route rendered its content.");
  }
  if (loadErrors.length > 0) {
    summary.push(`\nShows a load error:`);
    for (const r of loadErrors) {
      for (const text of r.loadErrors)
        summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${text}`);
    }
  }
  if (failed.length > 0) {
    summary.push(`\nFailed captures:`);
    for (const r of failed) summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.error}`);
  }
  summary.push(`Details: ${join(outDir, "results.json")}`);
  log(summary.join("\n"));

  if (failed.length > 0 || retired.length > 0 || notRendered.length > 0) return 1;
  if (strict && overflowing.length > 0) return 1;
  return 0;
}

runMain(main);
