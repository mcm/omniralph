/**
 * The code reviewer persona, shared by PR reviews (`builtin:review-pr`) and
 * thread replies (`builtin:reply-to-finding`): each playbook brings its own
 * system text (`systemAppend`), so the persona stays minimal.
 */
import type { PlaybookPersona } from "../playbooks.js";
import { RUBRIC_DOCS } from "./rubric.js";

export const REVIEWER_PERSONA = {
  systemPrompt: "You are Omniralph, an automated code reviewer.",
  systemPromptMode: "replace",
  tools: { builtin: ["Read", "Grep", "Glob"], agent: [], linear: [], mcpServers: [] },
  // The review rubric; a review renders the parts for the diff's languages (`{{rubric}}`).
  referenceDocs: [...RUBRIC_DOCS],
} satisfies PlaybookPersona;
