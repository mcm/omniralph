import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkItem } from "@omniralph/planning";
import { verifyTaskTemplateContext, type VerifyTaskPromptContext } from "@omniralph/ralph";
import { afterAll, describe, expect, it } from "vitest";
import { getBuiltinTask } from "../builtins.js";
import { renderTemplate, validateTemplate } from "../template.js";
import { availableVariables, taskCatalog, taskVariables } from "../variables.js";
import { TASK_DIFF_COMMAND } from "./verify-task.js";

const task = getBuiltinTask("builtin:verify-task")!;

const PARAGRAPH_1 =
  "I want you to list the widgets on the dashboard, so that operators see what is deployed.";
const PARAGRAPH_2 =
  "Build it by adding a `listWidgets` query in `src/widgets.ts` and reusing the `Table` component.";
const TASK_TEXT = `${PARAGRAPH_1}

${PARAGRAPH_2}

Don't stop until:
- The dashboard lists every widget by name
- Widgets sort by name`;
const CRITERIA = ["The dashboard lists every widget by name", "Widgets sort by name"];

const COMMIT = "3333333333333333333333333333333333333333";
const DIFF = `diff --git a/src/widgets.ts b/src/widgets.ts
--- a/src/widgets.ts
+++ b/src/widgets.ts
@@ -1 +1,2 @@
+export const listWidgets = () => db.widgets.orderBy("name");`;
const BUILDER_SUMMARY = "Added listWidgets and wired it to the Table component.";

/** A three-paragraph task as the story job had it: all three paragraphs, and its builder's summary. */
function taskStory(kind: "story" | "fix" = "story") {
  const parsed = parseWorkItem(TASK_TEXT)!;
  return {
    identifier: "ENG-601",
    title: "List widgets",
    description: parsed.description,
    approach: parsed.approach,
    acceptanceCriteria: parsed.acceptanceCriteria,
    summary: BUILDER_SUMMARY,
    task: true,
    kind,
  };
}

function context(
  story: VerifyTaskPromptContext["story"],
  commitSha: string | null = COMMIT,
): VerifyTaskPromptContext {
  return {
    branch: "omniralph/eng-600-widgets",
    baseBranch: "main",
    epic: { identifier: "ENG-600", title: "Widgets", description: "## Problem\n\nNo widgets." },
    story,
    commitSha,
    qualityGates: ["pnpm test"],
  };
}

/** The verifier's prompt for `ctx`, with the setup command's diff as the agent renders it. */
function render(ctx: VerifyTaskPromptContext, diff = DIFF): string {
  return renderTemplate(
    task.promptTemplate,
    { ...verifyTaskTemplateContext(ctx), setup: { diff } },
    taskCatalog(task),
    task.variableLimits,
  );
}

describe("builtin:verify-task", () => {
  it("can use the task's paragraphs 1 and 3 and its diff, never paragraph 2", () => {
    expect(taskVariables(task)).toContain("setup.diff");
    expect(validateTemplate(task.promptTemplate, taskVariables(task))).toEqual([]);
    // A verifier's template can't even name paragraph 2: no run.invoked task gets it.
    expect(
      validateTemplate("{{story.approach}}", availableVariables("query", ["run.invoked"])),
    ).toEqual([expect.objectContaining({ kind: "unknown-variable", name: "story.approach" })]);
  });

  it("shows a task's paragraph 1, its done criteria and its diff, and nothing of how it was built", async () => {
    const story = taskStory();
    // The parse the payload carries: paragraph 2 apart from paragraphs 1 and 3.
    expect(story.description).toBe(PARAGRAPH_1);
    expect(story.approach).toBe(PARAGRAPH_2);
    expect(story.acceptanceCriteria).toEqual(CRITERIA);

    const prompt = render(context(story));
    expect(prompt).toContain(`### What to Build\n\`\`\`markdown\n${PARAGRAPH_1}\n\`\`\``);
    expect(prompt).toContain(`### Don't Stop Until\n`);
    for (const criterion of CRITERIA) expect(prompt).toContain(`- \`\`\`\n${criterion}\n\`\`\``);
    expect(prompt).toContain(`\`\`\`diff\n${DIFF}\n\`\`\``);
    expect(prompt).toContain(`checkout of the task's commit \`${COMMIT}\``);
    expect(prompt).toContain("Don't read the commit's message or the branch's log");
    expect(prompt).not.toContain("Build it by");
    expect(prompt).not.toContain("listWidgets` query");
    expect(prompt).not.toContain(BUILDER_SUMMARY);
    expect(prompt).not.toContain("### Acceptance Criteria");
    await expect(prompt).toMatchFileSnapshot("__snapshots__/verify-task.task.md");
  });

  it("names a Fix's paragraph 1 as what is broken", () => {
    const prompt = render(context(taskStory("fix")));
    expect(prompt).toContain(`### What Is Broken\n\`\`\`markdown\n${PARAGRAPH_1}`);
    expect(prompt).not.toContain("### What to Build");
  });

  it("checks a task that committed nothing on its branch, without its log", () => {
    const prompt = render(context(taskStory(), null));
    expect(prompt).not.toContain(DIFF);
    expect(prompt).toContain("`git diff origin/main...HEAD`");
    expect(prompt).not.toContain("`git log origin/main..HEAD`");
    expect(prompt).toContain("Don't read commit messages");
  });

  it("checks a task without done criteria against what it was meant to deliver", () => {
    const prompt = render(context({ ...taskStory(), acceptanceCriteria: [] }));
    expect(prompt).not.toContain("### Don't Stop Until");
    expect(prompt).toContain("The task lists no done criteria");
  });

  it("verifies a legacy story as before: its description, acceptance criteria and commit", async () => {
    const prompt = render(
      context({
        identifier: "ENG-602",
        title: "Sort widgets",
        description: "Sort the widgets.",
        acceptanceCriteria: ["Widgets sort by name"],
      }),
    );
    expect(prompt).toContain("### Description\n```markdown\nSort the widgets.\n```");
    expect(prompt).toContain("### Acceptance Criteria\n");
    expect(prompt).toContain(`\`git show --stat ${COMMIT}\`, then \`git show ${COMMIT}\``);
    // The diff the setup command produced isn't part of a legacy story's prompt.
    expect(prompt).not.toContain(DIFF);
    expect(prompt).not.toContain("### Don't Stop Until");
    await expect(prompt).toMatchFileSnapshot("__snapshots__/verify-task.legacy.md");
  });

  describe("its diff setup command", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "verify-task-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Builder",
          GIT_AUTHOR_EMAIL: "builder@example.com",
          GIT_COMMITTER_NAME: "Builder",
          GIT_COMMITTER_EMAIL: "builder@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });

    it("prints the checked-out commit's diff without its message", () => {
      git("init", "-q");
      writeFileSync(path.join(repo, "widgets.ts"), "export const widgets = [];\n");
      git("add", ".");
      git("commit", "-q", "-m", "Start");
      writeFileSync(path.join(repo, "widgets.ts"), "export const widgets = ['a'];\n");
      git("commit", "-q", "-am", `feat: list widgets\n\n${BUILDER_SUMMARY}`);

      const out = execFileSync("sh", ["-c", TASK_DIFF_COMMAND], { cwd: repo, encoding: "utf8" });
      expect(out).toMatch(/^diff --git a\/widgets\.ts b\/widgets\.ts\n/);
      expect(out).toContain("+export const widgets = ['a'];");
      expect(out).not.toContain("list widgets");
      expect(out).not.toContain(BUILDER_SUMMARY);
      expect(out).not.toContain("Builder");
    });
  });
});
