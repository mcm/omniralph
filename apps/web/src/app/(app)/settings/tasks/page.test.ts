import { describe, expect, it, vi } from "vitest";
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

/** A custom review task of org-1 (a clone of `builtin:review-pr`) with stored requirements. */
const rows = vi.hoisted(async () => {
  const { getBuiltinTask } = await import("@omniralph/tasks");
  const { id: _id, name: _name, ...definition } = getBuiltinTask("builtin:review-pr")!;
  const now = new Date("2026-10-01T00:00:00Z");
  const task = {
    id: "22222222-2222-4222-8222-222222222222",
    organizationId: "org-1",
    name: "Security review",
    definition,
    requirements: { minHarnessVersion: "0.40.0", installables: [], hostTools: ["git"] },
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
  };
  return { task };
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
vi.mock("@omniralph/db", async () => {
  const { task } = await rows;
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
        ? [{ id: "repo-1", fullPath: "acme/app", reviewTask: true, correlationTask: false }]
        : [],
    listChatChannelTaskReferences: async () => [],
    getChatTaskDefaults: async () => ({
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    }),
  };
});
vi.mock("./tasks-view", () => ({ TasksView: () => null }));
vi.mock("./[id]/task-detail-view", () => ({ TaskDetailView: () => null }));

const { default: TasksPage } = await import("./page");
const { default: TaskPage } = await import("./[id]/page");

const user = (role: Role, organizationId = "org-1") => ({
  id: `${role}-1`,
  role,
  organization: { id: organizationId, name: "Acme" },
  name: null,
  email: null,
  image: null,
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("Settings › Tasks pages", () => {
  it("need a signed-in user", async () => {
    state.user = null;
    await expect(TasksPage()).rejects.toThrow();
    await expect(TaskPage(params("builtin:review-pr"))).rejects.toThrow();
  });

  it("list built-ins, then the organization's tasks, with their agents, for a member", async () => {
    state.user = user("member");
    const { props } = await TasksPage();
    expect(props.isAdmin).toBe(false);
    const ids = props.tasks.map((task: { id: string }) => task.id);
    expect(ids.at(-1)).toBe(CUSTOM_ID);
    expect(ids.slice(0, -1).every((id: string) => id.startsWith("builtin:"))).toBe(true);
    expect(props.tasks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", taskType: "coding", builtin: true }),
    );
    expect(props.tasks.at(-1)).toEqual({
      id: CUSTOM_ID,
      name: "Security review",
      description: expect.any(String),
      builtin: false,
      taskType: "review",
      agentId: "builtin:reviewer",
      agentName: "Reviewer",
      triggers: expect.arrayContaining(["pr.updated"]),
      sink: "review",
      pool: "short",
    });
  });

  it("tells the views whether the user is an admin", async () => {
    state.user = user("admin");
    expect((await TasksPage()).props.isAdmin).toBe(true);
    expect((await TaskPage(params(CUSTOM_ID))).props.isAdmin).toBe(true);
  });

  it("show a built-in task with derived requirements and what uses it to a member", async () => {
    state.user = user("member");
    const { props } = await TaskPage(params(encodeURIComponent("builtin:describe-pr")));
    expect(props.isAdmin).toBe(false);
    expect(props.builtin).toBe(true);
    expect(props.task.id).toBe("builtin:describe-pr");
    expect(props.requirements.minHarnessVersion).toEqual(expect.any(String));
    expect(props.referrers.codingTasks).toContainEqual(
      expect.objectContaining({ id: "builtin:implement-story", builtin: true }),
    );
  });

  it("show a coding task's PR description task name", async () => {
    state.user = user("member");
    const { props } = await TaskPage(params(encodeURIComponent("builtin:implement-story")));
    expect(props.task.prDescriptionTaskId).toBe("builtin:describe-pr");
    expect(props.prDescriptionTaskName).toEqual(expect.any(String));
    expect(props.agentName).toEqual(expect.any(String));
  });

  it("show the organization's own task with its stored requirements and referrers", async () => {
    state.user = user("member");
    const { props } = await TaskPage(params(CUSTOM_ID));
    expect(props.builtin).toBe(false);
    expect(props.task).toMatchObject({ id: CUSTOM_ID, name: "Security review" });
    expect(props.agentName).toBe("Reviewer");
    expect(props.requirements).toEqual({
      minHarnessVersion: "0.40.0",
      installables: [],
      hostTools: ["git"],
    });
    expect(props.referrers.repositories).toEqual([
      { id: "repo-1", fullPath: "acme/app", reviewTask: true, correlationTask: false },
    ]);
  });

  it("don't find another organization's task or an unknown ID", async () => {
    state.user = user("member", "org-2");
    await expect(TaskPage(params(CUSTOM_ID))).rejects.toThrow("NEXT_NOT_FOUND");
    expect((await TasksPage()).props.tasks.map((task: { id: string }) => task.id)).not.toContain(
      CUSTOM_ID,
    );
    await expect(TaskPage(params("builtin:nope"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(TaskPage(params("%E0%A4%A"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
