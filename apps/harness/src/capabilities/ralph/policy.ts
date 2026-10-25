import type { ToolPolicy } from "../index.js";

/**
 * Coding sessions build in the lane's branch worktree: Claude Code's default
 * tools without permission prompts, with the agent user's settings
 * (`~/.claude`: skills, `CLAUDE.md`, plugins, MCP servers) and the repository's
 * project and local settings (`CLAUDE.md`, skills, hooks). Story sessions
 * commit nothing themselves (the run commits and pushes after the quality
 * gates); request sessions may commit and push their branch (a `pre-push`
 * hook rejects any other ref).
 */
export const RALPH_TOOL_POLICY: ToolPolicy = {
  tools: "claude_code",
  allowedTools: [],
  disallowedTools: [],
  fileScope: "cwd",
  permissionMode: "bypassPermissions",
  settingSources: ["user", "project", "local"],
  writable: true,
};

/** `ralph.prepare` runs approved commands and no Claude session at all. */
export const RALPH_PREPARE_TOOL_POLICY: ToolPolicy = {
  tools: "allowed",
  allowedTools: [],
  disallowedTools: [],
  fileScope: "worktree",
  permissionMode: "dontAsk",
  settingSources: [],
  writable: false,
};

/** `ralph.cleanup` runs git in the agent's repo cache and no Claude session at all. */
export const RALPH_CLEANUP_TOOL_POLICY: ToolPolicy = RALPH_PREPARE_TOOL_POLICY;
