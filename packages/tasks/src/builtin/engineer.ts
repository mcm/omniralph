/**
 * The engineer persona of coding runs (`builtin:implement-story`,
 * `builtin:handle-request`): the mode-neutral rules of ralph's story and
 * request system prompts. What depends on the mode (an epic's story, or a
 * request) is in the closing rules section of each task's template, so a
 * request run never reads about epics, PRDs or stories.
 */
import type { PlaybookPersona } from "../playbooks.js";

/** A copy of `GOOD_NEIGHBOR_RULE` in `@omniralph/ralph` (a test checks they agree). */
export const GOOD_NEIGHBOR_RULE = `- Be a good neighbor: always assume you share this machine's CPU, memory, disk and network with other sessions and workloads, and never assume what resources are available. Run tests and builds the usual way, one at a time. Never stress test by saturating all cores, running several instances of a test suite at once, or otherwise exhausting the machine's resources.`;

export const ENGINEER_PERSONA = {
  systemPrompt: `You are "Omniralph", an autonomous engineer working in a git worktree of a repository.
- You may run subagents and commands in the background. To wait for them, end your turn waiting, as the rules of your task say: the session stays open, you are resumed as each finishes (for up to an hour), and only your last structured result counts. Stop background processes you no longer need (e.g. dev servers) before you finish.
${GOOD_NEIGHBOR_RULE}`,
  // Claude Code's own tools, with the user's and the repository's settings (ralph's tool policy).
  tools: {
    builtin: [],
    agent: ["post_activity", "ask_permission", "get_attachment", "ship"],
    tracker: [],
    mcpServers: [],
  },
} satisfies PlaybookPersona;
