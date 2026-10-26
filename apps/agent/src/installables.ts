/**
 * Installables on this host: npm packages with an `omniralph` manifest,
 * installed by the `install` system RPC into an agent-managed npm prefix
 * (`<dataDir>/installables`), never `npm -g`, so they don't collide with the
 * agent package or each other.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";
import {
  InstallablePackageName,
  parseInstallablePackage,
  type InstallablePackageParse,
} from "@omniralph/tasks";

export const INSTALLABLES_DIR = "installables";
/** Longest one `npm install` or `npm uninstall` may take. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** The npm prefix installables go into. */
export function installablesPrefix(dataDir: string): string {
  return path.join(dataDir, INSTALLABLES_DIR);
}

/** Where an installed package lives in the prefix. */
export function installablePackageDir(prefix: string, name: string): string {
  return path.join(prefix, "node_modules", ...name.split("/"));
}

/** Env var naming an installable's cache directory for the run's repository. */
export const CACHE_DIR_ENV = "OMNIRALPH_CACHE_DIR";
/** Env var naming an installable's cache directory for the run's PR (PR triggers only). */
export const PR_CACHE_DIR_ENV = "OMNIRALPH_PR_CACHE_DIR";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The path segments of an installable's cache: its package name (a scope is
 * a nested directory) and the repository ID; throws unless both are valid,
 * so neither can point a cache outside its tree.
 */
function cacheSegments(name: string, repositoryId: string): string[] {
  if (!InstallablePackageName.safeParse(name).success) {
    throw new Error(`invalid installable name for a cache directory: ${name}`);
  }
  if (!UUID_PATTERN.test(repositoryId)) {
    throw new Error(`invalid repository ID for a cache directory: ${repositoryId}`);
  }
  return [...name.split("/"), repositoryId];
}

/**
 * An installable's cache for a repository: `<dataDir>/cache/<name>/<repository id>`.
 * The installable owns its contents (and keying, e.g. by commit); it only
 * ever holds data derived from the repository's trusted branches.
 */
export function installableCacheDir(dataDir: string, name: string, repositoryId: string): string {
  return path.join(dataDir, "cache", ...cacheSegments(name, repositoryId));
}

/**
 * An installable's cache for a PR:
 * `<dataDir>/pr-cache/<name>/<repository id>/<number>`, a sibling tree of the
 * repository caches (never inside one), so what an untrusted PR leaves there
 * is never read by runs of other PRs or of the repository.
 */
export function installablePrCacheDir(
  dataDir: string,
  name: string,
  repositoryId: string,
  prNumber: number,
): string {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`invalid PR number for a cache directory: ${prNumber}`);
  }
  return path.join(dataDir, "pr-cache", ...cacheSegments(name, repositoryId), String(prNumber));
}

/**
 * Creates the installable's cache directories for a run (private to the
 * agent user) and returns their env vars: `OMNIRALPH_CACHE_DIR` when the
 * run has a repository, plus `OMNIRALPH_PR_CACHE_DIR` when it also has a PR.
 */
export async function installableCacheEnv(
  dataDir: string,
  name: string,
  run: { repositoryId: string | null; prNumber: number | null },
): Promise<Record<string, string>> {
  if (run.repositoryId === null) return {};
  const env: Record<string, string> = {
    [CACHE_DIR_ENV]: installableCacheDir(dataDir, name, run.repositoryId),
  };
  if (run.prNumber !== null) {
    env[PR_CACHE_DIR_ENV] = installablePrCacheDir(dataDir, name, run.repositoryId, run.prNumber);
  }
  for (const dir of Object.values(env)) await mkdir(dir, { recursive: true, mode: 0o700 });
  return env;
}

/**
 * Creates the prefix with its own private package.json, so npm keeps the
 * installables' dependencies there and never looks for a project above it.
 */
export async function ensureInstallablesPrefix(prefix: string): Promise<void> {
  await mkdir(prefix, { recursive: true });
  await writeFile(
    path.join(prefix, "package.json"),
    `${JSON.stringify({ name: "omniralph-installables", private: true }, null, 2)}\n`,
    { flag: "wx" },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/**
 * The installed package `name` in the prefix, parsed as an installable; null
 * when it isn't installed.
 */
export async function readInstalledPackage(
  prefix: string,
  name: string,
): Promise<InstallablePackageParse | null> {
  let text: string;
  try {
    text = await readFile(path.join(installablePackageDir(prefix, name), "package.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return parseInstallablePackage(json);
}

/** An installed installable, as reported in the heartbeat. */
export interface InstalledInstallable {
  name: string;
  version: string;
}

/** Most installables one heartbeat reports. */
export const MAX_REPORTED_INSTALLABLES = 100;

/**
 * The installables installed in `<dataDir>/installables`, sorted by name: the
 * prefix's own dependencies (not their dependencies) whose installed
 * package.json is a valid installable (others are skipped, with a warning on
 * `log`). Empty when nothing was installed yet.
 */
export async function listInstalledInstallables(
  dataDir: string,
  log?: Pick<Logger, "warn">,
): Promise<InstalledInstallable[]> {
  const prefix = installablesPrefix(dataDir);
  let dependencies: unknown;
  try {
    const json: unknown = JSON.parse(await readFile(path.join(prefix, "package.json"), "utf8"));
    dependencies = (json as { dependencies?: unknown } | null)?.dependencies;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (typeof dependencies !== "object" || dependencies === null) return [];
  const installed: InstalledInstallable[] = [];
  for (const name of Object.keys(dependencies).sort()) {
    if (!InstallablePackageName.safeParse(name).success) continue;
    const parsed = await readInstalledPackage(prefix, name);
    if (!parsed?.ok || parsed.installable.name !== name) {
      log?.warn(
        { installable: name, problem: parsed?.ok === false ? parsed.error.message : undefined },
        "skipping an installed package that isn't a valid installable",
      );
      continue;
    }
    installed.push({ name, version: parsed.installable.version });
    if (installed.length === MAX_REPORTED_INSTALLABLES) break;
  }
  return installed;
}

/** Installs packages into an npm prefix (injectable for tests, as `Installer` for self-update). */
export interface InstallableInstaller {
  /** Installs or updates `name` at `version` (a semver version or dist-tag). */
  install(
    name: string,
    version: string,
    prefix: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  uninstall(name: string, prefix: string, options?: { signal?: AbortSignal }): Promise<void>;
}

/** Runs npm in `prefix`; rejects with the tail of its stderr. */
export function runNpm(
  args: string[],
  prefix: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<void> {
  const fullArgs = [args[0]!, "--prefix", prefix, "--no-audit", "--no-fund", ...args.slice(1)];
  return new Promise((resolve, reject) => {
    execFile(
      "npm",
      fullArgs,
      {
        env: options.env ?? process.env,
        signal: options.signal,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const tail = String(stderr).trim().split("\n").slice(-5).join("\n");
        reject(new Error(`npm ${args.join(" ")} failed: ${tail || error.message}`));
      },
    );
  });
}

/**
 * `npm install --prefix <prefix> <name>@<version>` with the agent's own
 * environment (never a job's: no job token reaches npm or install scripts).
 * `spec` maps a name and version to what npm installs (tests map it to a
 * packed tarball).
 */
export function npmInstallableInstaller(
  env: NodeJS.ProcessEnv = process.env,
  spec: (name: string, version: string) => string = (name, version) => `${name}@${version}`,
): InstallableInstaller {
  return {
    // `--` so nothing in the spec is ever read as an option.
    install: (name, version, prefix, options) =>
      runNpm(["install", "--save-exact", "--", spec(name, version)], prefix, { ...options, env }),
    uninstall: (name, prefix, options) =>
      runNpm(["uninstall", "--", name], prefix, { ...options, env }),
  };
}
