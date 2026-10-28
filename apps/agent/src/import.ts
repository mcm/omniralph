import { execFile } from "node:child_process";
import { chmod, readFile, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AgentLocalSettings } from "@omniralph/shared";
import {
  AgentConfig,
  ConfigError,
  defaultConfigPath,
  defaultDataDir,
  validateServerUrl,
  writePrivateJson,
} from "./config.js";
import type { Io } from "./main.js";
import { localSettingsPath } from "./settings.js";
import { UPDATE_REQUEST_FILE, UPDATE_STATE_FILE } from "./update.js";

/**
 * `omniralph-agent import`: brings an `@omniralph/harness` install's local
 * config over to this agent, so the machine comes back as the same agent
 * without enrolling again. Offline by design: the refresh token is copied, not
 * exchanged, and the old install is left untouched for rollback.
 */

/** The legacy package and binary, which only `import` refers to. */
export const LEGACY_PACKAGE = "@omniralph/harness";
export const LEGACY_BINARY = "omniralph-harness";
export const LEGACY_CONFIG_ENV = "OMNIRALPH_HARNESS_CONFIG";

export function legacyConfigPath(home = homedir()): string {
  return path.join(home, ".config", "omniralph", "harness.json");
}

/** The filesystem calls `import` makes; nothing else on disk is touched. */
export interface ImportFs {
  readFile: (file: string) => Promise<string>;
  /** Throws an `ENOENT` error for a missing path. */
  stat: (file: string) => Promise<{ mode: number; isDirectory: () => boolean }>;
  rename: (from: string, to: string) => Promise<void>;
  chmod: (file: string, mode: number) => Promise<void>;
  writePrivateJson: (file: string, value: unknown) => Promise<void>;
}

export const nodeImportFs: ImportFs = {
  readFile: (file) => readFile(file, "utf8"),
  stat: (file) => stat(file),
  rename: (from, to) => rename(from, to),
  chmod: (file, mode) => chmod(file, mode),
  writePrivateJson,
};

/** The argv of every running process (`/proc/<pid>/cmdline`). */
export type ProcessLister = () => Promise<string[][]>;

/** Runs `pm2 <args>` and returns its stdout, or `undefined` when no pm2 daemon runs. */
export type Pm2Runner = (args: string[]) => Promise<string | undefined>;

/** The argv of every process under `procRoot` except this one; `[]` off Linux. */
export function procCmdlines(procRoot = "/proc", ownPid = process.pid): ProcessLister {
  return async () => {
    let entries: string[];
    try {
      entries = await readdir(procRoot);
    } catch {
      return [];
    }
    const result: string[][] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === ownPid) continue;
      try {
        const raw = await readFile(path.join(procRoot, entry, "cmdline"), "utf8");
        const argv = raw.split("\0").filter((arg) => arg !== "");
        if (argv.length > 0) result.push(argv);
      } catch {
        // Exited meanwhile, or not ours to read.
      }
    }
    return result;
  };
}

/**
 * Runs the `pm2` CLI, but only when a pm2 daemon is up (its `rpc.sock` exists):
 * `pm2 jlist` would otherwise start one.
 */
export function pm2Cli(env: NodeJS.ProcessEnv, home = homedir()): Pm2Runner {
  return async (args) => {
    const pm2Home = env.PM2_HOME ?? path.join(home, ".pm2");
    try {
      await stat(path.join(pm2Home, "rpc.sock"));
    } catch {
      return undefined;
    }
    return new Promise((resolve, reject) => {
      execFile(
        "pm2",
        args,
        { env, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") resolve(undefined);
          else if (error) reject(new Error(`'pm2 ${args.join(" ")}' failed: ${error.message}`));
          else resolve(stdout);
        },
      );
    });
  };
}

/** What `import` reads of a pm2 process: never its env. */
export interface Pm2Process {
  name: string;
  status: string;
  execPath: string;
  args: string[];
}

/** Parses `pm2 jlist`, keeping only the name, status, exec path and args of each process. */
export function parsePm2List(stdout: string): Pm2Process[] {
  // pm2 may print notices before the JSON.
  const start = stdout.search(/^\[/m);
  if (start === -1) return [];
  const list: unknown = JSON.parse(stdout.slice(start));
  if (!Array.isArray(list)) return [];
  return list.map((item) => {
    const entry = (item ?? {}) as { name?: unknown; pm2_env?: Record<string, unknown> };
    const pm2Env = entry.pm2_env ?? {};
    const args = pm2Env.args;
    return {
      name: typeof entry.name === "string" ? entry.name : "",
      status: typeof pm2Env.status === "string" ? pm2Env.status : "",
      execPath: typeof pm2Env.pm_exec_path === "string" ? pm2Env.pm_exec_path : "",
      args: Array.isArray(args)
        ? args.map(String)
        : typeof args === "string"
          ? args.split(/\s+/).filter(Boolean)
          : [],
    };
  });
}

function namesLegacy(value: string): boolean {
  return value.includes(LEGACY_BINARY) || value.includes(`${LEGACY_PACKAGE}/`);
}

function isLegacyPm2Process(proc: Pm2Process): boolean {
  return namesLegacy(proc.execPath) || proc.args.some(namesLegacy);
}

/** A non-pm2 `omniralph-harness start` (systemd, a shell, …). */
function isLegacyStartCommand(argv: string[]): boolean {
  const binary = argv.findIndex(namesLegacy);
  return binary !== -1 && argv.slice(binary + 1).includes("start");
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

function shellQuote(arg: string): string {
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The old daemon's `start` args for the new one: without the old `--config`,
 * plus the new config when it isn't the default.
 */
function replacementStartArgs(oldArgs: string[], configPath: string, home: string): string[] {
  const args = oldArgs[0] === "start" ? oldArgs.slice(1) : [...oldArgs];
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config") {
      i++;
      continue;
    }
    if (arg.startsWith("--config=")) continue;
    kept.push(arg);
  }
  if (path.resolve(configPath) !== defaultConfigPath(home)) kept.push("--config", configPath);
  return kept;
}

export function pm2ReplaceCommands(proc: Pm2Process, configPath: string, home: string): string[] {
  const startArgs = replacementStartArgs(proc.args, configPath, home).map(shellQuote);
  return [
    `pm2 delete ${shellQuote(proc.name)}`,
    `pm2 start "$(command -v omniralph-agent)" --name omniralph-agent --kill-timeout 90000 --max-restarts 5 -- start${startArgs.length ? ` ${startArgs.join(" ")}` : ""}`,
    "pm2 save",
  ];
}

export interface ImportDeps {
  io: Io;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  fs?: ImportFs;
  listProcesses?: ProcessLister;
  runPm2?: Pm2Runner;
  /** Clock for the backup name (ms since epoch). */
  now?: () => number;
}

export interface ImportOptions {
  from?: string;
  config: string;
  force: boolean;
  dryRun: boolean;
}

const REQUIRED_KEYS = ["server", "agentId", "refreshToken", "workspaceRoot"] as const;
const OPTIONAL_KEYS = ["dataDir", "blockedExecPaths"] as const;
/** Settings the old control panel held for the agent that now start at their defaults. */
const LOCAL_DEFAULTS = ["slots", "pool limits", "host tool paths", "version pin"];
const CONTROL_PANEL_SETTINGS = ["pins", "desired version"];

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function exists(fs: ImportFs, file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function isDirectory(fs: ImportFs, dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return false;
    throw error;
  }
}

/** `20261026T143005Z` */
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

interface Detected {
  pm2: Pm2Process[];
  running: string[];
  warnings: string[];
}

async function detectOldDaemon(deps: ImportDeps, home: string): Promise<Detected> {
  const detected: Detected = { pm2: [], running: [], warnings: [] };
  const runPm2 = deps.runPm2 ?? pm2Cli(deps.env, home);
  try {
    const stdout = await runPm2(["jlist"]);
    if (stdout !== undefined) detected.pm2 = parsePm2List(stdout).filter(isLegacyPm2Process);
  } catch (error) {
    detected.warnings.push(`couldn't list pm2 processes (${(error as Error).message})`);
  }
  for (const proc of detected.pm2) {
    if (proc.status === "online") detected.running.push(`pm2 process '${proc.name}'`);
  }
  const listProcesses = deps.listProcesses ?? procCmdlines();
  const commands = (await listProcesses()).filter(isLegacyStartCommand);
  if (commands.length > 0 && detected.running.length === 0) {
    detected.running.push(
      ...commands.map((argv) => `process '${argv.join(" ")}'`.replace(/\s+/g, " ")),
    );
  }
  return detected;
}

/**
 * Runs `omniralph-agent import` and returns the exit code: 0 when the config
 * was written (or, with `--dry-run`, could be read), 1 otherwise.
 */
export async function runImport(options: ImportOptions, deps: ImportDeps): Promise<number> {
  const { io } = deps;
  const fs = deps.fs ?? nodeImportFs;
  const home = deps.homeDir ?? homedir();
  const configPath = options.config;

  // Which old config.
  const candidates = options.from
    ? [options.from]
    : [
        ...new Set(
          [deps.env[LEGACY_CONFIG_ENV], legacyConfigPath(home)].filter(
            (file): file is string => !!file,
          ),
        ),
      ];
  let from: string | undefined;
  for (const candidate of candidates) {
    if (await exists(fs, candidate)) {
      from = candidate;
      break;
    }
  }
  if (!from) {
    io.stderr(
      `omniralph-agent: no ${LEGACY_PACKAGE} config found (checked ${candidates.join(", ")}).\n` +
        `Nothing to import: enroll this machine with 'omniralph-agent enroll --server <url> --token <token>'.\n`,
    );
    return 1;
  }

  // Read and check it.
  const problems: string[] = [];
  const mode = (await fs.stat(from)).mode;
  if ((mode & 0o077) !== 0) {
    problems.push(
      `it is readable by group or others (mode ${(mode & 0o777).toString(8)}): run 'chmod 600 ${from}'`,
    );
  }
  let old: Record<string, unknown> | undefined;
  try {
    const json: unknown = JSON.parse(await fs.readFile(from));
    if (isRecord(json)) old = json;
    else problems.push("it is not a JSON object");
  } catch (error) {
    if (error instanceof SyntaxError) problems.push("it is not valid JSON");
    else throw error;
  }
  const next: Record<string, unknown> = {};
  const nextSettings: Record<string, unknown> = { v: 1 };
  if (old) {
    for (const key of REQUIRED_KEYS) {
      const value = old[key];
      if (typeof value !== "string" || value === "") {
        problems.push(value === undefined ? `${key} is missing` : `${key} must be a string`);
        continue;
      }
      if (key === "server") {
        try {
          next.server = validateServerUrl(value);
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error;
          problems.push(`server: ${error.message}`);
        }
      } else {
        next[key] = value;
      }
    }
    for (const key of OPTIONAL_KEYS) {
      if (old[key] !== undefined) next[key] = old[key];
    }
    // The machine settings it had go to settings.json.
    if (old.acceptedTaskTypes !== undefined) nextSettings.acceptedTaskTypes = old.acceptedTaskTypes;
    const installables = old.installables;
    if (installables !== undefined) {
      if (!isRecord(installables)) problems.push("installables must be an object");
      else if (installables.allow !== undefined) {
        nextSettings.installables = { allow: installables.allow };
      }
    }
    if (problems.length === 0) {
      for (const schema of [AgentConfig, AgentLocalSettings]) {
        const parsed = schema.safeParse(schema === AgentConfig ? next : nextSettings);
        if (parsed.success) continue;
        for (const issue of parsed.error.issues) {
          problems.push(
            issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
          );
        }
      }
    }
  }
  if (problems.length > 0) {
    io.stderr(
      `omniralph-agent: can't import ${from}:\n${problems.map((problem) => `  - ${problem}\n`).join("")}` +
        `Nothing was written.\n`,
    );
    return 1;
  }
  const config = AgentConfig.parse(next);
  const source = old!;
  const dataDir = config.dataDir ?? defaultDataDir(home);
  const settingsPath = localSettingsPath(dataDir);
  const imported = AgentLocalSettings.parse(nextSettings);
  // Merged into a settings.json already there; written only when there is something to import.
  let settings: AgentLocalSettings | undefined;
  if (imported.acceptedTaskTypes !== undefined || imported.installables !== undefined) {
    let existing: AgentLocalSettings = { v: 1 };
    try {
      const parsed = AgentLocalSettings.safeParse(JSON.parse(await fs.readFile(settingsPath)));
      if (!parsed.success) throw new SyntaxError("invalid");
      existing = parsed.data;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        if (!(error instanceof SyntaxError)) throw error;
        io.stderr(
          `omniralph-agent: can't import ${from}: ${settingsPath} exists and isn't valid.\n` +
            `Fix or remove it, then run the import again. Nothing was written.\n`,
        );
        return 1;
      }
    }
    settings = { ...existing, ...imported };
  }

  // The summary: one line per setting.
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  rows.push(["server", `imported (${config.server})`]);
  rows.push(["agentId", `imported (${config.agentId})`]);
  rows.push(["refreshToken", "imported (hidden)"]);
  rows.push(["workspaceRoot", `imported (${config.workspaceRoot})`]);
  if (!(await isDirectory(fs, config.workspaceRoot))) {
    warnings.push(
      `workspaceRoot ${config.workspaceRoot} doesn't exist: repos will be cloned again.`,
    );
  }
  rows.push(["dataDir", config.dataDir === undefined ? "default" : `imported (${config.dataDir})`]);
  if (!(await isDirectory(fs, dataDir))) {
    warnings.push(`dataDir ${dataDir} doesn't exist: installables will be reinstalled.`);
  }
  rows.push([
    "blockedExecPaths",
    config.blockedExecPaths === undefined
      ? "default"
      : `imported (${describeValue(config.blockedExecPaths)})`,
  ]);
  const toSettings = (value: unknown) =>
    value === undefined ? "default" : `imported into settings.json (${describeValue(value)})`;
  rows.push(["installables.allow", toSettings(imported.installables?.allow)]);
  rows.push(["acceptedTaskTypes", toSettings(imported.acceptedTaskTypes)]);
  const known = new Set<string>([
    ...REQUIRED_KEYS,
    ...OPTIONAL_KEYS,
    "acceptedTaskTypes",
    "installables",
  ]);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) rows.push([key, "not imported: unknown key"]);
  }
  if (isRecord(source.installables)) {
    for (const key of Object.keys(source.installables)) {
      if (key !== "allow") rows.push([`installables.${key}`, "not imported: unknown key"]);
    }
  }
  for (const file of [UPDATE_STATE_FILE, UPDATE_REQUEST_FILE]) {
    if (await exists(fs, path.join(path.dirname(from), file))) {
      rows.push([file, `not imported: versions of ${LEGACY_PACKAGE}`]);
    }
  }
  for (const setting of LOCAL_DEFAULTS) {
    rows.push([setting, "default (set them on the agent's page)"]);
  }
  for (const setting of CONTROL_PANEL_SETTINGS) rows.push([setting, "kept by the control panel"]);

  const width = Math.max(...rows.map(([name]) => name.length));
  let summary =
    `Importing ${from}\n     into ${configPath}\n` +
    (settings ? `      and ${settingsPath}\n` : "") +
    "\n" +
    rows.map(([name, outcome]) => `  ${name.padEnd(width)}  ${outcome}\n`).join("");

  const detected = await detectOldDaemon(deps, home);
  warnings.push(...detected.warnings.map((warning) => `${warning}.`));
  if (warnings.length > 0) {
    summary += `\nWarnings:\n${warnings.map((warning) => `  ${warning}\n`).join("")}`;
  }
  io.stdout(summary);

  const replace =
    detected.pm2.length > 0
      ? `\nReplace the old pm2 process with the agent:\n` +
        detected.pm2
          .flatMap((proc) => pm2ReplaceCommands(proc, configPath, home))
          .map((command, i) => `  ${i + 1}. ${command}\n`)
          .join("")
      : "";
  const runningMessage =
    `the old daemon is running (${detected.running.join(", ")}).\n` +
    `The old daemon and the agent would share one refresh token, and reusing it revokes the agent.\n` +
    `Stop the old daemon first (${
      detected.pm2.some((proc) => proc.status === "online")
        ? detected.pm2
            .filter((proc) => proc.status === "online")
            .map((proc) => `'pm2 stop ${shellQuote(proc.name)}'`)
            .join(", ")
        : `'pm2 stop <name>' or 'systemctl stop ${LEGACY_BINARY}'`
    }), then run the import again.\n`;
  const configExists = await exists(fs, configPath);

  if (options.dryRun) {
    const notes: string[] = [];
    if (detected.running.length > 0) {
      notes.push(
        options.force
          ? `The old daemon is running (${detected.running.join(", ")}); --force imports anyway.`
          : `An import would refuse: the old daemon is running (${detected.running.join(", ")}).`,
      );
    }
    if (configExists) {
      notes.push(
        options.force
          ? `${configPath} exists: an import with --force would back it up first.`
          : `${configPath} exists: an import would refuse without --force.`,
      );
    }
    io.stdout(
      `\n${notes.map((note) => `${note}\n`).join("")}Dry run: nothing was written.\n${replace}`,
    );
    return 0;
  }

  if (detected.running.length > 0 && !options.force) {
    io.stderr(`omniralph-agent: ${runningMessage}Nothing was written.\n`);
    return 1;
  }
  if (configExists && !options.force) {
    io.stderr(
      `omniralph-agent: ${configPath} already exists. Nothing was written.\n` +
        `Pass --force to back it up and replace it.\n`,
    );
    return 1;
  }
  let backup: string | undefined;
  if (configExists) {
    backup = `${configPath}.bak-${utcStamp(deps.now?.() ?? Date.now())}`;
    await fs.rename(configPath, backup);
    await fs.chmod(backup, 0o600);
  }
  await fs.writePrivateJson(configPath, config);
  if (settings) await fs.writePrivateJson(settingsPath, settings);
  io.stdout(
    `\n${backup ? `Backed up the existing config to ${backup}.\n` : ""}` +
      `Wrote ${configPath}${settings ? ` and ${settingsPath}` : ""}. ` +
      `${from} and its install are unchanged.\n` +
      (replace || `Run 'omniralph-agent start' to start the agent.\n`),
  );
  return 0;
}

/**
 * The hint for `start` without a config: `import` when an old install's config
 * is at its default path, `enroll` otherwise.
 */
export async function missingConfigHint(
  configPath: string,
  home = homedir(),
  fs: Pick<ImportFs, "stat"> = nodeImportFs,
): Promise<string> {
  const legacy = legacyConfigPath(home);
  let found = false;
  try {
    await fs.stat(legacy);
    found = true;
  } catch {
    // none
  }
  return found
    ? `${configPath} not found; ${legacy} exists: run 'omniralph-agent import' to bring that install over`
    : `${configPath} not found; run 'omniralph-agent enroll --server <url> --token <token>' first`;
}
