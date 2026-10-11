import { describe, expect, it } from "vitest";
import {
  TRIGGER_KINDS,
  VARIABLES,
  availableVariables,
  findVariable,
  renderTemplate,
  setupVariables,
  taskCatalog,
  taskVariables,
  validateTemplate,
} from "./index.js";

describe("VARIABLES", () => {
  it("has unique dotted names", () => {
    const names = VARIABLES.map((variable) => variable.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/);
  });

  it("only names known trigger kinds", () => {
    for (const variable of VARIABLES) {
      if (variable.source !== "trigger") continue;
      expect(variable.triggers.length).toBeGreaterThan(0);
      for (const trigger of variable.triggers) expect(TRIGGER_KINDS).toContain(trigger);
    }
  });

  it("describes trust and fences", () => {
    expect(findVariable("finding.title")).toMatchObject({ source: "trigger", trust: "untrusted" });
    expect(findVariable("finding.severity")).toMatchObject({ trust: "trusted" });
    expect(findVariable("hunk")).toMatchObject({
      source: "taskType",
      trust: "untrusted",
      fence: "diff",
      taskTypes: ["query"],
    });
    expect(findVariable("nope")).toBeUndefined();
  });

  it("gives query tasks question, hunk, conventions and checkout", () => {
    const query = VARIABLES.filter(
      (variable) => variable.source === "taskType" && variable.taskTypes.includes("query"),
    ).map((variable) => variable.name);
    expect(query).toEqual(["question", "hunk", "conventions", "checkout"]);
  });

  it("gives review tasks the depth, rubric, rules, diff, plan, risk, conventions and previous findings", () => {
    const review = VARIABLES.filter(
      (variable) => variable.source === "taskType" && variable.taskTypes.includes("review"),
    );
    expect(review.map((variable) => variable.name)).toEqual([
      "conventions",
      "depth",
      "rubric",
      "repositoryRules",
      "repositoryRules.instructions",
      "repositoryRules.rules.items.number",
      "repositoryRules.rules.items.text",
      "diff",
      "plan",
      "plan.mode",
      "plan.baseSha",
      "plan.fromSha",
      "plan.headSha",
      "plan.files",
      "plan.skipped.path",
      "plan.skipped.reason",
      "risk",
      "risk.complexityScore",
      "risk.hotspots",
      "previousFindings",
      "previousFindings.items.id",
      "previousFindings.items.path",
      "previousFindings.items.lines",
      "previousFindings.items.category",
      "previousFindings.items.text",
    ]);
    const untrusted = review.filter((v) => v.trust === "untrusted").map((v) => v.name);
    expect(untrusted).toEqual([
      "conventions",
      "diff",
      "previousFindings",
      "previousFindings.items.text",
    ]);
    expect(findVariable("diff")).toMatchObject({ fence: "diff" });
    expect(findVariable("previousFindings.items.text")).toMatchObject({ fence: "markdown" });
    expect(
      validateTemplate(
        "{{#previousFindings}}{{#previousFindings.items}}{{id}} {{text}}{{/previousFindings.items}}{{/previousFindings}}{{diff}}{{plan.mode}}{{risk.hotspots}}",
        availableVariables("review", ["pr.updated"]),
      ),
    ).toEqual([]);
  });
});

describe("availableVariables", () => {
  it("includes the task type's variables and the trigger's", () => {
    const names = availableVariables("query", ["finding.dismissed"]);
    expect(names).toEqual(
      expect.arrayContaining([
        "question",
        "hunk",
        "conventions",
        "finding.title",
        "dismissal.note",
      ]),
    );
    expect(names).not.toContain("chat.context");
  });

  it("only includes trigger variables every trigger provides", () => {
    const names = availableVariables("query", ["finding.mention", "finding.dismissed"]);
    expect(names).toContain("finding.title");
    expect(names).toContain("pr.number");
    expect(names).not.toContain("dismissal.note");

    const mixed = availableVariables("query", ["finding.mention", "chat.request"]);
    expect(mixed).toContain("repository");
    expect(mixed).not.toContain("finding.title");
    expect(mixed).not.toContain("branch");
  });

  it("leaves out other task types' variables", () => {
    expect(availableVariables("coding", ["linear.delegated"])).toEqual([
      "issue.identifier",
      "issue.url",
      "issue.stateType",
      "issue.creator.name",
      "issue.title",
      "issue.description",
    ]);
  });

  it("gives triage the Linear issue's comments, sub-issues, blockers, reply and previous triage", () => {
    const names = availableVariables("query", ["linear.triage"]);
    expect(names).toEqual(
      expect.arrayContaining([
        "repository",
        "branch",
        "checkout",
        "comments.items.body",
        "children.items.priority",
        "blockers.items.blocks",
        "reply",
        "previousResult.openQuestions.items.text",
      ]),
    );
    expect(availableVariables("query", ["linear.delegated"])).not.toContain("reply");
    expect(findVariable("issue.title")).toMatchObject({ trust: "untrusted", quote: "issue-title" });
  });

  it("has no trigger variables without triggers", () => {
    expect(availableVariables("query", [])).toEqual([
      "question",
      "hunk",
      "conventions",
      "checkout",
    ]);
  });
});

describe("setup variables", () => {
  const task = {
    taskType: "query" as const,
    triggers: ["chat.request" as const],
    setupCommands: [
      { name: "semgrep", fence: "json", optional: true },
      { name: "graph", fence: "", optional: false },
    ],
  };

  it("names each setup command's variable `setup.<name>`, untrusted", () => {
    expect(setupVariables(task.setupCommands)).toEqual([
      expect.objectContaining({
        name: "setup.semgrep",
        source: "setup",
        trust: "untrusted",
        fence: "json",
      }),
      expect.not.objectContaining({ fence: expect.anything() }),
    ]);
    expect(taskCatalog(task).slice(0, VARIABLES.length)).toEqual(VARIABLES);
  });

  it("makes them available to the task's template, and fences them when rendered", () => {
    const available = taskVariables(task);
    expect(available).toEqual([
      ...availableVariables("query", ["chat.request"]),
      "setup.semgrep",
      "setup.graph",
    ]);
    expect(validateTemplate("{{setup.semgrep}}{{#setup}}{{graph}}{{/setup}}", available)).toEqual(
      [],
    );
    expect(validateTemplate("{{setup.other}}", available)).toMatchObject([{ name: "setup.other" }]);
    expect(
      renderTemplate(
        "{{setup.semgrep}}\n{{setup.graph}}",
        { setup: { semgrep: '{"results":[]}', graph: "a -> b" } },
        taskCatalog(task),
      ),
    ).toBe('```json\n{"results":[]}\n```\n```\na -> b\n```');
  });
});
