// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
} from "@/components/query-test-utils";
import type * as UI from "@iamthemcmaster/ui";
import type { JobList } from "@/lib/api/jobs";
import type { JobRow } from "@/lib/harnesses/rows";
import { JobsView } from "./jobs-view";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/jobs",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  notify: toast.notify,
}));

function jobRow(n: number, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: `44444444-5555-4666-8777-${String(n).padStart(12, "0")}`,
    type: "review.run",
    taskType: "review",
    status: "queued",
    deliveryCount: 0,
    cancelRequested: false,
    error: null,
    agent: null,
    target: { label: `acme/api!${n}`, url: null },
    triageRun: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function list(jobs: JobRow[], overrides: Partial<JobList> = {}): JobList {
  return { jobs, page: 1, pageSize: 25, total: jobs.length, targetJobId: null, ...overrides };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  const view = render(<JobsView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return { client, view };
}

/** The jobs table (and its pending wrapper). */
function table() {
  return document.querySelector(".list-pending") as HTMLElement | null;
}

function row(job: JobRow) {
  return document.getElementById(`job-${job.id}`) as HTMLElement;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.search = new URLSearchParams();
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  window.location.hash = "";
  toast.notify.mockReset();
});

describe("JobsView", () => {
  it("shows a skeleton, then the jobs with when they were fetched", async () => {
    mockFetch({ "GET /api/ui/jobs": list([jobRow(1), jobRow(2, { status: "running" })]) });
    renderView();
    expect(screen.getByLabelText("Loading jobs")).toBeTruthy();
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!2"));
    expect(document.querySelector(".freshness")?.textContent).toMatch(/^Updated /);
    expect(screen.getByText("Newest first. Showing 1–2 of 2.")).toBeTruthy();
  });

  it("shows a job's new state when the list refetches", async () => {
    let job = jobRow(1);
    mockFetch({ "GET /api/ui/jobs": () => jsonResponse(list([job])) });
    const { client } = renderView();
    await waitFor(() => expect(within(row(job)).getAllByText("Queued").length).toBeGreaterThan(0));
    job = { ...job, status: "running" };
    await client.invalidateQueries();
    await waitFor(() => expect(within(row(job)).getAllByText("Running").length).toBeGreaterThan(0));
  });

  it("shows the chosen filter at once and dims the old results until the new ones arrive", async () => {
    let release: () => void = () => {};
    const seen = mockFetch({
      "GET /api/ui/jobs": async (request) => {
        if (request.query.get("status") !== "failed") {
          return jsonResponse(list([jobRow(1), jobRow(2, { status: "failed" })]));
        }
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([jobRow(2, { status: "failed" })]));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!1"));
    expect(table()!.getAttribute("aria-busy")).toBe("false");

    const status = screen.getByLabelText("Filter by status") as HTMLSelectElement;
    await userEvent.selectOptions(status, "failed");
    expect(status.value).toBe("failed");
    expect(nav.router.push).toHaveBeenCalledWith("/jobs?status=failed", { scroll: false });
    await waitFor(() =>
      expect(seen.some((request) => request.query.get("status") === "failed")).toBe(true),
    );
    expect(table()!.getAttribute("aria-busy")).toBe("true");
    expect(table()!.textContent).toContain("acme/api!1");

    nav.search = new URLSearchParams("status=failed");
    view.rerender(<JobsView />);
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("failed");

    release();
    await waitFor(() => expect(table()?.getAttribute("aria-busy")).toBe("false"));
    expect(table()!.textContent).not.toContain("acme/api!1");

    // Back to the unfiltered URL: its filter shows, not the earlier choice.
    nav.search = new URLSearchParams();
    view.rerender(<JobsView />);
    expect((screen.getByLabelText("Filter by status") as HTMLSelectElement).value).toBe("");
  });

  it("keeps the previous page, dimmed, while the next one loads", async () => {
    let release: () => void = () => {};
    mockFetch({
      "GET /api/ui/jobs": async (request) => {
        if (request.query.get("page") !== "2") {
          return jsonResponse(list([jobRow(1)], { total: 26 }));
        }
        await new Promise<void>((resolve) => (release = resolve));
        return jsonResponse(list([jobRow(26)], { page: 2, total: 26 }));
      },
    });
    const { view } = renderView();
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!1"));
    nav.search = new URLSearchParams("page=2");
    view.rerender(<JobsView />);
    await waitFor(() => expect(table()?.getAttribute("aria-busy")).toBe("true"));
    expect(table()!.textContent).toContain("acme/api!1");
    release();
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!26"));
    expect(table()!.getAttribute("aria-busy")).toBe("false");
  });

  it("shows a running job's cancel as requested until the harness confirms it, then canceled", async () => {
    let job = jobRow(1, { status: "running" });
    const seen = mockFetch({
      "GET /api/ui/jobs": () => jsonResponse(list([job])),
      [`POST /api/ui/jobs/${job.id}/cancel`]: () => {
        job = { ...job, cancelRequested: true };
        return jsonResponse({
          ok: true,
          warning: "Cancel requested: the agent stops the job with its next heartbeat.",
        });
      },
    });
    const { client } = renderView();
    await waitFor(() => expect(row(job)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /^Cancel job / }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel job" }));
    await waitFor(() =>
      expect(within(row(job)).getAllByText("Cancel requested").length).toBeGreaterThan(0),
    );
    expect(seen.some((request) => request.method === "POST")).toBe(true);
    expect(toast.notify).toHaveBeenCalledWith(
      "Cancel requested: the agent stops the job with its next heartbeat.",
      { variant: "warning" },
    );
    expect(screen.queryByRole("button", { name: /^Cancel job / })).toBeNull();

    // The harness confirms with its heartbeat; the next poll shows the job canceled.
    job = { ...job, status: "canceled", finishedAt: "2026-10-16T10:01:00.000Z" };
    await client.invalidateQueries();
    await waitFor(() =>
      expect(within(row(job)).getAllByText("Canceled").length).toBeGreaterThan(0),
    );
    expect(within(row(job)).queryByText("Cancel requested")).toBeNull();
  });

  it("shows the cancel at once while the request is on its way, and rolls it back when it fails", async () => {
    const job = jobRow(1, { status: "running" });
    let fail: (response: Response) => void = () => {};
    mockFetch({
      "GET /api/ui/jobs": () => jsonResponse(list([job])),
      [`POST /api/ui/jobs/${job.id}/cancel`]: () =>
        new Promise<Response>((resolve) => (fail = resolve)),
    });
    renderView();
    await waitFor(() => expect(row(job)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /^Cancel job / }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel job" }));
    await waitFor(() =>
      expect(within(row(job)).getAllByText("Cancel requested").length).toBeGreaterThan(0),
    );
    fail(jsonResponse({ error: "That job has already finished." }, 400));
    await waitFor(() =>
      expect(toast.notify).toHaveBeenCalledWith("That job has already finished.", {
        variant: "danger",
      }),
    );
    await waitFor(() => expect(within(row(job)).queryByText("Cancel requested")).toBeNull());
  });

  it("offers no cancel to members", async () => {
    mockFetch({ "GET /api/ui/jobs": list([jobRow(1)]) });
    renderView("member");
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!1"));
    expect(screen.queryByRole("button", { name: /^Cancel job / })).toBeNull();
  });

  it("opens the page of a `?job=` link and highlights its job", async () => {
    const target = jobRow(30);
    nav.search = new URLSearchParams(`job=${target.id}`);
    const seen = mockFetch({
      "GET /api/ui/jobs": list([target], { page: 2, total: 30, targetJobId: target.id }),
    });
    renderView();
    await waitFor(() => expect(row(target)?.getAttribute("aria-current")).toBe("true"));
    expect(seen[0]!.query.get("job")).toBe(target.id);
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      "GET /api/ui/jobs": () =>
        fail
          ? jsonResponse({ error: "Database unavailable." }, 500)
          : jsonResponse(list([jobRow(1)])),
    });
    renderView();
    expect(await screen.findByText("Couldn't load jobs")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(table()?.textContent).toContain("acme/api!1"));
  });
});
