import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  worktreeGuard,
  type SessionPermissions,
  type SessionPermissionsBuilder,
} from "@omniralph/engine";
import { ruleTool } from "@omniralph/shared";
import type { ToolPolicy } from "./index.js";

/**
 * The SDK permission options of a capability's sessions, built from its tool
 * policy: the tools, the allow/deny lists, the permission mode, the setting
 * sources and the worktree scope. A session with `allowExploration: false`
 * (a repair turn, a no-tool generation) gets no tools at all.
 *
 * Throws for a policy that bypasses permissions without being write-capable,
 * so a read-only capability can never end up with `bypassPermissions`.
 */
export function sdkPermissions(policy: ToolPolicy): SessionPermissionsBuilder {
  if (policy.permissionMode === "bypassPermissions" && !policy.writable) {
    throw new Error("only write-capable tool policies may bypass permissions");
  }
  const commands = policy.readOnlyCommands ?? [];
  if (commands.length > 0 && (policy.writable || policy.tools !== "allowed")) {
    throw new Error(
      "read-only commands are only for read-only policies with an explicit tool list",
    );
  }
  return ({ cwd, allowExploration }): SessionPermissions => {
    const allowed = allowExploration ? [...policy.allowedTools] : [];
    const shell = allowExploration && commands.length > 0;
    const tools: SessionPermissions["tools"] = !allowExploration
      ? []
      : policy.tools === "claude_code"
        ? { type: "preset", preset: "claude_code" }
        : [...policy.allowedTools, ...(shell ? ["Bash"] : [])];
    const guarded = policy.fileScope === "worktree" && allowed.length > 0;
    const preToolUse = [
      ...(guarded ? [{ matcher: allowed.join("|"), hooks: [worktreeGuard(cwd)] }] : []),
      ...(shell ? [{ matcher: "Bash", hooks: [readOnlyCommandGuard(commands)] }] : []),
    ];
    return {
      cwd,
      tools,
      allowedTools: [...allowed, ...(shell ? commands.map((c) => `Bash(${c}:*)`) : [])],
      disallowedTools: shell
        ? policy.disallowedTools.filter((t) => t !== "Bash")
        : [...policy.disallowedTools],
      permissionMode: policy.permissionMode,
      ...(policy.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      settingSources: [...policy.settingSources],
      // Without setting sources, nothing may come in some other way either.
      ...(policy.settingSources.length === 0
        ? { skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true }
        : {}),
      hooks: preToolUse.length > 0 ? { PreToolUse: preToolUse } : {},
    };
  };
}

/** A repository's tool settings (`allowedTools`/`disallowedTools`; null or empty for none). */
export interface ToolRestrictions {
  allowedTools?: readonly string[] | null;
  disallowedTools?: readonly string[] | null;
}

export { ruleTool };

const unique = (values: readonly string[]) => [...new Set(values)];

/**
 * A session's permissions narrowed by a repository's tool settings: they can
 * take tools away, never add any. `disallowedTools` are denied on top of the
 * policy's. With `allowedTools`, only their tools stay available (of those the
 * policy offers), and only calls matching them run: a session that bypassed
 * permissions gets `dontAsk` with the repository's rules as its only approvals,
 * and the policy's own approvals are kept only where the repository allows them.
 */
export function narrowPermissions(
  permissions: SessionPermissions,
  restrictions: ToolRestrictions | undefined,
): SessionPermissions {
  const disallowedTools = unique([
    ...(permissions.disallowedTools ?? []),
    ...(restrictions?.disallowedTools ?? []),
  ]);
  const allowed = restrictions?.allowedTools ?? [];
  if (allowed.length === 0) return { ...permissions, disallowedTools };

  const names = new Set(allowed.map(ruleTool));
  const current = permissions.tools;
  const tools = Array.isArray(current)
    ? current.filter((tool) => names.has(tool))
    : [...names].filter((tool) => !tool.startsWith("mcp__"));
  const available = (rule: string) =>
    ruleTool(rule).startsWith("mcp__") || tools.includes(ruleTool(rule));
  const bypassing = permissions.permissionMode === "bypassPermissions";
  const allowedTools = bypassing
    ? unique(allowed.filter(available))
    : (permissions.allowedTools ?? []).filter(
        (rule) => available(rule) && (allowed.includes(rule) || allowed.includes(ruleTool(rule))),
      );
  const narrowed: SessionPermissions = {
    ...permissions,
    tools,
    allowedTools,
    disallowedTools,
    permissionMode: bypassing ? "dontAsk" : permissions.permissionMode,
  };
  delete narrowed.allowDangerouslySkipPermissions;
  return narrowed;
}

/** Shell syntax beyond one plain command (chaining, pipes, redirection, substitution, globbing). */
const SHELL_SYNTAX = /[;&|<>`$(){}[\]*?!\\\n\r]/;
/** git options that write files, run other programs or read outside the repository. */
const UNSAFE_GIT_OPTIONS =
  /(^|\s)(--output(=|\s|$)|-o(\s|$)|--ext-diff|--textconv|--no-index|--exec|--upload-pack|-c\s|--git-dir|--work-tree|-C\s)/;

/** Whether a Bash command is exactly one of `commands` with plain arguments. */
export function isReadOnlyCommand(command: string, commands: readonly string[]): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd || UNSAFE_GIT_OPTIONS.test(cmd)) return false;
  return commands.some((c) => cmd === c || cmd.startsWith(`${c} `));
}

/**
 * Denies every Bash call that isn't one of `commands` with plain arguments.
 * The `Bash(<command>:*)` permission rules already do most of this; the hook
 * also refuses options that would write files or run other programs.
 */
export function readOnlyCommandGuard(commands: readonly string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && isReadOnlyCommand(command, commands)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Only these read-only commands may run, without shell syntax: ${commands.join(", ")}.`,
      },
    };
  };
}
