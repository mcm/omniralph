import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS, type AgentDefinition } from "@omniralph/tasks";
import type { ReactNode } from "react";
import {
  createTestQueryClient,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
} from "@/components/query-test-utils";
import { queryKeys } from "@/lib/api/keys";
import { definitionKeys } from "../definition-queries";
import { AgentDetailContent } from "./[id]/agent-detail-view";
import { AgentsTable, AgentsView, type AgentSummary } from "./agents-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const client = createTestQueryClient();
client.setQueryData(definitionKeys(queryKeys(TEST_ORGANIZATION_ID)).agents.list, { agents: [] });

/** The static markup of `node`, rendered for `role` with the query client. */
const html = (node: ReactNode, role: "admin" | "member" = "member") => {
  const Wrapper = queryWrapper(client, { ...testUser, role });
  return renderToStaticMarkup(<Wrapper>{node}</Wrapper>);
};

const reviewer = BUILTIN_AGENTS.find((agent) => agent.id === "builtin:reviewer") as AgentDefinition;

const BUILTIN: AgentSummary = {
  id: reviewer.id,
  name: reviewer.name,
  description: reviewer.description,
  builtin: true,
  taskTypes: reviewer.taskTypes,
  model: reviewer.model,
};

const CUSTOM: AgentSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Security reviewer",
  description: "Looks for vulnerabilities.",
  builtin: false,
  taskTypes: ["review"],
  model: "claude-opus-5-5",
};

/** The markup of the table row naming `name`. */
const row = (html: string, name: string) => {
  const start = html.lastIndexOf("<tr", html.indexOf(`>${name}<`));
  return html.slice(start, html.indexOf("</tr>", start));
};

describe("AgentsView", () => {
  it("lists built-ins and custom agents with ID, task types and model", () => {
    const markup = html(<AgentsTable agents={[BUILTIN, CUSTOM]} />);
    expect(markup.indexOf(">Reviewer<")).toBeLessThan(markup.indexOf(">Security reviewer<"));

    const builtin = row(markup, "Reviewer");
    expect(builtin).toContain("builtin:reviewer");
    expect(builtin).toContain('href="/settings/agents/builtin%3Areviewer"');
    expect(builtin).toContain("Built-in");
    expect(builtin).toContain(">Query<");
    expect(builtin).toContain(">Review<");

    const custom = row(markup, "Security reviewer");
    expect(custom).toContain(CUSTOM.id);
    expect(custom).toContain(`href="/settings/agents/${CUSTOM.id}"`);
    expect(custom).not.toContain("Built-in");
    expect(custom).toContain(">Review<");
    expect(custom).toContain("claude-opus-5-5");
  });

  it("offers admins a new agent, and members none", () => {
    const admin = html(<AgentsView />, "admin");
    expect(admin).toContain('href="/settings/agents/new"');
    expect(admin).toContain("New agent");
    expect(html(<AgentsView />, "member")).not.toContain("New agent");
  });
});

describe("AgentDetailContent", () => {
  const agent: AgentDefinition = {
    ...reviewer,
    model: "claude-sonnet-5-5",
    fallbackModel: "claude-haiku-5-5",
    skills: [{ name: "triage-findings", content: "How to rank findings." }],
    referenceDocs: [{ name: "style-guide", content: "Our style guide." }],
  };
  const tasks = [
    {
      id: "builtin:review-pr",
      name: "Review a pull request",
      taskType: "review" as const,
      builtin: true,
    },
  ];
  const render = (isAdmin: boolean) =>
    html(<AgentDetailContent agent={agent} builtin tasks={tasks} isAdmin={isAdmin} />);

  it("shows the agent's prompt, tools, documents, models, task types and tasks", () => {
    const html = render(false);
    expect(html).toContain("Built-in");
    expect(html).toContain(">System prompt<");
    expect(html).toContain(
      agent.systemPrompt.slice(0, 40).replaceAll("&", "&amp;").replaceAll("'", "&#x27;"),
    );
    for (const tool of agent.tools.builtin) expect(html).toContain(`>${tool}<`);
    expect(html).toContain("triage-findings");
    expect(html).toContain("How to rank findings.");
    expect(html).toContain("style-guide");
    expect(html).toContain("claude-sonnet-5-5");
    expect(html).toContain("claude-haiku-5-5");
    expect(html).toContain(">Query<");
    expect(html).toContain("Review a pull request");
    expect(html).toContain("builtin:review-pr");
  });

  it("offers admins Clone and no Edit or Delete on a built-in", () => {
    const html = render(true);
    expect(html).toContain(">Clone<");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Delete<");
  });

  it("offers admins Clone, Edit and Delete on a custom agent", () => {
    const custom = { ...agent, id: CUSTOM.id, name: CUSTOM.name };
    const admin = html(<AgentDetailContent agent={custom} builtin={false} tasks={[]} isAdmin />);
    expect(admin).not.toContain("Built-in");
    expect(admin).toContain(">Clone<");
    expect(admin).toContain(`href="/settings/agents/${CUSTOM.id}/edit"`);
    expect(admin).toContain(">Edit<");
    expect(admin).toContain(">Delete<");

    const member = html(
      <AgentDetailContent agent={custom} builtin={false} tasks={[]} isAdmin={false} />,
    );
    expect(member).not.toContain(">Clone<");
    expect(member).not.toContain(">Edit<");
    expect(member).not.toContain(">Delete<");
  });

  it("offers members no Clone", () => {
    const html = render(false);
    expect(html).not.toContain(">Clone<");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Delete<");
  });
});

describe("AgentsView on phone", () => {
  it("repeats the task types and model under the name and hides their columns", () => {
    const markup = html(<AgentsTable agents={[CUSTOM]} />);
    const tr = row(markup, "Security reviewer");
    const firstCell = tr.slice(tr.indexOf("<td"), tr.indexOf("</td>"));
    const meta = firstCell.slice(firstCell.indexOf('class="list-phone-meta"'));
    expect(meta).toContain(">Review<");
    expect(meta).toContain("claude-opus-5-5");
    expect(tr.match(/<td class="[^"]*list-col-wide/g)).toHaveLength(3);
    expect(markup.match(/<th class="[^"]*list-col-wide/g)).toHaveLength(3);
  });
});
