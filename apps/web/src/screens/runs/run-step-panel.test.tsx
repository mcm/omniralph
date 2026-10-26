// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
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
import { StepPanel } from "@/components/runs/step-panel";
import {
  attempt,
  epicRunDetail,
  NOW_AT,
  runDetail,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import { createQueryClient } from "@/lib/api/query-client";
import type { RunDetail, RunRetryResult, TranscriptPageView } from "@/lib/api/runs";
import { RunDetailView } from "./run-detail-view";
import { NOW, runRow } from "./test-fixtures";

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
const START = NOW_AT(-10);

type Event = TranscriptPageView["events"][number];

/** `n` transcript events from `START`, alternating thoughts and actions, 5 s apart. */
function transcriptEvents(n: number, from = 0): Event[] {
  return Array.from({ length: n }, (_, i) => {
    const index = from + i;
    const at = new Date(Date.parse(START) + index * 5000).toISOString();
    return index % 2 === 0
      ? { id: `ev-${index}`, type: "thought", body: `Thought ${index}`, parameter: null, at }
      : { id: `ev-${index}`, type: "action", body: "Bash", parameter: `cmd ${index}`, at };
  });
}

/** Serves `events` a page of 200 at a time through the cursors "c200", "c400"… */
function pagedTranscript(events: Event[]) {
  return (request: SeenRequest) => {
    const cursor = request.query.get("cursor");
    const start = cursor ? Number(cursor.slice(1)) : 0;
    const page = events.slice(start, start + 200);
    const next = start + 200 < events.length ? `c${start + 200}` : null;
    return jsonResponse({ events: page, nextCursor: next } satisfies TranscriptPageView);
  };
}

type StoryStep = Extract<RunDetail["steps"][number], { kind: "story" }>;

/** A story step with `changes`. */
const story = (step: RunDetail["steps"][number], changes: Partial<StoryStep>) =>
  ({ ...(step as StoryStep), ...changes }) satisfies StoryStep;

/**
 * A running epic on its second story: the story's running attempt (450 events) and its
 * failed one before it, after the first story's finished attempt.
 */
function epic(overrides: Partial<RunDetail> = {}): RunDetail {
  const base = epicRunDetail({
    id: RUN_ID,
    title: "Customer portal billing export",
    steps: [
      story(storyStep("1", "completed", 13 * MINUTE), { commit: "4f1c2ab9d0" }),
      story(storyStep("2", "running", 5 * MINUTE), {
        attempts: 1,
        lastFeedback: "The export test failed: the CSV header is missing.",
      }),
      storyStep("3", "pending"),
    ],
    attempts: [
      attempt("a3", {
        step: "2",
        status: "running",
        label: "Building TOOL-2",
        agent: { id: "agent-1", name: "build-01" },
        startedAt: START,
        createdAt: START,
        finishedAt: null,
        tokens: { in: 8400, out: 950 },
        transcriptEvents: 450,
      }),
      attempt("a2", {
        step: "2",
        status: "failed",
        label: "Tried TOOL-2",
        agent: { id: "agent-2", name: "build-02" },
        startedAt: NOW_AT(-30),
        createdAt: NOW_AT(-30),
        finishedAt: NOW_AT(-18),
        tokens: { in: 45_200_000, out: 225_000 },
        error: "Tests failed\n2 failing",
        transcriptEvents: 3,
      }),
      attempt("a1", { step: "1", label: "Built TOOL-1", transcriptEvents: 2 }),
    ],
  });
  return { ...base, ...overrides };
}

const withActions = (run: RunDetail, actions: Partial<RunDetail["details"]["actions"]>) => ({
  ...run,
  details: { ...run.details, actions: { ...run.details.actions, ...actions } },
});

let detail: RunDetail;
let seen: SeenRequest[];
let transcripts: Record<string, (request: SeenRequest) => Response | Promise<Response>>;
let cancelAnswer: () => Response | Promise<Response>;
let retryAnswer: () => Response | Promise<Response>;

const transcriptPath = (attemptId: string) =>
  `/api/ui/runs/${RUN_ID}/attempts/${attemptId}/transcript`;

function serve() {
  seen = mockFetch({
    [`GET /api/ui/runs/${RUN_ID}`]: () => jsonResponse(detail),
    [`GET /api/ui/runs/${RUN_ID}/session`]: () => jsonResponse(runSession()),
    [`GET ${transcriptPath("a1")}`]: (r) => transcripts.a1!(r),
    [`GET ${transcriptPath("a2")}`]: (r) => transcripts.a2!(r),
    [`GET ${transcriptPath("a3")}`]: (r) => transcripts.a3!(r),
    [`GET ${transcriptPath("t1")}`]: (r) => transcripts.t1!(r),
    "POST /api/ui/jobs/a3/cancel": () => cancelAnswer(),
    [`POST /api/ui/runs/${RUN_ID}/retry`]: () => retryAnswer(),
  });
}

function renderRun(
  options: { search?: string; client?: QueryClient; live?: ReturnType<typeof fakeAbly> } = {},
) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = options.client ?? createTestQueryClient();
  const tree = () => (
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              <RunDetailView runId={RUN_ID} />
            </LiveProvider>
          ) : (
            <RunDetailView runId={RUN_ID} />
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

const panel = () => screen.getByRole("region", { name: "Selected step" });
const loaded = () => waitFor(() => panel());
const tab = (name: RegExp | string) => within(panel()).getByRole("tab", { name });
const transcriptRows = () =>
  within(within(panel()).getByRole("list", { name: "Transcript" })).getAllByRole("listitem");
const stepToolbar = () => within(panel()).getByRole("toolbar", { name: "Step actions" });
const runToolbar = () => screen.getByRole("toolbar", { name: "Run actions" });
const requestsTo = (path: string) => seen.filter((r) => r.path === path);
/** An element's text, with its badges' spacing collapsed. */
const text = (element: Element) => element.textContent!.replace(/\s+/g, " ").trim();
const lastReplace = () => String(nav.router.replace.mock.calls.at(-1)?.[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  detail = epic();
  transcripts = {
    a1: pagedTranscript(transcriptEvents(2)),
    a2: pagedTranscript(transcriptEvents(3)),
    a3: pagedTranscript(transcriptEvents(450)),
  };
  cancelAnswer = () =>
    jsonResponse({
      ok: true,
      warning: "Cancel requested: the agent stops the job with its next heartbeat.",
    });
  retryAnswer = () => jsonResponse({ ...detail, warning: null } satisfies RunRetryResult);
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StepPanel in the run detail", () => {
  it("shows under the selected step, inside the progress card", async () => {
    renderRun();
    await loaded();
    const step = panel().closest("li")!;
    expect(step.className).toContain("or-step--selected");
    expect(within(step).getByRole("button", { current: "step" }).textContent).toContain("Story 2");
    expect(panel().closest(".or-progress-card")).not.toBeNull();
  });

  it("has Transcript and Attempts {n} tabs, Transcript by default", async () => {
    renderRun();
    await loaded();
    const tabs = within(panel()).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Transcript", "Attempts2"]);
    expect(tab("Attempts, 2")).toBeTruthy();
    expect(tab("Transcript").getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the tab in the URL", async () => {
    const { navigate } = renderRun();
    await loaded();
    await userEvent.click(tab("Attempts, 2"));
    expect(lastReplace()).toBe(`/runs/${RUN_ID}?step=2&tab=attempts`);

    navigate("step=2&tab=attempts");
    await waitFor(() => expect(tab("Attempts, 2").getAttribute("aria-selected")).toBe("true"));
    expect(within(panel()).getByRole("list", { name: "Attempts" })).toBeTruthy();

    navigate("step=2&tab=nonsense");
    await waitFor(() => expect(tab("Transcript").getAttribute("aria-selected")).toBe("true"));
  });

  it("shows the latest attempt's first 8 events, then loads the rest page by page", async () => {
    renderRun();
    await waitFor(() => expect(transcriptRows()).toHaveLength(8));
    expect(transcriptRows()[1]!.textContent).toBe("0:05Bashcmd 1");
    expect(text(within(panel()).getByText(/more events/).parentElement!)).toBe(
      "442 more events · Show all",
    );
    expect(requestsTo(transcriptPath("a3")).map((r) => r.query.get("cursor"))).toEqual([null]);

    await userEvent.click(within(panel()).getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(transcriptRows()).toHaveLength(450));
    expect(requestsTo(transcriptPath("a3")).map((r) => r.query.get("cursor"))).toEqual([
      null,
      "c200",
      "c400",
    ]);
    expect(transcriptRows()[449]!.textContent).toBe("37:25Bashcmd 449");
    expect(within(panel()).queryByText(/more events/)).toBeNull();
  });

  it("shows the attempt the URL names, with its failed outcome above and its error last", async () => {
    renderRun({ search: "step=2&attempt=a2" });
    await waitFor(() => expect(transcriptRows()).toHaveLength(3));
    const outcome = panel().querySelector(".or-step-panel__outcome")!;
    expect(text(outcome)).toBe("Tried TOOL-2");
    expect(outcome.querySelector(".or-dot")!.getAttribute("aria-label")).toBe("Failed");
    const alert = within(panel()).getByRole("alert");
    expect(alert.textContent).toBe("Tests failed\n2 failing");
    expect(alert.parentElement!.lastElementChild).toBe(alert);
  });

  it("shows the story's last feedback above the transcript while its last attempt hasn't completed", async () => {
    renderRun();
    await loaded();
    const feedback = within(panel()).getByText(/CSV header is missing/);
    const transcript = await waitFor(() =>
      within(panel()).getByRole("list", { name: "Transcript" }),
    );
    expect(
      feedback.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(panel()).getByRole("heading", { name: "Last feedback" })).toBeTruthy();
  });

  it("shows no last feedback once the story's last attempt completed", async () => {
    const run = epic();
    detail = {
      ...run,
      steps: run.steps.map((step) =>
        step.id === "2" ? story(step, { status: "completed" }) : step,
      ),
      attempts: run.attempts.map((a) =>
        a.id === "a3" ? { ...a, status: "completed" as const, finishedAt: NOW_AT(-1) } : a,
      ),
    };
    renderRun({ search: "step=2" });
    await waitFor(() => expect(transcriptRows()).toHaveLength(8));
    expect(within(panel()).queryByText(/CSV header is missing/)).toBeNull();
  });

  it("lists the step's attempts newest first with outcome, agent, start, duration and tokens", async () => {
    renderRun({ search: "step=2&tab=attempts" });
    await loaded();
    const rows = within(within(panel()).getByRole("list", { name: "Attempts" })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(2);
    const [running, failed] = rows.map(text);
    expect(running).toContain("Building TOOL-2");
    expect(running).toContain("build-01");
    expect(running).toContain("10m");
    expect(running).toContain("8.4k in · 950 out");
    expect(failed).toContain("Tried TOOL-2");
    expect(failed).toContain("build-02");
    expect(failed).toContain("12m");
    expect(failed).toContain("45.2M in · 225k out");
    expect(failed).toContain("Tests failed");
    expect(rows[0]!.querySelector("time")!.getAttribute("dateTime")).toBe(START);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(
      within(rows[1]!)
        .getByRole("link", { name: /build-02/ })
        .getAttribute("href"),
    ).toBe("/fleet/agent-2");
  });

  it("shows an attempt's transcript when it is chosen", async () => {
    const { navigate } = renderRun({ search: "step=2&tab=attempts" });
    await loaded();
    const rows = within(within(panel()).getByRole("list", { name: "Attempts" })).getAllByRole(
      "listitem",
    );
    await userEvent.click(within(rows[1]!).getByRole("button", { name: "Show transcript" }));
    expect(lastReplace()).toBe(`/runs/${RUN_ID}?step=2&attempt=a2&tab=transcript`);
    navigate("step=2&attempt=a2&tab=transcript");
    await waitFor(() => expect(transcriptRows()).toHaveLength(3));
    expect(requestsTo(transcriptPath("a2"))).toHaveLength(1);
  });

  it("cancels a running attempt after a confirm, showing Cancel requested before the server answers", async () => {
    const held = deferred();
    cancelAnswer = () => held.promise;
    renderRun({ search: "step=2&tab=attempts" });
    await loaded();
    const list = () => within(panel()).getByRole("list", { name: "Attempts" });
    const [runningRow, failedRow] = within(list()).getAllByRole("listitem");
    expect(within(failedRow!).queryByRole("button", { name: "Cancel attempt" })).toBeNull();
    await userEvent.click(within(runningRow!).getByRole("button", { name: "Cancel attempt" }));
    const dialog = screen.getByRole("alertdialog", { name: "Cancel this attempt?" });
    expect(seen.some((r) => r.method === "POST")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel attempt" }));

    await waitFor(() => expect(text(list())).toContain("Cancel requested"));
    expect(requestsTo("/api/ui/jobs/a3/cancel")).toHaveLength(1);
    expect(within(list()).queryByRole("button", { name: "Cancel attempt" })).toBeNull();

    detail = {
      ...detail,
      attempts: detail.attempts.map((a) => (a.id === "a3" ? { ...a, cancelRequested: true } : a)),
    };
    await act(async () => {
      held.resolve(
        jsonResponse({
          ok: true,
          warning: "Cancel requested: the agent stops the job with its next heartbeat.",
        }),
      );
      await held.promise;
    });
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "Cancel requested: the agent stops the job with its next heartbeat.",
        { variant: "warning" },
      ),
    );
    expect(text(list())).toContain("Cancel requested");
  });

  it("puts a canceled attempt back when the cancel fails", async () => {
    const held = deferred();
    cancelAnswer = () => held.promise;
    renderRun({ search: "step=2&tab=attempts" });
    await loaded();
    const list = () => within(panel()).getByRole("list", { name: "Attempts" });
    await userEvent.click(within(list()).getAllByRole("button", { name: "Cancel attempt" })[0]!);
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel attempt" }),
    );
    await waitFor(() => expect(text(list())).toContain("Cancel requested"));
    await act(async () => {
      held.resolve(jsonResponse({ error: "That job has already finished." }, 400));
      await held.promise;
    });
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("That job has already finished.", {
        variant: "danger",
      }),
    );
    await waitFor(() => expect(text(list())).not.toContain("Cancel requested"));
    expect(within(list()).getByRole("button", { name: "Cancel attempt" })).toBeTruthy();
  });

  it("drops Cancel requested once the agent confirms the cancel", async () => {
    const run = epic();
    detail = {
      ...run,
      attempts: run.attempts.map((a) =>
        a.id === "a3" ? { ...a, status: "canceled", cancelRequested: true, finishedAt: START } : a,
      ),
    };
    renderRun({ search: "step=2&tab=attempts" });
    await loaded();
    const list = within(panel()).getByRole("list", { name: "Attempts" });
    const [canceledRow] = within(list).getAllByRole("listitem");
    expect(within(canceledRow!).getByRole("img", { name: "Canceled" })).toBeTruthy();
    expect(text(list)).not.toContain("Cancel requested");
    expect(within(list).queryByRole("button", { name: "Cancel attempt" })).toBeNull();
  });

  it("retries a failed story (Retry story) and shows it at once", async () => {
    const run = epic();
    detail = withActions(
      {
        ...run,
        status: "failed",
        steps: run.steps.map((s) => (s.id === "2" ? story(s, { status: "exhausted" }) : s)),
        attempts: run.attempts.filter((a) => a.id !== "a3"),
      },
      { retry: { run: true, storyIds: ["2"], attemptIds: ["a2"] } },
    );
    const held = deferred();
    retryAnswer = () => held.promise;
    renderRun({ search: "step=2" });
    await loaded();
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "Retry story" }));
    await waitFor(() => expect(screen.getByRole("status", { name: /Queued/ })).toBeTruthy());
    const retries = seen.filter((r) => r.path.endsWith("/retry"));
    expect(retries.map((r) => r.body)).toEqual([{ target: { kind: "story", storyId: "2" } }]);
    expect(
      screen
        .getByRole("button", { current: "step" })
        .querySelector(".or-dot")!
        .getAttribute("aria-label"),
    ).toMatch(/Running/i);
    expect(within(runToolbar()).getByRole("button", { name: "Retry run" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(stepToolbar()).getByRole("button", { name: "Retry story" })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => {
      held.resolve(jsonResponse({ ...detail, status: "queued", warning: null }));
      await held.promise;
    });
    await waitFor(() =>
      expect(within(stepToolbar()).getByRole("button", { name: "Retry story" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("re-runs a finished story of a finished epic (Re-run story)", async () => {
    const run = epic();
    detail = withActions(
      {
        ...run,
        status: "completed",
        steps: run.steps.map((s) => story(s, { status: "completed" })),
        attempts: run.attempts.map((a) => ({
          ...a,
          status: "completed" as const,
          finishedAt: NOW_AT(-1),
        })),
      },
      { stop: false, retry: { run: false, storyIds: ["1", "2", "3"], attemptIds: [] } },
    );
    renderRun({ search: "step=1" });
    await loaded();
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "Re-run story" }));
    await waitFor(() => expect(seen.some((r) => r.path.endsWith("/retry"))).toBe(true));
    expect(seen.find((r) => r.path.endsWith("/retry"))!.body).toEqual({
      target: { kind: "story", storyId: "1" },
    });
  });

  it("retries a request's failed turn (Retry attempt)", async () => {
    detail = withActions(
      runDetail(null, {
        id: RUN_ID,
        kind: "request",
        status: "failed",
        progress: null,
        steps: [
          {
            kind: "attempt",
            id: "t1",
            label: "Answered the request",
            status: "failed",
            durationMs: 60_000,
          },
        ],
        attempts: [
          attempt("t1", {
            step: "t1",
            status: "failed",
            label: "Answered the request",
            error: "The agent went offline.",
            transcriptEvents: 1,
          }),
        ],
      }),
      { stop: false, retry: { run: false, storyIds: [], attemptIds: ["t1"] } },
    );
    transcripts.t1 = pagedTranscript(transcriptEvents(1));
    renderRun();
    await loaded();
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "Retry attempt" }));
    await waitFor(() => expect(seen.some((r) => r.path.endsWith("/retry"))).toBe(true));
    expect(seen.find((r) => r.path.endsWith("/retry"))!.body).toEqual({
      target: { kind: "attempt", attemptId: "t1" },
    });
  });

  it("offers no retry while the step can't be retried", async () => {
    renderRun();
    await loaded();
    expect(within(stepToolbar()).queryByRole("button", { name: /Retry|Re-run/ })).toBeNull();
  });

  it("copies the step's link and its commit from the ⋯ menu", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderRun({ search: "kind=epic&step=1" });
    await loaded();
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "More actions" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy link", "Copy commit"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`http://localhost:3000/runs/${RUN_ID}?step=1`),
    );
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy commit" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("4f1c2ab9d0"));
  });

  it("offers no Copy commit for a story without a commit", async () => {
    renderRun({ search: "step=2" });
    await loaded();
    await userEvent.click(within(stepToolbar()).getByRole("button", { name: "More actions" }));
    expect(
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy link"]);
  });

  it("shows no raw job type and no keyboard-shortcut indicator", async () => {
    const { navigate } = renderRun();
    await waitFor(() => expect(transcriptRows()).toHaveLength(8));
    const check = () => {
      expect(panel().textContent).not.toContain("repo.sync");
      expect(panel().querySelector("kbd, [aria-keyshortcuts]")).toBeNull();
      for (const element of panel().querySelectorAll("[title], [aria-label]")) {
        expect(element.getAttribute("title") ?? "").not.toContain("repo.sync");
        expect(element.getAttribute("aria-label") ?? "").not.toContain("repo.sync");
      }
    };
    check();
    navigate("step=2&tab=attempts");
    await waitFor(() => within(panel()).getByRole("list", { name: "Attempts" }));
    check();
  });
});

describe("the live transcript", () => {
  const changes = `org:${TEST_ORGANIZATION_ID}:changes`;
  const transcriptEvent = () =>
    changeEvent(TEST_ORGANIZATION_ID, { resource: "transcript", runId: RUN_ID });

  it("refetches a running attempt's latest page on its run's transcript events and appends the new events", async () => {
    let events = transcriptEvents(3);
    transcripts.a3 = (r) => pagedTranscript(events)(r);
    detail = epic({
      attempts: epic().attempts.map((a) => (a.id === "a3" ? { ...a, transcriptEvents: 3 } : a)),
    });
    const live = fakeAbly();
    renderRun({ live });
    await waitFor(() => expect(transcriptRows()).toHaveLength(3));
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));

    events = transcriptEvents(5);
    act(() => live.current().deliver(changes, transcriptEvent()));
    await waitFor(() => expect(transcriptRows()).toHaveLength(5));
    const asked = requestsTo(transcriptPath("a3"));
    expect(asked).toHaveLength(2);
    expect(asked.every((r) => r.query.get("cursor") === null)).toBe(true);
  });

  it("refetches only from the last loaded page once the rest is loaded", async () => {
    let events = transcriptEvents(450);
    transcripts.a3 = (r) => pagedTranscript(events)(r);
    const live = fakeAbly();
    renderRun({ live });
    await waitFor(() => expect(transcriptRows()).toHaveLength(8));
    await userEvent.click(within(panel()).getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(transcriptRows()).toHaveLength(450));
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));

    events = transcriptEvents(452);
    act(() => live.current().deliver(changes, transcriptEvent()));
    await waitFor(() => expect(transcriptRows()).toHaveLength(452));
    expect(requestsTo(transcriptPath("a3")).map((r) => r.query.get("cursor"))).toEqual([
      null,
      "c200",
      "c400",
      "c400",
    ]);
    expect(transcriptRows()[451]!.textContent).toBe("37:35Bashcmd 451");
  });

  it("leaves a finished attempt's transcript alone", async () => {
    const live = fakeAbly();
    renderRun({ live, search: "step=2&attempt=a2" });
    await waitFor(() => expect(transcriptRows()).toHaveLength(3));
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));
    act(() => live.current().deliver(changes, transcriptEvent()));
    // The run's other queries refetch nothing for a transcript event either.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(requestsTo(transcriptPath("a2"))).toHaveLength(1);
  });

  it("sets no refetchInterval of its own", async () => {
    const client = createQueryClient();
    renderRun({ client });
    await waitFor(() => expect(transcriptRows()).toHaveLength(8));
    const fallback = client.getDefaultOptions().queries!.refetchInterval;
    const queries = client
      .getQueryCache()
      .findAll({ queryKey: [TEST_ORGANIZATION_ID, "transcripts"] });
    expect(queries).toHaveLength(1);
    for (const query of queries) {
      expect(query.observers.length).toBeGreaterThan(0);
      for (const observer of query.observers) {
        expect(observer.options.refetchInterval).toBe(fallback);
      }
    }
    client.clear();
  });
});

describe("StepPanel tabs", () => {
  it("takes the tabs other screens register, between Transcript and Attempts", async () => {
    const onNavigate = vi.fn();
    const run = epic();
    const step = run.steps[1]!;
    const view = (tab: string | null) => (
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            <StepPanel
              run={run}
              step={step}
              tab={tab}
              attemptId={null}
              onNavigate={onNavigate}
              stepHref={`/runs/${RUN_ID}?step=2`}
              tabs={[
                { value: "diff", label: "Diff", content: <p>The story&apos;s diff</p> },
                { value: "findings", label: "Findings", count: 4, content: <p>Findings</p> },
              ]}
            />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>
    );
    const { rerender } = render(view(null));
    expect(
      within(panel())
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Transcript", "Diff", "Findings4", "Attempts2"]);
    await userEvent.click(tab("Diff"));
    expect(onNavigate).toHaveBeenCalledWith({ tab: "diff" });
    rerender(view("diff"));
    expect(within(panel()).getByRole("tabpanel").textContent).toBe("The story's diff");
  });
});
