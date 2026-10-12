import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinAgent, getBuiltinTask, type AgentDefinition } from "@omniralph/tasks";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

interface Row {
  id: string;
  organizationId: string;
  name: string;
  definition: Record<string, unknown>;
  requirements?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

const state = vi.hoisted(() => ({
  user: null as {
    id: string;
    role: Role;
    organization: { id: string; name: string };
    name: null;
    email: null;
    image: null;
  } | null,
  agents: [] as Row[],
  tasks: [] as Row[],
  writes: 0,
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const find = (rows: Row[], organizationId: string, id: string) =>
    UUID.test(id)
      ? (rows.find((row) => row.organizationId === organizationId && row.id === id) ?? null)
      : null;
  const list = (rows: Row[], organizationId: string) =>
    rows
      .filter((row) => row.organizationId === organizationId)
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    getStoredAgentDefinition: async (_db: unknown, organizationId: string, id: string) =>
      find(state.agents, organizationId, id),
    listStoredAgentDefinitions: async (_db: unknown, organizationId: string) =>
      list(state.agents, organizationId),
    getStoredTaskDefinition: async (_db: unknown, organizationId: string, id: string) =>
      find(state.tasks, organizationId, id),
    listStoredTaskDefinitions: async (_db: unknown, organizationId: string) =>
      list(state.tasks, organizationId),
    insertAgentDefinition: async (
      _db: unknown,
      organizationId: string,
      input: { id: string; name: string; definition: Record<string, unknown>; createdBy: string },
    ) => {
      state.writes++;
      const now = new Date();
      const row = {
        ...input,
        organizationId,
        createdAt: now,
        updatedAt: now,
        updatedBy: input.createdBy,
      };
      state.agents.push(row);
      return row;
    },
    updateAgentDefinition: async (
      _db: unknown,
      organizationId: string,
      id: string,
      input: { name: string; definition: Record<string, unknown>; updatedBy: string },
    ) => {
      const row = find(state.agents, organizationId, id);
      if (!row) return null;
      state.writes++;
      Object.assign(row, input, { updatedAt: new Date() });
      return row;
    },
    deleteAgentDefinition: async (_db: unknown, organizationId: string, id: string) => {
      const row = find(state.agents, organizationId, id);
      if (!row) return false;
      state.writes++;
      state.agents.splice(state.agents.indexOf(row), 1);
      return true;
    },
  };
});

const {
  cloneAgentDefinition,
  createAgentDefinition,
  deleteAgentDefinition,
  updateAgentDefinition,
} = await import("./actions");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

const user = (role: Role) => ({
  id: `${role}-1`,
  role,
  organization: { id: "org-1", name: "Acme" },
  name: null,
  email: null,
  image: null,
});

const INPUT = {
  name: "Security reviewer",
  description: "Looks for vulnerabilities.",
  systemPrompt: "Find vulnerabilities.",
  tools: { builtin: ["Read", "Grep"], harness: [], linear: [], mcpServers: [] },
  model: "claude-opus-5-5",
  taskTypes: ["review" as const, "query" as const],
};

const row = (fields: Partial<Row> & Pick<Row, "id" | "name" | "definition">): Row => ({
  organizationId: "org-1",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  createdBy: null,
  updatedBy: null,
  ...fields,
});

const {
  id: _reviewPrId,
  name: _reviewPrName,
  ...storedReviewPr
} = getBuiltinTask("builtin:review-pr")!;

/** A review task of org-1 running on `agentId`. */
const reviewTask = (name: string, agentId: string, id = TASK_ID) =>
  row({
    id,
    name,
    definition: { ...storedReviewPr, agentId },
    requirements: { minHarnessVersion: null, installables: [], hostTools: [] },
  });

describe("Settings › Agents actions", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.writes = 0;
    state.agents = [
      row({ id: AGENT_ID, name: "Security reviewer", definition: { ...INPUT, name: undefined } }),
      row({
        id: OTHER_ORG_AGENT_ID,
        organizationId: "org-2",
        name: "Theirs",
        definition: { systemPrompt: "", taskTypes: ["review"] },
      }),
    ];
    state.tasks = [];
  });

  it("are admin-only: a member writes nothing", async () => {
    state.user = user("member");
    const refused = { ok: false, error: expect.any(String) };
    expect(await createAgentDefinition(INPUT)).toEqual(refused);
    expect(await updateAgentDefinition(AGENT_ID, INPUT)).toEqual(refused);
    expect(await cloneAgentDefinition("builtin:reviewer")).toEqual(refused);
    expect(await deleteAgentDefinition(AGENT_ID)).toEqual(refused);
    expect(state.writes).toBe(0);
    expect(state.agents).toHaveLength(2);
  });

  it("creates a validated agent recording the admin, and returns its ID", async () => {
    const result = await createAgentDefinition({ ...INPUT, name: "  Researcher " });
    expect(result).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (result as { id: string }).id;
    const created = state.agents.find((agent) => agent.id === id)!;
    expect(created).toMatchObject({
      organizationId: "org-1",
      name: "Researcher",
      createdBy: "admin-1",
      updatedBy: "admin-1",
    });
    expect(created.definition).toMatchObject({
      systemPrompt: "Find vulnerabilities.",
      systemPromptMode: "append",
      model: "claude-opus-5-5",
      fallbackModel: null,
      taskTypes: ["review", "query"],
    });
    expect(created.definition).not.toHaveProperty("id");
    expect(created.definition).not.toHaveProperty("name");
  });

  it("rejects an invalid definition with the validator's field paths, writing nothing", async () => {
    const result = await createAgentDefinition({
      ...INPUT,
      name: " ",
      taskTypes: [],
      skills: [{ name: "owasp", content: "" }],
      tools: { ...INPUT.tools, harness: ["teleport" as never] },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
      fieldErrors: expect.objectContaining({
        name: expect.any(String),
        taskTypes: expect.any(String),
        "skills.0.content": expect.any(String),
        "tools.harness.0": expect.any(String),
      }),
    });
    expect(await updateAgentDefinition(AGENT_ID, { ...INPUT, taskTypes: [] })).toEqual({
      ok: false,
      error: expect.any(String),
      fieldErrors: { taskTypes: expect.any(String) },
    });
    expect(state.writes).toBe(0);
  });

  it("updates an agent recording the admin", async () => {
    state.user = { ...user("admin"), id: "admin-2" };
    expect(
      await updateAgentDefinition(AGENT_ID, { ...INPUT, name: "AppSec", fallbackModel: "x" }),
    ).toEqual({ ok: true });
    const updated = state.agents.find((agent) => agent.id === AGENT_ID)!;
    expect(updated).toMatchObject({ name: "AppSec", updatedBy: "admin-2" });
    expect(updated.definition).toMatchObject({ fallbackModel: "x" });
  });

  it("refuses an update that would make a task using the agent invalid, naming each task", async () => {
    state.tasks = [
      reviewTask("Security review", AGENT_ID),
      reviewTask("Dependency review", AGENT_ID, "44444444-4444-4444-8444-444444444444"),
      reviewTask("Unrelated review", "builtin:reviewer", "55555555-5555-4555-8555-555555555555"),
    ];
    const dropped = await updateAgentDefinition(AGENT_ID, { ...INPUT, taskTypes: ["query"] });
    expect(dropped).toMatchObject({ ok: false, fieldErrors: { taskTypes: expect.any(String) } });
    const { error } = dropped as { error: string };
    expect(error).toContain("Security review");
    expect(error).toContain("Dependency review");
    expect(error).not.toContain("Unrelated review");

    const shipping = await updateAgentDefinition(AGENT_ID, {
      ...INPUT,
      tools: { ...INPUT.tools, harness: ["ship"] },
    });
    expect(shipping).toMatchObject({
      ok: false,
      error: expect.stringContaining("Security review"),
      fieldErrors: { "tools.harness": expect.stringContaining("Security review") },
    });
    expect(state.writes).toBe(0);

    // Still suiting every task's type is fine.
    expect(await updateAgentDefinition(AGENT_ID, { ...INPUT, taskTypes: ["review"] })).toEqual({
      ok: true,
    });
  });

  it("refuses to update or delete a built-in, and treats another organization's agent as missing", async () => {
    for (const result of [
      await updateAgentDefinition("builtin:reviewer", INPUT),
      await deleteAgentDefinition("builtin:reviewer"),
    ]) {
      expect(result).toEqual({ ok: false, error: expect.stringContaining("Built-in") });
    }
    for (const result of [
      await updateAgentDefinition(OTHER_ORG_AGENT_ID, INPUT),
      await deleteAgentDefinition(OTHER_ORG_AGENT_ID),
      await cloneAgentDefinition(OTHER_ORG_AGENT_ID),
    ]) {
      expect(result).toEqual({ ok: false, error: "That agent doesn't exist." });
    }
    expect(state.writes).toBe(0);
    expect(state.agents.find((agent) => agent.id === OTHER_ORG_AGENT_ID)).toMatchObject({
      name: "Theirs",
    });
  });

  it("clones a built-in into a new row named as a copy", async () => {
    const result = await cloneAgentDefinition("builtin:reviewer");
    expect(result).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (result as { id: string }).id;
    const reviewer = getBuiltinAgent("builtin:reviewer") as AgentDefinition;
    const clone = state.agents.find((agent) => agent.id === id)!;
    expect(clone).toMatchObject({
      organizationId: "org-1",
      name: `${reviewer.name} (copy)`,
      createdBy: "admin-1",
    });
    const { id: _id, name: _name, ...definition } = reviewer;
    expect(clone.definition).toEqual(definition);
  });

  it("clones a custom agent", async () => {
    const result = await cloneAgentDefinition(AGENT_ID);
    const id = (result as { id: string }).id;
    expect(id).not.toBe(AGENT_ID);
    expect(state.agents.find((agent) => agent.id === id)).toMatchObject({
      name: "Security reviewer (copy)",
      definition: expect.objectContaining({ systemPrompt: "Find vulnerabilities." }),
    });
    expect(await cloneAgentDefinition("builtin:nope")).toEqual({
      ok: false,
      error: "That agent doesn't exist.",
    });
  });

  it("refuses to delete an agent tasks use, listing them; deletes it once unused", async () => {
    state.tasks = [
      reviewTask("Security review", AGENT_ID),
      // A task that no longer resolves still counts.
      row({
        id: "66666666-6666-4666-8666-666666666666",
        name: "Broken",
        definition: { agentId: AGENT_ID },
      }),
    ];
    const refused = await deleteAgentDefinition(AGENT_ID);
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("Security review") });
    expect((refused as { error: string }).error).toContain("Broken");
    expect(state.writes).toBe(0);

    state.tasks = [];
    expect(await deleteAgentDefinition(AGENT_ID)).toEqual({ ok: true });
    expect(state.agents.map((agent) => agent.id)).toEqual([OTHER_ORG_AGENT_ID]);
  });
});
