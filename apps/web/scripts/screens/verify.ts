// `pnpm --filter @omniralph/web verify:screens`: screenshots every panel route against the
// fixture database. Starts the fixture Postgres and `next dev`, runs Playwright in the
// mcr.microsoft.com/playwright container (`--network host`; files in and out with `docker
// cp`, no bind mounts, so a remote Docker daemon works), runs `impeccable detect` on each
// captured page when the CLI is available, and stops everything. See ../../README.md.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { removeFixtureDatabases } from "../fixtures/container";
import { FIXTURE_EMAILS } from "../fixtures/ids";
import { startFixtures } from "../fixtures/start";
import { parseScreensOptions, USAGE, VIEWPORTS, type ScreensOptions } from "./options";
import { routeMatches, SCREEN_ROUTES } from "./routes";

const run = promisify(execFile);
const WEB_DIR = resolve(__dirname, "../..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const SERVER_START_TIMEOUT_MS = 180_000;

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
  consoleErrors: string[];
  error: string | null;
  screenshot: string | null;
  html: string | null;
}

const cleanups: (() => Promise<void>)[] = [];

async function main(): Promise<number> {
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

  const playwrightVersion = readPlaywrightVersion();
  const image = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;
  const outDir = join(WEB_DIR, ".screens", new Date().toISOString().replace(/[:.]/g, "-"));

  if (!options.skipBuild) {
    log("Building the workspace packages the panel imports…");
    await runInherited("pnpm", ["turbo", "run", "build", "--filter=@omniralph/web^..."], REPO_ROOT);
  }

  log("Starting the fixture database…");
  cleanups.push(async () => {
    await removeFixtureDatabases();
    log("Fixture database removed.");
  });
  const fixtureEnv = await startFixtures();

  // `next dev` writes AGENTS.md and CLAUDE.md for AI agents; remove the ones it adds.
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(WEB_DIR, file);
    if (!existsSync(path)) cleanups.push(() => rm(path, { force: true }));
  }
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  log(`Starting the panel on ${baseUrl}…`);
  const server = startPanel(port, fixtureEnv);
  cleanups.push(() => stopPanel(server));
  await waitForPanel(baseUrl, server);

  log(
    `Capturing ${routes.length} route(s) × ${options.viewports.length} viewport(s) × ${options.themes.length} theme(s) in ${image}…`,
  );
  await capture({
    image,
    outDir,
    config: {
      baseUrl,
      signInPath: `/sign-in/dev?email=${encodeURIComponent(FIXTURE_EMAILS.admin)}&callbackUrl=/`,
      routes: routes.map(({ name, path, auth }) => ({ name, path, auth })),
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

function log(message: string) {
  console.error(message);
}

function readPlaywrightVersion(): string {
  const require = createRequire(join(WEB_DIR, "package.json"));
  return (require("playwright-core/package.json") as { version: string }).version;
}

/** Real path of the installed playwright-core (it has no dependencies). */
function playwrightCoreDir(): string {
  const require = createRequire(join(WEB_DIR, "package.json"));
  return dirname(require.resolve("playwright-core/package.json"));
}

function runInherited(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // stdout to stderr: this command's stdout is the list of screenshots.
    const child = spawn(command, args, { cwd, stdio: ["ignore", process.stderr, "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolvePromise(address.port)
          : reject(new Error("no free port")),
      );
    });
  });
}

function startPanel(port: number, fixtureEnv: Record<string, string>): ChildProcess {
  const nextBin = createRequire(join(WEB_DIR, "package.json")).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], {
    cwd: WEB_DIR,
    env: { ...process.env, ...fixtureEnv, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // its own process group, so stopping it stops its workers too
  });
  const output: string[] = [];
  const keep = (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  (child as ChildProcess & { output: string[] }).output = output;
  return child;
}

async function waitForPanel(baseUrl: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/sign-in`, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const output = (server as ChildProcess & { output: string[] }).output.join("");
  throw new Error(`The panel didn't start:\n${output.slice(-4000)}`);
}

async function stopPanel(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.pid === undefined) return;
  const exited = new Promise((r) => server.once("exit", r));
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    return;
  }
  const timeout = setTimeout(() => {
    try {
      process.kill(-server.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, 10_000);
  await exited;
  clearTimeout(timeout);
  log("Panel stopped.");
}

/**
 * Runs capture.mjs in the Playwright container: the script, its config and
 * playwright-core go in with `docker cp`, the screenshots come out the same way.
 */
async function capture({
  image,
  outDir,
  config,
}: {
  image: string;
  outDir: string;
  config: Record<string, unknown>;
}): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "omniralph-screens-"));
  cleanups.push(() => rm(staging, { recursive: true, force: true }));
  const work = join(staging, "work");
  await mkdir(join(work, "node_modules"), { recursive: true });
  await cp(join(__dirname, "capture.mjs"), join(work, "capture.mjs"));
  await cp(playwrightCoreDir(), join(work, "node_modules", "playwright-core"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(join(work, "config.json"), JSON.stringify(config));

  await run("docker", ["image", "inspect", image]).catch(async () => {
    log(`Pulling ${image}…`);
    await runInherited("docker", ["pull", image], WEB_DIR);
  });
  const name = `omniralph-screens-${process.pid}-${Date.now()}`;
  await run("docker", [
    "create",
    "--name",
    name,
    "--network",
    "host",
    "--shm-size",
    "1g",
    "--init",
    image,
    "node",
    "/work/capture.mjs",
    "/work/config.json",
  ]);
  cleanups.push(async () => {
    await run("docker", ["rm", "-f", name]).catch(() => {});
  });
  await run("docker", ["cp", work, `${name}:/work`]);

  let captureError: Error | null = null;
  await runInherited("docker", ["start", "--attach", name], WEB_DIR).catch((error: Error) => {
    captureError = error;
  });
  await mkdir(dirname(outDir), { recursive: true });
  await run("docker", ["cp", `${name}:/work/out`, outDir]).catch((error: Error) => {
    throw captureError ?? error;
  });
  if (captureError) throw captureError;
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
  const serverErrors = results.filter((r) => r.status !== null && r.status >= 500);
  const redirected = results.filter((r) => r.finalPath && r.finalPath !== r.path);

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
  if (failed.length > 0) {
    summary.push(`\nFailed captures:`);
    for (const r of failed) summary.push(`  ${r.route} ${r.viewport} ${r.theme}: ${r.error}`);
  }
  summary.push(`Details: ${join(outDir, "results.json")}`);
  log(summary.join("\n"));

  if (failed.length > 0) return 1;
  if (strict && overflowing.length > 0) return 1;
  return 0;
}

async function cleanUp() {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.error(error);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`\n${signal}: cleaning up…`);
    void cleanUp().finally(() => process.exit(130));
  });
}

// The app package is CommonJS to tsx, so no top-level await. Exit explicitly:
// Testcontainers keeps a Docker client open.
main()
  .catch((error: unknown) => {
    console.error(error);
    return 1;
  })
  .then(async (code) => {
    await cleanUp();
    process.exit(code);
  });
