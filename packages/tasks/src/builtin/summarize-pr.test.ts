import { describe, expect, it } from "vitest";
import { getBuiltinTask } from "../builtins.js";
import { renderTemplate, validateTemplate } from "../template.js";
import { availableVariables, taskCatalog } from "../variables.js";

const task = getBuiltinTask("builtin:summarize-pr")!;

describe("builtin:summarize-pr", () => {
  it("runs with the reviewer persona as a summary-only review task posting to a sticky comment", () => {
    expect(task).toMatchObject({
      taskType: "review",
      agentId: "builtin:summarize-pr",
      triggers: ["pr.updated", "pr.mention", "review.rerun"],
      sink: "sticky-comment",
      tokenBudget: null,
    });
    expect(task.systemAppend).toContain('{"findings": [], "summary": string}');
  });

  it.each(["pr.updated", "pr.mention", "review.rerun"] as const)(
    "has a template valid for the %s trigger",
    (trigger) => {
      expect(
        validateTemplate(task.promptTemplate, availableVariables("review", [trigger])),
      ).toEqual([]);
    },
  );

  it("asks for a summary only, with the change request and diff fenced", () => {
    const prompt = renderTemplate(
      task.promptTemplate,
      {
        repository: "acme/app",
        pr: { number: 7, title: "Add widgets", body: null },
        diff: "@@ -1 +1 @@\n-a\n+b",
      },
      taskCatalog(task),
    );
    expect(prompt).toContain("report no findings");
    expect(prompt).toContain("(none)");
    expect(prompt).toMatch(/```diff\n@@ -1 \+1 @@\n-a\n\+b\n```/);
  });
});
