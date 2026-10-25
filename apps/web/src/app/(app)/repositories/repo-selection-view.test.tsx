// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { repositoryListSchema, type RepositoryList } from "@/lib/api/repositories";
import { GitHubReposView } from "./github/[connectionId]/github-repos-view";
import { GitLabProjectsView } from "./gitlab/[connectionId]/gitlab-projects-view";

const CONNECTION_ID = "11111111-2222-4333-8444-555555555555";
const REPO_ID = "22222222-3333-4444-8555-666666666666";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ connectionId: "11111111-2222-4333-8444-555555555555" }),
  usePathname: () => "/repositories/github/11111111-2222-4333-8444-555555555555",
  useRouter: () => router,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const keys = queryKeys(TEST_ORGANIZATION_ID);
const CONNECTION_PATH = `/api/ui/scm-connections/${CONNECTION_ID}`;
const LISTING_PATH = `${CONNECTION_PATH}/repositories`;

function listing(enabled: number[] = [1]) {
  return {
    account: "acme",
    manageUrl: "https://github.com/settings/installations/42",
    truncated: false,
    repos: [
      { id: 1, fullPath: "acme/api", private: true, htmlUrl: "https://github.com/acme/api" },
      { id: 2, fullPath: "acme/web", private: false, htmlUrl: "https://github.com/acme/web" },
    ].map((repo) => ({ ...repo, enabled: enabled.includes(repo.id) })),
  };
}

function repositoryList(paths: string[]): RepositoryList {
  return {
    page: 1,
    pageSize: 25,
    total: paths.length,
    connections: [],
    repositories: paths.map((fullPath, index) => ({
      id: `${REPO_ID.slice(0, -1)}${index}`,
      provider: "github",
      fullPath,
      webUrl: `https://github.com/${fullPath}`,
      taskTypes: {
        query: { on: true, inherited: true },
        review: { on: true, inherited: true },
        coding: { on: false, inherited: true },
      },
      depth: "standard",
      pinnedHarnesses: [],
      lastReviewAt: null,
    })),
  };
}

function renderView(view = <GitHubReposView />) {
  const client = createTestQueryClient();
  render(view, { wrapper: queryWrapper(client) });
  return client;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  router.push.mockReset();
});

describe("GitHub repository picker", () => {
  it("loads the installation's repositories once, ticks the reviewed ones and refreshes on request", async () => {
    const seen = mockFetch({
      [`GET ${CONNECTION_PATH}`]: { id: CONNECTION_ID, provider: "github", name: "acme" },
      [`GET ${LISTING_PATH}`]: listing(),
    });
    const client = renderView();
    expect(screen.getAllByText("Loading repositories…").length).toBeGreaterThan(0);
    expect(await screen.findByLabelText("acme/api")).toBeTruthy();
    expect((screen.getByLabelText("acme/api") as HTMLButtonElement).dataset.state).toBe("checked");
    expect((screen.getByLabelText("acme/web") as HTMLButtonElement).dataset.state).toBe(
      "unchecked",
    );
    expect(screen.getByText("Change them on GitHub").closest("a")?.getAttribute("href")).toBe(
      "https://github.com/settings/installations/42",
    );
    // The list comes from GitHub: never polled or refetched on focus.
    const query = client
      .getQueryCache()
      .find({ queryKey: keys.connections.part(CONNECTION_ID, "selectable") });
    expect(query?.options).toMatchObject({ refetchInterval: false, refetchOnWindowFocus: false });
    const listings = () => seen.filter((request) => request.path === LISTING_PATH);
    expect(listings()).toHaveLength(1);
    expect(listings()[0]!.query.get("provider")).toBe("github");

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listings()).toHaveLength(2));
  });

  it("explains a listing failure and retries it", async () => {
    let fail = true;
    mockFetch({
      [`GET ${CONNECTION_PATH}`]: { id: CONNECTION_ID, provider: "github", name: "acme" },
      [`GET ${LISTING_PATH}`]: () =>
        fail
          ? jsonResponse({ error: "fetch failed", code: "listing_failed" }, 502)
          : jsonResponse(listing()),
    });
    renderView();
    expect(await screen.findByText("Couldn't reach GitHub")).toBeTruthy();
    expect(screen.getByText("fetch failed")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("acme/api")).toBeTruthy();
  });

  it("refetches the repositories list before going back to it, so it shows the saved ones on arrival", async () => {
    const events: string[] = [];
    let saved = false;
    const seen = mockFetch({
      [`GET ${CONNECTION_PATH}`]: { id: CONNECTION_ID, provider: "github", name: "acme" },
      [`GET ${LISTING_PATH}`]: listing(),
      [`PUT ${LISTING_PATH}`]: () => {
        events.push("save");
        saved = true;
        return jsonResponse({ ok: true });
      },
      "GET /api/ui/repositories": () => {
        events.push("list");
        return jsonResponse(repositoryList(saved ? ["acme/api", "acme/web"] : ["acme/api"]));
      },
    });
    const client = createTestQueryClient();
    // The repositories page was visited before: its list is cached (and not mounted here).
    const listKey = keys.repositories.list({ page: 1 });
    await client.prefetchQuery({
      queryKey: listKey,
      queryFn: () => api.get("/api/ui/repositories", repositoryListSchema),
    });
    render(<GitHubReposView />, { wrapper: queryWrapper(client) });
    router.push.mockImplementation(() => {
      events.push("navigate");
      const cached = client.getQueryData<RepositoryList>(listKey);
      expect(cached?.repositories.map((repo) => repo.fullPath)).toEqual(["acme/api", "acme/web"]);
    });

    await userEvent.click(await screen.findByLabelText("acme/web"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/repositories"));
    expect(events).toEqual(["list", "save", "list", "navigate"]);
    expect(seen.find((request) => request.method === "PUT")?.body).toEqual({
      provider: "github",
      selectedIds: [1, 2],
    });
  });

  it("shows a connection of another organization's or a missing one as an error", async () => {
    mockFetch({
      [`GET ${CONNECTION_PATH}`]: () =>
        jsonResponse({ error: "Not found.", code: "not_found" }, 404),
      [`GET ${LISTING_PATH}`]: () => jsonResponse({ error: "Not found.", code: "not_found" }, 404),
    });
    renderView();
    expect(await screen.findByText("Couldn't load the connection")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("GitLab project picker", () => {
  it("lists the bot's projects and says when the list is cut off", async () => {
    mockFetch({
      [`GET ${CONNECTION_PATH}`]: {
        id: CONNECTION_ID,
        provider: "gitlab",
        name: "bot @ gitlab.example.com",
      },
      [`GET ${LISTING_PATH}`]: {
        ...listing([]),
        account: "bot @ gitlab.example.com",
        truncated: true,
      },
    });
    renderView(<GitLabProjectsView />);
    expect(await screen.findByLabelText("acme/web")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("bot @ gitlab.example.com");
    expect(screen.getByText(/Only the first 2 projects are shown\./)).toBeTruthy();
    expect(screen.getByText("0 selected")).toBeTruthy();
  });
});
