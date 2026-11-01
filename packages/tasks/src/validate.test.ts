import { describe, expect, it } from "vitest";
import {
  BUILTIN_TASKS,
  deriveAgentRequirements,
  deriveTaskRequirements,
  getBuiltinRunSpec,
  getBuiltinTask,
  AGENT_VERSION_BY_TASK_TYPE,
  AGENT_VERSION_FOR_COMMANDS,
  AGENT_VERSION_FOR_TRACKER,
  RunSpecAgent,
  validateTaskDefinition,
  VARIABLES,
  type RunSpecAgentInput,
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

const customAgent: RunSpecAgentInput = {
  id: AGENT_ID,
  name: "Security reviewer",
  systemPrompt: "You look for security problems.",
};

const context: TaskValidationContext = {
  getAgent: (id) => (id === AGENT_ID ? validAgent() : (getBuiltinRunSpec(id)?.agent ?? null)),
  getTask: getBuiltinTask,
  sinks: SINKS,
};

function validAgent() {
  return RunSpecAgent.parse(customAgent);
}

/** A valid query task; each test breaks one rule. */
const query: TaskDefinitionInput = {
  id: TASK_ID,
  name: "Answer in a finding thread",
  taskType: "query",
  agentId: "builtin:reply-to-finding",
  triggers: ["finding.mention"],
  promptTemplate: "{{finding.title}}\n\n{{question}}",
  sink: "finding-thread",
};

/** A valid coding task started by a story or a request. */
const coding: TaskDefinitionInput = {
  id: TASK_ID,
  name: "Implement",
  taskType: "coding",
  agentId: "builtin:implement-story",
  triggers: ["tracker.delegated", "tracker.mention"],
  promptTemplate: "{{epic.title}}{{#epic.prd}}\n{{epic.prd}}{{/epic.prd}}",
  sink: "ralph-run",
};

function errors(input: unknown) {
  const result = validateTaskDefinition(input, context);
  return result.ok ? {} : result.fieldErrors;
}

describe("validateTaskDefinition", () => {
  it("accepts every built-in task, returning its derived requirements", () => {
    expect(BUILTIN_TASKS.map((task) => task.id)).toEqual(
      expect.arrayContaining(["builtin:review-pr", "builtin:describe-pr"]),
    );
    for (const task of BUILTIN_TASKS) {
      const agent = getBuiltinRunSpec(task.id)!.agent;
      const requirements = deriveTaskRequirements(task, undefined, agent);
      expect(validateTaskDefinition(task, context), task.id).toEqual({
        ok: true,
        definition: task,
        requirements,
      });
      // No built-in task or agent needs an installable or a host tool.
      expect(requirements.installables, task.id).toEqual([]);
      expect(requirements.hostTools, task.id).toEqual([]);
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
      errors({ ...coding, triggers: ["tracker.delegated"], promptTemplate: "{{epic.prd}}" }),
    ).toEqual({});
  });

  it("rejects story outside an optional section on a task a request starts", () => {
    expect(errors({ ...coding, promptTemplate: "{{story.title}}" })).toEqual({
      promptTemplate: expect.stringContaining("may have no epic or story: put {{story.title}}"),
    });
    expect(
      errors({ ...coding, triggers: ["tracker.delegated"], promptTemplate: "{{story.title}}" }),
    ).toEqual({});
  });

  it("rejects an unknown agent, and one with agent tools the task type doesn't allow", () => {
    expect(errors({ ...query, agentId: "builtin:nope" })).toEqual({
      agentId: "There is no agent builtin:nope.",
    });
    const shipper = RunSpecAgent.parse({ ...customAgent, tools: { agent: ["ship"] } });
    expect(
      validateTaskDefinition(
        { ...query, agentId: AGENT_ID },
        { ...context, getAgent: (id) => (id === AGENT_ID ? shipper : null) },
      ),
    ).toEqual({
      ok: false,
      fieldErrors: { agentId: "query runs can't use the agent tool ship." },
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

  it("rejects an output schema that isn't an object, or the agent can't check output against", () => {
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

  it("rejects a model or token budget on a review task: its review depth sets them", () => {
    const review = getBuiltinTask("builtin:review-pr")!;
    const custom = { ...review, id: TASK_ID };
    expect(errors(custom)).toEqual({});
    expect(errors({ ...custom, model: "claude-opus-5-5", tokenBudget: { tokens: 1000 } })).toEqual({
      model: "Review tasks can't set a model; the repo's review depth sets it.",
      tokenBudget: "Review tasks can't set a token budget; the repo's review depth sets it.",
    });
    expect(errors({ ...custom, tokenBudget: { tokens: 1000 } })).toEqual({
      tokenBudget: expect.stringContaining("review depth sets it"),
    });
    // Other task types keep theirs.
    expect(errors({ ...query, model: "claude-opus-5-5", tokenBudget: { tokens: 1000 } })).toEqual(
      {},
    );
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

  it("needs the agent release that runs the task type", () => {
    expect(task(query).requirements).toEqual({
      minAgentVersion: AGENT_VERSION_BY_TASK_TYPE.query,
      installables: [],
      hostTools: [],
    });
    // Coding runs' ralph payloads carry the tracker fields, so they need the tracker protocol.
    expect(task(coding).requirements.minAgentVersion).toBe(AGENT_VERSION_FOR_TRACKER);
  });

  it("needs the tracker protocol release when the task turns on the tracker tools", () => {
    const reader = { ...query, toolSettings: { ...query.toolSettings, trackerRead: true } };
    expect(task(reader).requirements.minAgentVersion).toBe(AGENT_VERSION_FOR_TRACKER);
    expect(task(query).requirements.minAgentVersion).not.toBe(AGENT_VERSION_FOR_TRACKER);
  });

  it("needs the release that runs setup and teardown commands when the task has any", () => {
    expect(
      task({ ...query, teardownCommands: [{ name: "clean", command: "rm -rf tmp" }] }).requirements
        .minAgentVersion,
    ).toBe(AGENT_VERSION_FOR_COMMANDS);
  });

  it("needs the task's installables and host tools and those of its agent's MCP servers", () => {
    const graphAgent = {
      ...validAgent(),
      tools: {
        ...validAgent().tools,
        mcpServers: ["github", "@omniralph/code-graph:graph", "@omniralph/code-graph:search"],
      },
    };
    const result = validateTaskDefinition(
      {
        ...query,
        taskType: "review",
        agentId: AGENT_ID,
        triggers: ["pr.updated"],
        promptTemplate: "{{pr.title}}",
        sink: "review",
        requires: { installables: ["@omniralph/sast"], hostTools: ["opengrep", "git", "opengrep"] },
      },
      { ...context, getAgent: (id) => (id === AGENT_ID ? graphAgent : null) },
    );
    expect(result.ok && result.requirements).toEqual({
      minAgentVersion: AGENT_VERSION_BY_TASK_TYPE.review,
      installables: ["@omniralph/code-graph", "@omniralph/sast"],
      hostTools: ["git", "opengrep"],
    });
    expect(deriveAgentRequirements({}, graphAgent)).toEqual({
      installables: ["@omniralph/code-graph"],
      hostTools: [],
    });
    expect(deriveAgentRequirements({}, null)).toEqual({ installables: [], hostTools: [] });
  });

  it("needs the release that provides each task-type variable its template uses", () => {
    const catalog: VariableDefinition[] = VARIABLES.map((variable) =>
      variable.name === "checkout" && variable.source === "taskType"
        ? { ...variable, minAgentVersion: "0.40.2" }
        : variable,
    );
    const { definition } = task(query);
    expect(deriveTaskRequirements(definition, catalog).minAgentVersion).toBe(
      AGENT_VERSION_BY_TASK_TYPE.query,
    );
    const usesCheckout = {
      ...definition,
      promptTemplate: "{{#checkout}}Read the code.{{/checkout}}",
    };
    expect(deriveTaskRequirements(usesCheckout, catalog).minAgentVersion).toBe("0.40.2");
    expect(deriveTaskRequirements(usesCheckout).minAgentVersion).toBe(
      AGENT_VERSION_BY_TASK_TYPE.query,
    );
  });
});
