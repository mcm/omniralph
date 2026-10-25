import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import type { ReactNode } from "react";
import {
  createTestQueryClient,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
} from "@/components/query-test-utils";
import { queryKeys } from "@/lib/api/keys";
import type { TaskReferrers } from "@/lib/definitions/referrers";
import { definitionKeys } from "../definition-queries";
import { TaskDetailContent } from "./[id]/task-detail-view";
import { TasksView, type TaskSummary } from "./tasks-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** The static markup of `node` with a query client holding `tasks` as the task list. */
const markup = (node: ReactNode, { isAdmin = false, tasks = [] as TaskSummary[] } = {}) => {
  const client = createTestQueryClient();
  client.setQueryData(definitionKeys(queryKeys(TEST_ORGANIZATION_ID)).tasks.list, { tasks });
  const Wrapper = queryWrapper(client, { ...testUser, role: isAdmin ? "admin" : "member" });
  return renderToStaticMarkup(<Wrapper>{node}</Wrapper>);
};

/** The tasks page listing `tasks`. */
const tasksView = (isAdmin: boolean, tasks: TaskSummary[]) =>
  markup(<TasksView />, { isAdmin, tasks });

const CUSTOM_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const summary = (task: TaskDefinition, builtin: boolean, agentName: string): TaskSummary => ({
  id: task.id,
  name: task.name,
  description: task.description,
  builtin,
  taskType: task.taskType,
  agentId: task.agentId,
  agentName,
  triggers: task.triggers,
  sink: task.sink,
});

const reviewPr = getBuiltinTask("builtin:review-pr")!;
const askAboutCode = getBuiltinTask("builtin:ask-about-code")!;
const implementStory = getBuiltinTask("builtin:implement-story")!;

const CUSTOM_REVIEW: TaskSummary = {
  ...summary(reviewPr, false, "Security reviewer"),
  id: CUSTOM_ID,
  name: "Security review",
  agentId: AGENT_ID,
  description: "Reviews for vulnerabilities.",
};

const NO_REFERRERS: TaskReferrers = {
  repositories: [],
  chatTasks: [],
  chatChannels: [],
  codingTasks: [],
};

/** The markup of the table row naming `name`. */
const row = (html: string, name: string) => {
  const start = html.lastIndexOf("<tr", html.indexOf(`>${name}<`));
  return html.slice(start, html.indexOf("</tr>", start));
};

/** The markup of the card listing tasks of `label`'s type. */
const group = (html: string, label: string) => {
  const start = html.indexOf(`aria-label="${label} tasks"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('aria-label="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

describe("TasksView", () => {
  it("groups built-in and custom tasks under Query, Review and Coding", () => {
    const html = tasksView(false, [
      summary(askAboutCode, true, "Code explainer"),
      summary(reviewPr, true, "Reviewer"),
      summary(implementStory, true, "Engineer"),
      CUSTOM_REVIEW,
    ]);
    expect(html.indexOf('aria-label="Query tasks"')).toBeLessThan(
      html.indexOf('aria-label="Review tasks"'),
    );
    expect(html.indexOf('aria-label="Review tasks"')).toBeLessThan(
      html.indexOf('aria-label="Coding tasks"'),
    );

    const query = group(html, "Query");
    expect(query).toContain(askAboutCode.name);
    expect(query).not.toContain(reviewPr.name);

    const review = group(html, "Review");
    expect(review).toContain(reviewPr.name);
    expect(review).toContain("Security review");
    expect(review).not.toContain(implementStory.name);
    expect(group(html, "Coding")).toContain(implementStory.name);

    const builtin = row(html, reviewPr.name);
    expect(builtin).toContain("builtin:review-pr");
    expect(builtin).toContain('href="/settings/tasks/builtin%3Areview-pr"');
    expect(builtin).toContain("Built-in");
    expect(builtin).toContain(`href="/settings/agents/${encodeURIComponent(reviewPr.agentId)}"`);
    expect(builtin).toContain(">Reviewer<");
    for (const trigger of reviewPr.triggers) expect(builtin).toContain(`>${trigger}<`);
    expect(builtin).toContain(`>${reviewPr.sink}<`);

    const custom = row(html, "Security review");
    expect(custom).toContain(CUSTOM_ID);
    expect(custom).toContain(`href="/settings/tasks/${CUSTOM_ID}"`);
    expect(custom).not.toContain("Built-in");
    expect(custom).toContain(`href="/settings/agents/${AGENT_ID}"`);
    expect(custom).toContain(">Security reviewer<");
  });

  it("offers admins a new task", () => {
    const admin = tasksView(true, [CUSTOM_REVIEW]);
    expect(admin).toContain('href="/settings/tasks/new"');
    const member = tasksView(false, [CUSTOM_REVIEW]);
    expect(member).not.toContain('href="/settings/tasks/new"');
  });

  it("shows the bare agent ID when the agent doesn't resolve", () => {
    const html = tasksView(false, [{ ...CUSTOM_REVIEW, agentName: null }]);
    const custom = row(html, "Security review");
    expect(custom).toContain(AGENT_ID);
    expect(custom).not.toContain(`href="/settings/agents/${AGENT_ID}"`);
  });
});

describe("TaskDetailContent", () => {
  it("shows a built-in coding task with its timing and PR description task, Clone only for admins", () => {
    const task: TaskDefinition = {
      ...implementStory,
      pushTiming: "end",
      prDescriptionTaskId: "builtin:describe-pr",
    };
    const render = (isAdmin: boolean) =>
      markup(
        <TaskDetailContent
          isAdmin={isAdmin}
          task={task}
          builtin
          agentName="Engineer"
          prDescriptionTaskName="Describe PR"
          requirements={{ minHarnessVersion: "0.11.0", installables: [], hostTools: [] }}
          referrers={NO_REFERRERS}
        />,
      );
    const html = render(true);
    expect(html).toContain("Built-in");
    expect(html).toContain(">Coding<");
    expect(html).toContain("Once, when every story is done");
    expect(html).not.toContain("Draft PR");
    expect(html).toContain('href="/settings/tasks/builtin%3Adescribe-pr"');
    expect(html).toContain(">Describe PR<");
    expect(html).toContain(">0.11.0<");
    expect(html).not.toContain("Output schema");
    expect(html).toContain("Nothing uses this task.");
    expect(html).toContain("Clone");
    expect(html).not.toContain("Edit");
    expect(html).not.toContain("Delete");

    const member = render(false);
    expect(member).not.toContain("Clone");
    expect(member).not.toContain("Edit");
    expect(member).not.toContain("Delete");
  });

  it("shows a query task with its output schema, commands, requirements and referrers", () => {
    const task: TaskDefinition = {
      ...askAboutCode,
      id: CUSTOM_ID,
      name: "Structured answer",
      promptTemplate: "Answer {{question}} with a verdict.",
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string", enum: ["yes", "no"] } },
        required: ["verdict"],
      },
      setupCommands: [
        {
          name: "deps",
          command: "pnpm ls --json",
          timeoutSeconds: 60,
          maxOutputBytes: 5000,
          fence: "json",
          optional: true,
        },
      ],
      teardownCommands: [
        { name: "cleanup", command: "rm -rf tmp", timeoutSeconds: 30, maxOutputBytes: 1000 },
      ],
      toolSettings: { shell: true, linearRead: false, network: false },
      model: "claude-sonnet-5-5",
      tokenBudget: { tokens: 50_000 },
    };
    const html = markup(
      <TaskDetailContent
        isAdmin={false}
        task={task}
        builtin={false}
        agentName="Code explainer"
        prDescriptionTaskName={null}
        requirements={{
          minHarnessVersion: "0.12.3",
          installables: ["ripgrep"],
          hostTools: ["git"],
        }}
        referrers={{
          repositories: [
            {
              id: "repo-1",
              fullPath: "acme/app",
              reviewTask: false,
              correlationTask: true,
              storyTask: false,
              requestTask: false,
            },
          ],
          chatTasks: ["askAboutCode"],
          chatChannels: [
            {
              connectionId: "conn-1",
              connectionName: "Acme Slack",
              channelId: "slack:C0123ABCD",
              askAboutCode: true,
              startWork: false,
            },
          ],
          codingTasks: [{ id: "builtin:implement-story", name: "Implement story", builtin: true }],
        }}
      />,
    );
    expect(html).not.toContain("Built-in task");
    expect(html).toContain(">Query<");
    expect(html).toContain(`href="/settings/agents/${encodeURIComponent(askAboutCode.agentId)}"`);
    expect(html).toContain("Output schema");
    expect(html).toContain("&quot;verdict&quot;");
    expect(html).toContain("&quot;required&quot;");
    expect(html).not.toContain("PR description task");
    expect(html).toContain("pnpm ls --json");
    expect(html).toContain("rm -rf tmp");
    expect(html).toContain("claude-sonnet-5-5");
    expect(html).toContain("50,000 tokens");
    expect(html).toContain("Minimum harness version");
    expect(html).toContain(">0.12.3<");
    expect(html).toContain(">ripgrep<");
    expect(html).toContain(">git<");
    expect(html).toContain("Answer {{question}} with a verdict.");
    expect(html).toContain('href="/repositories/repo-1"');
    expect(html).toContain("correlation task");
    expect(html).toContain("organization Ask about code task");
    expect(html).toContain("Acme Slack › C0123ABCD");
    expect(html).toContain('href="/settings/tasks/builtin%3Aimplement-story"');
    expect(html).not.toContain("Clone");
  });

  it("shows admins Clone, Edit and Delete on a custom task", () => {
    const task: TaskDefinition = { ...reviewPr, id: CUSTOM_ID, name: "Security review" };
    const render = (isAdmin: boolean) =>
      markup(
        <TaskDetailContent
          isAdmin={isAdmin}
          task={task}
          builtin={false}
          agentName="Reviewer"
          prDescriptionTaskName={null}
          requirements={{ minHarnessVersion: null, installables: [], hostTools: [] }}
          referrers={NO_REFERRERS}
        />,
      );
    const html = render(true);
    expect(html).toContain("Clone");
    expect(html).toContain(`href="/settings/tasks/${CUSTOM_ID}/edit"`);
    expect(html).toContain("Delete");
    const member = render(false);
    expect(member).not.toContain("Clone");
    expect(member).not.toContain("/edit");
    expect(member).not.toContain("Delete");
  });
});

describe("TasksView on phone", () => {
  it("repeats the agent, triggers and sink under the name and hides their columns", () => {
    const html = tasksView(false, [CUSTOM_REVIEW]);
    const tr = row(html, "Security review");
    const firstCell = tr.slice(tr.indexOf("<td"), tr.indexOf("</td>"));
    const meta = firstCell.slice(firstCell.indexOf('class="list-phone-meta"'));
    expect(meta).toContain(`href="/settings/agents/${AGENT_ID}"`);
    expect(meta).toContain(">Security reviewer<");
    for (const trigger of CUSTOM_REVIEW.triggers) expect(meta).toContain(`>${trigger}<`);
    expect(meta).toContain(`>${CUSTOM_REVIEW.sink}<`);
    expect(tr.match(/<td class="[^"]*list-col-wide/g)).toHaveLength(4);
    expect(html.match(/<th class="[^"]*list-col-wide/g)).toHaveLength(4);
  });
});
