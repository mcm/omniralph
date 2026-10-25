import { describe, expect, it } from "vitest";
import {
  CODING_DEFAULTS,
  CUSTOM_PLAYBOOK_ROLES,
  HARNESS_VERSION_BY_TASK_TYPE,
  PLAYBOOK_ROLES,
  PLAYBOOK_ROLE_IDS,
  Playbook,
  REQUEST_TRIGGERS,
  getBuiltinPlaybook,
  TRIGGERS_BY_TASK_TYPE,
  playbookRequirements,
  playbookRunSpec,
  playbookTaskType,
  type PlaybookInput,
} from "./index.js";

const UUID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";

const chat: PlaybookInput = {
  id: UUID,
  name: "Explain code",
  role: "chat-ask",
  systemPrompt: "You explain code.",
  promptTemplate: "{{question}}",
};

function messages(input: unknown): Record<string, string> {
  const result = Playbook.safeParse(input);
  if (result.success) return {};
  return Object.fromEntries(
    result.error.issues.map((issue) => [issue.path.join("."), issue.message]),
  );
}

describe("PLAYBOOK_ROLES", () => {
  it("fixes each role's task type, triggers and sink", () => {
    expect(PLAYBOOK_ROLES).toEqual({
      review: {
        taskType: "review",
        triggers: ["pr.updated", "pr.mention", "review.rerun"],
        sink: "review",
        builtinOnly: false,
      },
      "review-summary": {
        taskType: "review",
        triggers: ["pr.updated", "pr.mention", "review.rerun"],
        sink: "sticky-comment",
        builtinOnly: false,
      },
      correlation: {
        taskType: "query",
        triggers: ["run.invoked"],
        sink: "run-result",
        builtinOnly: false,
      },
      story: {
        taskType: "coding",
        triggers: ["linear.delegated"],
        sink: "ralph-run",
        builtinOnly: false,
      },
      request: {
        taskType: "coding",
        triggers: REQUEST_TRIGGERS,
        sink: "ralph-run",
        builtinOnly: false,
      },
      "pr-description": {
        taskType: "query",
        triggers: ["run.invoked"],
        sink: "run-result",
        builtinOnly: false,
      },
      "chat-ask": {
        taskType: "query",
        triggers: ["chat.request"],
        sink: "chat-thread",
        builtinOnly: false,
      },
      triage: { taskType: "query", triggers: ["linear.triage"], sink: "triage", builtinOnly: true },
      "learn-rule": {
        taskType: "query",
        triggers: ["finding.dismissed"],
        sink: "learned-rule",
        builtinOnly: true,
      },
      "reply-to-finding": {
        taskType: "query",
        triggers: ["finding.mention"],
        sink: "finding-thread",
        builtinOnly: true,
      },
    });
  });

  it("only uses triggers its task type accepts", () => {
    for (const role of PLAYBOOK_ROLE_IDS) {
      const { taskType, triggers } = PLAYBOOK_ROLES[role];
      for (const trigger of triggers) expect(TRIGGERS_BY_TASK_TYPE[taskType]).toContain(trigger);
    }
  });

  it("leaves triage, learn-rule and reply-to-finding to built-ins", () => {
    expect(CUSTOM_PLAYBOOK_ROLES).toEqual([
      "review",
      "review-summary",
      "correlation",
      "story",
      "request",
      "pr-description",
      "chat-ask",
    ]);
    expect(playbookTaskType({ role: "story" })).toBe("coding");
  });
});

describe("Playbook", () => {
  it("fills defaults", () => {
    expect(Playbook.parse(chat)).toEqual({
      ...chat,
      description: "",
      systemPromptMode: "append",
      referenceDocs: [],
      model: null,
      fallbackModel: null,
      tools: { builtin: [], harness: [], linear: [], mcpServers: [] },
      toolSettings: { shell: false, linearRead: false, network: false },
      setupCommands: [],
      teardownCommands: [],
      tokenBudget: null,
    });
  });

  it("accepts every field a playbook has", () => {
    const full = {
      id: UUID,
      name: "Implement with the graph",
      description: "Implements stories with the code graph.",
      role: "story",
      systemPrompt: "You write code.",
      systemPromptMode: "append",
      promptTemplate: "{{epic.title}}",
      systemAppend: "Ship small commits.",
      referenceDocs: [{ name: "style", content: "Be brief." }],
      model: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
      tools: {
        builtin: ["Read"],
        harness: ["post_activity", "ship"],
        linear: ["linear_get_issue"],
        mcpServers: ["@omniralph/code-graph:graph"],
      },
      toolSettings: { shell: true, linearRead: true, network: true },
      requires: { installables: ["@omniralph/sast"], hostTools: ["opengrep"] },
      setupCommands: [
        {
          name: "deps",
          command: "pnpm install",
          timeoutSeconds: 60,
          maxOutputBytes: 1000,
          fence: "",
          optional: false,
        },
      ],
      teardownCommands: [
        { name: "clean", command: "rm -rf tmp", timeoutSeconds: 60, maxOutputBytes: 1000 },
      ],
      tokenBudget: { tokens: 1_000_000 },
      coding: { maxAttemptsPerStory: 2, pushTiming: "end", prDescriptionPlaybookId: UUID },
      variableLimits: { "epic.prd": 10_000 },
      idleTimeoutMs: 60_000,
      maxTurns: 100,
    } as const;
    expect(Playbook.parse(full)).toEqual(full);
  });

  it("drops the skills old agents had", () => {
    const parsed = Playbook.parse({ ...chat, skills: [{ name: "review", content: "# Review" }] });
    expect(parsed).not.toHaveProperty("skills");
  });

  it("refuses the fields its role (or the repo) now sets, saying why", () => {
    expect(
      messages({
        ...chat,
        taskTypes: ["query"],
        sink: "chat-thread",
        pool: "short",
        triggers: ["chat.request"],
        draftPullRequest: "early",
      }),
    ).toEqual({
      taskTypes: "A playbook's role sets its task type; remove taskTypes.",
      sink: "A playbook's role sets where its output goes; remove sink.",
      pool: "A run's pool follows from its role's task type; remove pool.",
      triggers: "A playbook's role sets what starts its runs; remove triggers.",
      draftPullRequest:
        'The repo\'s "open PR early" setting decides when the draft PR opens; remove draftPullRequest.',
    });
    expect(
      messages({
        ...chat,
        role: "story",
        promptTemplate: "{{epic.title}}",
        coding: { draftPullRequest: "end" },
      }),
    ).toEqual({
      "coding.draftPullRequest":
        'The repo\'s "open PR early" setting decides when the draft PR opens; remove draftPullRequest.',
    });
  });

  it("refuses MCP servers that aren't an installable's", () => {
    expect(
      messages({ ...chat, tools: { mcpServers: ["@omniralph/code-graph:graph", "github"] } }),
    ).toEqual({
      "tools.mcpServers.1":
        "Name an installable's MCP server as <package>:<server>; other MCP servers can't be used.",
    });
  });

  it("refuses a model or token budget on a review playbook", () => {
    const review = { ...chat, role: "review", promptTemplate: "{{pr.title}}" };
    expect(messages(review)).toEqual({});
    expect(messages({ ...review, model: "opus", tokenBudget: { tokens: 10 } })).toEqual({
      model: "Review playbooks can't set a model; the repo's review depth sets it.",
      tokenBudget: "Review playbooks can't set a token budget; the repo's review depth sets it.",
    });
    expect(messages({ ...review, role: "review-summary", model: "opus" })).toEqual({
      model: "Review playbooks can't set a model; the repo's review depth sets it.",
    });
  });

  it("refuses settings its role's task type can't use", () => {
    expect(
      messages({
        ...chat,
        role: "review",
        outputSchema: { type: "object" },
        coding: { maxAttemptsPerStory: 2 },
        tools: { harness: ["ship"] },
      }),
    ).toEqual({
      outputSchema: "A review playbook can't declare an output schema.",
      coding: "Only story and request playbooks have coding settings.",
      "tools.harness": "review runs can't use the harness tool ship.",
    });
  });

  it("refuses unknown roles and duplicate setup command names", () => {
    expect(Object.keys(messages({ ...chat, role: "deploy" }))).toEqual(["role"]);
    expect(
      messages({
        ...chat,
        setupCommands: [
          { name: "deps", command: "a" },
          { name: "deps", command: "b" },
        ],
      }),
    ).toEqual({ "setupCommands.1.name": "Setup command name deps is used twice" });
  });
});

describe("playbookRunSpec", () => {
  it("builds the run spec agent and task, with its role's task type, triggers and sink", () => {
    const playbook = Playbook.parse({
      ...chat,
      systemAppend: "Answer briefly.",
      model: "claude-sonnet-5-5",
      fallbackModel: "claude-haiku-5-5",
      tools: { builtin: ["Read"] },
      tokenBudget: { tokens: 50_000 },
      maxTurns: 30,
    });
    expect(playbookRunSpec(playbook)).toEqual({
      agent: {
        id: UUID,
        name: "Explain code",
        description: "",
        systemPrompt: "You explain code.",
        systemPromptMode: "append",
        tools: { builtin: ["Read"], harness: [], linear: [], mcpServers: [] },
        referenceDocs: [],
        model: "claude-sonnet-5-5",
        fallbackModel: "claude-haiku-5-5",
      },
      task: {
        id: UUID,
        name: "Explain code",
        description: "",
        taskType: "query",
        agentId: UUID,
        triggers: ["chat.request"],
        promptTemplate: "{{question}}",
        systemAppend: "Answer briefly.",
        setupCommands: [],
        teardownCommands: [],
        toolSettings: { shell: false, linearRead: false, network: false },
        sink: "chat-thread",
        model: "claude-sonnet-5-5",
        tokenBudget: { tokens: 50_000 },
        maxTurns: 30,
      },
    });
  });

  it("leaves the model unset for the Claude Code default", () => {
    const { agent, task } = playbookRunSpec(Playbook.parse(chat));
    expect(agent.model).toBeNull();
    expect(task).not.toHaveProperty("model");
  });

  it("gives story and request playbooks their coding settings over the defaults", () => {
    const story = Playbook.parse({
      ...chat,
      role: "story",
      promptTemplate: "{{epic.title}}",
      coding: {
        maxAttemptsPerStory: 5,
        prDescriptionPlaybookId: UUID,
        verifyCommands: ["pnpm test"],
        worktreeSetupCommand: "pnpm install",
        epicCompletedState: "In Review",
      },
    });
    expect(playbookRunSpec(story).task).toMatchObject({
      ...CODING_DEFAULTS,
      taskType: "coding",
      triggers: ["linear.delegated"],
      sink: "ralph-run",
      maxAttemptsPerStory: 5,
      prDescriptionTaskId: UUID,
      verifyCommands: ["pnpm test"],
      worktreeSetupCommand: "pnpm install",
      epicCompletedState: "In Review",
    });
    const request = Playbook.parse({ ...chat, role: "request", promptTemplate: "{{branch}}" });
    const { task } = playbookRunSpec(request);
    expect(task).toMatchObject({ ...CODING_DEFAULTS, triggers: [...REQUEST_TRIGGERS] });
    expect(task.draftPullRequest).toBeUndefined();
  });

  it("gives the built-in story and request playbooks 3 review and CI fix rounds", () => {
    for (const id of ["builtin:implement-story", "builtin:handle-request"]) {
      const { task } = playbookRunSpec(getBuiltinPlaybook(id)!);
      expect(task).toMatchObject({
        maxReviewRounds: 3,
        maxFixRounds: 3,
        verifyCommands: [],
        worktreeSetupCommand: null,
        runPrdQualityGates: true,
        allowPreparation: true,
        epicCompletedState: null,
        cleanupMergedWorktrees: true,
        unmergedBranchTimeoutMinutes: 60,
      });
    }
  });
});

describe("playbookRequirements", () => {
  it("needs its role's harness release, its installables and its MCP servers' installables", () => {
    const playbook = Playbook.parse({
      ...chat,
      role: "review",
      promptTemplate: "{{pr.title}}",
      tools: { mcpServers: ["@omniralph/code-graph:graph"] },
      requires: { installables: ["@omniralph/sast"], hostTools: ["opengrep"] },
    });
    expect(playbookRequirements(playbook)).toEqual({
      minHarnessVersion: HARNESS_VERSION_BY_TASK_TYPE.review,
      installables: ["@omniralph/code-graph", "@omniralph/sast"],
      hostTools: ["opengrep"],
    });
  });
});
