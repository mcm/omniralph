// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
  TEST_ORGANIZATION_ID,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { CodingLinear, RepositoryCoding, RepositoryDetail } from "@/lib/api/repositories";
import { queryKeys } from "@/lib/api/keys";
import { RepositorySettingsView, type RepositorySettingsTab } from "./repository-settings-view";

const REPO_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const DETAIL = `/api/ui/repositories/${REPO_ID}`;
const HARNESS_ID = "0a7c3e1d-5b2f-4c8a-9d6e-1f2a3b4c5d6e";

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound,
  useParams: () => ({ id: REPO_ID }),
  usePathname: () => `/repositories/${REPO_ID}/settings`,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function detail(overrides: Partial<RepositoryDetail["settings"]> = {}): RepositoryDetail {
  return {
    repository: {
      id: REPO_ID,
      provider: "github",
      fullPath: "acme/app",
      webUrl: "https://github.com/acme/app",
    },
    settings: {
      profileId: "standard",
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      customInstructions: "",
      pinnedHarnessIds: [HARNESS_ID],
      reviewTaskIds: ["builtin:review-pr"],
      correlationTaskId: "builtin:correlate-findings",
      ...overrides,
    },
    reviewTasks: [
      { id: "builtin:review-pr", name: "Review PR", description: "Reviews.", builtin: true },
    ],
    correlationTasks: [
      { id: "builtin:correlate-findings", name: "Correlate findings", builtin: true },
    ],
    profiles: [
      {
        id: "standard",
        name: "Standard",
        description: null,
        model: "sonnet",
        maxTokensPerReview: 200_000,
        maxFiles: 50,
        allowRepoExploration: true,
      },
    ],
    harnesses: [
      {
        id: HARNESS_ID,
        name: "build-01",
        // Five minutes ago: offline, whatever the server computed.
        lastHeartbeatAt: ago(5 * 60_000),
        online: true,
        revoked: false,
        updating: false,
        acceptedTaskTypes: ["review"],
      },
    ],
    taskTypes: {
      overrides: { query: null, review: null, coding: true },
      inherited: { query: true, review: true, coding: true },
    },
  };
}

const coding: RepositoryCoding = {
  settings: {
    codingPath: "tasks",
    storyTaskId: "builtin:implement-story",
    requestTaskId: "builtin:handle-request",
    ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
  },
  tasks: {
    story: [{ id: "builtin:implement-story", name: "Implement story", builtin: true }],
    request: [{ id: "builtin:handle-request", name: "Handle request", builtin: true }],
  },
  models: [],
  harnessCount: 1,
  pinned: true,
  routingRules: [],
};

let served: RepositoryDetail;
let linear: CodingLinear;
let requests: SeenRequest[];
let client: QueryClient;

const gets = (path: string) => requests.filter((r) => r.method === "GET" && r.path === path);

function view(tab: RepositorySettingsTab, user = testUser) {
  return render(<RepositorySettingsView tab={tab} />, { wrapper: queryWrapper(client, user) });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = createTestQueryClient();
  served = detail();
  linear = { status: "unavailable" };
  requests = mockFetch({
    [`GET ${DETAIL}`]: () => jsonResponse(served),
    [`GET ${DETAIL}/coding`]: coding,
    [`GET ${DETAIL}/coding/linear`]: () => jsonResponse(linear),
    [`PUT ${DETAIL}/settings`]: (request) => {
      served = detail(request.body as RepositoryDetail["settings"]);
      return jsonResponse({ ok: true });
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("RepositorySettingsView", () => {
  it("loads the repository from the API, asking with the page it's on", async () => {
    view("settings");
    expect(screen.getByLabelText("Loading the repository")).toBeTruthy();
    expect(await screen.findByLabelText("Custom instructions")).toBeTruthy();
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(gets(DETAIL)[0]!.query.get("next")).toBe("/");
    // Only the Coding tab asks for the coding settings and Linear.
    expect(gets(`${DETAIL}/coding`)).toHaveLength(0);
    expect(gets(`${DETAIL}/coding/linear`)).toHaveLength(0);
  });

  it("follows a refetch while the form is clean, and never overwrites an edit", async () => {
    const user = userEvent.setup();
    view("settings");
    const instructions = (await screen.findByLabelText(
      "Custom instructions",
    )) as HTMLTextAreaElement;

    served = detail({ customInstructions: "From another tab." });
    await client.refetchQueries();
    await waitFor(() => expect(instructions.value).toBe("From another tab."));

    await user.clear(instructions);
    await user.type(instructions, "Mine.");
    served = detail({ customInstructions: "Changed again." });
    await client.refetchQueries();
    expect(gets(DETAIL).length).toBe(3);
    expect(instructions.value).toBe("Mine.");
  });

  it("saves, then refetches the repository and invalidates the repositories and harnesses", async () => {
    const user = userEvent.setup();
    const keys = queryKeys(TEST_ORGANIZATION_ID);
    client.setQueryData(keys.harnesses.list(), []);
    client.setQueryData(keys.repositories.list(), {});
    view("settings");
    const instructions = await screen.findByLabelText("Custom instructions");
    await user.type(instructions, "Be terse.");
    await user.click(screen.getByRole("button", { name: "Save review settings" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Save 1 change" }));

    // The saved values came back with the refetch: the form is clean, and says so.
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const put = requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe(`${DETAIL}/settings`);
    expect(put.body).toMatchObject({
      customInstructions: "Be terse.",
      pinnedHarnessIds: [HARNESS_ID],
    });
    expect(gets(DETAIL)).toHaveLength(2);
    expect(client.getQueryState(keys.harnesses.list())!.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.repositories.list())!.isInvalidated).toBe(true);
  });

  it("shows the pinned harnesses' online state against the browser's clock, live", async () => {
    view("harnesses");
    const list = await screen.findByRole("list", { name: "Pinned harnesses" });
    expect(within(list).getByText("Offline")).toBeTruthy();

    served = detail();
    served.harnesses[0]!.lastHeartbeatAt = ago(5_000);
    await client.refetchQueries();
    await waitFor(() => expect(within(list).getByText("Online")).toBeTruthy());
  });

  it("is a 404 for members on the Coding tab", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => view("coding", { ...testUser, role: "member" })).toThrow("NEXT_NOT_FOUND");
    expect(requests).toHaveLength(0);
  });

  it("shows the Coding tab with Linear read-only when it can't be read, and tries again", async () => {
    const user = userEvent.setup();
    view("coding");
    expect(await screen.findAllByText(/couldn.t be read just now/)).not.toHaveLength(0);
    linear = {
      status: "connected",
      options: {
        teams: [],
        labels: [],
        projects: [],
        states: [],
        projectMilestones: [],
        cycles: [],
        users: [],
      },
    };
    await user.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    await waitFor(() => expect(screen.queryByText(/couldn.t be read just now/)).toBeNull());
    expect(gets(`${DETAIL}/coding/linear`)).toHaveLength(2);
  });

  it("shows a failed load in place, with a retry", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`GET ${DETAIL}`]: () => jsonResponse({ error: "Something broke." }, 500),
    });
    view("settings");
    expect(await screen.findByText("Couldn't load the repository")).toBeTruthy();
    requests = mockFetch({ [`GET ${DETAIL}`]: () => jsonResponse(served) });
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByLabelText("Custom instructions")).toBeTruthy();
  });
});
