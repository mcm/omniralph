import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENTS,
  BUILTIN_TASKS,
  deriveTaskRequirements,
  getBuiltinAgent,
  getBuiltinTask,
  HARNESS_VERSION_BY_TASK_TYPE,
  HARNESS_VERSION_FOR_COMMANDS,
  validateAgentDefinition,
  validateTaskDefinition,
  VARIABLES,
  type AgentDefinitionInput,
  type SinkKind,
  type SinkOutput,
  type TaskDefinitionInput,
  type TaskValidationContext,
  type VariableDefinition,
} from "./index.js";

const AGENT_ID = "6f1c0f4e-1d2b-4c1a-9a55-3b7f2f3c9d10";
const TASK_ID = "0b6f7a0e-8a3d-4e43-9a51-2a8c55a1f6e2";

/** What the control panel's sinks accept (`apps/web/src/lib/definitions/validation.ts` has the real ones). */
const SINKS: Record<SinkKind, SinkOutput> = {
  "chat-thread": { taskType: "query", output: "answer" },
  "finding-thread": { taskType: "query", output: "answer" },
  "learned-rule": {
    taskType: "query",
    output: {
      schema: {
        type: "object",
        properties: { rule: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] } },
        required: ["rule"],
        additionalProperties: false,
      },
    },
  },
  triage: {
    taskType: "query",
    output: { schema: getBuiltinTask("builtin:triage")!.outputSchema! },
  },
  "run-result": { taskType: "query", output: "any" },
  review: { taskType: "review" },
  "sticky-comment": { taskType: "review" },
  "ralph-run": { taskType: "coding" },
};

const customAgent: AgentDefinitionInput = {
  id: AGENT_ID,
  name: "Security reviewer",
  systemPrompt: "You look for security problems.",
  taskTypes: ["review"],
};

const context: TaskValidationContext = {
  getAgent: (id) => (id === AGENT_ID ? validAgent() : getBuiltinAgent(id)),
  getTask: getBuiltinTask,
  sinks: SINKS,
};

function validAgent() {
  const result = validateAgentDefinition(customAgent);
  if (!result.ok) throw new Error("fixture agent is invalid");
  return result.definition;
}

/** A valid query task; each test breaks one rule. */
const query: TaskDefinitionInput = {
  id: TASK_ID,
  name: "Answer in a finding thread",
  taskType: "query",
  agentId: "builtin:reviewer",
  triggers: ["finding.mention"],
  promptTemplate: "{{finding.title}}\n\n{{question}}",
  sink: "finding-thread",
  pool: "short",
};

/** A valid coding task started by a story or a request. */
const coding: TaskDefinitionInput = {
  id: TASK_ID,
  name: "Implement",
  taskType: "coding",
  agentId: "builtin:engineer",
  triggers: ["linear.delegated", "linear.mention"],
  promptTemplate: "{{epic.title}}{{#epic.prd}}\n{{epic.prd}}{{/epic.prd}}",
  sink: "ralph-run",
  pool: "long",
};

function errors(input: unknown) {
  const result = validateTaskDefinition(input, context);
  return result.ok ? {} : result.fieldErrors;
}

describe("validateAgentDefinition", () => {
  it("accepts every built-in agent", () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(validateAgentDefinition(agent), agent.id).toEqual({ ok: true, definition: agent });
    }
  });

  it("parses a custom agent, filling defaults", () => {
    const result = validateAgentDefinition(customAgent);
    expect(result.ok && result.definition).toMatchObject({
      ...customAgent,
      systemPromptMode: "append",
      model: null,
    });
  });

  it("returns schema errors by field path", () => {
    expect(
      validateAgentDefinition({
        ...customAgent,
        name: " ",
        taskTypes: [],
        tools: { harness: ["nope"] },
        skills: [{ name: "x", content: "" }],
      }),
    ).toEqual({
      ok: false,
      fieldErrors: {
        name: expect.any(String),
        taskTypes: expect.any(String),
        "tools.harness.0": expect.any(String),
        "skills.0.content": expect.any(String),
      },
    });
    expect(validateAgentDefinition(null)).toEqual({
      ok: false,
      fieldErrors: { form: expect.any(String) },
    });
  });
});

describe("validateTaskDefinition", () => {
  it("accepts every built-in task, returning its derived requirements", () => {
    expect(BUILTIN_TASKS.map((task) => task.id)).toEqual(
      expect.arrayContaining(["builtin:review-pr", "builtin:describe-pr"]),
    );
    for (const task of BUILTIN_TASKS) {
      expect(validateTaskDefinition(task, context), task.id).toEqual({
        ok: true,
        definition: task,
        requirements: deriveTaskRequirements(task),
      });
    }
  });

  it("accepts the fixtures", () => {
    expect(errors(query)).toEqual({});
    expect(errors(coding)).toEqual({});
    expect(
      errors({
        ...query,
        taskType: "review",
        agentId: AGENT_ID,
        triggers: ["pr.updated"],
        promptTemplate: "{{pr.title}}",
        sink: "review",
      }),
    ).toEqual({});
  });

  it("returns the schema's errors by field path", () => {
    expect(
      errors({
        ...query,
        triggers: ["nope"],
        setupCommands: [
          { name: "lint", command: "pnpm lint" },
          { name: "lint", command: "pnpm lint" },
        ],
      }),
    ).toEqual({ "triggers.0": expect.any(String) });
    expect(
      errors({
        ...query,
        setupCommands: [
          { name: "lint", command: "pnpm lint" },
          { name: "lint", command: "pnpm lint" },
        ],
      }),
    ).toEqual({ "setupCommands.1.name": "Setup command name lint is used twice" });
    const { sink: _sink, ...withoutSink } = query;
    expect(errors(withoutSink)).toEqual({ sink: expect.any(String) });
  });

  it("rejects a variable not available for every trigger, naming it and the triggers", () => {
    expect(
      errors({
        ...query,
        triggers: ["finding.mention", "finding.dismissed"],
        promptTemplate: "{{finding.title}} {{dismissal.note}}",
      }),
    ).toEqual({ promptTemplate: "{{dismissal.note}} isn't available for finding.mention." });
    expect(errors({ ...query, promptTemplate: "{{finding.title}} {{nope}}" })).toEqual({
      promptTemplate: "{{nope}} isn't a variable query tasks can use.",
    });
    // A variable of another task type.
    expect(errors({ ...query, promptTemplate: "{{diff}}" })).toEqual({
      promptTemplate: "{{diff}} isn't available for finding.mention.",
    });
  });

  it("accepts setup variables of the task's named setup commands", () => {
    const withSetup = { ...query, setupCommands: [{ name: "lint", command: "pnpm lint" }] };
    expect(errors({ ...withSetup, promptTemplate: "{{setup.lint}}" })).toEqual({});
    expect(errors({ ...withSetup, promptTemplate: "{{setup.test}}" })).toEqual({
      promptTemplate: "{{setup.test}} isn't a variable query tasks can use.",
    });
  });

  it("rejects templates outside the Mustache subset", () => {
    for (const template of [
      "{{> partial}}",
      "{{{finding.title}}}",
      "{{& finding.title}}",
      "{{=<% %>=}}",
      "{{#finding.title}}",
    ]) {
      expect(errors({ ...query, promptTemplate: template }), template).toEqual({
        promptTemplate: expect.stringMatching(/^Line 1, column 1: /),
      });
    }
  });

  it("rejects epic.prd outside an optional section on a task a request starts", () => {
    expect(errors({ ...coding, promptTemplate: "{{epic.title}}\n{{epic.prd}}" })).toEqual({
      promptTemplate: expect.stringContaining("may have no epic or story: put {{epic.prd}}"),
    });
    // Without a request trigger it's fine.
    expect(
      errors({ ...coding, triggers: ["linear.delegated"], promptTemplate: "{{epic.prd}}" }),
    ).toEqual({});
  });

  it("rejects story outside an optional section on a task a request starts", () => {
    expect(errors({ ...coding, promptTemplate: "{{story.title}}" })).toEqual({
      promptTemplate: expect.stringContaining("may have no epic or story: put {{story.title}}"),
    });
    expect(
      errors({ ...coding, triggers: ["linear.delegated"], promptTemplate: "{{story.title}}" }),
    ).toEqual({});
  });

  it("rejects an unknown agent, and one that doesn't suit the task type", () => {
    expect(errors({ ...query, agentId: "builtin:nope" })).toEqual({
      agentId: "There is no agent builtin:nope.",
    });
    expect(errors({ ...query, agentId: AGENT_ID })).toEqual({
      agentId: expect.stringContaining("suits review tasks, not query"),
    });
  });

  it("rejects an output schema on a task that isn't a query task", () => {
    expect(
      errors({
        ...coding,
        outputSchema: { type: "object" },
      }),
    ).toEqual({ outputSchema: "outputSchema is only allowed on query tasks" });
  });

  it("rejects an output schema that isn't an object, or the harness can't check output against", () => {
    const structured = {
      ...query,
      sink: "run-result",
      triggers: ["run.invoked"],
      promptTemplate: "{{branch}}",
    } as const;
    expect(errors({ ...structured, outputSchema: { type: "object" } })).toEqual({});
    expect(errors({ ...structured, outputSchema: { type: "string" } })).toEqual({
      outputSchema: expect.stringContaining('"type": "object"'),
    });
    expect(
      errors({
        ...structured,
        outputSchema: { type: "object", properties: { a: { type: "strin" } } },
      }),
    ).toEqual({ outputSchema: expect.stringContaining("Unsupported type: strin") });
  });

  it("rejects a PR description task whose output isn't { title, body }", () => {
    const describer = {
      ...getBuiltinTask("builtin:describe-pr")!,
      outputSchema: { type: "object" },
    };
    expect(
      validateTaskDefinition(
        { ...coding, prDescriptionTaskId: describer.id },
        { ...context, getTask: (id) => (id === describer.id ? describer : getBuiltinTask(id)) },
      ),
    ).toEqual({
      ok: false,
      fieldErrors: {
        prDescriptionTaskId: expect.stringContaining("doesn't output the { title, body }"),
      },
    });
  });

  it("rejects a trigger kind the task type doesn't accept", () => {
    expect(
      errors({
        ...query,
        triggers: ["finding.mention", "pr.updated"],
        promptTemplate: "{{pr.title}}",
      }),
    ).toEqual({
      triggers: expect.stringContaining("query tasks can't be started by pr.updated"),
    });
  });

  it("rejects pushing only at the end with an early draft PR on a coding task", () => {
    expect(errors({ ...coding, pushTiming: "end", draftPullRequest: "early" })).toEqual({
      draftPullRequest: expect.stringContaining("An early draft PR"),
    });
    expect(errors({ ...coding, pushTiming: "end", draftPullRequest: "end" })).toEqual({});
  });

  it("rejects a PR description task that isn't a query task started by run.invoked", () => {
    expect(errors({ ...coding, prDescriptionTaskId: "builtin:review-pr" })).toEqual({
      prDescriptionTaskId: expect.any(String),
    });
  });

  it("rejects a variable limit on a variable the task can't use", () => {
    expect(errors({ ...query, variableLimits: { "finding.title": 100, diff: 10 } })).toEqual({
      "variableLimits.diff": "This task can't use diff.",
    });
  });

  describe("sinks", () => {
    it("rejects a sink of another task type", () => {
      expect(errors({ ...query, sink: "review" })).toEqual({
        sink: "The review sink applies the output of review tasks, not query tasks.",
      });
      expect(errors({ ...coding, sink: "chat-thread" })).toEqual({ sink: expect.any(String) });
    });

    it("rejects a sink that isn't available", () => {
      const result = validateTaskDefinition(query, { ...context, sinks: {} });
      expect(result).toEqual({
        ok: false,
        fieldErrors: { sink: "The finding-thread sink isn't available." },
      });
    });

    it("rejects an output schema on a sink that takes a Markdown answer", () => {
      expect(errors({ ...query, outputSchema: { type: "object" } })).toEqual({
        sink: expect.stringContaining("takes a Markdown answer"),
      });
    });

    it("needs an output schema the structured sink accepts", () => {
      const learn = { ...getBuiltinTask("builtin:learn-rule")!, id: TASK_ID };
      const { outputSchema: _schema, ...withoutSchema } = learn;
      expect(errors(withoutSchema)).toEqual({
        sink: expect.stringContaining("takes structured output"),
      });
      expect(
        errors({
          ...learn,
          outputSchema: {
            type: "object",
            properties: { rule: { type: "number" } },
            required: ["rule"],
            additionalProperties: false,
          },
        }),
      ).toEqual({ sink: expect.stringContaining("`rule` may be number") });
      expect(
        errors({
          ...learn,
          outputSchema: { type: "object", properties: { rule: { type: "string" } } },
        }),
      ).toEqual({ sink: expect.stringContaining("`rule` must be required") });
    });

    it("accepts any query output on a sink that takes any", () => {
      expect(errors({ ...query, sink: "run-result", outputSchema: { type: "object" } })).toEqual(
        {},
      );
      expect(errors({ ...query, sink: "run-result" })).toEqual({});
    });
  });
});

describe("deriveTaskRequirements", () => {
  const task = (input: TaskDefinitionInput) => {
    const result = validateTaskDefinition(input, context);
    if (!result.ok) throw new Error(JSON.stringify(result.fieldErrors));
    return result;
  };

  it("needs the harness release that runs the task type", () => {
    expect(task(query).requirements).toEqual({
      minHarnessVersion: HARNESS_VERSION_BY_TASK_TYPE.query,
      installables: [],
      hostTools: [],
    });
    expect(task(coding).requirements.minHarnessVersion).toBe(HARNESS_VERSION_BY_TASK_TYPE.coding);
  });

  it("needs the release that runs setup and teardown commands when the task has any", () => {
    expect(
      task({ ...query, teardownCommands: [{ name: "clean", command: "rm -rf tmp" }] }).requirements
        .minHarnessVersion,
    ).toBe(HARNESS_VERSION_FOR_COMMANDS);
  });

  it("needs the release that provides each task-type variable its template uses", () => {
    const catalog: VariableDefinition[] = VARIABLES.map((variable) =>
      variable.name === "checkout" && variable.source === "taskType"
        ? { ...variable, minHarnessVersion: "0.40.2" }
        : variable,
    );
    const { definition } = task(query);
    expect(deriveTaskRequirements(definition, catalog).minHarnessVersion).toBe(
      HARNESS_VERSION_BY_TASK_TYPE.query,
    );
    const usesCheckout = {
      ...definition,
      promptTemplate: "{{#checkout}}Read the code.{{/checkout}}",
    };
    expect(deriveTaskRequirements(usesCheckout, catalog).minHarnessVersion).toBe("0.40.2");
    expect(deriveTaskRequirements(usesCheckout).minHarnessVersion).toBe(
      HARNESS_VERSION_BY_TASK_TYPE.query,
    );
  });
});
