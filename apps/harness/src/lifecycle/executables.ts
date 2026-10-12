/**
 * The executables a run may use from its host: the task's host tools and
 * the commands and MCP servers of its required installables, each by its
 * absolute path, never by name from the run's `PATH` (which the code being
 * worked on or reviewed may put its own binary in front of).
 */
import type { McpServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { RunSpec } from "@omniralph/shared";
import {
  deriveHarnessRequirements,
  parseInstallableMcpServerRef,
  resolveInstallablePaths,
} from "@omniralph/tasks";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import {
  installablePackageDir,
  installablesPrefix,
  listInstalledInstallables,
  readInstalledPackage,
} from "../installables.js";

/** How long a run waits before it's retried when a required host tool or installable is missing. */
export const MISSING_EXECUTABLE_RETRY_SECONDS = 60;

/** A run's executables, resolved before its setup commands run. */
export interface RunExecutables {
  /**
   * Absolute path by command name: the task's host tools (their negotiated
   * paths), then the commands of the required installables (a name taken
   * by a host tool or an earlier installable, by name, keeps that one).
   */
  commands: ReadonlyMap<string, string>;
  /**
   * The installable MCP servers the agent lists (`<package>:<server>`), for
   * `SessionRequest.mcpServers`; null when it lists none.
   */
  mcpServers: { servers: Record<string, McpStdioServerConfig>; allowedTools: string[] } | null;
}

/** No host tools, installable commands or MCP servers. */
export const NO_EXECUTABLES: RunExecutables = { commands: new Map(), mcpServers: null };

/**
 * The session's server name for an installable's MCP server: `<package>_<server>`
 * with every character but letters, digits, `_` and `-` replaced by `_` and no
 * leading `_` (`@omniralph/code-graph:graph` → `omniralph_code-graph_graph`),
 * so its tools are `mcp__<name>__<tool>`.
 */
export function installableMcpServerName(installable: string, server: string): string {
  return `${installable}_${server}`.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "");
}

/**
 * Resolves the executables of a run of `spec.task` on `spec.agent`: each host
 * tool in the task's `requires.hostTools` by its negotiated path
 * (`ctx.hostToolPath`), and each installable the run requires (the task's
 * `requires.installables` and those whose MCP servers the agent lists) in the
 * harness's installables prefix under `ctx.dataDir`. A missing host tool or
 * installable throws `RetryableJobError` (the claim saw it, so it went away
 * since, or isn't negotiated yet after a restart); an MCP server the
 * installed version doesn't provide throws.
 */
export async function resolveRunExecutables(
  spec: Pick<RunSpec, "task" | "agent">,
  ctx: Pick<JobContext, "hostToolPath" | "dataDir">,
): Promise<RunExecutables> {
  const { installables, hostTools } = deriveHarnessRequirements(spec.task, spec.agent);
  if (installables.length === 0 && hostTools.length === 0) return NO_EXECUTABLES;

  const commands = new Map<string, string>();
  for (const name of hostTools) {
    const toolPath = ctx.hostToolPath?.(name) ?? null;
    if (toolPath === null) {
      throw new RetryableJobError(
        `the host tool ${name} is not available on this harness`,
        MISSING_EXECUTABLE_RETRY_SECONDS,
      );
    }
    commands.set(name, toolPath);
  }

  const mcpRefs = spec.agent.tools.mcpServers.flatMap((entry) => {
    const ref = parseInstallableMcpServerRef(entry);
    return ref ? [ref] : [];
  });
  const servers: Record<string, McpStdioServerConfig> = {};
  if (installables.length > 0) {
    const missing = (name: string) =>
      new RetryableJobError(
        `the installable ${name} is not installed on this harness`,
        MISSING_EXECUTABLE_RETRY_SECONDS,
      );
    if (ctx.dataDir === undefined) throw missing(installables[0]!);
    const installed = new Set((await listInstalledInstallables(ctx.dataDir)).map((i) => i.name));
    const prefix = installablesPrefix(ctx.dataDir);
    for (const name of installables) {
      const parsed = installed.has(name) ? await readInstalledPackage(prefix, name) : null;
      if (!parsed?.ok) throw missing(name);
      const { manifest } = parsed.installable;
      const paths = resolveInstallablePaths(installablePackageDir(prefix, name), manifest);
      for (const [command, bin] of Object.entries(paths.commands)) {
        if (!commands.has(command)) commands.set(command, bin);
      }
      for (const ref of mcpRefs.filter((r) => r.installable === name)) {
        const server = manifest.mcpServers.find((s) => s.name === ref.server);
        if (!server) {
          throw new Error(
            `the installable ${name} ${parsed.installable.version} has no MCP server ${ref.server}`,
          );
        }
        servers[installableMcpServerName(name, server.name)] = {
          type: "stdio",
          command: paths.mcpServers[server.name]!,
          args: [...server.args],
        };
      }
    }
  }
  const names = Object.keys(servers);
  return {
    commands,
    mcpServers:
      names.length > 0 ? { servers, allowedTools: names.map((server) => `mcp__${server}`) } : null,
  };
}

/**
 * Session MCP servers: the in-process `omniralph` server's (when there is
 * one) and the run's installable MCP servers; undefined when there are none.
 */
export function sessionMcpServers(
  harness: { config: McpServerConfig; allowedTools: readonly string[] } | null,
  executables: RunExecutables,
): { servers: Record<string, McpServerConfig>; allowedTools: string[] } | undefined {
  const installable = executables.mcpServers;
  if (!harness && !installable) return undefined;
  return {
    servers: {
      ...installable?.servers,
      ...(harness && { omniralph: harness.config }),
    },
    allowedTools: [...(harness?.allowedTools ?? []), ...(installable?.allowedTools ?? [])],
  };
}
