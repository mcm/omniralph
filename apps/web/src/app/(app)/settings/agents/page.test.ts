import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@omniralph/db", () => ({
  getStoredAgentDefinition: async (_db: unknown, organizationId: string, id: string) =>
    organizationId === rows.agent.organizationId && id === rows.agent.id ? rows.agent : null,
  listStoredAgentDefinitions: async (_db: unknown, organizationId: string) =>
    organizationId === rows.agent.organizationId ? [rows.agent] : [],
  getStoredTaskDefinition: async () => null,
  listStoredTaskDefinitions: async () => [],
}));
vi.mock("./agents-view", () => ({ AgentsView: () => null }));
vi.mock("./[id]/agent-detail-view", () => ({ AgentDetailView: () => null }));

const { default: AgentsPage } = await import("./page");
const { default: AgentPage } = await import("./[id]/page");

const user = (role: Role, organizationId = "org-1") => ({
  id: `${role}-1`,
  role,
  organization: { id: organizationId, name: "Acme" },
  name: null,
  email: null,
  image: null,
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Settings › Agents pages", () => {
  it("need a signed-in user", async () => {
    state.user = null;
    await expect(AgentsPage()).rejects.toThrow();
    await expect(AgentPage(params("builtin:reviewer"))).rejects.toThrow();
  });

  it("list built-ins first, then the organization's agents, for a member", async () => {
    state.user = user("member");
    const { props } = await AgentsPage();
    expect(props.isAdmin).toBe(false);
    const ids = props.agents.map((agent: { id: string }) => agent.id);
    expect(ids.at(-1)).toBe(CUSTOM_ID);
    expect(ids.slice(0, -1).every((id: string) => id.startsWith("builtin:"))).toBe(true);
    expect(props.agents.at(-1)).toEqual({
      id: CUSTOM_ID,
      name: "Security reviewer",
      description: "",
      builtin: false,
      taskTypes: ["review"],
      model: null,
    });
  });

  it("tells the view whether the user is an admin", async () => {
    state.user = user("admin");
    expect((await AgentsPage()).props.isAdmin).toBe(true);
  });

  it("show a built-in agent and the tasks using it to a member", async () => {
    state.user = user("member");
    const { props } = await AgentPage(params(encodeURIComponent("builtin:reviewer")));
    expect(props.builtin).toBe(true);
    expect(props.isAdmin).toBe(false);
    expect(props.agent.id).toBe("builtin:reviewer");
    expect(props.tasks).toContainEqual(
      expect.objectContaining({ id: "builtin:review-pr", taskType: "review", builtin: true }),
    );
  });

  it("show the organization's own agent", async () => {
    state.user = user("member");
    const { props } = await AgentPage(params(CUSTOM_ID));
    expect(props.builtin).toBe(false);
    expect(props.agent).toMatchObject({ id: CUSTOM_ID, name: "Security reviewer" });
    expect(props.tasks).toEqual([]);
  });

  it("don't find another organization's agent or an unknown ID", async () => {
    state.user = user("member", "org-2");
    await expect(AgentPage(params(CUSTOM_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(AgentPage(params("builtin:nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(AgentPage(params("%E0%A4%A"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
