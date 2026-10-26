// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
} from "@/components/query-test-utils";
import type { ConnectionRow, LegacyRepositoryList as RepositoryList } from "@/lib/api/repositories";
import { RepositoriesView, TaskTypeBadges, type RepositoryRow } from "./repositories-view";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const CONNECTION_ID = "11111111-2222-4333-8444-555555555555";

function repo(n: number, overrides: Partial<RepositoryRow> = {}): RepositoryRow {
  return {
    id: `22222222-3333-4444-8555-${String(n).padStart(12, "0")}`,
    provider: "gitlab",
    fullPath: `acme/repo-${n}`,
    webUrl: `https://gitlab.example.com/acme/repo-${n}`,
    taskTypes: { reviews: true, coding: false, ask: true },
    depth: "standard",
    pinnedAgents: [],
    lastReviewAt: null,
    ...overrides,
  };
}

const gitlab: ConnectionRow = {
  id: CONNECTION_ID,
  provider: "gitlab",
  name: "bot @ gitlab.example.com",
  health: {
    checkedAt: new Date().toISOString(),
    tokenExpiresAt: null,
    problems: [
      {
        code: "webhook_missing",
        message: "acme/repo-1 has no Omniralph webhook.",
        repositoryId: repo(1).id,
      },
    ],
  },
};

function list(
  repositories: RepositoryRow[],
  { page = 1, total = repositories.length, connections = [gitlab] } = {},
): RepositoryList {
  return { repositories, page, pageSize: 2, total, connections };
}

const SETUP = { githubInstallPath: null, defaultGitLabUrl: "https://gitlab.com" };

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  const view = render(<RepositoriesView />, {
    wrapper: queryWrapper(client, { ...testUser, role }),
  });
  return { client, view };
}

/** The table of connected repositories (and its pending wrapper). */
function table() {
  return document.querySelector(".list-pending") as HTMLElement;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
});

describe("RepositoriesView", () => {
  it("shows a skeleton, then the repositories and the connections with their health", async () => {
    mockFetch({
      "GET /api/ui/repositories/overview": list([repo(1)]),
      "GET /api/ui/repositories/setup": SETUP,
    });
    renderView();
    expect(screen.getByLabelText("Loading repositories")).toBeTruthy();
    expect(await screen.findByText("Code-host connections")).toBeTruthy();
    expect(table().textContent).toContain("acme/repo-1");
    expect(screen.getByText("bot @ gitlab.example.com")).toBeTruthy();
    expect(screen.getByText("acme/repo-1 has no Omniralph webhook.")).toBeTruthy();
    // The GitHub App isn't configured here.
    expect(screen.getByText("GitHub App not configured")).toBeTruthy();
  });

  it("shows members the repositories only, without asking for the admin setup", async () => {
    const seen = mockFetch({
      "GET /api/ui/repositories/overview": list([repo(1)], { connections: [] }),
    });
    renderView("member");
    await waitFor(() => expect(table()?.textContent).toContain("acme/repo-1"));
    expect(screen.queryByText("Code-host connections")).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect GitLab/ })).toBeNull();
    expect(seen.map((request) => request.path)).toEqual(["/api/ui/repositories/overview"]);
  });

  it("keeps the previous page on screen, dimmed, while the next one loads", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/repositories/overview": async (request) => {
        if (request.query.get("page") !== "2")
          return jsonResponse(list([repo(1), repo(2)], { total: 3 }));
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([repo(3)], { page: 2, total: 3 }));
      },
      "GET /api/ui/repositories/setup": SETUP,
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("acme/repo-2"));
    expect(table().getAttribute("aria-busy")).toBe("false");

    // The pagination link changes the URL's `page`.
    nav.search = new URLSearchParams("page=2");
    view.rerender(<RepositoriesView />);
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("page") === "2")).toBe(true),
    );
    expect(table().textContent).toContain("acme/repo-2");
    expect(table().getAttribute("aria-busy")).toBe("true");

    act(() => release());
    await waitFor(() => expect(table().textContent).toContain("acme/repo-3"));
    expect(table().textContent).not.toContain("acme/repo-2");
    expect(table().getAttribute("aria-busy")).toBe("false");
  });

  it("links a repository to its pages, and its reviews to Runs", async () => {
    mockFetch({
      "GET /api/ui/repositories/overview": list([repo(1)], { connections: [] }),
    });
    renderView("member");
    await waitFor(() => expect(table()?.textContent).toContain("acme/repo-1"));
    const id = repo(1).id;
    expect(
      Array.from(table().querySelectorAll("a.repositories-title"), (a) => a.getAttribute("href")),
    ).toEqual([`/repositories/${id}/rules`]);
    await userEvent.click(screen.getByRole("button", { name: "Actions for acme/repo-1" }));
    const reviews = await screen.findByRole("menuitem", { name: /Reviews/ });
    expect(reviews.getAttribute("href")).toBe(`/runs?kind=review&repository=${id}`);
  });

  it("disconnects a repository and updates the list without a reload", async () => {
    let connected = true;
    const seen = mockFetch({
      "GET /api/ui/repositories/overview": () => jsonResponse(list(connected ? [repo(1)] : [])),
      "GET /api/ui/repositories/setup": SETUP,
      [`DELETE /api/ui/repositories/${repo(1).id}`]: () => {
        connected = false;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for acme/repo-1" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Disconnect/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("No repositories yet")).toBeTruthy();
    expect(seen.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("recreates a webhook and drops the problem from the connection's health", async () => {
    let fixed = false;
    mockFetch({
      "GET /api/ui/repositories/overview": () =>
        jsonResponse(
          list([repo(1)], {
            connections: [
              fixed ? { ...gitlab, health: { ...gitlab.health!, problems: [] } } : gitlab,
            ],
          }),
        ),
      "GET /api/ui/repositories/setup": SETUP,
      [`POST /api/ui/repositories/${repo(1).id}/webhook`]: () => {
        fixed = true;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Recreate webhook" }));
    await waitFor(() =>
      expect(screen.queryByText("acme/repo-1 has no Omniralph webhook.")).toBeNull(),
    );
  });

  it("removes a connection and its repositories without a reload", async () => {
    let removed = false;
    mockFetch({
      "GET /api/ui/repositories/overview": () =>
        jsonResponse(removed ? list([], { connections: [] }) : list([repo(1)])),
      "GET /api/ui/repositories/setup": SETUP,
      [`DELETE /api/ui/scm-connections/${CONNECTION_ID}`]: () => {
        removed = true;
        return jsonResponse({ ok: true });
      },
    });
    renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove bot @ gitlab.example.com" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("No repositories yet")).toBeTruthy();
    expect(screen.queryByText("Code-host connections")).toBeNull();
  });

  it("connects GitLab and goes on to pick its projects once the list knows the connection", async () => {
    let connected = false;
    const seen = mockFetch({
      "GET /api/ui/repositories/overview": () =>
        jsonResponse(list([], { connections: connected ? [gitlab] : [] })),
      "GET /api/ui/repositories/setup": SETUP,
      "POST /api/ui/gitlab-connections": () => {
        connected = true;
        return jsonResponse({ ok: true, connectionId: CONNECTION_ID });
      },
    });
    renderView();
    // The Connect buttons are ready once the setup has loaded.
    await screen.findByText("GitHub App not configured");
    await userEvent.click(screen.getByRole("button", { name: "Connect GitLab" }));
    expect((screen.getByLabelText(/GitLab URL/) as HTMLInputElement).value).toBe(
      "https://gitlab.com",
    );
    await userEvent.type(screen.getByLabelText(/Access token/), "glpat-bot");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(`/repositories/gitlab/${CONNECTION_ID}`),
    );
    expect(seen.find((request) => request.method === "POST")?.body).toEqual({
      baseUrl: "https://gitlab.com",
      token: "glpat-bot",
    });
    // The list was refetched (with the new connection) before navigating.
    expect(screen.getByText("bot @ gitlab.example.com")).toBeTruthy();
  });

  it("shows a failed load in place with a retry", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/repositories/overview": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(list([])),
      "GET /api/ui/repositories/setup": SETUP,
    });
    renderView();
    expect(await screen.findByText("Couldn't load repositories")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No repositories yet")).toBeTruthy();
  });
});

function badges(taskTypes: RepositoryRow["taskTypes"]): string {
  return renderToStaticMarkup(<TaskTypeBadges taskTypes={taskTypes} />);
}

describe("TaskTypeBadges", () => {
  it("shows each switch on or off", () => {
    const html = badges({ reviews: false, coding: true, ask: true });
    expect(html).toContain('aria-label="Reviews: Off"');
    expect(html).toContain('aria-label="Coding: On"');
    expect(html).toContain('aria-label="Ask: On"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("ReviewsCodingAsk");
  });
});
