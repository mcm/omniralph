import { DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import type { RunSpecAgent, ToolSettings } from "@omniralph/tasks";
import type { ToolPolicy } from "../capabilities/index.js";

/** Claude Code's shell tool: only with the task's `toolSettings.shell`. */
export const SHELL_TOOLS: readonly string[] = ["Bash"];

/** Tools that reach the network: only with the task's `toolSettings.network`. */
export const NETWORK_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/** Every built-in tool a query session may get (read-only file tools, shell, network). */
export const QUERY_TOOLS: readonly string[] = [
  ...EXPLORATION_TOOLS,
  ...SHELL_TOOLS,
  ...NETWORK_TOOLS,
];

/**
 * The tool policy of a query session: the agent's built-in tools (already
 * narrowed by the repository's settings at claim time) ∩ what the task's
 * `toolSettings` allow ∩ `QUERY_TOOLS`. `Read`/`Grep`/`Glob` are confined to
 * the session's working directory, `Bash` needs `shell`, `WebSearch`/`WebFetch`
 * need `network`; without `files` (no checkout) the file tools and the shell
 * are dropped. Nothing else is available: every other tool is denied, no
 * settings are loaded (so no skills, plugins or MCP servers come in), and the
 * session never bypasses permissions. The run spec's repository `tools` narrow
 * it further when the session is built (`narrowPermissions`), and only narrow.
 */
export function queryToolPolicy(
  agent: Pick<RunSpecAgent, "tools">,
  settings: Pick<ToolSettings, "shell" | "network">,
  { files = true }: { files?: boolean } = {},
): ToolPolicy {
  const offered = new Set([
    ...(files ? EXPLORATION_TOOLS : []),
    ...(files && settings.shell ? SHELL_TOOLS : []),
    ...(settings.network ? NETWORK_TOOLS : []),
  ]);
  const allowedTools = QUERY_TOOLS.filter(
    (tool) => offered.has(tool) && agent.tools.builtin.includes(tool),
  );
  return {
    tools: "allowed",
    allowedTools,
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...QUERY_TOOLS])].filter(
      (tool) => !allowedTools.includes(tool),
    ),
    fileScope: "worktree",
    permissionMode: "dontAsk",
    settingSources: [],
    writable: false,
  };
}
