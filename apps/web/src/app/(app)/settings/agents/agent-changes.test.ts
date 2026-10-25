import { describe, expect, it } from "vitest";
import { getBuiltinRunSpec } from "@omniralph/tasks";
import type { CustomAgent } from "@/lib/api/definitions";
import { agentChanges, agentDraft, type AgentDraft } from "./agent-changes";

const reviewer: CustomAgent = getBuiltinRunSpec("builtin:review-pr")!.agent;

const AGENT = {
  ...reviewer,
  name: "Security reviewer",
  model: "claude-opus-5-5",
  fallbackModel: null,
  systemPromptMode: "append" as const,
  referenceDocs: [{ name: "owasp", content: "The OWASP top ten." }],
};

const saved = agentDraft(AGENT);
const changesTo = (change: Partial<AgentDraft>) => agentChanges(saved, { ...saved, ...change });

describe("agentChanges", () => {
  it("has none for the saved agent", () => {
    expect(agentChanges(saved, agentDraft(AGENT))).toEqual([]);
    expect(changesTo({ builtinTools: [...saved.builtinTools] })).toEqual([]);
  });

  it("lists each changed setting old → new, in form order", () => {
    expect(
      changesTo({
        systemPromptMode: "replace",
        fallbackModel: "claude-sonnet-5-5",
      }),
    ).toEqual([
      {
        key: "fallbackModel",
        label: "Fallback model",
        from: "Not set",
        to: "claude-sonnet-5-5",
      },
      {
        key: "systemPromptMode",
        label: "System prompt mode",
        from: "Append to the Claude Code system prompt",
        to: "Replace the Claude Code system prompt",
      },
    ]);
  });

  it("shows documents by name and size, and notices an edited document", () => {
    expect(
      changesTo({
        referenceDocs: [{ name: "owasp", content: "The OWASP top ten.\nAnd the CWE top 25." }],
      }),
    ).toEqual([
      {
        key: "referenceDocs",
        label: "Reference docs",
        from: "owasp (1 line, 18 characters)",
        to: "owasp (2 lines, 38 characters)",
      },
    ]);
    expect(changesTo({ referenceDocs: [] })).toEqual([
      {
        key: "referenceDocs",
        label: "Reference docs",
        from: "owasp (1 line, 18 characters)",
        to: "Not set",
      },
    ]);
  });

  it("keeps a system prompt whole so the confirmation can diff it", () => {
    const [change] = changesTo({ systemPrompt: "You review.\nBe brief." });
    expect(change?.to).toBe("You review.\nBe brief.");
  });
});
