import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS, type AgentDefinition } from "@omniralph/tasks";
import { AgentDetailView } from "./[id]/agent-detail-view";
import { AgentsView, type AgentSummary } from "./agents-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("./actions", () => ({ cloneAgentDefinition: vi.fn(), deleteAgentDefinition: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
    const html = renderToStaticMarkup(<AgentsView agents={[BUILTIN, CUSTOM]} isAdmin={false} />);
    expect(html.indexOf(">Reviewer<")).toBeLessThan(html.indexOf(">Security reviewer<"));

    const builtin = row(html, "Reviewer");
    expect(builtin).toContain("builtin:reviewer");
    expect(builtin).toContain('href="/settings/agents/builtin%3Areviewer"');
    expect(builtin).toContain("Built-in");
    expect(builtin).toContain(">query<");
    expect(builtin).toContain(">review<");

    const custom = row(html, "Security reviewer");
    expect(custom).toContain(CUSTOM.id);
    expect(custom).toContain(`href="/settings/agents/${CUSTOM.id}"`);
    expect(custom).not.toContain("Built-in");
    expect(custom).toContain(">review<");
    expect(custom).toContain("claude-opus-5-5");
    expect(html).not.toContain("New agent");
  });

  it("offers admins a new agent", () => {
    const html = renderToStaticMarkup(<AgentsView agents={[BUILTIN]} isAdmin />);
    expect(html).toContain('href="/settings/agents/new"');
    expect(html).toContain("New agent");
  });
});

describe("AgentDetailView", () => {
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
    renderToStaticMarkup(<AgentDetailView agent={agent} builtin tasks={tasks} isAdmin={isAdmin} />);

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
    expect(html).toContain(">query<");
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
    const html = renderToStaticMarkup(
      <AgentDetailView agent={custom} builtin={false} tasks={[]} isAdmin />,
    );
    expect(html).not.toContain("Built-in");
    expect(html).toContain(">Clone<");
    expect(html).toContain(`href="/settings/agents/${CUSTOM.id}/edit"`);
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Delete<");

    const member = renderToStaticMarkup(
      <AgentDetailView agent={custom} builtin={false} tasks={[]} isAdmin={false} />,
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
