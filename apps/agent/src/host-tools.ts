/**
 * Host tools: software the agent owner installs by hand (e.g. opengrep).
 * The heartbeat response lists the organization's host tools with the path
 * configured for this agent; the next heartbeat reports, per tool, whether
 * that path is a usable executable and what the agent found on its own
 * `PATH`. Nothing covered by the local `blockedExecPaths` is ever reported or used.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { KnownHostTool, ReportedHostTool } from "@omniralph/shared";
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

/**
 * The path a host tool runs from: a configured path when it's usable (none
 * when it isn't: no fallback), else the discovered path, else none.
 */
export function effectiveHostToolPath(
  configuredPath: string | null,
  report: Pick<ReportedHostTool, "configuredPathExists" | "discoveredPath">,
): string | null {
  if (configuredPath !== null) return report.configuredPathExists === true ? configuredPath : null;
  return report.discoveredPath;
}

export interface HostToolPathsOptions {
  config: Pick<AgentConfig, "blockedExecPaths">;
  /** The `PATH` to discover tools on: the agent's own, never a run's. */
  searchPath: () => string | undefined;
  logger: Logger;
}

/**
 * The host tools' effective paths from the last exchange with the control
 * panel: `check()` reports on the tools of the last heartbeat response and
 * keeps their effective paths; `update()` drops the ones a newer response
 * removed or configured another path for, until they're checked again.
 */
export class HostToolPaths {
  private readonly paths = new Map<
    string,
    { configuredPath: string | null; path: string | null }
  >();
  /** Blocked configured paths already warned about (`name\0path`), so each is logged once. */
  private readonly warned = new Set<string>();

  constructor(private readonly options: HostToolPathsOptions) {}

  /** Checks the known tools and returns the heartbeat's report on them. */
  async check(known: readonly KnownHostTool[]): Promise<ReportedHostTool[]> {
    const searchPath = this.options.searchPath();
    const reports: ReportedHostTool[] = [];
    const paths = new Map<string, { configuredPath: string | null; path: string | null }>();
    for (const { name, configuredPath } of known) {
      const report: ReportedHostTool = {
        name,
        configuredPath,
        configuredPathExists:
          configuredPath === null ? null : await this.configuredPathUsable(name, configuredPath),
        discoveredPath: await findOnPath(this.options.config, name, searchPath),
      };
      reports.push(report);
      paths.set(name, { configuredPath, path: effectiveHostToolPath(configuredPath, report) });
    }
    this.paths.clear();
    for (const [name, entry] of paths) this.paths.set(name, entry);
    return reports;
  }

  /** Applies a heartbeat response's tools: a removed or reconfigured tool has no path until checked. */
  update(known: readonly KnownHostTool[]): void {
    const configured = new Map(known.map((tool) => [tool.name, tool.configuredPath]));
    for (const [name, entry] of this.paths) {
      if (configured.get(name) !== entry.configuredPath) this.paths.delete(name);
    }
  }

  /** The absolute path to run a host tool from, or null when it's unavailable. */
  path(name: string): string | null {
    return this.paths.get(name)?.path ?? null;
  }

  private async configuredPathUsable(name: string, configuredPath: string): Promise<boolean> {
    if (!path.isAbsolute(configuredPath)) return false;
    if (await execPathBlocked(this.options.config, configuredPath)) {
      const key = `${name}\0${configuredPath}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.options.logger.warn(
          { hostTool: name, path: configuredPath },
          "the configured host tool path is covered by blockedExecPaths; the tool is unavailable",
        );
      }
      return false;
    }
    return isExecutableFile(configuredPath);
  }
}
