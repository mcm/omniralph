/**
 * Host tools: software the agent owner installs by hand (e.g. opengrep).
 * Their paths are set in the agent's `settings.json` (`hostTools`); a tool
 * with none configured is looked up on the agent's own `PATH`. Every
 * heartbeat reports each configured tool and each one the organization's
 * playbooks require (the last response's `requiredHostTools`). Nothing
 * covered by the local `blockedExecPaths` is ever reported or used.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { HostToolProblem, HostToolReport } from "@omniralph/shared";
import { execPathBlocked, type AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Whether `file` is (or links to) a regular file the agent may execute. */
export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first executable named `name` in the directories of `searchPath` (a
 * `PATH` value) that isn't covered by `blockedExecPaths`, or null. Relative
 * entries (including empty ones, which mean the working directory) are skipped.
 */
export async function findOnPath(
  config: Pick<AgentConfig, "blockedExecPaths">,
  name: string,
  searchPath: string | undefined,
): Promise<string | null> {
  if (name === "" || name.includes("/") || name === "." || name === "..") return null;
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (await execPathBlocked(config, candidate)) continue;
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export interface HostToolPathsOptions {
  config: Pick<AgentConfig, "blockedExecPaths">;
  /** The paths configured in `settings.json` (`hostTools`), read at each check and lookup. */
  configured: () => Readonly<Record<string, string>>;
  /** The `PATH` to discover tools on: the agent's own, never a run's. */
  searchPath: () => string | undefined;
  logger: Logger;
}

/** A checked tool: the configured path it was checked with (null: none) and its report. */
interface CheckedHostTool {
  configuredPath: string | null;
  report: HostToolReport;
}

/**
 * The host tools' paths. `check()` checks every tool configured in
 * `settings.json` and every name the control panel asked about (its
 * `requiredHostTools`) and keeps the result for `path()`. A tool whose
 * configured path changed since (a page save or hand edit) has no path until
 * it's checked again.
 */
export class HostToolPaths {
  private checked = new Map<string, CheckedHostTool>();
  /** Blocked configured paths already warned about (`name\0path`), so each is logged once. */
  private readonly warned = new Set<string>();

  constructor(private readonly options: HostToolPathsOptions) {}

  /** Checks the configured tools and the `required` names; returns the heartbeat's report, by name. */
  async check(required: readonly string[]): Promise<HostToolReport[]> {
    const configured = this.options.configured();
    const searchPath = this.options.searchPath();
    const names = [...new Set([...Object.keys(configured), ...required])].sort();
    const checked = new Map<string, CheckedHostTool>();
    for (const name of names) {
      const configuredPath = Object.hasOwn(configured, name) ? configured[name]! : null;
      const report =
        configuredPath === null
          ? await this.discover(name, searchPath)
          : await this.checkConfigured(name, configuredPath);
      checked.set(name, { configuredPath, report });
    }
    this.checked = checked;
    return names.map((name) => checked.get(name)!.report);
  }

  /** The names `check()` last checked. */
  checkedNames(): string[] {
    return [...this.checked.keys()];
  }

  /** The absolute path to run a host tool from, or null when it's unavailable. */
  path(name: string): string | null {
    const entry = this.checked.get(name);
    if (!entry) return null;
    const configured = this.options.configured();
    const configuredPath = Object.hasOwn(configured, name) ? configured[name]! : null;
    return configuredPath === entry.configuredPath ? entry.report.path : null;
  }

  private async discover(name: string, searchPath: string | undefined): Promise<HostToolReport> {
    const found = await findOnPath(this.options.config, name, searchPath);
    return { name, path: found, source: found === null ? null : "discovered", problem: null };
  }

  private async checkConfigured(name: string, configuredPath: string): Promise<HostToolReport> {
    const problem = await this.configuredPathProblem(name, configuredPath);
    return problem === null
      ? { name, path: configuredPath, source: "configured", problem: null }
      : { name, path: null, source: null, problem };
  }

  private async configuredPathProblem(
    name: string,
    configuredPath: string,
  ): Promise<HostToolProblem | null> {
    if (!path.isAbsolute(configuredPath)) return "missing";
    if (await execPathBlocked(this.options.config, configuredPath)) {
      const key = `${name}\0${configuredPath}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.options.logger.warn(
          { hostTool: name, path: configuredPath },
          "the configured host tool path is covered by blockedExecPaths; the tool is unavailable",
        );
      }
      return "blocked";
    }
    try {
      if (!(await stat(configuredPath)).isFile()) return "not_executable";
    } catch {
      return "missing";
    }
    return (await isExecutableFile(configuredPath)) ? null : "not_executable";
  }
}
