import { describe, expect, it } from "vitest";
import {
  BUILTIN_PLAYBOOKS,
  BUILTIN_TASKS,
  builtinProblems,
  getBuiltinPlaybook,
  getBuiltinTask,
  playbookRunSpec,
  type PlaybookInput,
} from "./index.js";

const playbook: PlaybookInput = {
  id: "builtin:learn-rule",
  name: "Learn a rule",
  role: "learn-rule",
  systemPrompt: "You review code.",
  promptTemplate: "{{finding.title}}: {{dismissal.note}}",
};

describe("the built-in registry", () => {
  it("has no problems: every built-in parses, has a builtin: ID and a valid template", () => {
    expect(builtinProblems(BUILTIN_PLAYBOOKS)).toEqual([]);
  });

  it("finds every built-in playbook and its run spec task by ID", () => {
    for (const p of BUILTIN_PLAYBOOKS) {
      expect(getBuiltinPlaybook(p.id)).toBe(p);
      expect(getBuiltinTask(p.id)).toEqual(playbookRunSpec(p).task);
    }
    expect(BUILTIN_TASKS.map((t) => t.id)).toEqual(BUILTIN_PLAYBOOKS.map((p) => p.id));
  });

  it("returns null for unknown IDs", () => {
    expect(getBuiltinPlaybook("builtin:nope")).toBeNull();
    expect(getBuiltinTask("builtin:nope")).toBeNull();
  });
});

/**
 * Each built-in as its run sees it: the snapshots under
 * `builtin/__snapshots__/playbook.<name>.json` were written from the agent +
 * task pairs before they were merged into playbooks, so a byte-identical match
 * means every built-in's runs get the same system prompt, template, tools and
 * model as before.
 */
describe("built-in playbooks as their runs see them", () => {
  for (const playbook of BUILTIN_PLAYBOOKS) {
    it(`${playbook.id} renders as the agent + task pair it replaced`, async () => {
      const { agent, task } = playbookRunSpec(playbook);
      const coding =
        task.taskType === "coding"
          ? {
              maxAttemptsPerStory: task.maxAttemptsPerStory,
              maxRoundsPerStory: task.maxRoundsPerStory,
              stallRounds: task.stallRounds,
              maxIterationsPerRun: task.maxIterationsPerRun,
              maxReviewRounds: task.maxReviewRounds,
              maxFixRounds: task.maxFixRounds,
              pushTiming: task.pushTiming,
              prDescriptionTaskId: task.prDescriptionTaskId,
            }
          : null;
      const composed = {
        id: task.id,
        name: task.name,
        description: task.description,
        taskType: task.taskType,
        triggers: task.triggers,
        sink: task.sink,
        systemPromptMode: agent.systemPromptMode,
        systemPrompt: [agent.systemPrompt, task.systemAppend ?? ""]
          .filter((part) => part.trim() !== "")
          .join("\n\n"),
        promptTemplate: task.promptTemplate,
        tools: agent.tools,
        toolSettings: task.toolSettings,
        model: task.model ?? agent.model ?? null,
        fallbackModel: agent.fallbackModel,
        tokenBudget: task.tokenBudget,
        referenceDocs: agent.referenceDocs,
        requires: task.requires ?? null,
        setupCommands: task.setupCommands,
        teardownCommands: task.teardownCommands,
        outputSchema: task.outputSchema ?? null,
        variableLimits: task.variableLimits ?? null,
        idleTimeoutMs: task.idleTimeoutMs ?? null,
        maxTurns: task.maxTurns ?? null,
        coding,
      };
      await expect(JSON.stringify(composed, null, 2) + "\n").toMatchFileSnapshot(
        `builtin/__snapshots__/playbook.${playbook.id.slice("builtin:".length)}.json`,
      );
    });
  }
});

describe("builtinProblems", () => {
  it("accepts a valid playbook", () => {
    expect(builtinProblems([playbook])).toEqual([]);
  });

  it("reports playbooks that don't parse", () => {
    expect(builtinProblems([{ ...playbook, role: "nowhere" }])).toEqual([
      expect.stringMatching(/^Playbook #1 doesn't parse/),
    ]);
    expect(builtinProblems([{ ...playbook, sink: "learned-rule" }])).toEqual([
      expect.stringMatching(/^Playbook #1 doesn't parse/),
    ]);
  });

  it("reports IDs that aren't builtin: or are defined twice", () => {
    const uuid = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";
    expect(builtinProblems([{ ...playbook, id: uuid }, playbook, playbook])).toEqual([
      `Playbook ${uuid} doesn't have a builtin: ID.`,
      "Playbook builtin:learn-rule is defined twice.",
    ]);
  });

  it("reports template variables the role's task type and triggers don't provide, and parse errors", () => {
    expect(builtinProblems([{ ...playbook, promptTemplate: "{{issue.title}}" }])).toEqual([
      "Playbook builtin:learn-rule template (1:1): unknown variable issue.title",
    ]);
    expect(builtinProblems([{ ...playbook, promptTemplate: "{{> partial}}" }])).toEqual([
      expect.stringMatching(/^Playbook builtin:learn-rule template \(1:1\): /),
    ]);
    expect(builtinProblems([{ ...playbook, variableLimits: { "issue.title": 10 } }])).toEqual([
      "Playbook builtin:learn-rule limits the unknown variable issue.title.",
    ]);
  });

  it("reports a request playbook that renders an epic, or names a PR description playbook that can't write one", () => {
    const request: PlaybookInput = {
      id: "builtin:handle",
      name: "Handle a request",
      role: "request",
      systemPrompt: "You write code.",
      promptTemplate: "{{#epic.prd}}{{epic.prd}}{{/epic.prd}} on {{branch}}",
      coding: { prDescriptionPlaybookId: "builtin:describe-pr" },
    };
    const describer: PlaybookInput = {
      id: "builtin:describe-pr",
      name: "Describe a PR",
      role: "pr-description",
      systemPrompt: "You describe PRs.",
      promptTemplate: "Describe {{branch}}.",
      outputSchema: getBuiltinTask("builtin:describe-pr")!.outputSchema,
    };
    expect(builtinProblems([request, describer])).toEqual([]);
    expect(
      builtinProblems([
        {
          ...request,
          promptTemplate: "{{epic.prd}} on {{branch}}",
          coding: { prDescriptionPlaybookId: "builtin:learn-rule" },
        },
        describer,
        playbook,
      ]),
    ).toEqual([
      "Playbook builtin:handle prDescriptionTaskId: builtin:learn-rule isn't a query task started by run.invoked.",
      expect.stringMatching(
        /^Playbook builtin:handle promptTemplate: A request \(tracker\.mention, chat\.request, pr\.review-findings, pr\.ci-failed, pr\.fix-command\) may have no epic or story: put \{\{epic\.prd\}\} in an optional section/,
      ),
    ]);
  });
});
