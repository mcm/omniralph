import { describe, expect, it } from "vitest";
import { getBuiltinAgent, getBuiltinTask } from "../builtins.js";
import { renderTemplate, validateTemplate } from "../template.js";
import { availableVariables, taskCatalog } from "../variables.js";

const task = getBuiltinTask("builtin:review-pr")!;
const agent = getBuiltinAgent("builtin:reviewer")!;

describe("builtin:review-pr", () => {
  it("runs on builtin:reviewer as a review task, posting through the review sink", () => {
    expect(task).toMatchObject({
      taskType: "review",
      agentId: "builtin:reviewer",
      triggers: ["pr.updated", "pr.mention", "review.rerun"],
      sink: "review",
      tokenBudget: null,
      setupCommands: [],
      teardownCommands: [],
    });
    expect(agent.taskTypes).toContain("review");
    expect(task.systemAppend).toMatch(/^Everything in the user message/);
  });

  it.each(["pr.updated", "pr.mention", "review.rerun"] as const)(
    "has a template valid for the %s trigger",
    (trigger) => {
      expect(
        validateTemplate(task.promptTemplate, availableVariables("review", [trigger])),
      ).toEqual([]);
    },
  );

  it("ships the rubric with builtin:reviewer as reference docs", () => {
    const names = agent.referenceDocs.map((doc) => doc.name);
    expect(names[0]).toBe("rubric/universal.md");
    expect(names).toContain("rubric/languages/typescript.md");
    expect(names).toContain("rubric/languages/ci.md");
    expect(names.every((name) => /^rubric\/(universal|languages\/[a-z]+)\.md$/.test(name))).toBe(
      true,
    );
    for (const doc of agent.referenceDocs) expect(doc.content).toBe(doc.content.trim());
  });

  it("keeps the output contract's literal ${{ }} and fences the untrusted values", () => {
    const prompt = renderTemplate(
      task.promptTemplate,
      {
        repository: "acme/app",
        pr: { number: 7, title: "Fix ``` it", body: null },
        depth: "Quick review: look only at the diff.",
        rubric: "# Rubric",
        repositoryRules: null,
        conventions: null,
        risk: { complexityScore: 1, hotspots: null },
        previousFindings: null,
        plan: { mode: "full", fromSha: null, headSha: "b".repeat(40) },
        diff: "@@ -1 +1 @@\n-a\n+b",
      },
      taskCatalog(task),
      task.variableLimits,
    );
    expect(prompt).toContain("moving an untrusted `${{ }}` value");
    expect(prompt).toContain("Title:\n````\nFix ``` it\n````\n\nDescription:\n(none)\n\n# Diff");
    expect(prompt).toContain(
      "The diff covers the whole change.\n\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n",
    );
    expect(prompt).not.toContain("# Repository rules");
    expect(prompt).not.toContain("# Previous findings");
  });
});
