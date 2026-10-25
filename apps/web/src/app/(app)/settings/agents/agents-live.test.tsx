// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENTS, type AgentDefinition } from "@omniralph/tasks";
import type * as OmniralphUi from "@omniralph/ui";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
} from "@/components/query-test-utils";
import type { AgentDetail, AgentList, AgentSummary } from "@/lib/api/definitions";
import { queryKeys } from "@/lib/api/keys";
import { definitionKeys } from "../definition-queries";
import { AgentDetailView } from "./[id]/agent-detail-view";
import { EditAgentView, NewAgentView } from "./agent-editor-view";
import { AgentsView } from "./agents-view";

const navigation = vi.hoisted(() => ({
  id: "",
  push: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`);
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({ id: navigation.id }),
  notFound: navigation.notFound,
  redirect: navigation.redirect,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toasts = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: toasts.toast,
}));

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CLONE_ID = "22222222-2222-4222-8222-222222222222";
const reviewer = BUILTIN_AGENTS.find((agent) => agent.id === "builtin:reviewer") as AgentDefinition;
const keys = definitionKeys(queryKeys(TEST_ORGANIZATION_ID));

const summary = (agent: AgentDefinition, builtin: boolean): AgentSummary => ({
  id: agent.id,
  name: agent.name,
  description: agent.description,
  builtin,
  taskTypes: agent.taskTypes,
  model: agent.model,
});

const custom = (changes: Partial<AgentDefinition> = {}): AgentDefinition => ({
  ...reviewer,
  id: AGENT_ID,
  name: "Security reviewer",
  description: "Looks for vulnerabilities.",
  ...changes,
});

const detail = (agent: AgentDefinition = custom(), builtin = false): AgentDetail => ({
  agent,
  builtin,
  tasks: [],
});

const list = (...agents: AgentDefinition[]): AgentList => ({
  agents: [summary(reviewer, true), ...agents.map((agent) => summary(agent, false))],
});

const CHOICES = { models: [], installables: [], harnessCount: 1 };

/** The agents list as visited before (cached, not on screen): it refetches from the API. */
const visitList = (client: QueryClient) =>
  client.prefetchQuery({
    queryKey: keys.agents.list,
    queryFn: async () => (await fetch("/api/ui/agents")).json(),
  });

function renderView(node: React.ReactNode, role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(node, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toasts.toast.mockReset();
  navigation.push.mockReset();
  navigation.notFound.mockReset();
  navigation.redirect.mockClear();
  navigation.id = AGENT_ID;
});

describe("AgentsView", () => {
  it("shows a skeleton, then the agents, and an agent created elsewhere on the next refetch", async () => {
    let agents = list();
    mockFetch({ "GET /api/ui/agents": () => jsonResponse(agents) });
    const client = renderView(<AgentsView />);
    expect(screen.getByLabelText("Loading the agents")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Reviewer" })).toBeTruthy();
    expect(screen.queryByText("Security reviewer")).toBeNull();

    agents = list(custom());
    await client.invalidateQueries();
    expect(await screen.findByRole("link", { name: "Security reviewer" })).toBeTruthy();
  });

  it("shows an error with a retry when the agents don't load", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/agents": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(list()),
    });
    renderView(<AgentsView />);
    expect(await screen.findByText("Couldn't load the agents")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("link", { name: "Reviewer" })).toBeTruthy();
  });
});

describe("AgentDetailView", () => {
  it("loads a built-in by its encoded ID", async () => {
    navigation.id = encodeURIComponent("builtin:reviewer");
    const seen = mockFetch({
      "GET /api/ui/agents/builtin%3Areviewer": detail(reviewer, true),
    });
    renderView(<AgentDetailView />, "member");
    expect(await screen.findByRole("heading", { name: reviewer.name })).toBeTruthy();
    expect(seen.map((request) => request.path)).toEqual(["/api/ui/agents/builtin%3Areviewer"]);
    expect(screen.queryByRole("button", { name: /Clone/ })).toBeNull();
  });

  it("shows the not-found page for an unknown agent, another organization's too", async () => {
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () =>
        jsonResponse({ error: "Not found.", code: "not_found" }, 404),
    });
    renderView(<AgentDetailView />);
    await waitFor(() => expect(navigation.notFound).toHaveBeenCalled());
  });

  it("shows a change saved elsewhere on the next refetch", async () => {
    let agent = custom();
    mockFetch({ [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(detail(agent)) });
    const client = renderView(<AgentDetailView />);
    expect(await screen.findByRole("heading", { name: "Security reviewer" })).toBeTruthy();
    agent = custom({ name: "AppSec reviewer" });
    await client.invalidateQueries();
    expect(await screen.findByRole("heading", { name: "AppSec reviewer" })).toBeTruthy();
  });

  it("clones, refetching the agents before opening the clone's form", async () => {
    let agents = list(custom());
    const copy = custom({ id: CLONE_ID, name: "Security reviewer (copy)" });
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: detail(),
      "GET /api/ui/agents": () => jsonResponse(agents),
      [`POST /api/ui/agents/${AGENT_ID}/clone`]: () => {
        agents = list(custom(), copy);
        return jsonResponse({ ok: true, id: CLONE_ID });
      },
    });
    const client = renderView(<AgentDetailView />);
    await visitList(client);
    let listRefetchedFirst = false;
    navigation.push.mockImplementation(() => {
      listRefetchedFirst =
        JSON.stringify(client.getQueryData(keys.agents.list)) ===
        JSON.stringify(list(custom(), copy));
    });
    await userEvent.click(await screen.findByRole("button", { name: /Clone/ }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/settings/agents/${CLONE_ID}/edit`),
    );
    expect(listRefetchedFirst).toBe(true);
    expect(toasts.toast).toHaveBeenCalledWith("Cloned Security reviewer");
  });

  it("deletes, refetching the list before going back to it", async () => {
    let agents = list(custom());
    const seen = mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: detail(),
      "GET /api/ui/agents": () => jsonResponse(agents),
      [`DELETE /api/ui/agents/${AGENT_ID}`]: () => {
        agents = list();
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView(<AgentDetailView />);
    await visitList(client);
    let listRefetchedFirst = false;
    navigation.push.mockImplementation(() => {
      listRefetchedFirst =
        JSON.stringify(client.getQueryData(keys.agents.list)) === JSON.stringify(list());
    });
    await userEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/settings/agents"));
    expect(seen.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(listRefetchedFirst).toBe(true);
    // The deleted agent isn't refetched (it would 404) and leaves the cache.
    expect(
      seen.filter(
        (request) => request.path === `/api/ui/agents/${AGENT_ID}` && request.method === "GET",
      ),
    ).toHaveLength(1);
    expect(client.getQueryData(keys.agents.detail(AGENT_ID))).toBeUndefined();
  });

  it("keeps the page and shows the error when a delete is refused", async () => {
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: detail(),
      [`DELETE /api/ui/agents/${AGENT_ID}`]: () =>
        jsonResponse({ error: "Security reviewer can't be deleted while tasks use it: X." }, 400),
    });
    renderView(<AgentDetailView />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "Security reviewer can't be deleted while tasks use it: X.",
        { variant: "danger" },
      ),
    );
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Security reviewer" })).toBeTruthy();
  });
});

describe("Agent editor", () => {
  const nameField = () => document.getElementById("agent-name") as HTMLInputElement;

  it("sends members to the access-denied page", () => {
    mockFetch({});
    expect(() => renderView(<NewAgentView />, "member")).toThrow(
      "redirect /access-denied?reason=forbidden",
    );
    expect(() => renderView(<EditAgentView />, "member")).toThrow(
      "redirect /access-denied?reason=forbidden",
    );
  });

  it("doesn't edit a built-in", async () => {
    navigation.id = encodeURIComponent("builtin:reviewer");
    mockFetch({
      "GET /api/ui/agents/builtin%3Areviewer": detail(reviewer, true),
      "GET /api/ui/agents/form-options": CHOICES,
    });
    renderView(<EditAgentView />);
    await waitFor(() => expect(navigation.notFound).toHaveBeenCalled());
  });

  it("follows a change saved elsewhere while clean, never over an edit", async () => {
    let agent = custom();
    mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(detail(agent)),
      "GET /api/ui/agents/form-options": CHOICES,
    });
    const client = renderView(<EditAgentView />);
    await waitFor(() => expect(nameField().value).toBe("Security reviewer"));

    agent = custom({ name: "AppSec reviewer" });
    await client.invalidateQueries();
    await waitFor(() => expect(nameField().value).toBe("AppSec reviewer"));

    fireEvent.change(nameField(), { target: { value: "My reviewer" } });
    agent = custom({ name: "Someone else's name" });
    await client.invalidateQueries();
    await waitFor(() =>
      expect(client.getQueryData(keys.agents.detail(AGENT_ID))).toEqual(detail(agent)),
    );
    expect(nameField().value).toBe("My reviewer");
  });

  it("saves after confirming, refetching the agent before opening its page", async () => {
    let agent = custom();
    const seen = mockFetch({
      [`GET /api/ui/agents/${AGENT_ID}`]: () => jsonResponse(detail(agent)),
      "GET /api/ui/agents/form-options": CHOICES,
      [`PUT /api/ui/agents/${AGENT_ID}`]: (request) => {
        agent = custom({ name: (request.body as { name: string }).name });
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView(<EditAgentView />);
    await waitFor(() => expect(nameField().value).toBe("Security reviewer"));
    fireEvent.change(nameField(), { target: { value: "AppSec reviewer" } });
    await userEvent.click(screen.getByRole("button", { name: "Save agent" }));
    // Scoped to the dialog: a `*ByRole` name query over the whole editor is slow in jsdom.
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Save 1 change" }));

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/settings/agents/${AGENT_ID}`),
    );
    expect(seen.find((request) => request.method === "PUT")!.body).toMatchObject({
      name: "AppSec reviewer",
      systemPrompt: reviewer.systemPrompt,
    });
    // The agent's page renders the saved agent from the cache on arrival.
    expect(client.getQueryData(keys.agents.detail(AGENT_ID))).toEqual(
      detail(custom({ name: "AppSec reviewer" })),
    );
    expect(toasts.toast).toHaveBeenCalledWith("AppSec reviewer saved");
  });

  it("creates an agent and opens it; a refused one shows its field errors", async () => {
    let refuse = true;
    const seen = mockFetch({
      "GET /api/ui/agents/form-options": CHOICES,
      "POST /api/ui/agents": () =>
        refuse
          ? jsonResponse(
              { error: "Fix the highlighted fields.", fieldErrors: { name: "Name is required." } },
              400,
            )
          : jsonResponse({ ok: true, id: CLONE_ID }),
    });
    renderView(<NewAgentView />);
    await waitFor(() => expect(nameField()).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();

    refuse = false;
    fireEvent.change(nameField(), { target: { value: "Researcher" } });
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/settings/agents/${CLONE_ID}`),
    );
    expect(seen.filter((request) => request.method === "POST").at(-1)!.body).toMatchObject({
      name: "Researcher",
    });
    expect(toasts.toast).toHaveBeenCalledWith("Researcher created");
  });
});
