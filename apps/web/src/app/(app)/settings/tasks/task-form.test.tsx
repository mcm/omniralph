import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinTask, TRIGGERS_BY_TASK_TYPE, type TaskDefinition } from "@omniralph/tasks";
import { TaskForm, type TaskFormAgent, type TaskFormSink } from "./task-form";

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

const render = (task: TaskDefinition | null, initialErrors = {}) =>
  renderToStaticMarkup(
    <TaskForm
      task={task}
      agents={AGENTS}
      sinks={SINKS}
      pools={["short", "long"]}
      initialErrors={initialErrors}
    />,
  );

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
});
