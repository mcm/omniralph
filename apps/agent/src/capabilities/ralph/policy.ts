import { DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import type { ToolPolicy } from "../index.js";

/**
 * Story sessions build the story in the epic's branch worktree: Claude Code's
 * default tools without permission prompts, with the repository's project and
 * local settings (`CLAUDE.md`, skills, hooks). They commit nothing themselves;
 * the job commits and pushes after the quality gates. `ralph.request` sessions
 * use it too, and may commit and push their branch (a `pre-push` hook rejects
 * any other ref).
 */
export const RALPH_TOOL_POLICY: ToolPolicy = {
  tools: "claude_code",
  allowedTools: [],
  disallowedTools: [],
  fileScope: "cwd",
  permissionMode: "bypassPermissions",
  settingSources: ["project", "local"],
  writable: true,
};

/** Read-only git commands a `ralph.describe-pr` session may run to study the branch. */
export const DESCRIBE_PR_GIT_COMMANDS: readonly string[] = [
  "git log",
  "git diff",
  "git show",
  "git status",
  "git rev-parse",
  "git merge-base",
  "git ls-files",
];

/**
 * `ralph.describe-pr` only reads the branch worktree to describe it: Read,
 * Grep and Glob confined to the worktree, plus read-only git commands. No
 * Write, Edit or other shell use.
 */
export const RALPH_DESCRIBE_PR_TOOL_POLICY: ToolPolicy = {
  tools: "allowed",
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  settingSources: [],
  writable: false,
  readOnlyCommands: DESCRIBE_PR_GIT_COMMANDS,
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
