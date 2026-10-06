import { DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import {
  RALPH_CAPABILITY,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_JOB_TYPES,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
} from "@omniralph/shared";
import type { Capability, ToolPolicy } from "./index.js";

/**
 * Story sessions build the story in the epic's branch worktree: Claude Code's
 * default tools without permission prompts, with the repository's project and
 * local settings (`CLAUDE.md`, skills, hooks). They commit nothing themselves;
 * the job commits and pushes after the quality gates.
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

/** `ralph.describe-pr` only reads the branch worktree to describe it: no Write, Edit or shell. */
export const RALPH_DESCRIBE_PR_TOOL_POLICY: ToolPolicy = {
  tools: "allowed",
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  settingSources: [],
  writable: false,
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

/** A job type this build registers but can't run yet; failing it is final, not retried. */
export class NotImplementedJobError extends Error {
  override name = "NotImplementedJobError";
}

/**
 * Builds a delegated Linear epic story by story (ported from cyralph). The
 * control panel orchestrates the run; this capability runs its jobs:
 * `ralph.story`, `ralph.describe-pr` and `ralph.prepare`.
 */
export const ralphCapability: Capability = {
  name: RALPH_CAPABILITY,
  jobTypes: RALPH_JOB_TYPES,
  toolPolicy: RALPH_TOOL_POLICY,
  jobToolPolicies: {
    [RALPH_STORY_JOB_TYPE]: RALPH_TOOL_POLICY,
    [RALPH_DESCRIBE_PR_JOB_TYPE]: RALPH_DESCRIBE_PR_TOOL_POLICY,
    [RALPH_PREPARE_JOB_TYPE]: RALPH_PREPARE_TOOL_POLICY,
  },
  run(job) {
    return Promise.reject(
      new NotImplementedJobError(`${job.type} jobs are not supported by this agent yet`),
    );
  },
};
