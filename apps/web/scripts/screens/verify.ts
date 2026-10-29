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
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "../../src/lib/auth/routes";
import { FIXTURE_EMAILS, FIXTURE_METADATA_NAMES } from "../fixtures/ids";
import {
  accessibilityFindings,
  captureFailures,
  unexpectedLoadFailures,
  unignoredDetectFindings,
  DECIDED_CHECK_TITLES,
  DECIDED_CHECKS,
  decidedFindings,
  decidedOptions,
  type CaptureResult,
} from "./checks";
import {
  ACCESSIBILITY_CHECKS,
  detectIgnoredBy,
  ignoredBy,
  parseIgnoreList,
  type AccessibilityCheck,
  type AccessibilityIgnoreEntry,
  type DetectFinding,
  type ParsedIgnoreList,
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
      organizationScopeCookie: ORGANIZATION_SCOPE_COOKIE,
      agent: agent && { baseUrl: agent.browserBaseUrl, signInPath: agent.signInPath },
      routes: [
        ...routes.map((route) => {
          const { name, path, auth, steps, viewportOnly, as, organization, viewports, waitFor } =
            route;
          return {
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
            detail: route.detail,
            org: route.org,
            // The Decided checks' options (decided-page.mjs). Signed out, there's no
            // organization scope; signed in, it's "All organizations" or one.
            decided: decidedOptions(route, {
              names: Object.values(FIXTURE_METADATA_NAMES).flat(),
              org: auth === "signed-out" ? null : route.org === "all" ? "all" : "single",
            }),
          };
        }),
        ...agentRoutes.map((route) => ({
          name: route.name,
          path: route.path,
          surface: "agent",
          auth: "signed-in",
          steps: route.steps,
          viewportOnly: route.viewportOnly,
          viewports: route.viewports,
          waitFor: route.waitFor,
          detail: route.detail,
          // The agent page belongs to one agent: no organization badge to check.
          decided: decidedOptions(
            { ...route, surface: "agent" },
            { names: agent?.metadataNames ?? [], org: null },
          ),
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
  const detected = await detect(outDir, results);
  // results.json gains each capture's detect findings.
  if (detected) await writeFile(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const ignore = parseIgnoreList(await readFile(IGNORE_LIST, "utf8"));
  return report(outDir, results, [...routes, ...agentRoutes], options.strict, ignore, detected);
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
  for (const script of [
    "capture.mjs",
    "a11y-page.mjs",
    "decided-page.mjs",
    "load-errors-page.mjs",
  ]) {
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

/**
 * Runs `impeccable detect --json` on each HTML snapshot, into `<screen>.impeccable.json`, and
 * sets each result's `impeccable` (or `impeccableError`). Returns whether it ran.
 */
async function detect(outDir: string, results: CaptureResult[]): Promise<boolean> {
  const cli = await findImpeccable();
  if (!cli) {
    log(
      "impeccable CLI not found (set IMPECCABLE_CLI or put `impeccable` on PATH): skipping detect.",
    );
    return false;
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
    if (failure) {
      result.impeccableError = failure.slice(0, 2000);
      continue;
    }
    try {
      const findings = JSON.parse(stdout || "[]") as unknown;
      if (!Array.isArray(findings)) throw new Error("not a list of findings");
      result.impeccable = findings as DetectFinding[];
    } catch (error) {
      result.impeccableError = `unreadable output: ${(error as Error).message}`;
    }
  }
  return true;
}

/** Prints the screenshots (stdout) and a summary (stderr); returns the exit code. */
async function report(
  outDir: string,
  results: CaptureResult[],
  routes: readonly (Pick<ScreenRoute, "name" | "page"> &
    Pick<Partial<ScreenRoute>, "expectedFailures">)[],
  strict: boolean,
  ignore: ParsedIgnoreList,
  detected: boolean,
): Promise<number> {
  const summary: string[] = [];
  const routeOf = new Map(routes.map((route) => [route.name, route]));
  const failed = results.filter((r) => r.error);
  const overflowing = results.filter((r) => r.overflow);
  const retired = results.filter((r) => r.retiredWording.length > 0);
  const serverErrors = results.filter((r) => r.status !== null && r.status >= 500);
  const redirected = results.filter((r) => r.finalPath && r.finalPath !== r.path);
  const notRendered = results.filter((r) => r.notRendered);

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
  summary.push(...loadFailureReport(results, routeOf, strict));
  summary.push(...decidedReport(results, routeOf, strict));
  summary.push(...accessibilityReport(results, ignore.entries));
  summary.push(...detectReport(results, ignore, detected, strict));
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
    (r) =>
      captureFailures(r, routeOf.get(r.route), {
        strict,
        ignore: ignore.entries,
        detectIgnore: ignore.detect,
      }).length > 0,
  );
  return failing.length > 0 ? 1 : 0;
}

/**
 * The in-place load errors and failed API responses, by route, viewport and theme; those the
 * route expects (`expectedFailures`) are marked. `--strict` fails on the others.
 */
function loadFailureReport(
  results: CaptureResult[],
  routeOf: Map<string, Pick<Partial<ScreenRoute>, "expectedFailures">>,
  strict: boolean,
): string[] {
  const lines: string[] = [];
  for (const r of results) {
    const unexpected = new Set(unexpectedLoadFailures(r, routeOf.get(r.route)?.expectedFailures));
    const all = [
      ...r.loadErrors.map((text) => `load error: ${text}`),
      ...(r.failedResponses ?? []).map((line) => `failed API response: ${line}`),
    ];
    for (const line of all) {
      lines.push(
        `  ${r.route} ${r.viewport} ${r.theme}: ${line}${unexpected.has(line) ? "" : " (expected)"}`,
      );
    }
  }
  if (lines.length === 0) return ["No route shows a load error or got a failed API response."];
  return [
    `\nLoad errors and failed API responses${strict ? "" : " (fail only with --strict)"}:`,
    ...lines,
  ];
}

/**
 * The "Decided" section: each capture check that guards a Decided item (DESIGN.md), with its
 * findings by route, viewport and theme. `--strict` fails on every one (the shortcut
 * indicators always).
 */
function decidedReport(
  results: CaptureResult[],
  routeOf: Map<string, Pick<ScreenRoute, "page">>,
  strict: boolean,
): string[] {
  const lines = [
    `\nDecided (DESIGN.md "Decided — never flag, never undo")${strict ? "" : ": fails only with --strict, but the shortcut indicators"}:`,
  ];
  const findings = results.flatMap((result) =>
    decidedFindings(result, routeOf.get(result.route)).map((finding) => ({ result, ...finding })),
  );
  for (const check of DECIDED_CHECKS) {
    const own = findings.filter((finding) => finding.check === check);
    if (own.length === 0) {
      lines.push(`  ${check}: no findings. ${DECIDED_CHECK_TITLES[check]}`);
      continue;
    }
    lines.push(`  ${check}: ${own.length} finding(s). ${DECIDED_CHECK_TITLES[check]}`);
    for (const { result, finding } of own) {
      lines.push(`    ${result.route} ${result.viewport} ${result.theme}: ${finding}`);
    }
  }
  return lines;
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

/**
 * The "impeccable detect" section: each rule the detector found on the HTML snapshots, with
 * what it saw (up to five distinct snippets) and the captures (route, viewport, theme) it was
 * seen on, then how many findings each ignore.md entry matched. `--strict` fails on the rest.
 */
function detectReport(
  results: CaptureResult[],
  ignore: ParsedIgnoreList,
  detected: boolean,
  strict: boolean,
): string[] {
  const title = `\nimpeccable detect (HTML snapshots)${strict ? "" : ": fails only with --strict"}`;
  if (!detected) return [`${title}: didn't run (no CLI).`];
  const lines: string[] = [];
  const errors = results.filter((r) => r.impeccableError);
  const rules = new Map<
    string,
    { name: string | undefined; snippets: Set<string>; where: Set<string>; count: number }
  >();
  const ignored = new Map<string, number>();
  for (const result of results) {
    const capture = `${result.route} ${result.viewport} ${result.theme}`;
    const unignored = new Set(unignoredDetectFindings(result, ignore.detect));
    for (const finding of result.impeccable ?? []) {
      if (!unignored.has(finding)) {
        const entry = detectIgnoredBy(ignore.detect, finding)!;
        ignored.set(entry.text, (ignored.get(entry.text) ?? 0) + 1);
        continue;
      }
      const rule = rules.get(finding.antipattern) ?? {
        name: finding.name,
        snippets: new Set<string>(),
        where: new Set<string>(),
        count: 0,
      };
      rule.count++;
      rule.snippets.add(finding.snippet);
      rule.where.add(capture);
      rules.set(finding.antipattern, rule);
    }
  }
  if (rules.size === 0) {
    lines.push(`${title}: no findings.`);
  } else {
    lines.push(`${title}: ${rules.size} rule(s)`);
    for (const [antipattern, rule] of [...rules].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(
        `  ${antipattern}${rule.name ? ` (${rule.name})` : ""}: ${rule.count} finding(s) on ${rule.where.size} capture(s)`,
      );
      const snippets = [...rule.snippets];
      for (const snippet of snippets.slice(0, 5)) lines.push(`    ${snippet}`);
      if (snippets.length > 5) lines.push(`    … and ${snippets.length - 5} more`);
      lines.push(`    on ${[...rule.where].join(", ")}`);
    }
  }
  for (const [text, count] of ignored) lines.push(`  ${count} ignored by ignore.md: ${text}`);
  if (errors.length > 0) {
    lines.push(`  detect failed on:`);
    for (const r of errors) {
      lines.push(`    ${r.route} ${r.viewport} ${r.theme}: ${r.impeccableError}`);
    }
  }
  return lines;
}

runMain(main);
