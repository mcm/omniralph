import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBuiltinRunSpec, getBuiltinTask } from "../builtins.js";
import { renderTemplate, validateTemplate } from "../template.js";
import { availableVariables, VARIABLES } from "../variables.js";

interface Fixture {
  finding: {
    path: string;
    startLine: number;
    endLine: number;
    severity: string;
    category: string;
    title: string;
    body: string;
  };
  hunk: string | null;
  note: string | null;
}

/** Inputs shared with `@omniralph/engine`'s learn-rule test, which renders them with `buildLearnRulePrompt`. */
const FIXTURES = JSON.parse(
  readFileSync(new URL("./__fixtures__/learn-rule.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;

/** The trigger context `enqueueLearnRule` stores, plus the query variables the harness computes. */
function context({ finding, hunk, note }: Fixture): Record<string, unknown> {
  return {
    feedbackId: "f0f0f0f0-0000-4000-8000-000000000001",
    repository: "acme/app",
    finding: {
      ...finding,
      id: "f0f0f0f0-0000-4000-8000-000000000002",
      file: JSON.stringify(finding.path),
      location:
        finding.startLine === finding.endLine
          ? `line ${finding.startLine}`
          : `lines ${finding.startLine}-${finding.endLine}`,
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
    },
    dismissal: { note: note?.trim() ?? "" },
    question: null,
    hunk,
    conventions: null,
  };
}

const task = getBuiltinTask("builtin:learn-rule")!;
const agent = getBuiltinRunSpec("builtin:learn-rule")!.agent;

function render(fixture: Fixture): string {
  return renderTemplate(task.promptTemplate, context(fixture), VARIABLES, task.variableLimits);
}

describe("builtin:learn-rule", () => {
  it("runs with the rule writer persona as a query task with no tools and no preset", () => {
    expect(agent).toMatchObject({
      systemPromptMode: "replace",
      tools: { builtin: [], harness: [], linear: [], mcpServers: [] },
      model: "claude-sonnet-5-5",
    });
    expect(task).toMatchObject({
      taskType: "query",
      agentId: "builtin:learn-rule",
      triggers: ["finding.dismissed"],
      sink: "learned-rule",
      model: "claude-sonnet-5-5",
      tokenBudget: { tokens: 5000 },
      toolSettings: { shell: false, linearRead: false, network: false },
    });
    expect(
      validateTemplate(task.promptTemplate, availableVariables("query", task.triggers)),
    ).toEqual([]);
  });

  // Each snapshot equals `buildLearnRulePrompt` for the same inputs: the engine's learn-rule test compares against these files.
  it.each(Object.keys(FIXTURES))("renders the prompt of today's builder (%s)", async (name) => {
    await expect(render(FIXTURES[name]!)).toMatchFileSnapshot(
      `__snapshots__/learn-rule.${name}.md`,
    );
  });

  it("fences untrusted values and quotes the path", () => {
    const prompt = render(FIXTURES["without-hunk"]!);
    expect(prompt).toContain('File: "src/we\\"ird path.ts"\nLocation: line 7\n');
    expect(prompt).toContain("(not available)");
    expect(prompt).toContain("(none; the finding was marked a false positive without a note)");
    expect(prompt).toMatch(/Body:\n````markdown\n/);
  });
});
