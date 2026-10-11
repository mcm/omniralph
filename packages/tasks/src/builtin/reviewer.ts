/**
 * The code reviewer persona, shared by PR reviews (`builtin:review-pr`) and
 * thread replies (`builtin:reply-to-finding`): each task brings its own
 * system text (`systemAppend`), so the persona stays minimal.
 */
import type { AgentDefinitionInput } from "../definitions.js";
import { RUBRIC_DOCS } from "./rubric.js";

export const REVIEWER_AGENT: AgentDefinitionInput = {
  id: "builtin:reviewer",
  name: "Reviewer",
  description: "Omniralph's code reviewer. Reads the checkout (Read, Grep, Glob); never writes.",
  systemPrompt: "You are Omniralph, an automated code reviewer.",
  systemPromptMode: "replace",
  tools: { builtin: ["Read", "Grep", "Glob"], harness: [], linear: [], mcpServers: [] },
  // The review rubric; a review renders the parts for the diff's languages (`{{rubric}}`).
  referenceDocs: [...RUBRIC_DOCS],
  taskTypes: ["query", "review"],
};
