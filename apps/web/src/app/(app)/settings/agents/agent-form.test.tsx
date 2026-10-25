import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_PLAYBOOKS, getBuiltinRunSpec, playbookRunSpec } from "@omniralph/tasks";
import type { CustomAgent } from "@/lib/api/definitions";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import type { HarnessChoices } from "@/lib/harnesses/editor-choices";
import { AgentForm, agentInput, type AgentFormProps } from "./agent-form";
import { agentDraft } from "./agent-changes";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const reviewer: CustomAgent = getBuiltinRunSpec("builtin:review-pr")!.agent;

const AGENT = {
  ...reviewer,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Security reviewer",
  model: "claude-opus-5-5",
  fallbackModel: "claude-sonnet-5-5",
  referenceDocs: [{ name: "threat-model", content: "Our threat model." }],
};

const CHOICES: HarnessChoices = {
  models: [
    { value: "claude-opus-5-5", displayName: "Opus 5.5", harnessIds: ["h1", "h2"] },
    { value: "claude-haiku-5-5", displayName: "Haiku 5.5", harnessIds: ["h1"] },
  ],
  installables: [
    { name: "@omniralph/code-graph", harnessIds: ["h1"], mcpServers: ["graph"] },
    { name: "@omniralph/sast", harnessIds: ["h2"], mcpServers: [] },
  ],
  harnessCount: 2,
};

const render = (
  agent: AgentFormProps["agent"],
  props: Partial<Omit<AgentFormProps, "agent">> = {},
) => {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(
    <Wrapper>
      <AgentForm agent={agent} choices={CHOICES} {...props} />
    </Wrapper>,
  );
};

/** The form's submit button, from its tag to its label. */
const submitButton = (html: string) => {
  const at = html.indexOf('type="submit"');
  expect(at, "a submit button").toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf("</button>", at));
};

/** The field `text` is shown in: the id of the field whose description or error holds it. */
const fieldOf = (html: string, text: string) => {
  const at = html.indexOf(text);
  expect(at, `"${text}" is shown`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('id="', at) + 4;
  return html.slice(start, html.indexOf('"', start)).replace(/-(description|error)$/, "");
};

describe("AgentForm", () => {
  it("renders every field of an agent being edited", () => {
    const html = render(AGENT);
    for (const id of [
      "agent-name",
      "agent-description",
      "agent-system-prompt",
      "agent-system-prompt-mode",
      "agent-tools-builtin",
      "agent-tools-harness-post_activity",
      "agent-tools-linear-linear_get_issue",
      "agent-tools-mcp",
      "agent-referenceDocs.0-content",
      "agent-model",
      "agent-fallback-model",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('value="Security reviewer"');
    // The model by its name; a fallback no harness reports is kept with a warning.
    expect(html).toContain("Opus 5.5");
    expect(html).toMatch(/claude-sonnet-5-5<\/span><span class="picker-chip-note">not available/);
    // Tools are chips, not a comma-separated text box.
    for (const tool of reviewer.tools.builtin) expect(html).toContain(`>${tool}<`);
    expect(html).not.toContain(`value="${reviewer.tools.builtin.join(", ")}"`);
    expect(html).toContain('value="threat-model"');
    expect(html).toContain("Our threat model.");
    // Agents no longer have task types or skills.
    expect(html).not.toContain("agent-task-types");
    expect(html).not.toContain("Skills");
    expect(html).toContain("Save agent");
  });

  it("disables Save on an unchanged edit and states each field's default", () => {
    const html = render(AGENT);
    expect(submitButton(html)).toContain('disabled=""');
    expect(submitButton(html)).toContain("Save agent");
    expect(html).not.toContain("Discard");
    expect(fieldOf(html, "Default: the review depth&#x27;s model.")).toBe("agent-model");
    expect(fieldOf(html, "Default: append to the Claude Code system prompt.")).toBe(
      "agent-system-prompt-mode",
    );
  });

  it("renders an empty form for a new agent", () => {
    const html = render(null);
    expect(html).toContain("New agent");
    expect(html).toContain('id="agent-name"');
    expect(html).toContain("Create agent");
    expect(html).toContain("No reference docs.");
  });

  it("shows each field error next to its field", () => {
    const errors = {
      name: "Name is required.",
      systemPrompt: "System prompt must be a string.",
      "tools.builtin.1": "Tool names are at most 100 characters.",
      "tools.harness": "Not allowed for Triage (query).",
      "tools.linear.0": "Unknown Linear tool.",
      "tools.mcpServers.0": "Server names are required.",
      "referenceDocs.0.content": "Reference docs need content.",
      model: "Model is required.",
      fallbackModel: "Fallback model is too long.",
    };
    const html = render(AGENT, { initialErrors: errors });
    const expected: Record<string, string> = {
      name: "agent-name",
      systemPrompt: "agent-system-prompt",
      "tools.builtin.1": "agent-tools-builtin",
      "tools.harness": "agent-tools-harness",
      "tools.linear.0": "agent-tools-linear",
      "tools.mcpServers.0": "agent-tools-mcp",
      "referenceDocs.0.content": "agent-referenceDocs.0-content",
      model: "agent-model",
      fallbackModel: "agent-fallback-model",
    };
    for (const [field, message] of Object.entries(errors)) {
      expect(fieldOf(html, message), field).toMatch(new RegExp(`^${expected[field]}(-|$)`));
    }
    expect(html).toContain('id="agent-name" aria-invalid="true"');
  });

  it("shows saved MCP servers as chips, marking a configured server's name as unavailable", () => {
    const html = render({
      ...AGENT,
      tools: { ...AGENT.tools, mcpServers: ["@omniralph/code-graph:graph", "github"] },
    });
    expect(html).toContain(">@omniralph/code-graph:graph<");
    expect(html).toContain(">github<");
    // Only an installable's servers can be picked: a name saved before playbooks is flagged.
    expect(html).toMatch(/github<\/span><span class="picker-chip-note">/);
  });

  it("offers no model when no harness reports one", () => {
    const html = render(null, { choices: { models: [], installables: [], harnessCount: 0 } });
    expect(html).toContain("The review depth&#x27;s model");
  });
});

describe("agentInput", () => {
  it("saves an agent loaded and left unedited exactly as it was", () => {
    const custom: CustomAgent = {
      ...AGENT,
      tools: {
        ...AGENT.tools,
        builtin: ["Read", "Bash(pnpm test:*)", "Grep"],
        mcpServers: ["@omniralph/code-graph:graph", "custom:server"],
      },
    };
    for (const agent of [
      custom,
      ...BUILTIN_PLAYBOOKS.map((playbook) => playbookRunSpec(playbook).agent),
      { ...AGENT, model: null, fallbackModel: null },
    ]) {
      const { id: _id, ...fields } = agent;
      expect(agentInput(agentDraft(agent))).toEqual({
        ...fields,
        model: agent.model ?? null,
        fallbackModel: agent.fallbackModel ?? null,
      });
    }
  });
});
