import { describe, expect, it } from "vitest";
import { TRIGGER_KINDS, VARIABLES, availableVariables, findVariable } from "./index.js";

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

  it("gives query tasks question, hunk and conventions", () => {
    const query = VARIABLES.filter(
      (variable) => variable.source === "taskType" && variable.taskTypes.includes("query"),
    ).map((variable) => variable.name);
    expect(query).toEqual(["question", "hunk", "conventions"]);
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
      "issue.title",
      "issue.description",
    ]);
  });

  it("has no trigger variables without triggers", () => {
    expect(availableVariables("query", [])).toEqual(["question", "hunk", "conventions"]);
  });
});
