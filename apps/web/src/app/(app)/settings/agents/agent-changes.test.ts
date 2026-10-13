import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS, type AgentDefinition } from "@omniralph/tasks";
import { agentChanges, agentDraft, type AgentDraft } from "./agent-changes";

const reviewer = BUILTIN_AGENTS.find((agent) => agent.id === "builtin:reviewer") as AgentDefinition;

const AGENT = {
  ...reviewer,
  name: "Security reviewer",
  model: "claude-opus-5-5",
  fallbackModel: null,
  systemPromptMode: "append" as const,
  skills: [{ name: "owasp", content: "The OWASP top ten." }],
  referenceDocs: [],
};

const saved = agentDraft(AGENT);
const changesTo = (change: Partial<AgentDraft>) => agentChanges(saved, { ...saved, ...change });

describe("agentChanges", () => {
  it("has none for the saved agent, whatever the list spacing", () => {
    expect(agentChanges(saved, agentDraft(AGENT))).toEqual([]);
    expect(changesTo({ builtinTools: saved.builtinTools.replaceAll(", ", ",") })).toEqual([]);
  });

  it("lists each changed setting old → new, in form order", () => {
    expect(
      changesTo({
        systemPromptMode: "replace",
        fallbackModel: "claude-sonnet-5-5",
        taskTypes: ["query"],
      }),
    ).toEqual([
      {
        key: "taskTypes",
        label: "Suited task types",
        from: AGENT.taskTypes.join(", "),
        to: "query",
      },
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
        skills: [{ name: "owasp", content: "The OWASP top ten.\nAnd the CWE top 25." }],
      }),
    ).toEqual([
      {
        key: "skills",
        label: "Skills",
        from: "owasp (1 line, 18 characters)",
        to: "owasp (2 lines, 38 characters)",
      },
    ]);
    expect(changesTo({ referenceDocs: [{ name: "threat-model", content: "a" }] })).toEqual([
      {
        key: "referenceDocs",
        label: "Reference docs",
        from: "Not set",
        to: "threat-model (1 line, 1 character)",
      },
    ]);
  });

  it("keeps a system prompt whole so the confirmation can diff it", () => {
    const [change] = changesTo({ systemPrompt: "You review.\nBe brief." });
    expect(change?.to).toBe("You review.\nBe brief.");
  });
});
