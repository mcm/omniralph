import { DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import type { Capability, ToolPolicy } from "./index.js";

/** Review sessions only read the job's worktree (the engine's Claude provider enforces the same lists). */
export const REVIEW_TOOL_POLICY: ToolPolicy = {
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  loadProjectSettings: false,
};

/**
 * Code review. The runner (repo cache, worktree, engine, result upload) lands
 * with US-012; until then review jobs fail without retries.
 */
export const reviewCapability: Capability = {
  name: "review",
  jobTypes: ["review.run"],
  toolPolicy: REVIEW_TOOL_POLICY,
  async run() {
    throw new Error("the review capability is not implemented in this agent build yet");
  },
};
