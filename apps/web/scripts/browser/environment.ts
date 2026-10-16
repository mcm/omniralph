// What `verify:screens` and `e2e` share: the fixture database, `next dev` against it, and a
// script run in the mcr.microsoft.com/playwright container (`--network host`; files in and out
// with `docker cp`, no bind mounts, so a remote Docker daemon works). See ../../README.md.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { removeFixtureDatabases } from "../fixtures/container";
import { startFixtures } from "../fixtures/start";

export const run = promisify(execFile);
export const WEB_DIR = resolve(__dirname, "../..");
export const REPO_ROOT = resolve(WEB_DIR, "../..");
const SERVER_START_TIMEOUT_MS = 180_000;

// How the Playwright container reaches the panel on the host. With `--network host` on Linux
// it shares the host's network, so `localhost` works. Docker Desktop (Mac, Windows) runs the
// daemon in a VM, whose `localhost` isn't the host's: the container opens
// `host.docker.internal` instead, and `next dev` must allow that origin
// (`allowedDevOrigins`) or it blocks the dev resources and the page never hydrates.

/** Docker Desktop's in-container name for the host. */
export const DOCKER_DESKTOP_HOST = "host.docker.internal";

/** Env var `next.config.ts` reads for extra `allowedDevOrigins` (comma-separated). */
export const DEV_ORIGINS_ENV = "OMNIRALPH_ALLOWED_DEV_ORIGINS";

/** True for `docker info`'s `OperatingSystem` of a Docker Desktop daemon. */
export function isDockerDesktop(operatingSystem: string): boolean {
  return /docker desktop/i.test(operatingSystem);
}

/** The host name the browser container uses for the panel. */
export function browserHost(operatingSystem: string): string {
  return isDockerDesktop(operatingSystem) ? DOCKER_DESKTOP_HOST : "localhost";
}

/** `url` as the container reaches it: a loopback host becomes `host`. */
export function containerUrl(url: string, host: string): string {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return url;
  parsed.hostname = host;
  return parsed.toString();
}

export function log(message: string) {
  console.error(message);
}

/** Cleanups run in reverse order, on exit and on SIGINT/SIGTERM. */
export class Cleanups {
  private readonly steps: (() => Promise<void>)[] = [];

  push(step: () => Promise<void>) {
    this.steps.push(step);
  }

  async run() {
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step();
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/**
 * Runs `main`, then its cleanups, and exits with its code. The app package is CommonJS to
 * tsx, so no top-level await. Exits explicitly: Testcontainers keeps a Docker client open.
 */
export function runMain(main: (cleanups: Cleanups) => Promise<number>) {
  const cleanups = new Cleanups();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log(`\n${signal}: cleaning up…`);
      void cleanups.run().finally(() => process.exit(130));
    });
  }
  main(cleanups)
    .catch((error: unknown) => {
      console.error(error);
      return 1;
    })
    .then(async (code) => {
      await cleanups.run();
      process.exit(code);
    });
}

/** Runs a command with its output on stderr (stdout is the scripts' own output); returns its exit code. */
export function runForExitCode(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", process.stderr, "inherit"] });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolvePromise(code ?? (signal ? 128 : 1)));
  });
}

export async function runInherited(command: string, args: string[], cwd: string): Promise<void> {
  const code = await runForExitCode(command, args, cwd);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}`);
}

/** Builds the workspace packages the panel imports. */
export async function buildWorkspacePackages(): Promise<void> {
  log("Building the workspace packages the panel imports…");
  await runInherited("pnpm", ["turbo", "run", "build", "--filter=@omniralph/web^..."], REPO_ROOT);
}

/** Real path of an installed package of the panel. */
export function packageDir(name: string): string {
  const require = createRequire(join(WEB_DIR, "package.json"));
  return dirname(require.resolve(`${name}/package.json`));
}

/** The Playwright container image matching the installed `playwright-core`. */
export function playwrightImage(): string {
  const require = createRequire(join(WEB_DIR, "package.json"));
  const { version } = require("playwright-core/package.json") as { version: string };
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

/** `docker info`'s `OperatingSystem` ("Docker Desktop" on Docker Desktop). */
async function dockerOperatingSystem(): Promise<string> {
  const { stdout } = await run("docker", ["info", "--format", "{{.OperatingSystem}}"]);
  return stdout.trim();
}

export interface FixturePanel {
  /** The fixture database's environment (`DATABASE_URL`, `AUTH_SECRET`, …). */
  fixtureEnv: Record<string, string>;
  /** The host name the Playwright container reaches the host on. */
  host: string;
  /** The panel's URL from the host. */
  baseUrl: string;
  /** The panel's URL from the Playwright container. */
  browserBaseUrl: string;
}

/**
 * Starts (or reuses) and reseeds the fixture database and runs `next dev` against it on a
 * free port; both are stopped by `cleanups`.
 */
export async function startFixturePanel(cleanups: Cleanups): Promise<FixturePanel> {
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
  const host = browserHost(await dockerOperatingSystem());
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  log(`Starting the panel on ${baseUrl}…`);
  const server = startPanel(
    port,
    host === "localhost" ? fixtureEnv : { ...fixtureEnv, [DEV_ORIGINS_ENV]: host },
  );
  cleanups.push(() => stopPanel(server));
  await waitForPanel(baseUrl, server);
  if (host !== "localhost") log(`Docker Desktop: the browser opens the panel on ${host}.`);
  return { fixtureEnv, host, baseUrl, browserBaseUrl: `http://${host}:${port}` };
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
 * A temporary directory (removed by `cleanups`) with an empty `work/node_modules`, to stage
 * what goes into the container as `/work`. Returns the `work` directory.
 */
export async function stageWorkDir(cleanups: Cleanups, prefix: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), `${prefix}-`));
  cleanups.push(() => rm(staging, { recursive: true, force: true }));
  const work = join(staging, "work");
  await mkdir(join(work, "node_modules"), { recursive: true });
  return work;
}

/**
 * Runs `command` in the Playwright container with `work` copied in as `/work` (`docker cp`),
 * its output on stderr, then copies each of `outputs` (container path → host path) out,
 * when it exists. Returns the command's exit code.
 */
export async function runInPlaywrightContainer({
  cleanups,
  name,
  work,
  command,
  env = {},
  outputs = [],
}: {
  cleanups: Cleanups;
  /** Container name prefix. */
  name: string;
  work: string;
  command: string[];
  env?: Record<string, string>;
  outputs?: { from: string; to: string }[];
}): Promise<number> {
  const image = playwrightImage();
  await run("docker", ["image", "inspect", image]).catch(async () => {
    log(`Pulling ${image}…`);
    await runInherited("docker", ["pull", image], WEB_DIR);
  });
  const container = `${name}-${process.pid}-${Date.now()}`;
  await run("docker", [
    "create",
    "--name",
    container,
    "--network",
    "host",
    "--shm-size",
    "1g",
    "--init",
    "--workdir",
    "/work",
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    image,
    ...command,
  ]);
  cleanups.push(async () => {
    await run("docker", ["rm", "-f", container]).catch(() => {});
  });
  // `/.`: the contents, as `--workdir` already created `/work`.
  await run("docker", ["cp", `${work}/.`, `${container}:/work`]);

  const code = await runForExitCode("docker", ["start", "--attach", container], WEB_DIR);
  for (const { from, to } of outputs) {
    await mkdir(dirname(to), { recursive: true });
    await run("docker", ["cp", `${container}:${from}`, to]).catch((error: Error) => {
      if (!/no such file or directory|could not find the file/i.test(error.message)) throw error;
    });
  }
  return code;
}
