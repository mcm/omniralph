import { DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import type { ToolPolicy } from "../index.js";

/**
 * `triage.run` sessions only read: Read, Grep and Glob confined to the
 * checkout of the repository's default branch (or an empty directory when no
 * repository is routed). No shell, no writes, no network, no skills, plugins
 * or MCP servers, like review and `ralph.describe-pr` sessions.
 */
export const TRIAGE_TOOL_POLICY: ToolPolicy = {
  tools: "allowed",
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  settingSources: [],
  writable: false,
};
