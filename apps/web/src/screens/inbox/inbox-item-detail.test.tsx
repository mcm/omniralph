// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import {
  attempt,
  epicRunDetail,
  NOW_AT,
  reviewRunDetail,
  runDetail,
  storyStep,
} from "@/components/runs/test-fixtures";
import type { InboxItem } from "@/lib/api/inbox";
import type { RunDetail } from "@/lib/api/runs";
import { RUN_LOAD_FAILED } from "./inbox-item-cards";
import { InboxView } from "./inbox-view";
import { agentOfflineItem, COUNTS, inboxItem, mrReadyItem, NOW } from "./test-fixtures";

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

function TestLink({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        nav.router.push(href);
      }}
    />
  );
}

const RUN_ID = "44444444-4444-4444-8444-444444444444";

let feeds: Record<string, InboxItem[]>;
let runs: Record<string, RunDetail>;
let runRoute: ((request: SeenRequest) => Response | Promise<Response>) | null;
let seen: SeenRequest[];

function serve() {
  const routes: Parameters<typeof mockFetch>[0] = {
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: feeds[request.query.get("tab") ?? "needs-you"] ?? [] }),
    "GET /api/ui/inbox/counts": COUNTS,
  };
  for (const id of [...Object.keys(runs), RUN_ID, "run-1", "run-2", "run-3"]) {
    routes[`GET /api/ui/runs/${id}`] = (request) =>
      runRoute
        ? runRoute(request)
        : runs[id]
          ? jsonResponse(runs[id])
          : jsonResponse({ error: "Not found." }, 404);
  }
  seen = mockFetch(routes);
}

function renderInbox(search: string, live?: ReturnType<typeof fakeAbly>) {
  nav.search = new URLSearchParams(search);
  const client = createTestQueryClient();
  const view = <InboxView />;
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {live ? (
            <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
              {view}
            </LiveProvider>
          ) : (
            view
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return client;
}

const detail = () => screen.getByRole("region", { name: "Item" });
/** The detail's card named `name`, once loaded (a skeleton card has the same title). */
const card = (name: string) =>
  waitFor(() => {
    const found = within(detail()).getByRole("region", { name });
    expect(within(found).queryByTestId("run-skeleton")).toBeNull();
    return found;
  });
const runRequests = (id: string) => seen.filter((r) => r.path === `/api/ui/runs/${id}`);

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  feeds = { "needs-you": [], problems: [], running: [] };
  runs = {};
  runRoute = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("an item with a run", () => {
  it("shows a manual story's epic progress with an Open run link, and its activity", async () => {
    feeds["needs-you"] = [inboxItem()];
    runs["run-1"] = epicRunDetail({ status: "waiting" });
    serve();
    renderInbox("");
    const progress = await card("Epic progress");
    expect(within(progress).getByText("1 of 3 done · 1 running · 18m")).toBeTruthy();
    expect(within(progress).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      "/runs/run-1",
    );
    const activity = await card("Activity");
    const entries = within(activity)
      .getAllByRole("listitem")
      .map((entry) => entry.textContent);
    expect(entries.some((text) => text?.endsWith(inboxItem().reason))).toBe(true);
    expect(entries.some((text) => text?.endsWith("Built TOOL-1"))).toBe(true);
    expect(entries.at(-1)).toMatch(/Epic started from Linear$/);
  });

  it("shows a stopped epic's progress", async () => {
    feeds["needs-you"] = [
      inboxItem({
        key: "stopped:run-1:x",
        kind: "stopped_epic",
        run: { id: "run-1", kind: "epic", status: "stopped" },
        reason: "The epic was stopped.",
        actions: ["resume", "done", "snooze"],
      }),
    ];
    runs["run-1"] = epicRunDetail({
      status: "stopped",
      steps: [storyStep("1", "completed", 60_000), storyStep("2", "canceled")],
    });
    serve();
    renderInbox("");
    const progress = await card("Epic progress");
    expect(within(progress).getByText("1 of 2 done · 1 canceled · 1m")).toBeTruthy();
    expect(within(progress).getByRole("img", { name: "Canceled" })).toBeTruthy();
  });

  it("shows a running review's passes", async () => {
    feeds.running = [
      inboxItem({
        key: "running:run-3",
        tab: "running",
        kind: "run",
        title: "Review !12",
        run: { id: "run-3", kind: "review", status: "running" },
        reason: "Om is working on it.",
        actions: [],
      }),
    ];
    runs["run-3"] = reviewRunDetail();
    serve();
    renderInbox("tab=running");
    const progress = await card("Review passes");
    expect(within(progress).getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      "/runs/run-3",
    );
    expect(within(progress).getAllByRole("listitem")).toHaveLength(3);
    // A running run's reason isn't activity.
    const activity = await card("Activity");
    expect(within(activity).queryByText("Om is working on it.")).toBeNull();
  });

  it("shows skeletons while the run loads", async () => {
    feeds["needs-you"] = [inboxItem()];
    const held = deferred();
    runRoute = () => held.promise;
    serve();
    renderInbox("");
    await waitFor(() => expect(within(detail()).getAllByTestId("run-skeleton")).toHaveLength(2));
    expect(within(detail()).getByRole("region", { name: "Epic progress" })).toBeTruthy();
    expect(within(detail()).queryByRole("progressbar")).toBeNull();
    held.resolve(jsonResponse(epicRunDetail()));
    expect(await within(detail()).findByRole("progressbar")).toBeTruthy();
    expect(within(detail()).queryByTestId("run-skeleton")).toBeNull();
  });

  it("says when the run couldn't load, and Retry loads it again", async () => {
    const user = userEvent.setup({ advanceTimers: () => {} });
    feeds["needs-you"] = [inboxItem()];
    runRoute = () => jsonResponse({ error: "Something broke." }, 500);
    serve();
    renderInbox("");
    const alert = await within(detail()).findByRole("alert");
    expect(alert.textContent).toContain(RUN_LOAD_FAILED);
    expect(within(detail()).queryByRole("progressbar")).toBeNull();
    runRoute = () => jsonResponse(epicRunDetail());
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await card("Epic progress")).toBeTruthy();
    expect(within(detail()).queryByRole("alert")).toBeNull();
  });
});

describe("a pull or merge request ready for review", () => {
  it("shows the AI review's status, open findings by severity and an Open review link", async () => {
    feeds["needs-you"] = [mrReadyItem()];
    runs["run-2"] = epicRunDetail({ id: "run-2", status: "completed" });
    serve();
    renderInbox("");
    const review = await card("AI review");
    expect(within(review).getByText("Finished")).toBeTruthy();
    expect(within(review).getByText("1 high · 2 medium")).toBeTruthy();
    expect(within(review).getByRole("link", { name: "Open review" }).getAttribute("href")).toBe(
      "/runs/run-3",
    );
    expect(await card("Epic progress")).toBeTruthy();
  });

  it("says No open findings when the review found nothing open", async () => {
    feeds["needs-you"] = [
      mrReadyItem({
        review: {
          runId: "run-3",
          status: "running",
          openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
      }),
    ];
    runs["run-2"] = epicRunDetail({ id: "run-2", status: "completed" });
    serve();
    renderInbox("");
    const review = await card("AI review");
    expect(within(review).getByText("Running")).toBeTruthy();
    expect(within(review).getByText("No open findings")).toBeTruthy();
  });
});

describe("what went wrong", () => {
  it("shows a failed run's last failed attempt", async () => {
    feeds.problems = [
      inboxItem({
        key: "failed:run-1:a2",
        tab: "problems",
        kind: "failed_run",
        run: { id: "run-1", kind: "request", status: "failed" },
        reason: "The run failed. Tests failed.",
        actions: ["retry", "done", "snooze"],
      }),
    ];
    runs["run-1"] = runDetail(null, {
      kind: "request",
      status: "failed",
      finishedAt: NOW_AT(-5),
      steps: [{ kind: "attempt", id: "a2", label: "Built it", status: "failed", durationMs: 1000 }],
      attempts: [
        attempt("a2", {
          status: "failed",
          label: "Couldn't build TOOL-42",
          error: "Tests failed\nexpected 3, got 4",
          finishedAt: NOW_AT(-5),
        }),
        attempt("a1", {
          status: "failed",
          label: "Couldn't start",
          error: "older",
          finishedAt: NOW_AT(-20),
        }),
      ],
    });
    serve();
    renderInbox("tab=problems");
    const cause = await card("What went wrong");
    expect(within(cause).getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(within(cause).getByText("Couldn't build TOOL-42")).toBeTruthy();
    expect(cause.querySelector("pre")!.textContent).toBe("Tests failed\nexpected 3, got 4");
    expect(within(cause).queryByText("Couldn't start")).toBeNull();
    expect(await card("Turns")).toBeTruthy();
    // Attempts read as their label, never their job type, and carry no shortcut indicator.
    expect(document.body.textContent).not.toContain("repo.sync");
    for (const element of document.querySelectorAll("[title], [aria-label]")) {
      expect(element.getAttribute("title") ?? "").not.toContain("repo.sync");
      expect(element.getAttribute("aria-label") ?? "").not.toContain("repo.sync");
    }
    expect(document.querySelector("kbd, [aria-keyshortcuts]")).toBeNull();
  });

  it("shows failed system work's attempt label and the item's reason", async () => {
    feeds.problems = [
      inboxItem({
        key: "failed_attempt:j1",
        tab: "problems",
        kind: "failed_system",
        title: "Couldn't sync web",
        run: null,
        workItem: null,
        reason: "Couldn't sync web. git fetch failed",
        actions: ["retry", "done", "snooze"],
      }),
    ];
    serve();
    renderInbox("tab=problems");
    const cause = await card("What went wrong");
    expect(within(cause).getByText("Couldn't sync web")).toBeTruthy();
    expect(cause.querySelector("pre")!.textContent).toBe("Couldn't sync web. git fetch failed");
    expect(seen.some((r) => r.path.startsWith("/api/ui/runs/"))).toBe(false);
  });
});

describe("agents", () => {
  it("links an offline agent's badge to Fleet and says how long it's been offline", async () => {
    feeds.problems = [agentOfflineItem()];
    serve();
    renderInbox("tab=problems");
    await waitFor(() => expect(within(detail()).getByRole("status")).toBeTruthy());
    expect(within(detail()).getByRole("status").textContent).toContain("Offline for 2 hours");
    expect(
      within(detail())
        .getByRole("link", { name: /build-box/ })
        .getAttribute("href"),
    ).toBe("/fleet/agent-1");
    expect(within(detail()).queryByRole("region", { name: "What went wrong" })).toBeNull();
  });

  it("names the version an agent couldn't update to", async () => {
    feeds.problems = [
      agentOfflineItem({
        key: "agent_update:agent-1:1.4.0",
        kind: "agent_update_failed",
        version: "1.4.0",
        reason: "build-box couldn't update to 1.4.0.",
        since: NOW_AT(-180),
      }),
    ];
    serve();
    renderInbox("tab=problems");
    await waitFor(() =>
      expect(within(detail()).getByRole("status").textContent).toContain(
        "Update to 1.4.0 failed 3 hours ago",
      ),
    );
    expect(
      within(detail())
        .getByRole("link", { name: /build-box/ })
        .getAttribute("href"),
    ).toBe("/fleet/agent-1");
  });
});

describe("a ready PRD", () => {
  it("shows the work item's size on the row and in the header", async () => {
    feeds["needs-you"] = [
      inboxItem({
        key: "prd_ready:t1:j1",
        kind: "prd_ready",
        title: "Billing export",
        run: { id: "run-1", kind: "triage", status: "completed" },
        actions: ["done", "snooze"],
        size: "XL",
      }),
    ];
    runs["run-1"] = runDetail(null, { kind: "triage", status: "completed" });
    serve();
    renderInbox("");
    const row = await screen.findByRole("link", { name: "Billing export" });
    const rowItem = row.closest("li")!;
    expect(within(rowItem).getByRole("img", { name: "Size XL" })).toBeTruthy();
    const header = detail().querySelector("header")!;
    expect(within(header).getByRole("img", { name: "Size XL" })).toBeTruthy();
  });

  it("shows no size badge without a size", async () => {
    feeds["needs-you"] = [
      inboxItem({
        key: "prd_ready:t1:j1",
        kind: "prd_ready",
        run: { id: "run-1", kind: "triage", status: "completed" },
        size: null,
      }),
    ];
    runs["run-1"] = runDetail(null, { kind: "triage", status: "completed" });
    serve();
    renderInbox("");
    await card("Turns");
    expect(screen.queryByRole("img", { name: /^Size / })).toBeNull();
  });
});

describe("live updates", () => {
  it("refetch the run detail on the run's change event, updating the progress card and activity", async () => {
    const live = fakeAbly();
    feeds["needs-you"] = [inboxItem({ run: { id: RUN_ID, kind: "epic", status: "waiting" } })];
    runs[RUN_ID] = epicRunDetail({ id: RUN_ID, status: "waiting" });
    serve();
    renderInbox("", live);
    const progress = await card("Epic progress");
    expect(within(progress).getByText("1 of 3 done · 1 running · 18m")).toBeTruthy();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const before = runRequests(RUN_ID).length;

    runs[RUN_ID] = epicRunDetail({
      id: RUN_ID,
      status: "waiting",
      steps: [
        storyStep("1", "completed", 13 * 60_000),
        storyStep("2", "completed", 7 * 60_000),
        storyStep("3", "manual"),
      ],
      attempts: [
        attempt("a2", { step: "2", label: "Built TOOL-2", finishedAt: NOW_AT(-1) }),
        attempt("a1", { step: "1", label: "Built TOOL-1" }),
      ],
    });
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID, ids: [RUN_ID] }),
        ),
    );
    await waitFor(() => expect(runRequests(RUN_ID).length).toBe(before + 1));
    expect(
      await within(await card("Epic progress")).findByText("2 of 3 done · 1 waiting on you · 20m"),
    ).toBeTruthy();
    const activity = await card("Activity");
    expect(within(activity).getByText("Built TOOL-2")).toBeTruthy();
  });
});
