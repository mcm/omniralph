/**
 * The executables a run may use from its host: the task's host tools and
 * the commands and MCP servers of its required installables, each by its
 * absolute path, never by name from the run's `PATH` (which the code being
 * worked on or reviewed may put its own binary in front of).
 */
import type { McpServerConfig, McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { RunSpec, RunTrigger } from "@omniralph/shared";
import {
  deriveAgentRequirements,
  type TriggerKind,
  parseInstallableMcpServerRef,
  resolveInstallablePaths,
} from "@omniralph/tasks";
import { RetryableJobError, type JobContext } from "../capabilities/index.js";
import { installableSkillPlugin, type InstallableSkills } from "../installable-skills.js";
import {
  installableCacheEnv,
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
   * Absolute path by command name: the task's host tools (their checked
   * paths), then the commands of the required installables (a name taken
   * by a host tool keeps the host tool; two installables providing one name
   * fail the run).
   */
  commands: ReadonlyMap<string, string>;
  /**
   * Extra environment by command name, for the installable commands in
   * `commands`: their installable's cache directories
   * (`OMNIRALPH_CACHE_DIR`, `OMNIRALPH_PR_CACHE_DIR`).
   */
  commandEnv: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /**
   * The installable MCP servers the agent lists (`<package>:<server>`), for
   * `SessionRequest.mcpServers`; null when it lists none.
   */
  mcpServers: { servers: Record<string, McpStdioServerConfig>; allowedTools: string[] } | null;
  /**
   * The skills of the required installables, as plugins the agent wrote
   * (`installableSkillPlugin`), for `SessionRequest.skills`; null when they
   * have none.
   */
  skills: InstallableSkills | null;
}

/** No host tools, installable commands or MCP servers. */
export const NO_EXECUTABLES: RunExecutables = {
  commands: new Map(),
  commandEnv: new Map(),
  mcpServers: null,
  skills: null,
};

/** Triggers whose context carries the PR (`pr.number`) a run is about. */
const PR_CACHE_TRIGGERS: ReadonlySet<TriggerKind> = new Set<TriggerKind>([
  "pr.updated",
  "pr.mention",
  "review.rerun",
  "finding.mention",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
]);

/** The PR a run of a PR trigger is about (`context.pr.number`); null for other triggers. */
export function runPrNumber(trigger: RunTrigger | undefined): number | null {
  if (!trigger || !PR_CACHE_TRIGGERS.has(trigger.kind)) return null;
  const pr = trigger.context.pr;
  const number = pr && typeof pr === "object" ? (pr as { number?: unknown }).number : undefined;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}

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
 * tool in the task's `requires.hostTools` by its checked path
 * (`ctx.hostToolPath`), and each installable the run requires (the task's
 * `requires.installables` and those whose MCP servers the agent lists) in the
 * agent's installables prefix under `ctx.dataDir`. A missing host tool or
 * installable throws `RetryableJobError` (the claim saw it, so it went away
 * since, or its new configured path isn't checked yet); an MCP server the
 * installed version doesn't provide, a command name two installables provide,
 * two MCP servers with one session name, and any path the local config's
 * `blockedExecPaths` cover (`ctx.execPathBlocked`) throw. Each installable's commands and
 * MCP servers get its cache directories for the run's repository
 * (`spec.repositoryId`) and, on a PR trigger, its PR (`installableCacheEnv`).
 * The skills of every required installable are loaded into the run's
 * sessions (`installableSkillPlugin`); an installable the run doesn't
 * require never is.
 */
export async function resolveRunExecutables(
  spec: Pick<RunSpec, "task" | "agent"> & Partial<Pick<RunSpec, "trigger" | "repositoryId">>,
  ctx: Pick<JobContext, "hostToolPath" | "dataDir" | "execPathBlocked"> &
    Partial<Pick<JobContext, "logger">>,
): Promise<RunExecutables> {
  const { installables, hostTools } = deriveAgentRequirements(spec.task, spec.agent);
  if (installables.length === 0 && hostTools.length === 0) return NO_EXECUTABLES;

  const checkBlocked = async (file: string, what: string) => {
    if (await ctx.execPathBlocked?.(file)) {
      throw new Error(`${file} (${what}) is blocked by blockedExecPaths on this agent`);
    }
  };

  const commands = new Map<string, string>();
  for (const name of hostTools) {
    const toolPath = ctx.hostToolPath?.(name) ?? null;
    if (toolPath === null) {
      throw new RetryableJobError(
        `the host tool ${name} is not available on this agent`,
        MISSING_EXECUTABLE_RETRY_SECONDS,
      );
    }
    await checkBlocked(toolPath, `the host tool ${name}`);
    commands.set(name, toolPath);
  }

  const mcpRefs = [...new Set(spec.agent.tools.mcpServers)].flatMap((entry) => {
    const ref = parseInstallableMcpServerRef(entry);
    return ref ? [{ ...ref, entry }] : [];
  });
  const serverEntries = new Map<string, string>();
  const commandOwners = new Map<string, string>();
  const servers: Record<string, McpStdioServerConfig> = {};
  const commandEnv = new Map<string, Record<string, string>>();
  const skills: InstallableSkills = { plugins: [], skills: [] };
  const pluginOwners = new Map<string, string>();
  if (installables.length > 0) {
    const missing = (name: string) =>
      new RetryableJobError(
        `the installable ${name} is not installed on this agent`,
        MISSING_EXECUTABLE_RETRY_SECONDS,
      );
    if (ctx.dataDir === undefined) throw missing(installables[0]!);
    const installed = new Set(
      (await listInstalledInstallables(ctx.dataDir, ctx.logger)).map((i) => i.name),
    );
    const prefix = installablesPrefix(ctx.dataDir);
    const cacheRun = {
      repositoryId: spec.repositoryId ?? null,
      prNumber: runPrNumber(spec.trigger),
    };
    for (const name of installables) {
      const parsed = installed.has(name) ? await readInstalledPackage(prefix, name) : null;
      if (!parsed?.ok) throw missing(name);
      const { manifest } = parsed.installable;
      const paths = resolveInstallablePaths(installablePackageDir(prefix, name), manifest);
      const cacheEnv = await installableCacheEnv(ctx.dataDir, name, cacheRun);
      const plugin = await installableSkillPlugin(ctx.dataDir, name, paths.skills);
      if (plugin) {
        const other = pluginOwners.get(plugin.name);
        if (other !== undefined) {
          throw new Error(
            `the skills of the installables ${other} and ${name} both have the plugin name ${plugin.name}`,
          );
        }
        pluginOwners.set(plugin.name, name);
        skills.plugins.push({ type: "local", path: plugin.path, skipMcpDiscovery: true });
        skills.skills.push(...plugin.skills);
      }
      for (const [command, bin] of Object.entries(paths.commands)) {
        const owner = commandOwners.get(command);
        if (owner !== undefined) {
          throw new Error(
            `the installables ${owner} and ${name} both provide the command ${command}`,
          );
        }
        commandOwners.set(command, name);
        if (commands.has(command)) continue;
        await checkBlocked(bin, `the command ${command} of ${name}`);
        commands.set(command, bin);
        commandEnv.set(command, cacheEnv);
      }
      for (const ref of mcpRefs.filter((r) => r.installable === name)) {
        const server = manifest.mcpServers.find((s) => s.name === ref.server);
        if (!server) {
          throw new Error(
            `the installable ${name} ${parsed.installable.version} has no MCP server ${ref.server}`,
          );
        }
        const key = installableMcpServerName(name, server.name);
        const other = serverEntries.get(key);
        if (other !== undefined) {
          throw new Error(
            `the MCP servers ${other} and ${ref.entry} both have the session name ${key}`,
          );
        }
        serverEntries.set(key, ref.entry);
        const command = paths.mcpServers[server.name]!;
        await checkBlocked(command, `the MCP server ${ref.entry}`);
        servers[key] = {
          type: "stdio",
          command,
          args: [...server.args],
          ...(Object.keys(cacheEnv).length > 0 && { env: { ...cacheEnv } }),
        };
      }
    }
  }
  const names = Object.keys(servers);
  return {
    commands,
    commandEnv,
    mcpServers:
      names.length > 0 ? { servers, allowedTools: names.map((server) => `mcp__${server}`) } : null,
    skills: skills.plugins.length > 0 ? skills : null,
  };
}

/**
 * Session MCP servers: the in-process `omniralph` server's (when there is
 * one) and the run's installable MCP servers; undefined when there are none.
 */
export function sessionMcpServers(
  omniralph: { config: McpServerConfig; allowedTools: readonly string[] } | null,
  executables: RunExecutables,
): { servers: Record<string, McpServerConfig>; allowedTools: string[] } | undefined {
  const installable = executables.mcpServers;
  if (!omniralph && !installable) return undefined;
  return {
    servers: {
      ...installable?.servers,
      ...(omniralph && { omniralph: omniralph.config }),
    },
    allowedTools: [...(omniralph?.allowedTools ?? []), ...(installable?.allowedTools ?? [])],
  };
}
