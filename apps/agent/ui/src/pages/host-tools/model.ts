/**
 * The Host tools page's copy and pure helpers: one row per tool (configured in
 * `settings.json`, last checked by the agent, or required by a playbook) and how it reads.
 */
import { HOST_TOOL_NAME_PATTERN } from "@omniralph/shared";
import type { StatusTone } from "@omniralph/ui";
import type { AgentUiHostTool, AgentUiHostTools } from "../../../../src/ui/state.js";

export const NEVER_RUN_FROM_DESCRIPTION = "The agent never runs a program from these paths.";
export const PATH_REQUIRED = "Enter a path";
export const PATH_NOT_ABSOLUTE = "Use an absolute path";
export const NAME_REQUIRED = "Enter a name";
export const NAME_INVALID = "Use lowercase letters, digits, dots, dashes and underscores";
export const CHECKING = "Checking…";

export interface HostToolRow {
  name: string;
  /** A playbook of the organization requires it. */
  required: boolean;
  /** The path in `settings.json`; null when it's looked up on `PATH`. */
  configuredPath: string | null;
  /** The configured path isn't the one last checked: the agent's next check tells. */
  checking: boolean;
  /** The last check, when it's still the current one. */
  checked: AgentUiHostTool | null;
}

/** The rows, by name: configured tools, checked tools and required ones. */
export function hostToolRows(
  configured: Readonly<Record<string, string>>,
  hostTools: AgentUiHostTools,
): HostToolRow[] {
  const checkedByName = new Map(hostTools.tools.map((tool) => [tool.name, tool]));
  const names = new Set([
    ...Object.keys(configured),
    ...hostTools.tools.map((tool) => tool.name),
    ...hostTools.required,
  ]);
  return [...names].sort().flatMap((name) => {
    const configuredPath = Object.hasOwn(configured, name) ? configured[name]! : null;
    const checked = checkedByName.get(name) ?? null;
    const required = hostTools.required.includes(name);
    // Checked with a path no longer configured, and nothing needs it: it goes at the next check.
    if (configuredPath === null && !required && checked?.checkedPath != null) {
      return [{ name, required, configuredPath, checking: true, checked: null }];
    }
    const checking = checked === null || checked.checkedPath !== configuredPath;
    return [{ name, required, configuredPath, checking, checked: checking ? null : checked }];
  });
}

/** The Status column. */
export function hostToolStatus(row: HostToolRow): { text: string; tone: StatusTone } {
  const { checked } = row;
  if (row.checking || !checked) return { text: CHECKING, tone: "neutral" };
  if (checked.problem === "blocked") return { text: "Blocked", tone: "fail" };
  if (checked.problem === "not_executable") return { text: "Not executable", tone: "fail" };
  if (checked.source === "configured") return { text: "Configured", tone: "neutral" };
  if (checked.source === "discovered") return { text: "Found on PATH", tone: "neutral" };
  return { text: "Not found", tone: row.required ? "fail" : "neutral" };
}

/** The Path column: the configured path, else the one found on `PATH`. */
export function hostToolPath(row: HostToolRow): string | null {
  return row.configuredPath ?? row.checked?.path ?? null;
}

/** The path input's error, or null for an absolute path. */
export function pathError(value: string): string | null {
  const path = value.trim();
  if (!path) return PATH_REQUIRED;
  return path.startsWith("/") ? null : PATH_NOT_ABSOLUTE;
}

/** The name input's error, or null for a valid host tool name. */
export function nameError(value: string): string | null {
  const name = value.trim();
  if (!name) return NAME_REQUIRED;
  return HOST_TOOL_NAME_PATTERN.test(name) ? null : NAME_INVALID;
}

/** The whole map to save with `name` set to `path` (null: looked up on `PATH`). */
export function withHostToolPath(
  configured: Readonly<Record<string, string>>,
  name: string,
  path: string | null,
): Record<string, string> {
  const next = { ...configured };
  if (path === null) delete next[name];
  else next[name] = path;
  return next;
}
