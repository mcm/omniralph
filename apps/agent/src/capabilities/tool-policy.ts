import {
  worktreeGuard,
  type SessionPermissions,
  type SessionPermissionsBuilder,
} from "@omniralph/engine";
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
  return ({ cwd, allowExploration }): SessionPermissions => {
    const allowed = allowExploration ? [...policy.allowedTools] : [];
    const tools: SessionPermissions["tools"] = !allowExploration
      ? []
      : policy.tools === "claude_code"
        ? { type: "preset", preset: "claude_code" }
        : [...policy.allowedTools];
    const guarded = policy.fileScope === "worktree" && allowed.length > 0;
    return {
      cwd,
      tools,
      allowedTools: allowed,
      disallowedTools: [...policy.disallowedTools],
      permissionMode: policy.permissionMode,
      ...(policy.permissionMode === "bypassPermissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      settingSources: [...policy.settingSources],
      // Without setting sources, nothing may come in some other way either.
      ...(policy.settingSources.length === 0
        ? { skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true }
        : {}),
      hooks: guarded
        ? { PreToolUse: [{ matcher: allowed.join("|"), hooks: [worktreeGuard(cwd)] }] }
        : {},
    };
  };
}
