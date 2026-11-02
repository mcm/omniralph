import { auditEpicTemplateContext, type AuditEpicPromptContext } from "@omniralph/ralph";
import { describe, expect, it } from "vitest";
import { getBuiltinTask } from "../builtins.js";
import { EPIC_AUDIT_OUTPUT_SCHEMA, epicAuditProblem } from "../coding.js";
import { outputSchemaProblem } from "../output-schema.js";
import { renderTemplate, validateTemplate } from "../template.js";
import { availableVariables, taskCatalog } from "../variables.js";

const task = getBuiltinTask("builtin:audit-epic")!;

const CONTEXT: AuditEpicPromptContext = {
  branch: "omniralph/eng-1-priorities",
  baseBranch: "main",
  epic: {
    identifier: "ENG-1",
    title: "Task priorities",
    description: "## Problem\nNo priorities.",
  },
  requirements: [
    { id: "FR-1", text: "The system must store a priority on every task." },
    { id: "FR-2", text: "The system must show each task's priority as a badge." },
  ],
  tasks: [
    {
      identifier: "ENG-2",
      title: "Store task priorities",
      repository: null,
      acceptanceCriteria: ["Tasks have a priority, medium by default"],
    },
    {
      identifier: "ENG-3",
      title: "Show the badge",
      repository: "acme/web",
      acceptanceCriteria: [],
    },
  ],
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  round: 1,
  maxRounds: 2,
  prTerm: "pull request",
};

function render(ctx: AuditEpicPromptContext): string {
  return renderTemplate(
    task.promptTemplate,
    auditEpicTemplateContext(ctx) as unknown as Record<string, unknown>,
    taskCatalog(task),
  );
}

describe("builtin:audit-epic", () => {
  it("is a read-only query task the story run invokes, whose output is an epic audit", () => {
    expect(task).toMatchObject({
      taskType: "query",
      agentId: "builtin:audit-epic",
      triggers: ["run.invoked"],
      sink: "run-result",
      toolSettings: { shell: true, trackerRead: false, network: false },
    });
    expect(epicAuditProblem(task)).toBeNull();
    expect(outputSchemaProblem(task.outputSchema!, EPIC_AUDIT_OUTPUT_SCHEMA)).toBeNull();
    expect(
      validateTemplate(task.promptTemplate, availableVariables("query", ["run.invoked"])),
    ).toEqual([]);
  });

  it("lists each requirement and the tasks' criteria, marking tasks done in another repo", async () => {
    const prompt = render(CONTEXT);
    expect(prompt).toContain("### FR-1\n```\nThe system must store a priority on every task.\n```");
    expect(prompt).toContain(
      "Acceptance criteria:\n```\nTasks have a priority, medium by default\n```",
    );
    expect(prompt).toContain("### ENG-3: Show the badge (in `acme/web`, not this checkout)");
    expect(prompt).toContain("checkout of `0123456789abcdef0123456789abcdef01234567`");
    expect(prompt).not.toContain("last audit round");
    await expect(prompt).toMatchFileSnapshot("__snapshots__/audit-epic.first-round.md");
  });

  it("audits the branch as checked out without a commit, and warns on the last round", async () => {
    const prompt = render({ ...CONTEXT, commitSha: null, round: 2, prTerm: "merge request" });
    expect(prompt).toContain("checkout of `omniralph/eng-1-priorities`, the epic's branch");
    expect(prompt).toContain("This is the last audit round");
    expect(prompt).toContain("listed in the merge request description");
    await expect(prompt).toMatchFileSnapshot("__snapshots__/audit-epic.last-round.md");
  });
});
