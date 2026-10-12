import { describe, expect, it } from "vitest";
import {
  BUILTIN_TASKS,
  getBuiltinTask,
  TaskDefinition,
  prDescriptionProblem,
  validateCodingTask,
  type TaskDefinitionInput,
} from "./index.js";

const story: TaskDefinitionInput = {
  id: "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f",
  name: "Implement a story",
  taskType: "coding",
  agentId: "builtin:engineer",
  triggers: ["linear.delegated"],
  promptTemplate: "{{story.title}}\n{{epic.prd}}",
  sink: "ralph-run",
  pool: "long",
};

const request: TaskDefinitionInput = {
  ...story,
  triggers: ["linear.mention", "chat.request"],
  promptTemplate: "{{#requests}}{{.}}{{/requests}}",
};

function errors(input: TaskDefinitionInput): Record<string, string> {
  return validateCodingTask(TaskDefinition.parse(input), getBuiltinTask);
}

describe("validateCodingTask", () => {
  it("passes the coding built-ins and the PR description task they name", () => {
    const coding = BUILTIN_TASKS.filter((t) => t.taskType === "coding");
    expect(coding.map((t) => t.id)).toEqual(["builtin:implement-story", "builtin:handle-request"]);
    for (const task of BUILTIN_TASKS) {
      expect(validateCodingTask(task, getBuiltinTask), task.id).toEqual({});
    }
    expect(errors(story)).toEqual({});
    expect(errors(request)).toEqual({});
  });

  it("rejects pushing only at the end with an early draft PR", () => {
    expect(errors({ ...story, pushTiming: "end", draftPullRequest: "early" })).toEqual({
      draftPullRequest: expect.stringContaining("push after each story"),
    });
    expect(errors({ ...story, pushTiming: "end", draftPullRequest: "end" })).toEqual({});
    expect(errors({ ...story, pushTiming: "end" })).toEqual({});
    expect(errors({ ...story, pushTiming: "per-story", draftPullRequest: "early" })).toEqual({});
  });

  it("rejects a prDescriptionTaskId that isn't a query task started by run.invoked", () => {
    for (const id of ["builtin:implement-story", "builtin:summarize-pr"]) {
      expect(errors({ ...story, prDescriptionTaskId: id })).toEqual({
        prDescriptionTaskId: `${id} isn't a query task started by run.invoked.`,
      });
    }
    expect(errors({ ...story, prDescriptionTaskId: "builtin:nope" })).toEqual({
      prDescriptionTaskId: "There is no task builtin:nope.",
    });
    expect(errors({ ...story, prDescriptionTaskId: "builtin:describe-pr" })).toEqual({});
  });

  it("rejects a prDescriptionTaskId whose output isn't { title, body }", () => {
    // A query task started by run.invoked with another output.
    expect(errors({ ...story, prDescriptionTaskId: "builtin:correlate-findings" })).toEqual({
      prDescriptionTaskId: expect.stringContaining(
        "builtin:correlate-findings doesn't output the { title, body } of a PR description",
      ),
    });
  });

  it("rejects epic.prd or story outside an optional section on a task a request starts", () => {
    for (const template of [
      "{{epic.prd}}",
      "{{story.title}}",
      "{{story.acceptanceCriteria.items}}",
      "{{story}}",
    ]) {
      expect(errors({ ...request, promptTemplate: template }), template).toEqual({
        promptTemplate: expect.stringContaining("may have no epic or story"),
      });
    }
    // One request trigger is enough.
    expect(
      errors({ ...story, triggers: ["linear.delegated", "pr.fix-command"] }).promptTemplate,
    ).toContain("{{story.title}}, {{epic.prd}}");
    for (const template of [
      "{{#epic.prd}}{{epic.prd}}{{/epic.prd}}",
      "{{#story}}{{title}}{{/story}}",
      "{{#ship}}{{story.title}}{{/ship}}",
      "{{^fromChat}}{{epic.prd}}{{/fromChat}}",
      "{{epic.title}} {{stories.total}}",
    ]) {
      expect(errors({ ...request, promptTemplate: template }), template).toEqual({});
    }
  });

  it("only checks coding tasks", () => {
    const query = getBuiltinTask("builtin:describe-pr")!;
    expect(
      validateCodingTask({ ...query, promptTemplate: "{{epic.prd}}" }, getBuiltinTask),
    ).toEqual({});
  });
});

describe("prDescriptionProblem", () => {
  const describer = getBuiltinTask("builtin:describe-pr")!;

  it("accepts a query task started by run.invoked whose output has a string title and body", () => {
    expect(prDescriptionProblem(describer)).toBeNull();
    expect(
      prDescriptionProblem({
        ...describer,
        outputSchema: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 60 },
            body: { type: "string" },
            labels: { type: "array" },
          },
          required: ["title", "body", "labels"],
        },
      }),
    ).toBeNull();
  });

  it("rejects one without the output, or with an optional or mistyped field", () => {
    expect(prDescriptionProblem({ ...describer, outputSchema: undefined })).toContain(
      "has no output schema",
    );
    for (const outputSchema of [
      { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "number" } },
        required: ["title", "body"],
      },
    ]) {
      expect(prDescriptionProblem({ ...describer, outputSchema })).toContain(
        "doesn't output the { title, body }",
      );
    }
  });

  it("rejects one of another type or trigger", () => {
    expect(prDescriptionProblem({ ...describer, triggers: ["chat.request"] })).toBe(
      "builtin:describe-pr isn't a query task started by run.invoked.",
    );
  });
});
