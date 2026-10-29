// `pnpm --filter @omniralph/web verify:screens`: screenshots every panel route against the
// fixture database, and every screen of the agent's local page in its fixture mode
// (`apps/agent/scripts/ui-fixture`). Starts the fixture Postgres and `next dev` (and the agent
// page's fixture server), runs Playwright in the
// mcr.microsoft.com/playwright container (`--network host`, opening `host.docker.internal`
// on Docker Desktop; files in and out with `docker cp`, no bind mounts, so a remote Docker
// daemon works), runs `impeccable detect` on each captured page when the CLI is available,
// and stops everything. See ../../README.md.
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  buildAgentPage,
  buildWorkspacePackages,
  dockerBrowserHost,
  log,
  packageDir,
  playwrightImage,
  REPO_ROOT,
  run,
  runInPlaywrightContainer,
  runMain,
  stageWorkDir,
  startAgentPageFixture,
  startFixturePanel,
  WEB_DIR,
  type AgentScreenRoute,
  type Cleanups,
} from "../browser/environment";
import { ORGANIZATION_COOKIE } from "../../src/lib/auth/routes";
import { FIXTURE_EMAILS } from "../fixtures/ids";
import {
  accessibilityFindings,
  captureFailures,
  showsShortcutIndicators,
  type CaptureResult,
} from "./checks";
import {
  ACCESSIBILITY_CHECKS,
  ignoredBy,
  parseIgnoreList,
  type AccessibilityCheck,
  type AccessibilityIgnoreEntry,
} from "./ignore";
import {
  parseScreensOptions,
  USAGE,
  VIEWPORTS,
  type ScreensOptions,
  type ViewportName,
} from "./options";
import { capturedAt, routeMatches, SCREEN_ROUTES, type ScreenRoute } from "./routes";

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
  const selected = (route: Pick<ScreenRoute, "name" | "path" | "viewports">) =>
    (options.routes === null || routeMatches(route, options.routes)) &&
    options.viewports.some((viewport) => capturedAt(route, viewport));
  const routes = options.surfaces.includes("panel") ? SCREEN_ROUTES.filter(selected) : [];

  const image = playwrightImage();
  const outDir = join(WEB_DIR, ".screens", new Date().toISOString().replace(/[:.]/g, "-"));

  // The agent page first: its routes come from its fixture server, and it starts in seconds.
  let agent: Awaited<ReturnType<typeof startAgentPageFixture>> | null = null;
  let agentRoutes: AgentScreenRoute[] = [];
  if (options.surfaces.includes("agent")) {
    if (!options.skipBuild) await buildAgentPage();
    agent = await startAgentPageFixture(cleanups, await dockerBrowserHost());
    agentRoutes = agent.routes.filter((route) =>
      selected({ ...route, viewports: route.viewports as ViewportName[] | undefined }),
    );
  }
  if (routes.length + agentRoutes.length === 0) {
    console.error(`No route matches --routes ${options.routes}.`);
    return 2;
  }

  let panelUrl: string | null = null;
  if (routes.length > 0) {
    if (!options.skipBuild) await buildWorkspacePackages();
    panelUrl = (await startFixturePanel(cleanups)).browserBaseUrl;
  }

  log(
    `Capturing ${routes.length + agentRoutes.length} route(s) × ${options.viewports.length} viewport(s) × ${options.themes.length} theme(s) in ${image}…`,
  );
  await capture({
    cleanups,
    outDir,
    config: {
      baseUrl: panelUrl,
      signInPaths: {
        admin: devSignInPath(FIXTURE_EMAILS.admin),
        member: devSignInPath(FIXTURE_EMAILS.member),
      },
      organizationCookie: ORGANIZATION_COOKIE,
      agent: agent && { baseUrl: agent.browserBaseUrl, signInPath: agent.signInPath },
      routes: [
        ...routes.map(
          ({ name, path, auth, steps, viewportOnly, as, organization, viewports, waitFor }) => ({
            name,
            path,
            surface: "panel",
            auth,
            steps,
            viewportOnly,
            as,
            organization,
            viewports,
            waitFor,
          }),
        ),
        ...agentRoutes.map(({ name, path, steps, viewportOnly, viewports, waitFor }) => ({
          name,
          path,
          surface: "agent",
          auth: "signed-in",
          steps,
          viewportOnly,
          viewports,
          waitFor,
        })),
      ],
      themes: options.themes,
      viewports: Object.fromEntries(options.viewports.map((name) => [name, VIEWPORTS[name]])),
      outDir: "/work/out",
    },
  });

  const results = JSON.parse(
    await readFile(join(outDir, "results.json"), "utf8"),
  ) as CaptureResult[];
  await detect(outDir, results);
  const ignore = parseIgnoreList(await readFile(IGNORE_LIST, "utf8"));
  return report(outDir, results, [...routes, ...agentRoutes], options.strict, ignore);
}

/** The critique ignore list: its accessibility entries are scoped exceptions to `--strict`. */
const IGNORE_LIST = join(REPO_ROOT, ".impeccable", "critique", "ignore.md");

function devSignInPath(email: string): string {
  return `/sign-in/dev?email=${encodeURIComponent(email)}&callbackUrl=/`;
}

/**
 * Runs capture.mjs in the Playwright container: the scripts, their config, playwright-core
 * and axe-core go in with `docker cp`, the screenshots and reports come out the same way.
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
  for (const script of ["capture.mjs", "a11y-page.mjs"]) {
    await cp(join(__dirname, script), join(work, script));
  }
  for (const name of ["playwright-core", "axe-core"]) {
    await cp(packageDir(name), join(work, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }
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
async function report(
  outDir: string,
  results: CaptureResult[],
  routes: readonly Pick<ScreenRoute, "name" | "page">[],
  strict: boolean,
  ignore: { entries: AccessibilityIgnoreEntry[]; problems: string[] },
): Promise<number> {
  const summary: string[] = [];
  const routeOf = new Map(routes.map((route) => [route.name, route]));
  const failed = results.filter((r) => r.error);
  const overflowing = results.filter((r) => r.overflow);
  const shortcutIndicators = results.filter((r) =>
    showsShortcutIndicators(r, routeOf.get(r.route)),
  );
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
  if (shortcutIndicators.length > 0) {
    summary.push(
      `\nShows keyboard-shortcut indicators (rule 7: only the panel's Help page lists keys):`,
    );
    for (const r of shortcutIndicators) {
      summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.kbdCount} visible kbd`);
    }
  } else {
    summary.push("No route outside Help shows a keyboard-shortcut indicator.");
  }
  if (retired.length > 0) {
    summary.push(`\nShows "Ralph" or "harness" (say "Om" for the AI, "agent" for the machine):`);
    for (const r of retired) {
      for (const text of r.retiredWording) {
        summary.push(`  ${r.route} ${r.viewport} ${r.theme}: …${text}…`);
      }
    }
  } else {
    summary.push('No route shows "Ralph" or "harness".');
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
  summary.push(...accessibilityReport(results, ignore.entries));
  if (ignore.problems.length > 0) {
    summary.push(
      `\nIgnore list entries that ignore nothing (${relative(process.cwd(), IGNORE_LIST)}):`,
    );
    for (const problem of ignore.problems) summary.push(`  ${problem}`);
  }
  if (failed.length > 0) {
    summary.push(`\nFailed captures:`);
    for (const r of failed) summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.error}`);
  }
  summary.push(`Details: ${join(outDir, "results.json")}`);
  log(summary.join("\n"));

  const failing = results.filter(
    (r) => captureFailures(r, routeOf.get(r.route), { strict, ignore: ignore.entries }).length > 0,
  );
  return failing.length > 0 ? 1 : 0;
}

const CHECK_TITLES: Record<AccessibilityCheck, string> = {
  axe: "axe-core (WCAG 2.2 A and AA)",
  keyboard: "Keyboard walk (Tab from the top of the page)",
  escape: "Escape (overlays the steps opened)",
  landmarks: "Landmarks (one main, an h1, named navigation links at rail)",
};

/**
 * A section per accessibility check: each finding (rule, target, summary) with the captures
 * (route, viewport, theme) it was seen on, then how many ignore.md entries matched.
 */
function accessibilityReport(
  results: CaptureResult[],
  entries: readonly AccessibilityIgnoreEntry[],
): string[] {
  const lines: string[] = [];
  const errors = results.flatMap((r) =>
    r.checkErrors.map((error) => `  ${r.route} ${r.viewport} ${r.theme}: ${error}`),
  );
  if (errors.length > 0) lines.push(`\nAccessibility checks that couldn't run:`, ...errors);
  for (const check of ACCESSIBILITY_CHECKS) {
    const seen = new Map<string, string[]>();
    const ignored = new Map<string, number>();
    for (const result of results) {
      for (const finding of accessibilityFindings(result)) {
        if (finding.check !== check) continue;
        const entry = ignoredBy(entries, check, finding, result);
        if (entry) {
          ignored.set(entry.text, (ignored.get(entry.text) ?? 0) + 1);
          continue;
        }
        const key = [
          finding.rule,
          finding.impact ? `(${finding.impact})` : null,
          finding.target,
          `— ${finding.summary}`,
        ]
          .filter(Boolean)
          .join(" ");
        const where = seen.get(key) ?? [];
        where.push(`${result.route} ${result.viewport} ${result.theme}`);
        seen.set(key, where);
      }
    }
    if (seen.size === 0) {
      lines.push(`${CHECK_TITLES[check]}: no findings.`);
    } else {
      lines.push(`\n${CHECK_TITLES[check]}: ${seen.size} finding(s)`);
      for (const [key, where] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`  ${key}`, `    on ${where.join(", ")}`);
      }
    }
    for (const [text, count] of ignored) {
      lines.push(`  ${count} ignored by ignore.md: ${text}`);
    }
  }
  return lines;
}

runMain(main);
