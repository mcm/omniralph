import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinAgent, getBuiltinTask, type TaskDefinitionInput } from "@omniralph/tasks";
import type { ActionResult } from "@/lib/action-result";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

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

interface RepositoryReference {
  organizationId: string;
  id: string;
  fullPath: string;
  reviewTaskIds: string[];
  correlationTaskId: string;
  storyTaskId?: string;
  requestTaskId?: string;
}

interface ChannelReference {
  organizationId: string;
  connectionId: string;
  connectionName: string;
  channelId: string;
  askAboutCodeTaskId: string | null;
  startWorkTaskId: string | null;
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
  repositories: [] as RepositoryReference[],
  channels: [] as ChannelReference[],
  chatTasks: { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" },
  activeJobs: [] as { organizationId: string; taskId: string }[],
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
    insertTaskDefinition: async (
      _db: unknown,
      organizationId: string,
      input: Omit<Row, "organizationId" | "createdAt" | "updatedAt" | "updatedBy">,
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
      state.tasks.push(row);
      return row;
    },
    updateTaskDefinition: async (
      _db: unknown,
      organizationId: string,
      id: string,
      input: Pick<Row, "name" | "definition" | "requirements" | "updatedBy">,
    ) => {
      const row = find(state.tasks, organizationId, id);
      if (!row) return null;
      state.writes++;
      Object.assign(row, input, { updatedAt: new Date() });
      return row;
    },
    deleteTaskDefinition: async (_db: unknown, organizationId: string, id: string) => {
      const row = find(state.tasks, organizationId, id);
      if (!row) return false;
      state.writes++;
      state.tasks.splice(state.tasks.indexOf(row), 1);
      return true;
    },
    countActiveTaskJobs: async (_db: unknown, organizationId: string, taskId: string) =>
      state.activeJobs.filter(
        (job) => job.organizationId === organizationId && job.taskId === taskId,
      ).length,
    listRepositoryTaskReferences: async (_db: unknown, organizationId: string, taskId: string) =>
      state.repositories
        .filter(
          (repo) =>
            repo.organizationId === organizationId &&
            (repo.reviewTaskIds.includes(taskId) ||
              repo.correlationTaskId === taskId ||
              repo.storyTaskId === taskId ||
              repo.requestTaskId === taskId),
        )
        .map((repo) => ({
          id: repo.id,
          fullPath: repo.fullPath,
          reviewTask: repo.reviewTaskIds.includes(taskId),
          correlationTask: repo.correlationTaskId === taskId,
          storyTask: repo.storyTaskId === taskId,
          requestTask: repo.requestTaskId === taskId,
        })),
    listChatChannelTaskReferences: async (_db: unknown, organizationId: string, taskId: string) =>
      state.channels
        .filter(
          (channel) =>
            channel.organizationId === organizationId &&
            (channel.askAboutCodeTaskId === taskId || channel.startWorkTaskId === taskId),
        )
        .map((channel) => ({
          connectionId: channel.connectionId,
          connectionName: channel.connectionName,
          channelId: channel.channelId,
          askAboutCode: channel.askAboutCodeTaskId === taskId,
          startWork: channel.startWorkTaskId === taskId,
        })),
    getChatTaskDefaults: async () => state.chatTasks,
  };
});

const collection = await import("@/app/api/ui/tasks/route");
const one = await import("@/app/api/ui/tasks/[id]/route");
const clone = await import("@/app/api/ui/tasks/[id]/clone/route");

// The handlers, as the server actions they replaced.
type Saved = ActionResult | { ok: true; id: string };
const createTaskDefinition = async (input: unknown) =>
  (await callAction(collection.POST, "POST", {}, input)) as Saved;
const updateTaskDefinition = (id: string, input: unknown) =>
  callAction(one.PUT, "PUT", { id: encodeURIComponent(id) }, input);
const cloneTaskDefinition = async (id: string) =>
  (await callAction(clone.POST, "POST", { id: encodeURIComponent(id) })) as Saved;
const deleteTaskDefinition = (id: string) =>
  callAction(one.DELETE, "DELETE", { id: encodeURIComponent(id) });
const { getTaskDefinition, listTaskChoices, PR_DESCRIPTION_TASKS } =
  await import("@/lib/definitions");

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG_TASK_ID = "44444444-4444-4444-8444-444444444444";
const CODING_TASK_ID = "55555555-5555-4555-8555-555555555555";

const user = (role: Role) => ({
  id: `${role}-1`,
  role,
  organization: { id: "org-1", name: "Acme" },
  name: null,
  email: null,
  image: null,
});

const row = (fields: Partial<Row> & Pick<Row, "id" | "name" | "definition">): Row => ({
  organizationId: "org-1",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  createdBy: null,
  updatedBy: null,
  requirements: { minHarnessVersion: null, installables: [], hostTools: [] },
  ...fields,
});

/** A built-in's definition without its ID and name. */
const fieldsOf = (id: string) => {
  const { id: _id, name: _name, ...fields } = getBuiltinTask(id)!;
  return fields;
};

/** A second review task on the built-in reviewer: what an organization adds. */
const INPUT = {
  name: "Security review",
  description: "Reviews for vulnerabilities.",
  taskType: "review",
  agentId: "builtin:reviewer",
  triggers: ["pr.updated", "review.rerun"],
  promptTemplate: "Review {{pr.title}} for vulnerabilities.",
  sink: "review",
  pool: "short",
  model: "claude-opus-5-5",
  tokenBudget: { tokens: 50_000 },
} satisfies Omit<TaskDefinitionInput, "id">;

/** A query task with every section filled: what a custom PR description task looks like. */
const DESCRIBER = {
  name: "Describe with changelog",
  description: "Writes the PR description, with the changelog entry.",
  taskType: "query",
  agentId: "builtin:pr-writer",
  triggers: ["run.invoked"],
  promptTemplate: "Describe {{branch}}.\n\n{{setup.changelog}}",
  setupCommands: [
    {
      name: "changelog",
      command: "git log --oneline -20",
      timeoutSeconds: 30,
      maxOutputBytes: 4000,
      fence: "text",
      optional: true,
    },
  ],
  teardownCommands: [
    { name: "cleanup", command: "rm -rf tmp", timeoutSeconds: 10, maxOutputBytes: 1000 },
  ],
  toolSettings: { shell: true, linearRead: true, network: true },
  outputSchema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 60 },
      body: { type: "string" },
      changelog: { type: "string" },
    },
    required: ["title", "body", "changelog"],
    additionalProperties: false,
  },
  sink: "run-result",
  pool: "short",
  model: "claude-opus-5-5",
  tokenBudget: { profileFraction: 0.25 },
} satisfies Omit<TaskDefinitionInput, "id">;

/** A coding task with every section filled (its PR description task is set per test). */
const CODER = {
  name: "Ship stories",
  description: "Implements a story at a time.",
  taskType: "coding",
  agentId: "builtin:engineer",
  triggers: ["linear.delegated"],
  promptTemplate: "Implement {{story.title}}.\n\n{{setup.status}}",
  setupCommands: [
    {
      name: "status",
      command: "git status --short",
      timeoutSeconds: 60,
      maxOutputBytes: 2000,
      fence: "",
      optional: false,
    },
  ],
  teardownCommands: [
    { name: "stop", command: "docker compose down", timeoutSeconds: 120, maxOutputBytes: 500 },
  ],
  toolSettings: { shell: true, linearRead: false, network: true },
  sink: "ralph-run",
  pool: "long",
  tokenBudget: null,
  maxAttemptsPerStory: 2,
  maxRoundsPerStory: 6,
  stallRounds: 2,
  maxIterationsPerRun: 30,
  maxReviewRounds: 3,
  maxFixRounds: 4,
  pushTiming: "end",
  draftPullRequest: "end",
  prDescriptionTaskId: "builtin:describe-pr",
} satisfies Omit<TaskDefinitionInput, "id">;

describe("Settings › Tasks API", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.writes = 0;
    const { id: _id, name: _name, ...reviewer } = getBuiltinAgent("builtin:reviewer")!;
    state.agents = [row({ id: AGENT_ID, name: "Custom reviewer", definition: reviewer })];
    state.tasks = [
      row({ id: TASK_ID, name: "Security review", definition: fieldsOf("builtin:review-pr") }),
      row({
        id: OTHER_ORG_TASK_ID,
        organizationId: "org-2",
        name: "Theirs",
        definition: fieldsOf("builtin:review-pr"),
      }),
    ];
    state.repositories = [];
    state.channels = [];
    state.chatTasks = {
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    };
    state.activeJobs = [];
  });

  it("are admin-only: a member writes nothing", async () => {
    state.user = user("member");
    const refused = { ok: false, error: expect.any(String) };
    expect(await createTaskDefinition(INPUT)).toEqual(refused);
    expect(await updateTaskDefinition(TASK_ID, INPUT)).toEqual(refused);
    expect(await cloneTaskDefinition("builtin:review-pr")).toEqual(refused);
    expect(await deleteTaskDefinition(TASK_ID)).toEqual(refused);
    expect(state.writes).toBe(0);
    expect(state.tasks).toHaveLength(2);
  });

  it("creates a task on a built-in agent with its requirements, readable through the resolver", async () => {
    const result = await createTaskDefinition(INPUT);
    expect(result).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (result as { id: string }).id;
    const created = state.tasks.find((task) => task.id === id)!;
    expect(created).toMatchObject({
      organizationId: "org-1",
      name: "Security review",
      createdBy: "admin-1",
      updatedBy: "admin-1",
      requirements: {
        minHarnessVersion: expect.any(String),
        installables: [],
        hostTools: expect.any(Array),
      },
    });
    expect(created.definition).not.toHaveProperty("id");
    expect(created.definition).not.toHaveProperty("name");

    const resolved = await getTaskDefinition({} as never, "org-1", id);
    expect(resolved).toMatchObject({
      builtin: false,
      definition: {
        id,
        name: "Security review",
        agentId: "builtin:reviewer",
        triggers: ["pr.updated", "review.rerun"],
        tokenBudget: { tokens: 50_000 },
      },
      requirements: created.requirements,
    });
  });

  it("creates a task on one of the organization's agents", async () => {
    const result = await createTaskDefinition({ ...INPUT, agentId: AGENT_ID });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects a template variable unavailable for one of the triggers, writing nothing", async () => {
    const result = await createTaskDefinition({
      ...fieldsOf("builtin:ask-about-code"),
      name: "Ask anywhere",
      triggers: ["chat.request", "finding.mention"],
      promptTemplate: "Answer from {{chat.context}}.",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: {
        promptTemplate: expect.stringMatching(/\{\{chat\.context\}\}.*finding\.mention/),
      },
    });
    const { fieldErrors } = result as { fieldErrors: Record<string, string> };
    expect(fieldErrors.promptTemplate).not.toContain("chat.request");
    expect(state.writes).toBe(0);
  });

  it("rejects invalid fields with the validator's field paths, writing nothing", async () => {
    const result = await createTaskDefinition({
      ...INPUT,
      name: "",
      agentId: "builtin:engineer",
      triggers: ["chat.request"],
      sink: "chat-thread",
    });
    expect(result).toMatchObject({ ok: false, error: "Fix the highlighted fields." });
    const { fieldErrors } = result as { fieldErrors: Record<string, string> };
    expect(Object.keys(fieldErrors)).toEqual(expect.arrayContaining(["name"]));
    expect(state.writes).toBe(0);

    const unsuited = await createTaskDefinition({ ...INPUT, agentId: "builtin:engineer" });
    expect(unsuited).toMatchObject({ ok: false, fieldErrors: { agentId: expect.any(String) } });
    const triggers = await createTaskDefinition({ ...INPUT, triggers: ["chat.request"] });
    expect(triggers).toMatchObject({ ok: false, fieldErrors: { triggers: expect.any(String) } });
    const sink = await createTaskDefinition({ ...INPUT, sink: "chat-thread" });
    expect(sink).toMatchObject({ ok: false, fieldErrors: { sink: expect.any(String) } });
    expect(state.writes).toBe(0);
  });

  it("updates the organization's task and its requirements, recording the admin", async () => {
    expect(await updateTaskDefinition(TASK_ID, { ...INPUT, name: "Renamed" })).toEqual({
      ok: true,
    });
    const updated = state.tasks.find((task) => task.id === TASK_ID)!;
    expect(updated).toMatchObject({ name: "Renamed", updatedBy: "admin-1" });
    expect(updated.definition).toMatchObject({ promptTemplate: INPUT.promptTemplate });
    expect(updated.requirements).toMatchObject({ minHarnessVersion: expect.any(String) });
  });

  it("rejects an invalid update, writing nothing", async () => {
    const result = await updateTaskDefinition(TASK_ID, {
      ...INPUT,
      promptTemplate: "Review {{chat.context}}.",
    });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { promptTemplate: expect.any(String) },
    });
    expect(state.writes).toBe(0);
  });

  it("refuses to change the type of a task in use", async () => {
    state.repositories = [
      {
        organizationId: "org-1",
        id: "repo-1",
        fullPath: "acme/app",
        reviewTaskIds: [TASK_ID],
        correlationTaskId: "builtin:correlate-findings",
      },
    ];
    const result = await updateTaskDefinition(TASK_ID, {
      ...fieldsOf("builtin:ask-about-code"),
      name: "Summary",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("acme/app"),
      fieldErrors: { taskType: expect.stringContaining("acme/app") },
    });
    expect(state.writes).toBe(0);
  });

  it("refuses to change or delete a built-in, and doesn't find another organization's task", async () => {
    const builtin = { ok: false, error: expect.stringContaining("Built-in tasks") };
    expect(await updateTaskDefinition("builtin:review-pr", INPUT)).toEqual(builtin);
    expect(await deleteTaskDefinition("builtin:review-pr")).toEqual(builtin);
    const missing = { ok: false, error: "That task doesn't exist." };
    expect(await updateTaskDefinition(OTHER_ORG_TASK_ID, INPUT)).toEqual(missing);
    expect(await deleteTaskDefinition(OTHER_ORG_TASK_ID)).toEqual(missing);
    expect(await cloneTaskDefinition(OTHER_ORG_TASK_ID)).toEqual(missing);
    expect(state.writes).toBe(0);
    expect(state.tasks.find((task) => task.id === OTHER_ORG_TASK_ID)?.name).toBe("Theirs");
  });

  it("clones a built-in into a new row on the same agent, with derived requirements", async () => {
    const result = await cloneTaskDefinition("builtin:review-pr");
    expect(result).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (result as { id: string }).id;
    const builtin = getBuiltinTask("builtin:review-pr")!;
    const clone = state.tasks.find((task) => task.id === id)!;
    expect(clone).toMatchObject({
      organizationId: "org-1",
      name: `${builtin.name} (copy)`,
      createdBy: "admin-1",
      definition: { agentId: builtin.agentId, promptTemplate: builtin.promptTemplate },
      requirements: { minHarnessVersion: expect.any(String) },
    });
    expect((await getTaskDefinition({} as never, "org-1", id))?.definition.name).toBe(
      `${builtin.name} (copy)`,
    );
  });

  it("clones one of the organization's tasks", async () => {
    const result = await cloneTaskDefinition(TASK_ID);
    expect(result).toMatchObject({ ok: true });
    const clone = state.tasks.find((task) => task.id === (result as { id: string }).id)!;
    expect(clone.name).toBe("Security review (copy)");
  });

  it("deletes an unused task of the organization", async () => {
    expect(await deleteTaskDefinition(TASK_ID)).toEqual({ ok: true });
    expect(state.tasks.map((task) => task.id)).not.toContain(TASK_ID);
  });

  it("refuses to delete a task in use, naming each referrer", async () => {
    state.repositories = [
      {
        organizationId: "org-1",
        id: "repo-1",
        fullPath: "acme/app",
        reviewTaskIds: [TASK_ID],
        correlationTaskId: "builtin:correlate-findings",
      },
    ];
    state.channels = [
      {
        organizationId: "org-1",
        connectionId: "conn-1",
        connectionName: "Acme Slack",
        channelId: "C0123",
        askAboutCodeTaskId: TASK_ID,
        startWorkTaskId: null,
      },
    ];
    state.chatTasks = { askAboutCode: TASK_ID, startWork: "builtin:handle-request" };
    state.tasks.push(
      row({
        id: CODING_TASK_ID,
        name: "Ship it",
        definition: { ...fieldsOf("builtin:implement-story"), prDescriptionTaskId: TASK_ID },
      }),
    );
    const result = await deleteTaskDefinition(TASK_ID);
    expect(result).toMatchObject({ ok: false });
    const { error } = result as { error: string };
    expect(error).toContain("repository acme/app (review task)");
    expect(error).toContain("the chat ask about code task");
    expect(error).toContain("chat channel Acme Slack › C0123 (ask about code)");
    expect(error).toContain("coding task Ship it");
    expect(state.writes).toBe(0);
  });

  it("refuses to delete a repository's story or request task, naming the repository", async () => {
    state.tasks.push(
      row({ id: CODING_TASK_ID, name: "Ship it", definition: fieldsOf("builtin:implement-story") }),
    );
    state.repositories = [
      {
        organizationId: "org-1",
        id: "repo-1",
        fullPath: "acme/app",
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
        storyTaskId: CODING_TASK_ID,
        requestTaskId: CODING_TASK_ID,
      },
    ];
    const result = await deleteTaskDefinition(CODING_TASK_ID);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("repository acme/app (story task, request task)"),
    });
    expect(state.writes).toBe(0);
  });

  it("refuses to delete a task with a queued or running job", async () => {
    state.activeJobs = [
      { organizationId: "org-1", taskId: TASK_ID },
      { organizationId: "org-1", taskId: TASK_ID },
    ];
    expect(await deleteTaskDefinition(TASK_ID)).toEqual({
      ok: false,
      error: "Security review can't be deleted while 2 runs of it are queued or running.",
    });
    expect(state.writes).toBe(0);
  });
  it("round-trips every section of a query task and a coding task naming it", async () => {
    const describer = await createTaskDefinition(DESCRIBER);
    expect(describer).toMatchObject({ ok: true });
    const describerId = (describer as { id: string }).id;
    expect((await getTaskDefinition({} as never, "org-1", describerId))?.definition).toEqual({
      id: describerId,
      ...DESCRIBER,
    });

    const coder = { ...CODER, prDescriptionTaskId: describerId };
    const created = await createTaskDefinition(coder);
    expect(created).toMatchObject({ ok: true });
    const coderId = (created as { id: string }).id;
    expect((await getTaskDefinition({} as never, "org-1", coderId))?.definition).toEqual({
      id: coderId,
      ...coder,
    });
  });

  it("round-trips an update of the commands, tool settings and coding fields", async () => {
    const created = (await createTaskDefinition(CODER)) as { id: string };
    const changed = {
      ...CODER,
      setupCommands: [],
      promptTemplate: "Implement {{story.title}}.",
      teardownCommands: [],
      toolSettings: { shell: false, linearRead: true, network: false },
      pushTiming: "per-story",
      draftPullRequest: "early",
    } satisfies Omit<TaskDefinitionInput, "id">;
    expect(await updateTaskDefinition(created.id, changed)).toEqual({ ok: true });
    expect((await getTaskDefinition({} as never, "org-1", created.id))?.definition).toEqual({
      id: created.id,
      ...changed,
    });
  });

  it("lists built-in and custom tasks with the { title, body } output as PR description tasks", async () => {
    const describer = (await createTaskDefinition(DESCRIBER)) as { id: string };
    // A query task started by run.invoked with another output.
    const other = (await createTaskDefinition({
      ...DESCRIBER,
      name: "Summarize",
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    })) as { id: string };
    expect(other).toMatchObject({ ok: true });
    const choices = await listTaskChoices({} as never, "org-1", PR_DESCRIPTION_TASKS);
    expect(choices).toEqual([
      { id: "builtin:describe-pr", name: "Describe a PR", builtin: true },
      { id: describer.id, name: DESCRIBER.name, builtin: false },
    ]);

    expect(await createTaskDefinition({ ...CODER, prDescriptionTaskId: other.id })).toMatchObject({
      ok: false,
      fieldErrors: { prDescriptionTaskId: expect.stringContaining("{ title, body }") },
    });
    for (const id of ["builtin:ask-about-code", "builtin:correlate-findings", TASK_ID]) {
      expect(await createTaskDefinition({ ...CODER, prDescriptionTaskId: id }), id).toMatchObject({
        ok: false,
        fieldErrors: { prDescriptionTaskId: expect.any(String) },
      });
    }
  });

  it("rejects a template using a setup command that was removed", async () => {
    const result = await createTaskDefinition({ ...DESCRIBER, setupCommands: [] });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { promptTemplate: expect.stringContaining("{{setup.changelog}}") },
    });
    expect(state.writes).toBe(0);
  });

  it("rejects invalid setup commands, output schemas and coding timing by field", async () => {
    const commands = await createTaskDefinition({
      ...DESCRIBER,
      setupCommands: [{ ...DESCRIBER.setupCommands[0]!, name: "Change Log", timeoutSeconds: 0 }],
    });
    expect(commands).toMatchObject({
      ok: false,
      fieldErrors: {
        "setupCommands.0.name": expect.any(String),
        "setupCommands.0.timeoutSeconds": expect.any(String),
      },
    });
    const schema = await createTaskDefinition({
      ...DESCRIBER,
      outputSchema: { type: "object", properties: { title: { type: "strng" } } },
    });
    expect(schema).toMatchObject({
      ok: false,
      fieldErrors: { outputSchema: expect.stringContaining("strng") },
    });
    const notObject = await createTaskDefinition({ ...DESCRIBER, outputSchema: { type: "array" } });
    expect(notObject).toMatchObject({
      ok: false,
      fieldErrors: { outputSchema: expect.any(String) },
    });
    const timing = await createTaskDefinition({ ...CODER, draftPullRequest: "early" });
    expect(timing).toMatchObject({
      ok: false,
      fieldErrors: { draftPullRequest: expect.stringContaining("An early draft PR") },
    });
    expect(state.writes).toBe(0);
  });
});
