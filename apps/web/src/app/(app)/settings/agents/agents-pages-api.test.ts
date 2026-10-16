import { describe, expect, it, vi } from "vitest";
import type { AgentDetail, AgentList } from "@/lib/api/definitions";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const CUSTOM_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  user: null as {
    id: string;
    role: Role;
    organization: { id: string; name: string };
    name: null;
    email: null;
    image: null;
  } | null,
}));

/** A custom agent and a custom task on it, both belonging to org-1. */
const rows = vi.hoisted(() => {
  const now = new Date("2026-10-01T00:00:00Z");
  const agent = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "org-1",
    name: "Security reviewer",
    definition: { systemPrompt: "Find vulnerabilities.", taskTypes: ["review"] },
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  };
  return { agent };
});

const MODEL = { value: "claude-opus-5-5", displayName: "Opus 5.5", harnessIds: ["harness-1"] };

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  getStoredAgentDefinition: async (_db: unknown, organizationId: string, id: string) =>
    organizationId === rows.agent.organizationId && id === rows.agent.id ? rows.agent : null,
  listStoredAgentDefinitions: async (_db: unknown, organizationId: string) =>
    organizationId === rows.agent.organizationId ? [rows.agent] : [],
  getStoredTaskDefinition: async () => null,
  listStoredTaskDefinitions: async () => [],
  listActiveHarnessIds: async (_db: unknown, organizationId: string) =>
    organizationId === rows.agent.organizationId ? ["harness-1"] : [],
  listReportedModels: async () => [MODEL],
  listReportedInstallables: async () => [],
}));
const list = await import("@/app/api/ui/agents/route");
const detail = await import("@/app/api/ui/agents/[id]/route");
const formOptions = await import("@/app/api/ui/agents/form-options/route");

const user = (role: Role, organizationId = "org-1") => ({
  id: `${role}-1`,
  role,
  organization: { id: organizationId, name: "Acme" },
  name: null,
  email: null,
  image: null,
});

/** Calls a GET handler; resolves to the status and JSON body. */
async function get<T = Record<string, unknown>>(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  id = "",
) {
  const response = await handler(new Request("http://localhost/api/ui/agents"), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("Settings › Agents pages' API", () => {
  it("needs a signed-in user", async () => {
    state.user = null;
    expect((await get(list.GET)).status).toBe(401);
    expect((await get(detail.GET, "builtin:reviewer")).status).toBe(401);
  });

  it("lists built-ins first, then the organization's agents, to a member", async () => {
    state.user = user("member");
    const { status, body } = await get<AgentList>(list.GET);
    expect(status).toBe(200);
    const ids = body.agents.map((agent) => agent.id);
    expect(ids.at(-1)).toBe(CUSTOM_ID);
    expect(ids.slice(0, -1).every((id) => id.startsWith("builtin:"))).toBe(true);
    expect(body.agents.at(-1)).toEqual({
      id: CUSTOM_ID,
      name: "Security reviewer",
      description: "",
      builtin: false,
      taskTypes: ["review"],
      model: null,
    });
  });

  it("shows a built-in agent (its ID encoded) and the tasks using it to a member", async () => {
    state.user = user("member");
    const { status, body } = await get<AgentDetail>(
      detail.GET,
      encodeURIComponent("builtin:reviewer"),
    );
    expect(status).toBe(200);
    expect(body.builtin).toBe(true);
    expect(body.agent.id).toBe("builtin:reviewer");
    expect(body.tasks).toContainEqual(
      expect.objectContaining({ id: "builtin:review-pr", taskType: "review", builtin: true }),
    );
  });

  it("shows the organization's own agent", async () => {
    state.user = user("member");
    const { body } = await get<AgentDetail>(detail.GET, CUSTOM_ID);
    expect(body.builtin).toBe(false);
    expect(body.agent).toMatchObject({
      id: CUSTOM_ID,
      name: "Security reviewer",
      systemPrompt: "Find vulnerabilities.",
      taskTypes: ["review"],
    });
    expect(body.tasks).toEqual([]);
  });

  it("404s on another organization's agent or an unknown ID", async () => {
    state.user = user("member", "org-2");
    for (const id of [CUSTOM_ID, "builtin:nope", "%E0%A4%A"]) {
      expect(await get(detail.GET, id), id).toEqual({
        status: 404,
        body: expect.objectContaining({ code: "not_found" }),
      });
    }
  });

  it("gives the form's choices to admins only", async () => {
    state.user = user("member");
    expect((await get(formOptions.GET)).status).toBe(403);
    state.user = user("admin");
    expect(await get(formOptions.GET)).toEqual({
      status: 200,
      body: { models: [MODEL], installables: [], harnessCount: 1 },
    });
  });
});
