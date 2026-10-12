import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinTask, TRIGGERS_BY_TASK_TYPE, type TaskDefinition } from "@omniralph/tasks";
import type { TaskChoice } from "@/lib/definitions";
import { TaskForm, type TaskFormAgent, type TaskFormSink } from "./task-form";
import { parseOutputSchema } from "./task-form-sections";

vi.mock("./actions", () => ({
  createTaskDefinition: vi.fn(),
  updateTaskDefinition: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const TASK: TaskDefinition = {
  ...getBuiltinTask("builtin:review-pr")!,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Security review",
  promptTemplate: "Review the change for vulnerabilities.",
  model: "claude-opus-5-5",
  tokenBudget: { tokens: 50_000 },
};

const AGENTS: TaskFormAgent[] = [
  { id: "builtin:reviewer", name: "Reviewer", taskTypes: ["query", "review"], builtin: true },
  { id: "builtin:engineer", name: "Engineer", taskTypes: ["coding"], builtin: true },
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Custom reviewer",
    taskTypes: ["review"],
    builtin: false,
  },
];

const SINKS: TaskFormSink[] = [
  { kind: "review", taskType: "review" },
  { kind: "sticky-comment", taskType: "review" },
  { kind: "chat-thread", taskType: "query" },
  { kind: "ralph-run", taskType: "coding" },
];

const PR_DESCRIPTION_TASKS: TaskChoice[] = [
  { id: "builtin:describe-pr", name: "Describe a PR", builtin: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Describe with changelog", builtin: false },
];

const render = (task: TaskDefinition | null, initialErrors = {}) =>
  renderToStaticMarkup(
    <TaskForm
      task={task}
      agents={AGENTS}
      sinks={SINKS}
      pools={["short", "long"]}
      prDescriptionTasks={PR_DESCRIPTION_TASKS}
      initialErrors={initialErrors}
    />,
  );

/** A task of `id`'s built-in, as one of the organization's. */
const custom = (id: string, fields: Partial<TaskDefinition> = {}): TaskDefinition => ({
  ...getBuiltinTask(id)!,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Custom",
  promptTemplate: "Do the work.",
  ...fields,
});

const SETUP = {
  name: "changelog",
  command: "git log --oneline",
  timeoutSeconds: 30,
  maxOutputBytes: 4000,
  fence: "text",
  optional: true,
};

/** The `for` of the last label before `text`: the field `text` is shown in. */
const fieldOf = (html: string, text: string) => {
  const at = html.indexOf(text);
  expect(at, `"${text}" is shown`).toBeGreaterThan(-1);
  const label = html.lastIndexOf('for="', at);
  return html.slice(label + 5, html.indexOf('"', label + 5));
};

describe("TaskForm", () => {
  it("renders the common fields of a task being edited", () => {
    const html = render(TASK);
    for (const id of [
      "task-name",
      "task-description",
      "task-type",
      "task-agent",
      "task-triggers-pr.updated",
      "task-prompt-template",
      "task-sink",
      "task-pool",
      "task-model",
      "task-token-budget",
      "task-token-budget-amount",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('value="Security review"');
    expect(html).toContain("Review the change for vulnerabilities.");
    expect(html).toContain('value="claude-opus-5-5"');
    expect(html).toContain('value="50000"');
    expect(html).toContain("Save task");
  });

  it("offers only the agents, triggers and sinks the task type accepts", () => {
    const html = render(TASK);
    expect(html).toContain(">Reviewer (built-in)<");
    expect(html).toContain(">Custom reviewer<");
    expect(html).not.toContain("Engineer");
    for (const trigger of TRIGGERS_BY_TASK_TYPE.review) {
      expect(html).toContain(`id="task-triggers-${trigger}"`);
    }
    expect(html).not.toContain('id="task-triggers-chat.request"');
    expect(html).toContain('value="sticky-comment"');
    expect(html).not.toContain('value="chat-thread"');
    expect(html).not.toContain('value="ralph-run"');
    expect(html).toContain('value="long"');
  });

  it("renders an empty query task for a new task", () => {
    const html = render(null);
    expect(html).toContain("New task");
    expect(html).toContain("Create task");
    expect(html).toContain('id="task-triggers-chat.request"');
    expect(html).toContain('value="chat-thread"');
    expect(html).not.toContain('id="task-token-budget-amount"');
  });

  it("shows each field error next to its field", () => {
    const errors = {
      name: "Name is required.",
      taskType: "The task type can not change while it is used.",
      agentId: "Agent builtin:engineer suits coding tasks, not review.",
      triggers: "review tasks accept pr.updated, pr.mention, review.rerun.",
      promptTemplate: "{{chat.context}} is not available for pr.updated.",
      sink: "The chat-thread sink takes query tasks.",
      pool: "Pick a pool.",
      model: "Model is too long.",
      "tokenBudget.tokens": "Tokens must be at least 1.",
    };
    const html = render(TASK, errors);
    const expected: Record<string, string> = {
      name: "task-name",
      taskType: "task-type",
      agentId: "task-agent",
      triggers: "task-triggers",
      promptTemplate: "task-prompt-template",
      sink: "task-sink",
      pool: "task-pool",
      model: "task-model",
      "tokenBudget.tokens": "task-token-budget",
    };
    for (const [field, message] of Object.entries(errors)) {
      expect(fieldOf(html, message), field).toMatch(new RegExp(`^${expected[field]}(-|$)`));
    }
    expect(html).toMatch(/id="task-prompt-template"[^>]*aria-invalid="true"/);
  });
  it("shows the commands and tool settings of every type, the output schema of a query task", () => {
    const html = render(
      custom("builtin:ask-about-code", {
        setupCommands: [SETUP],
        teardownCommands: [
          { name: "cleanup", command: "rm -rf tmp", timeoutSeconds: 10, maxOutputBytes: 100 },
        ],
        toolSettings: { shell: true, linearRead: false, network: true },
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    );
    for (const id of [
      "task-setupCommands-0-name",
      "task-setupCommands-0-command",
      "task-setupCommands-0-timeoutSeconds",
      "task-setupCommands-0-maxOutputBytes",
      "task-setupCommands-0-fence",
      "task-setupCommands-0-optional",
      "task-teardownCommands-0-name",
      "task-teardownCommands-0-command",
      "task-teardownCommands-0-timeoutSeconds",
      "task-teardownCommands-0-maxOutputBytes",
      "task-tool-settings-shell",
      "task-tool-settings-linearRead",
      "task-tool-settings-network",
      "task-output-schema",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="task-teardownCommands-0-fence"');
    expect(html).toContain('value="changelog"');
    expect(html).toContain('value="30"');
    expect(html).toContain("{{setup.changelog}}");
    expect(html).toContain("&quot;answer&quot;");
    expect(html).toMatch(
      /id="task-tool-settings-shell"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="task-tool-settings-shell"/,
    );
    expect(html).not.toContain('id="task-push-timing"');
    expect(html).not.toContain('id="task-pr-description-task"');
  });

  it("shows neither shell, output schema nor coding settings on a review task", () => {
    const html = render(TASK);
    expect(html).toContain("Setup commands");
    expect(html).toContain("Teardown commands");
    expect(html).toContain('id="task-tool-settings-linearRead"');
    expect(html).toContain('id="task-tool-settings-network"');
    expect(html).not.toContain('id="task-tool-settings-shell"');
    expect(html).not.toContain('id="task-output-schema"');
    expect(html).not.toContain('id="task-push-timing"');
    expect(html).not.toContain('id="task-draft-pull-request"');
    expect(html).not.toContain('id="task-pr-description-task"');
  });

  it("shows the coding settings of a coding task, its PR description task among the choices", () => {
    const html = render(
      custom("builtin:implement-story", {
        pushTiming: "end",
        draftPullRequest: "end",
        prDescriptionTaskId: PR_DESCRIPTION_TASKS[1]!.id,
      }),
    );
    for (const id of [
      "task-push-timing",
      "task-draft-pull-request",
      "task-pr-description-task",
      "task-maxAttemptsPerStory",
      "task-maxIterationsPerRun",
      "task-maxReviewRounds",
      "task-maxFixRounds",
      "task-tool-settings-network",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain("Add setup command");
    expect(html).toContain("Add teardown command");
    expect(html).not.toContain('id="task-output-schema"');
    expect(html).not.toContain('id="task-tool-settings-shell"');
    expect(html).toMatch(/<option value="end" selected="">Once at the end<\/option>/);
    expect(html).toMatch(/<option value="end" selected="">At the end<\/option>/);
    expect(html).toContain(">Describe a PR (built-in)<");
    expect(html).toMatch(
      /<option value="22222222-2222-4222-8222-222222222222" selected="">Describe with changelog<\/option>/,
    );
  });

  it("defaults a coding task's PR description task to builtin:describe-pr", () => {
    const html = render(custom("builtin:implement-story", { prDescriptionTaskId: undefined }));
    expect(html).toMatch(/<option value="builtin:describe-pr" selected="">/);
  });

  it("shows errors on a setup command and on the output schema next to their fields", () => {
    const errors = {
      "setupCommands.0.name": "Use lowercase letters, digits and _, starting with a letter",
      "setupCommands.0.timeoutSeconds": "Too big: expected number to be at most 1800",
      "teardownCommands.0.command": "Too small: expected string to have at least 1 character",
      outputSchema: "This is not valid JSON: Unexpected token",
    };
    const html = render(
      custom("builtin:ask-about-code", {
        setupCommands: [SETUP],
        teardownCommands: [
          { name: "cleanup", command: "x", timeoutSeconds: 10, maxOutputBytes: 100 },
        ],
      }),
      errors,
    );
    expect(fieldOf(html, errors["setupCommands.0.name"])).toBe("task-setupCommands-0-name");
    expect(fieldOf(html, errors["setupCommands.0.timeoutSeconds"])).toBe(
      "task-setupCommands-0-timeoutSeconds",
    );
    expect(fieldOf(html, errors["teardownCommands.0.command"])).toBe(
      "task-teardownCommands-0-command",
    );
    expect(fieldOf(html, errors.outputSchema)).toBe("task-output-schema");
    expect(html).toMatch(/id="task-output-schema"[^>]*aria-invalid="true"/);
  });

  it("shows coding field errors next to their fields", () => {
    const errors = {
      draftPullRequest: "An early draft PR needs the stories pushed as they are done.",
      prDescriptionTaskId: "builtin:ask-about-code is not a query task started by run.invoked.",
    };
    const html = render(
      custom("builtin:implement-story", { prDescriptionTaskId: "builtin:ask-about-code" }),
      errors,
    );
    expect(fieldOf(html, errors.draftPullRequest)).toBe("task-draft-pull-request");
    expect(fieldOf(html, errors.prDescriptionTaskId)).toBe("task-pr-description-task");
    // The task it names stays visible though it doesn't qualify.
    expect(html).toMatch(/<option value="builtin:ask-about-code" selected="">/);
  });
});

describe("parseOutputSchema", () => {
  it("reads a JSON object, nothing when empty, and says why anything else isn't a schema", () => {
    expect(parseOutputSchema("  ")).toEqual({});
    expect(parseOutputSchema('{"type": "object"}')).toEqual({ schema: { type: "object" } });
    expect(parseOutputSchema('{"type": ')).toEqual({
      error: expect.stringContaining("valid JSON"),
    });
    for (const text of ["[]", "null", "42", '"object"']) {
      expect(parseOutputSchema(text), text).toEqual({
        error: "The output schema must be a JSON object.",
      });
    }
  });
});
