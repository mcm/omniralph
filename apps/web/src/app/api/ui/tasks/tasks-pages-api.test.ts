import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskFormOptions, TaskList } from "@/lib/api/definitions";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const CUSTOM_ID = "22222222-2222-4222-8222-222222222222";

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

/**
 * A custom review task of org-1 (a clone of `builtin:review-pr`) with stored requirements,
 * built when the database mock loads (not while the mocks are being registered).
 */
const rows = vi.hoisted(() => async () => {
  const { getBuiltinTask } = await import("@omniralph/tasks");
  const { id: _id, name: _name, ...definition } = getBuiltinTask("builtin:review-pr")!;
  const now = new Date("2026-10-01T00:00:00Z");
  const task = {
    id: "22222222-2222-4222-8222-222222222222",
    organizationId: "org-1",
    name: "Security review",
    definition: { ...definition, requires: { hostTools: ["git"] } },
    // The installables and host tools shown follow the definitions, not what was stored.
    requirements: {
      minHarnessVersion: "0.40.0",
      installables: ["@omniralph/stale"],
      hostTools: [],
    },
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  };
  return { task };
});

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", async () => {
  const { task } = await rows();
  const own = (organizationId: string) => organizationId === task.organizationId;
  return {
    getStoredAgentDefinition: async () => null,
    listStoredAgentDefinitions: async () => [],
    getStoredTaskDefinition: async (_db: unknown, organizationId: string, id: string) =>
      own(organizationId) && id === task.id ? task : null,
    listStoredTaskDefinitions: async (_db: unknown, organizationId: string) =>
      own(organizationId) ? [task] : [],
    listRepositoryTaskReferences: async (_db: unknown, organizationId: string, taskId: string) =>
      own(organizationId) && taskId === task.id
        ? [
            {
              id: "repo-1",
              fullPath: "acme/app",
              reviewTask: true,
              correlationTask: false,
              storyTask: false,
              requestTask: false,
            },
          ]
        : [],
    listChatChannelTaskReferences: async () => [],
    listActiveHarnessIds: async () => ["harness-1"],
    listReportedModels: async () => [],
    listReportedInstallables: async () => [
      { name: "@omniralph/code-graph", harnessIds: ["harness-1"], mcpServers: ["graph"] },
    ],
    listHostTools: async () => [
      { id: "tool-1", organizationId: "org-1", name: "opengrep", description: "SAST scanner" },
    ],
    getChatTaskDefaults: async () => ({
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    }),
  };
});
const list = await import("@/app/api/ui/tasks/route");
const detail = await import("@/app/api/ui/tasks/[id]/route");
const formOptions = await import("@/app/api/ui/tasks/form-options/route");

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
  const response = await handler(new Request("http://localhost/api/ui/tasks"), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

describe("Settings › Tasks pages' API", () => {
  it("needs a signed-in user", async () => {
    state.user = null;
    expect((await get(list.GET)).status).toBe(401);
    expect((await get(detail.GET, "builtin:review-pr")).status).toBe(401);
  });

  it("lists built-ins, then the organization's tasks, with their agents, to a member", async () => {
    state.user = user("member");
    const { status, body } = await get<TaskList>(list.GET);
    expect(status).toBe(200);
    const ids = body.tasks.map((task) => task.id);
    expect(ids.at(-1)).toBe(CUSTOM_ID);
    expect(ids.slice(0, -1).every((id) => id.startsWith("builtin:"))).toBe(true);
    expect(body.tasks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", taskType: "coding", builtin: true }),
    );
    expect(body.tasks.at(-1)).toEqual({
      id: CUSTOM_ID,
      name: "Security review",
      description: expect.any(String),
      builtin: false,
      taskType: "review",
      agentId: "builtin:reviewer",
      agentName: "Reviewer",
      triggers: expect.arrayContaining(["pr.updated"]),
      sink: "review",
    });
  });

  it("shows a built-in task with derived requirements and what uses it to a member", async () => {
    state.user = user("member");
    const { status, body } = await get<TaskDetail>(
      detail.GET,
      encodeURIComponent("builtin:describe-pr"),
    );
    expect(status).toBe(200);
    expect(body.builtin).toBe(true);
    expect(body.task.id).toBe("builtin:describe-pr");
    expect(body.requirements.minHarnessVersion).toEqual(expect.any(String));
    expect(body.referrers.codingTasks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", builtin: true }),
    );
  });

  it("shows a coding task's PR description task name", async () => {
    state.user = user("member");
    const { body } = await get<TaskDetail>(
      detail.GET,
      encodeURIComponent("builtin:implement-story"),
    );
    expect(body.task.prDescriptionTaskId).toBe("builtin:describe-pr");
    expect(body.prDescriptionTaskName).toEqual(expect.any(String));
    expect(body.agentName).toEqual(expect.any(String));
  });

  it("shows the organization's own task with its requirements and referrers", async () => {
    state.user = user("member");
    const { body } = await get<TaskDetail>(detail.GET, CUSTOM_ID);
    expect(body.builtin).toBe(false);
    expect(body.task).toMatchObject({ id: CUSTOM_ID, name: "Security review" });
    expect(body.agentName).toBe("Reviewer");
    expect(body.requirements).toEqual({
      minHarnessVersion: "0.40.0",
      installables: [],
      hostTools: ["git"],
    });
    expect(body.referrers.repositories).toEqual([
      {
        id: "repo-1",
        fullPath: "acme/app",
        reviewTask: true,
        correlationTask: false,
        storyTask: false,
        requestTask: false,
      },
    ]);
  });

  it("404s on another organization's task or an unknown ID, and doesn't list it", async () => {
    state.user = user("member", "org-2");
    for (const id of [CUSTOM_ID, "builtin:nope", "%E0%A4%A"]) {
      expect(await get(detail.GET, id), id).toEqual({
        status: 404,
        body: expect.objectContaining({ code: "not_found" }),
      });
    }
    expect((await get<TaskList>(list.GET)).body.tasks.map((task) => task.id)).not.toContain(
      CUSTOM_ID,
    );
  });

  it("gives the form's options to admins only: agents, sinks, choices and host tools", async () => {
    state.user = user("member");
    expect((await get(formOptions.GET)).status).toBe(403);
    state.user = user("admin");
    const { status, body } = await get<TaskFormOptions>(formOptions.GET);
    expect(status).toBe(200);
    expect(body.agents).toContainEqual({
      id: "builtin:reviewer",
      name: "Reviewer",
      taskTypes: ["query", "review"],
      builtin: true,
    });
    expect(body.sinks).toContainEqual({ kind: "review", taskType: "review" });
    expect(body.sinks).toContainEqual({ kind: "chat-thread", taskType: "query" });
    // A task's pool follows from its task type: the form offers none.
    expect(body).not.toHaveProperty("pools");
    expect(body.choices).toEqual({
      models: [],
      installables: [
        { name: "@omniralph/code-graph", harnessIds: ["harness-1"], mcpServers: ["graph"] },
      ],
      harnessCount: 1,
    });
    expect(body.hostTools).toEqual([{ name: "opengrep", description: "SAST scanner" }]);
  });
});
