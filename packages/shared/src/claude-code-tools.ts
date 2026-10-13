/**
 * Claude Code's built-in tool names, as the Agent SDK's `allowedTools` / `disallowedTools`
 * take them. Settings pickers suggest these; permission rules such as `Bash(pnpm test:*)` and
 * MCP tool names stay valid, so this list is never used to reject a value.
 */
export const CLAUDE_CODE_TOOLS = [
  "Agent",
  "Bash",
  "BashOutput",
  "Edit",
  "Glob",
  "Grep",
  "KillShell",
  "ListMcpResourcesTool",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "ReadMcpResourceTool",
  "Skill",
  "SlashCommand",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;
