// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import type * as UI from "@iamthemcmaster/ui";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
  testUser,
} from "@/components/query-test-utils";
import type { TaskDetail, TaskFormOptions, TaskList } from "@/lib/api/definitions";
import { queryKeys } from "@/lib/api/keys";
import { definitionKeys } from "../definition-queries";
import { TaskDetailView } from "./[id]/task-detail-view";
import { EditTaskView, NewTaskView } from "./task-editor-view";
import { TasksView } from "./tasks-view";

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
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  notify: toast.notify,
}));

const TASK_ID = "33333333-3333-4333-8333-333333333333";
const CLONE_ID = "44444444-4444-4444-8444-444444444444";
const reviewPr = getBuiltinTask("builtin:review-pr")!;
const keys = definitionKeys(queryKeys(TEST_ORGANIZATION_ID));

const custom = (changes: Partial<TaskDefinition> = {}): TaskDefinition => ({
  ...reviewPr,
  id: TASK_ID,
  name: "Security review",
  ...changes,
});

const detail = (task: TaskDefinition = custom(), builtin = false): TaskDetail => ({
  task,
  builtin,
  agentName: "Reviewer",
  prDescriptionTaskName: null,
  requirements: { minHarnessVersion: null, installables: [], hostTools: [] },
  referrers: { repositories: [], chatTasks: [], chatChannels: [], codingTasks: [] },
});

const list = (...tasks: TaskDefinition[]): TaskList => ({
  tasks: [reviewPr, ...tasks].map((task) => ({
    id: task.id,
    name: task.name,
    description: task.description,
    builtin: task.id.startsWith("builtin:"),
    taskType: task.taskType,
    agentId: task.agentId,
    agentName: "Reviewer",
    triggers: task.triggers,
    sink: task.sink,
    pool: task.pool,
  })),
});

const OPTIONS: TaskFormOptions = {
  agents: [
    { id: "builtin:reviewer", name: "Reviewer", taskTypes: ["query", "review"], builtin: true },
  ],
  sinks: [
    { kind: "review", taskType: "review" },
    { kind: "chat-thread", taskType: "query" },
  ],
  pools: ["short", "long"],
  prDescriptionTasks: [],
  choices: { models: [], installables: [], harnessCount: 1 },
  hostTools: [],
};

/** The tasks list as visited before (cached, not on screen): it refetches from the API. */
const visitList = (client: QueryClient) =>
  client.prefetchQuery({
    queryKey: keys.tasks.list,
    queryFn: async () => (await fetch("/api/ui/tasks")).json(),
  });

function renderView(node: React.ReactNode, role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(node, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

const nameField = () => document.getElementById("task-name") as HTMLInputElement;

beforeEach(() => {
  vi.unstubAllGlobals();
  toast.notify.mockReset();
  navigation.push.mockReset();
  navigation.notFound.mockReset();
  navigation.redirect.mockClear();
  navigation.id = TASK_ID;
});

describe("TasksView", () => {
  it("shows a skeleton, then the tasks, and a task created elsewhere on the next refetch", async () => {
    let tasks = list();
    mockFetch({ "GET /api/ui/tasks": () => jsonResponse(tasks) });
    const client = renderView(<TasksView />, "member");
    expect(screen.getByLabelText("Loading the tasks")).toBeTruthy();
    expect(await screen.findByRole("link", { name: reviewPr.name })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New task" })).toBeNull();

    tasks = list(custom());
    await client.invalidateQueries();
    expect(await screen.findByRole("link", { name: "Security review" })).toBeTruthy();
  });

  it("shows an error with a retry when the tasks don't load", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/tasks": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(list()),
    });
    renderView(<TasksView />);
    expect(await screen.findByText("Couldn't load the tasks")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("link", { name: reviewPr.name })).toBeTruthy();
  });
});

describe("TaskDetailView", () => {
  it("loads a built-in by its encoded ID", async () => {
    navigation.id = encodeURIComponent("builtin:review-pr");
    const seen = mockFetch({
      "GET /api/ui/tasks/builtin%3Areview-pr": detail(reviewPr, true),
    });
    renderView(<TaskDetailView />, "member");
    expect(await screen.findByRole("heading", { name: reviewPr.name })).toBeTruthy();
    expect(seen.map((request) => request.path)).toEqual(["/api/ui/tasks/builtin%3Areview-pr"]);
  });

  it("shows the not-found page for an unknown task, another organization's too", async () => {
    mockFetch({
      [`GET /api/ui/tasks/${TASK_ID}`]: () =>
        jsonResponse({ error: "Not found.", code: "not_found" }, 404),
    });
    renderView(<TaskDetailView />);
    await waitFor(() => expect(navigation.notFound).toHaveBeenCalled());
  });

  it("clones, refetching the tasks before opening the clone's form", async () => {
    let tasks = list(custom());
    const copy = custom({ id: CLONE_ID, name: "Security review (copy)" });
    mockFetch({
      [`GET /api/ui/tasks/${TASK_ID}`]: detail(),
      "GET /api/ui/tasks": () => jsonResponse(tasks),
      [`POST /api/ui/tasks/${TASK_ID}/clone`]: () => {
        tasks = list(custom(), copy);
        return jsonResponse({ ok: true, id: CLONE_ID });
      },
    });
    const client = renderView(<TaskDetailView />);
    await visitList(client);
    let listRefetchedFirst = false;
    navigation.push.mockImplementation(() => {
      listRefetchedFirst =
        JSON.stringify(client.getQueryData(keys.tasks.list)) ===
        JSON.stringify(list(custom(), copy));
    });
    await userEvent.click(await screen.findByRole("button", { name: /Clone/ }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(`/settings/tasks/${CLONE_ID}/edit`),
    );
    expect(listRefetchedFirst).toBe(true);
  });

  it("deletes, refetching the list before going back to it", async () => {
    let tasks = list(custom());
    const seen = mockFetch({
      [`GET /api/ui/tasks/${TASK_ID}`]: detail(),
      "GET /api/ui/tasks": () => jsonResponse(tasks),
      [`DELETE /api/ui/tasks/${TASK_ID}`]: () => {
        tasks = list();
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView(<TaskDetailView />);
    await visitList(client);
    let listRefetchedFirst = false;
    navigation.push.mockImplementation(() => {
      listRefetchedFirst =
        JSON.stringify(client.getQueryData(keys.tasks.list)) === JSON.stringify(list());
    });
    await userEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/settings/tasks"));
    expect(listRefetchedFirst).toBe(true);
    expect(
      seen.filter((request) => request.method === "GET" && request.path.endsWith(TASK_ID)),
    ).toHaveLength(1);
    expect(client.getQueryData(keys.tasks.detail(TASK_ID))).toBeUndefined();
    expect(toast.notify).toHaveBeenCalledWith("Deleted Security review");
  });
});

describe("Task editor", () => {
  it("sends members to the access-denied page", () => {
    mockFetch({});
    expect(() => renderView(<NewTaskView />, "member")).toThrow(
      "redirect /access-denied?reason=forbidden",
    );
    expect(() => renderView(<EditTaskView />, "member")).toThrow(
      "redirect /access-denied?reason=forbidden",
    );
  });

  it("doesn't edit a built-in", async () => {
    navigation.id = encodeURIComponent("builtin:review-pr");
    mockFetch({
      "GET /api/ui/tasks/builtin%3Areview-pr": detail(reviewPr, true),
      "GET /api/ui/tasks/form-options": OPTIONS,
    });
    renderView(<EditTaskView />);
    await waitFor(() => expect(navigation.notFound).toHaveBeenCalled());
  });

  it("follows a change saved elsewhere while clean, never over an edit", async () => {
    let task = custom();
    mockFetch({
      [`GET /api/ui/tasks/${TASK_ID}`]: () => jsonResponse(detail(task)),
      "GET /api/ui/tasks/form-options": OPTIONS,
    });
    const client = renderView(<EditTaskView />);
    await waitFor(() => expect(nameField().value).toBe("Security review"));

    task = custom({ name: "AppSec review" });
    await client.invalidateQueries();
    await waitFor(() => expect(nameField().value).toBe("AppSec review"));

    fireEvent.change(nameField(), { target: { value: "My review" } });
    task = custom({ name: "Someone else's name" });
    await client.invalidateQueries();
    await waitFor(() =>
      expect(client.getQueryData(keys.tasks.detail(TASK_ID))).toMatchObject({
        task: { name: "Someone else's name" },
      }),
    );
    expect(nameField().value).toBe("My review");
  });

  it("saves after confirming, refetching the task before opening its page", async () => {
    let task = custom();
    const seen = mockFetch({
      [`GET /api/ui/tasks/${TASK_ID}`]: () => jsonResponse(detail(task)),
      "GET /api/ui/tasks/form-options": OPTIONS,
      [`PUT /api/ui/tasks/${TASK_ID}`]: (request) => {
        task = custom({ name: (request.body as { name: string }).name });
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView(<EditTaskView />);
    await waitFor(() => expect(nameField().value).toBe("Security review"));
    fireEvent.change(nameField(), { target: { value: "AppSec review" } });
    await userEvent.click(screen.getByRole("button", { name: "Save task" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save 1 change" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/settings/tasks/${TASK_ID}`));
    expect(seen.find((request) => request.method === "PUT")!.body).toMatchObject({
      name: "AppSec review",
      agentId: reviewPr.agentId,
      taskType: "review",
    });
    expect(client.getQueryData(keys.tasks.detail(TASK_ID))).toMatchObject({
      task: { name: "AppSec review" },
    });
    expect(toast.notify).toHaveBeenCalledWith("AppSec review saved");
  });

  it("shows a refused new task's field errors and stays on the form", async () => {
    mockFetch({
      "GET /api/ui/tasks/form-options": OPTIONS,
      "POST /api/ui/tasks": () =>
        jsonResponse(
          { error: "Fix the highlighted fields.", fieldErrors: { name: "Name is required." } },
          400,
        ),
    });
    renderView(<NewTaskView />);
    await waitFor(() => expect(nameField()).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(toast.notify).toHaveBeenCalledWith("Fix the highlighted fields.", {
      variant: "danger",
    });
  });
});
