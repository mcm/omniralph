// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
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
  expectAskRepo,
  serveAskRepositories,
  WithAskNewChat,
} from "@/components/ask/ask-context-test-utils";
import { useRunDetailOverlay } from "@/components/runs/run-detail-overlay";
import {
  attempt,
  epicRunDetail,
  NOW_AT,
  QUESTIONS,
  reviewRunDetail,
  runDetail,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import type { RunDetail, RunList, RunRetryResult } from "@/lib/api/runs";
import { RUN_NOT_FOUND, RunDetailView, type RunMenuExtension } from "./run-detail-view";
import { RunsView } from "./runs-view";
import { askRow, BETA_ID, FILTER_OPTIONS, NOW, reviewRow, runRow } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
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

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RUN_ID = runRow().id;
const MINUTE = 60_000;

/** A running epic of Acme, on its second of three stories, in acme/portal. */
function runningEpic(overrides: Partial<RunDetail> = {}): RunDetail {
  const base = epicRunDetail({
    id: RUN_ID,
    title: "Customer portal billing export",
    repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
    branch: "omniralph/tool-42",
    agent: { id: "agent-1", name: "build-01" },
  });
  return {
    ...base,
    ...overrides,
    details: {
      ...base.details,
      repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
      branch: "omniralph/tool-42",
      agent: { id: "agent-1", name: "build-01" },
      routedBy: "team `SOC` and label `product:portal`",
      tokens: { in: 45_200_000, out: 225_000 },
      attemptCount: 3,
      ...overrides.details,
    },
  };
}

/** A stopped epic that Retry run can resume. */
function stoppedEpic(): RunDetail {
  const run = runningEpic({
    status: "stopped",
    reason: "The epic was stopped. Stopped by Ada.",
    steps: [
      storyStep("1", "completed", 13 * MINUTE),
      storyStep("2", "exhausted", 5 * MINUTE),
      storyStep("3", "pending"),
    ],
  });
  return {
    ...run,
    details: {
      ...run.details,
      actions: { stop: false, retry: { run: true, storyIds: ["2", "3"], attemptIds: [] } },
    },
  };
}

let detail: RunDetail;
let list: RunList;
let seen: SeenRequest[];
let stopAnswer: () => Response | Promise<Response>;
let retryAnswer: () => Response | Promise<Response>;
let detailAnswer: (() => Response) | null;

function serve() {
  seen = mockFetch({
    "GET /api/ui/runs": () => jsonResponse(list),
    "GET /api/ui/runs/filter-options": FILTER_OPTIONS,
    [`GET /api/ui/runs/${RUN_ID}`]: () => detailAnswer?.() ?? jsonResponse(detail),
    [`GET /api/ui/runs/${RUN_ID}/session`]: () => jsonResponse(runSession()),
    [`POST /api/ui/runs/${RUN_ID}/stop`]: () => stopAnswer(),
    [`POST /api/ui/runs/${RUN_ID}/retry`]: () => retryAnswer(),
  });
}

function renderRun(
  options: {
    search?: string;
    user?: SessionUser;
    client?: QueryClient;
    live?: ReturnType<typeof fakeAbly>;
    menuItems?: RunMenuExtension;
    rail?: boolean;
    /** Renders New chat beside the screen, under one Ask context. */
    askNewChat?: boolean;
  } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const view = () =>
    options.askNewChat ? (
      <WithAskNewChat>
        <RunDetailView runId={RUN_ID} menuItems={options.menuItems} />
      </WithAskNewChat>
    ) : options.rail === false ? (
      <RunDetailView runId={RUN_ID} menuItems={options.menuItems} />
    ) : (
      <RunsView
        runId={RUN_ID}
        renderDetail={(id) => <RunDetailView runId={id} menuItems={options.menuItems} />}
      />
    );
  const tree = () => (
    <CurrentUserProvider user={options.user ?? testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              {view()}
            </LiveProvider>
          ) : (
            view()
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const utils = render(tree());
  return {
    ...utils,
    client,
    navigate: (search: string) => {
      nav.search = new URLSearchParams(search);
      utils.rerender(tree());
    },
  };
}

const pane = () => screen.getByRole("region", { name: "Run" });
const loaded = () =>
  waitFor(() => within(pane()).getByRole("heading", { level: 2, name: detail.title }));
const statusLine = () => within(pane()).getByRole("status");
const toolbar = () => within(pane()).getByRole("toolbar", { name: "Run actions" });
const steps = () =>
  within(pane())
    .getAllByRole("button")
    .filter((b) => b.classList.contains("or-step__button"));
const selected = () => steps().find((b) => b.getAttribute("aria-current") === "step");
const headerBadges = () =>
  [...pane().querySelectorAll(".or-run-detail__badges > *")].map((b) => b.textContent!.trim());
const rows = () =>
  screen.queryAllByRole("listitem").filter((row) => row.classList.contains("or-row"));

async function openMenu() {
  await userEvent.click(within(toolbar()).getByRole("button", { name: "More actions" }));
  return screen.getByRole("menu");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  detail = runningEpic();
  list = { runs: [runRow(), reviewRow(), askRow()], nextCursor: null };
  stopAnswer = () => jsonResponse({ ok: true });
  retryAnswer = () => jsonResponse({ ...detail, warning: null });
  detailAnswer = null;
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the run detail", () => {
  it("shows the rail with the URL's filters and the run's row selected beside the detail", async () => {
    renderRun({ search: "kind=epic&status=running" });
    await loaded();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const request = seen.find((r) => r.path === "/api/ui/runs")!;
    expect(request.query.getAll("kind")).toEqual(["epic"]);
    expect(request.query.getAll("status")).toEqual(["running"]);
    const current = rows().find((row) => row.getAttribute("aria-current") === "true");
    expect(current?.querySelector(".or-row__title")?.textContent).toBe(runRow().title);
  });

  it("shows the header badges, toolbar, status line, title and no reason while running", async () => {
    renderRun();
    await loaded();
    expect(headerBadges()).toEqual(["Epic", "Linear TOOL-42", "GitLab acme/portal"]);
    expect(statusLine().textContent).toContain("Running · story 2 of 3");
    expect(pane().querySelector(".or-run-detail__reason")).toBeNull();
    expect(within(pane()).queryByRole("form", { name: "Answer" })).toBeNull();
  });

  it("starts the header with the organization under All organizations", async () => {
    const user: SessionUser = {
      ...testUser,
      scope: "all",
      organizations: [
        { ...testUser.organization, role: "admin" },
        { id: BETA_ID, name: "Beta", role: "member" },
      ],
    };
    renderRun({ user });
    await loaded();
    expect(headerBadges()[0]).toBe("Acme");
  });

  it("says why a stopped run stopped", async () => {
    detail = stoppedEpic();
    renderRun();
    await loaded();
    expect(statusLine().textContent).toContain("Stopped");
    expect(pane().querySelector(".or-run-detail__reason")!.textContent).toBe(
      "The epic was stopped. Stopped by Ada.",
    );
  });

  it("says why a queued run waits for a host tool, with a link to Fleet after the sentence", async () => {
    detail = runningEpic({
      status: "queued",
      reason: "Waiting for an agent with gh installed",
      reasonLink: { label: "Open Fleet", href: "/fleet" },
    });
    renderRun();
    await loaded();
    const reason = pane().querySelector(".or-run-detail__reason")!;
    expect(reason.textContent).toBe("Waiting for an agent with gh installed. Open Fleet");
    const link = within(reason as HTMLElement).getByRole("link", { name: "Open Fleet" });
    expect(link.getAttribute("href")).toBe("/fleet");
    expect(reason.lastElementChild).toBe(link);
  });

  it("shows no reason for a queued run that waits for nothing in particular", async () => {
    detail = runningEpic({ status: "queued", reason: null, reasonLink: null });
    renderRun();
    await loaded();
    expect(pane().querySelector(".or-run-detail__reason")).toBeNull();
  });

  it("shows an open question's form under the reason", async () => {
    detail = runDetail(QUESTIONS.repository, {
      id: RUN_ID,
      reason: "Om needs to know which repo to work in.",
    });
    renderRun();
    await loaded();
    const form = within(pane()).getByRole("form", { name: "Answer" });
    const reason = pane().querySelector(".or-run-detail__reason")!;
    expect(reason.textContent).toBe("Om needs to know which repo to work in.");
    expect(reason.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      within(form).getByRole("radiogroup", { name: QUESTIONS.repository.prompt }),
    ).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Send answer" })).toBeTruthy();
    // The run variant: Send answer alone, no Done or Snooze.
    expect(within(form).queryByRole("button", { name: /Done|Snooze/ })).toBeNull();
  });

  it("selects the default step, and the URL's step, on the progress card", async () => {
    const { navigate } = renderRun({ search: "kind=epic" });
    await loaded();
    const card = within(pane()).getByRole("region", { name: "Stories" });
    expect(card.querySelector(".or-progress__count")!.textContent).toBe(
      "1 of 3 done · 1 running · 18m",
    );
    expect(selected()?.textContent).toContain("Story 2");
    await userEvent.click(steps()[0]!);
    expect(nav.router.replace).toHaveBeenCalledWith(`/runs/${RUN_ID}?kind=epic&step=1`, {
      scroll: false,
    });
    navigate("kind=epic&step=1");
    expect(selected()?.textContent).toContain("Story 1");
  });

  it("makes the run's repo New chat's default (useAskContextRepository)", async () => {
    serveAskRepositories([
      { id: "repo-0", provider: "github", fullPath: "acme/web" },
      { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
    ]);
    renderRun({ askNewChat: true });
    await screen.findByRole("heading", { level: 2, name: detail.title });
    await expectAskRepo("acme/portal");
  });

  it("lists the details in a collapsed section", async () => {
    renderRun();
    await loaded();
    const section = pane().querySelector("details.or-run-details") as HTMLDetailsElement;
    expect(section.open).toBe(false);
    expect(section.querySelector("summary")!.textContent).toBe("Details");
    expect(within(section).getByText("45.2M in · 225k out")).toBeTruthy();
  });

  it("keeps an epic's Session collapsed between Details and Activity", async () => {
    renderRun();
    await loaded();
    const session = await waitFor(
      () => pane().querySelector("details.or-run-session") as HTMLDetailsElement,
    );
    expect(session.open).toBe(false);
    expect(session.querySelector("summary")!.textContent).toBe("Session");
    const details = pane().querySelector("details.or-run-details")!;
    const activity = within(pane()).getByRole("list", { name: "Run activity" });
    expect(
      details.compareDocumentPosition(session) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      session.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no Session for a review run", async () => {
    detail = reviewRunDetail({ id: RUN_ID });
    renderRun();
    await loaded();
    expect(pane().querySelector("details.or-run-details")).not.toBeNull();
    expect(pane().querySelector("details.or-run-session")).toBeNull();
    expect(seen.some((r) => r.path.endsWith("/session"))).toBe(false);
  });

  it("shows the run's activity", async () => {
    detail = runningEpic({
      attempts: [attempt("a1", { step: "1", label: "Built TOOL-1", finishedAt: NOW_AT(-40) })],
    });
    renderRun();
    await loaded();
    const activity = within(pane()).getByRole("list", { name: "Run activity" });
    const entries = within(activity)
      .getAllByRole("listitem")
      .map((e) => e.textContent);
    expect(entries[0]).toContain("Built TOOL-1");
    expect(entries.at(-1)).toContain("Epic started from Linear");
    expect(within(activity).getByText("SOC")).toBeTruthy();
  });

  it("shows that a run doesn't exist or isn't in the user's organizations", async () => {
    detailAnswer = () => jsonResponse({ error: "That run doesn't exist." }, 404);
    renderRun({ rail: false });
    expect(await screen.findByRole("heading", { name: RUN_NOT_FOUND })).toBeTruthy();
  });
});

describe("the toolbar and menu", () => {
  it("opens the merge request and retries from icon buttons with tooltips", async () => {
    const stopped = stoppedEpic();
    detail = {
      ...stopped,
      pullRequest: { provider: "gitlab", number: 12, url: "https://gitlab.com/mr/12" },
    };
    renderRun();
    await loaded();
    const link = within(toolbar()).getByRole("link", { name: "Open merge request" });
    expect(link.getAttribute("href")).toBe("https://gitlab.com/mr/12");
    expect(within(toolbar()).getByRole("button", { name: "Retry run" })).toBeTruthy();
  });

  it("offers Open in Linear, Copy branch and, after a divider, Stop run", async () => {
    renderRun();
    await loaded();
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Open in Linear",
      "Copy branch",
      "Stop run",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("offers Open chat before the divider when the run came from the user's own Ask chat", async () => {
    detail = { ...detail, chat: { threadId: "chat-1", platform: "web", href: "/ask/chat-1" } };
    renderRun();
    await loaded();
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Open chat",
      "Open in Linear",
      "Copy branch",
      "Stop run",
    ]);
    expect(items[0]!.getAttribute("href")).toBe("/ask/chat-1");
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("renders a menu item's element through useRunDetailOverlay, and closes it on dismiss", async () => {
    function TestSheet() {
      const overlay = useRunDetailOverlay();
      return (
        <div role="dialog" aria-label="Test sheet">
          <button type="button" onClick={overlay.close}>
            Dismiss
          </button>
        </div>
      );
    }
    renderRun({
      menuItems: (_run, overlay) => [
        { label: "View test", onSelect: () => overlay.open(<TestSheet />) },
      ],
    });
    await loaded();
    const menu = await openMenu();
    expect(within(menu).getAllByRole("menuitem")[0]!.textContent).toBe("View test");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "View test" }));
    const sheet = await within(pane()).findByRole("dialog", { name: "Test sheet" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Dismiss" }));
    expect(within(pane()).queryByRole("dialog", { name: "Test sheet" })).toBeNull();
  });
});

describe("Stop and Retry", () => {
  it("asks to confirm Stop, then shows the run stopped before the server answers", async () => {
    const held = deferred();
    stopAnswer = () => held.promise;
    renderRun();
    await loaded();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Stop run" }));
    const dialog = screen.getByRole("alertdialog", { name: "Stop this run?" });
    expect(seen.some((r) => r.method === "POST")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Stop run" }));
    await waitFor(() =>
      expect(seen.some((r) => r.method === "POST" && r.path.endsWith("/stop"))).toBe(true),
    );
    await waitFor(() => expect(statusLine().textContent).toBe("Stopped"));
    detail = { ...detail, status: "stopped" };
    held.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Run stopped"));
    expect(statusLine().textContent).toBe("Stopped");
  });

  it("rolls a failed Stop back with the server's message", async () => {
    const held = deferred();
    stopAnswer = () => held.promise;
    renderRun();
    await loaded();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Stop run" }));
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Stop run" }),
    );
    await waitFor(() => expect(statusLine().textContent).toBe("Stopped"));
    held.resolve(jsonResponse({ error: "This run is already over (completed)." }, 400));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("This run is already over (completed).", {
        variant: "danger",
      }),
    );
    await waitFor(() => expect(statusLine().textContent).toContain("Running · story 2 of 3"));
  });

  it("retries the run: queued, the step running and the button disabled before the server answers", async () => {
    detail = stoppedEpic();
    const held = deferred();
    retryAnswer = () => held.promise;
    renderRun();
    await loaded();
    expect(selected()?.textContent).toContain("Story 2");
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Retry run" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Queued"));
    const retry = seen.find((r) => r.method === "POST" && r.path.endsWith("/retry"))!;
    expect(retry.body).toEqual({ target: { kind: "run" } });
    expect(within(selected()!).getByRole("img").getAttribute("aria-label")).toBe("Running");
    expect(
      (within(toolbar()).getByRole("button", { name: "Retry run" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const resumed: RunRetryResult = {
      ...detail,
      status: "running",
      progress: { done: 1, total: 3 },
      details: {
        ...detail.details,
        actions: { stop: true, retry: { run: false, storyIds: [], attemptIds: [] } },
      },
      warning: null,
    };
    detail = resumed;
    held.resolve(jsonResponse(resumed));
    await waitFor(() => expect(statusLine().textContent).toBe("Running · story 2 of 3"));
    expect(within(toolbar()).queryByRole("button", { name: "Retry run" })).toBeNull();
  });

  it("re-runs the selected story of a finished epic", async () => {
    const run = runningEpic({
      status: "completed",
      progress: { done: 2, total: 2 },
      steps: [storyStep("1", "completed", MINUTE), storyStep("2", "completed", MINUTE)],
    });
    detail = {
      ...run,
      details: {
        ...run.details,
        actions: { stop: false, retry: { run: false, storyIds: ["1", "2"], attemptIds: [] } },
      },
    };
    const held = deferred();
    retryAnswer = () => held.promise;
    renderRun({ search: "step=1" });
    await loaded();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Re-run story" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Queued"));
    const retry = seen.find((r) => r.method === "POST" && r.path.endsWith("/retry"))!;
    expect(retry.body).toEqual({ target: { kind: "story", storyId: "1" } });
    expect(within(steps()[0]!).getByRole("img").getAttribute("aria-label")).toBe("Running");
    expect(within(steps()[1]!).getByRole("img").getAttribute("aria-label")).toBe("Done");
    held.resolve(jsonResponse({ error: "Something broke." }, 500));
    await waitFor(() => expect(statusLine().textContent).toBe("Finished"));
  });

  it("rolls a refused retry back with the 409 message", async () => {
    detail = stoppedEpic();
    const held = deferred();
    retryAnswer = () => held.promise;
    renderRun();
    await loaded();
    await userEvent.click(within(toolbar()).getByRole("button", { name: "Retry run" }));
    await waitFor(() => expect(statusLine().textContent).toBe("Queued"));
    held.resolve(
      jsonResponse({ error: "Om is already working on this run.", code: "run_busy" }, 409),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Om is already working on this run.", {
        variant: "danger",
      }),
    );
    await waitFor(() => expect(statusLine().textContent).toBe("Stopped"));
    expect(within(selected()!).getByRole("img").getAttribute("aria-label")).toBe("Failed");
  });
});

describe("live updates", () => {
  it("refetch the detail on the run's change event: status line, progress and activity update", async () => {
    const live = fakeAbly();
    renderRun({ live });
    await loaded();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );
    const detailRequests = () => seen.filter((r) => r.path === `/api/ui/runs/${RUN_ID}`).length;
    const before = detailRequests();
    detail = runningEpic({
      status: "failed",
      reason: "The run failed. Out of turns.",
      progress: { done: 1, total: 3 },
      steps: [
        storyStep("1", "completed", 13 * MINUTE),
        storyStep("2", "exhausted", 5 * MINUTE),
        storyStep("3", "pending"),
      ],
      finishedAt: NOW_AT(-1),
    });
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID }),
        ),
    );
    await waitFor(() => expect(detailRequests()).toBeGreaterThan(before));
    await waitFor(() => expect(statusLine().textContent).toBe("Failed"));
    expect(within(selected()!).getByRole("img").getAttribute("aria-label")).toBe("Failed");
    const activity = within(pane()).getByRole("list", { name: "Run activity" });
    expect(within(activity).getAllByRole("listitem")[0]!.textContent).toContain(
      "The run failed. Out of turns.",
    );
  });
});

describe("/runs without a run", () => {
  type Callback = (entries: { contentRect: { width: number } }[]) => void;
  let observers: Callback[];

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: Callback) {
          observers.push(callback);
        }
      },
    );
  });

  function renderList() {
    nav.search = new URLSearchParams();
    render(
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            <RunsView />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>,
    );
  }

  it("shows the first listed run when the container is wide", async () => {
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(pane().querySelector(".or-run-detail")).toBeNull();
    act(() => observers.forEach((callback) => callback([{ contentRect: { width: 1200 } }])));
    await loaded();
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
  });

  it("shows no run when the container is narrow", async () => {
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(3));
    act(() => observers.forEach((callback) => callback([{ contentRect: { width: 600 } }])));
    expect(pane().querySelector(".or-run-detail")).toBeNull();
    expect(seen.some((r) => r.path === `/api/ui/runs/${RUN_ID}`)).toBe(false);
  });
});
