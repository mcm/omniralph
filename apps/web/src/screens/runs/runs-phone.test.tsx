// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import {
  attempt,
  epicRunDetail,
  NOW_AT,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import type { RunDetail, RunRetryResult, TranscriptPageView } from "@/lib/api/runs";
import { RunStepView, STEP_NOT_FOUND } from "./run-step-view";
import { RunsView } from "./runs-view";
import { FILTER_OPTIONS, NOW, REPO_PORTAL, runRow } from "./test-fixtures";

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

const RUN_ID = runRow().id;
const MINUTE = 60_000;
const START = NOW_AT(-10);
const FILTERS = `kind=epic&repository=${REPO_PORTAL}`;

type Event = TranscriptPageView["events"][number];

function transcriptEvents(n: number): Event[] {
  return Array.from({ length: n }, (_, index) => ({
    id: `ev-${index}`,
    type: "thought",
    body: `Thought ${index}`,
    parameter: null,
    at: new Date(Date.parse(START) + index * 5000).toISOString(),
  }));
}

/** A stopped epic on its second story, with a merge request, that Retry run can resume. */
function epic(): RunDetail {
  const base = epicRunDetail({
    id: RUN_ID,
    title: "Customer portal billing export",
    status: "stopped",
    pullRequest: { provider: "gitlab", number: 12, url: "https://gitlab.com/mr/12" },
    steps: [
      storyStep("1", "completed", 13 * MINUTE),
      storyStep("2", "exhausted", 5 * MINUTE),
      storyStep("3", "pending"),
    ],
    attempts: [
      attempt("a2", {
        step: "2",
        status: "failed",
        label: "Tried TOOL-2",
        startedAt: START,
        createdAt: START,
        error: "Tests failed",
        transcriptEvents: 3,
      }),
      attempt("a1", { step: "1", label: "Built TOOL-1", transcriptEvents: 2 }),
    ],
  });
  return {
    ...base,
    details: {
      ...base.details,
      actions: { stop: false, retry: { run: true, storyIds: ["2", "3"], attemptIds: [] } },
    },
  };
}

let detail: RunDetail;
let seen: SeenRequest[];
let retryAnswer: () => Response | Promise<Response>;

function serve() {
  seen = mockFetch({
    "GET /api/ui/runs": { runs: [runRow()], nextCursor: null },
    "GET /api/ui/runs/filter-options": FILTER_OPTIONS,
    [`GET /api/ui/runs/${RUN_ID}`]: () => jsonResponse(detail),
    [`GET /api/ui/runs/${RUN_ID}/session`]: () => jsonResponse(runSession()),
    [`GET /api/ui/runs/${RUN_ID}/attempts/a1/transcript`]: () =>
      jsonResponse({ events: transcriptEvents(2), nextCursor: null }),
    [`GET /api/ui/runs/${RUN_ID}/attempts/a2/transcript`]: () =>
      jsonResponse({ events: transcriptEvents(3), nextCursor: null }),
    [`POST /api/ui/runs/${RUN_ID}/retry`]: () => retryAnswer(),
  });
}

function renderWith(element: ReactNode, search = "") {
  nav.search = new URLSearchParams(search);
  const client = createTestQueryClient();
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>{element}</UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const split = (container: HTMLElement) => container.querySelector<HTMLElement>(".or-split")!;
const backLink = () => document.querySelector<HTMLAnchorElement>(".or-split__back");
const loadedDetail = () =>
  waitFor(() => screen.getByRole("heading", { level: 2, name: "Customer portal billing export" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  detail = epic();
  retryAnswer = () => jsonResponse({ ...detail, warning: null } satisfies RunRetryResult);
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Runs below SplitView's 880 px container width", () => {
  // jsdom measures every element at 0 px, so `useSplitWide` reports a narrow container.
  it("shows only the list on /runs, with no run open beside it", async () => {
    const { container } = renderWith(<RunsView />, FILTERS);
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0));
    expect(split(container).getAttribute("data-view")).toBe("list");
    // No first run is opened next to the rail: the detail pane stays empty.
    const pane = screen.getByRole("region", { name: "Run" });
    expect(pane.querySelector(".or-run-detail")).toBeNull();
    expect(seen.some((request) => request.path === `/api/ui/runs/${RUN_ID}`)).toBe(false);
  });

  it("shows only the detail on /runs/{id}, headed by ‹ Runs back to the list with its filters", async () => {
    const { container } = renderWith(<RunsView runId={RUN_ID} />, FILTERS);
    await loadedDetail();
    expect(split(container).getAttribute("data-view")).toBe("detail");
    const back = backLink()!;
    expect(back.textContent).toBe("‹ Runs");
    expect(back.getAttribute("href")).toBe(`/runs?${FILTERS}`);
    // The back link heads the detail pane.
    const pane = screen.getByRole("region", { name: "Run" });
    expect(pane.firstElementChild).toBe(back);
  });
});

describe("the run detail on phone", () => {
  it("gives each step a chevron link to its own view, with the URL's filters", async () => {
    renderWith(<RunsView runId={RUN_ID} />, `${FILTERS}&step=2`);
    await loadedDetail();
    const card = screen.getByRole("region", { name: "Stories" });
    expect(card.classList.contains("or-progress-card--step-links")).toBe(true);
    const chevrons = card.querySelectorAll<HTMLAnchorElement>(".or-step__open");
    expect([...chevrons].map((link) => link.getAttribute("href"))).toEqual(
      ["1", "2", "3"].map((id) => `/runs/${RUN_ID}/steps/${id}?${FILTERS}`),
    );
    expect(within(card).getByRole("link", { name: "Open Story 2" })).toBe(chevrons[1]);
    // The step panel is still rendered inline (CSS hides it on phone).
    expect(chevrons[1]!.nextElementSibling!.className).toBe("or-step__panel");
  });

  it("puts the chevron links beside the step buttons, never inside another control", async () => {
    renderWith(<RunsView runId={RUN_ID} />, FILTERS);
    await loadedDetail();
    for (const link of document.querySelectorAll(".or-step__open")) {
      expect(link.parentElement!.classList.contains("or-step")).toBe(true);
      expect(link.parentElement!.closest("a, button")).toBeNull();
      expect(link.querySelector("a, button")).toBeNull();
      expect(link.previousElementSibling!.tagName).toBe("BUTTON");
    }
  });

  it("keeps the toolbar's icon buttons and ⋯ menu, with Details and Session collapsed", async () => {
    renderWith(<RunsView runId={RUN_ID} />, FILTERS);
    await loadedDetail();
    const toolbar = screen.getByRole("toolbar", { name: "Run actions" });
    expect(within(toolbar).getByRole("link", { name: "Open merge request" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "Retry run" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "More actions" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Session")).toBeTruthy());
    const sections = [...document.querySelectorAll<HTMLDetailsElement>("details.or-more-info")];
    expect(
      sections.map((section) => section.querySelector("summary")!.textContent!.trim()),
    ).toEqual(["Details", "Session"]);
    expect(sections.every((section) => !section.open)).toBe(true);
  });
});

describe("the step page", () => {
  const renderStep = (stepId = "2", search = FILTERS) =>
    renderWith(<RunStepView runId={RUN_ID} stepId={stepId} />, search);
  const panel = () => screen.getByRole("region", { name: "Selected step" });

  it("shows ‹ {run title} back to the run, the step's state and the step panel at full width", async () => {
    const { container } = renderStep();
    const back = await screen.findByRole("link", { name: "Customer portal billing export" });
    expect(back.textContent).toBe("‹ Customer portal billing export");
    expect(back.getAttribute("href")).toBe(`/runs/${RUN_ID}?${FILTERS}&step=2`);
    const status = screen.getByRole("status", { name: "Story 2 · Failed" });
    expect(status.className).toContain("or-statusline--fail");
    expect(status.querySelector(".or-dot")!.getAttribute("aria-label")).toBe("Failed");
    // The panel fills the page: no split view, no progress card around it.
    expect(container.querySelector(".or-split")).toBeNull();
    expect(panel().closest(".or-progress-card")).toBeNull();
    expect(panel().parentElement!.classList.contains("or-run-step")).toBe(true);
  });

  it("has the tabs, the transcript, the attempts and the retry", async () => {
    renderStep();
    await waitFor(() => panel());
    const tabs = within(panel()).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Transcript", "Attempts1"]);
    await waitFor(() =>
      expect(
        within(within(panel()).getByRole("list", { name: "Transcript" })).getAllByRole("listitem"),
      ).toHaveLength(3),
    );
    const toolbar = within(panel()).getByRole("toolbar", { name: "Step actions" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Retry story" }));
    await waitFor(() =>
      expect(seen.find((request) => request.method === "POST")?.body).toEqual({
        target: { kind: "story", storyId: "2" },
      }),
    );
  });

  it("keeps the tab and attempt in the step page's URL, with the filters", async () => {
    renderStep();
    await waitFor(() => panel());
    await userEvent.click(within(panel()).getByRole("tab", { name: "Attempts, 1" }));
    expect(String(nav.router.replace.mock.calls.at(-1)?.[0])).toBe(
      `/runs/${RUN_ID}/steps/2?${FILTERS}&tab=attempts`,
    );
  });

  it("shows the attempts tab the URL names", async () => {
    renderStep("2", `${FILTERS}&tab=attempts`);
    await waitFor(() => panel());
    expect(within(panel()).getByRole("list", { name: "Attempts" })).toBeTruthy();
  });

  it("says when the run has no such step", async () => {
    renderStep("nope", "");
    expect(await screen.findByRole("heading", { name: STEP_NOT_FOUND })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Customer portal billing export" }).getAttribute("href"),
    ).toBe(`/runs/${RUN_ID}`);
  });
});

describe("phone CSS", () => {
  const read = (file: string) =>
    readFileSync(path.join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const surfaces = readFileSync(
    path.resolve(__dirname, "../../../../../packages/ui/styles/surfaces.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const phone = (css: string) =>
    css.match(/@media \(max-width: 768px\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/)?.[1] ?? "";
  const rule = (css: string, selector: string) =>
    css
      .replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "")
      .match(
        new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
      )?.[1] ?? "";

  it("shows the step chevrons and hides the inline step panel at 768 px and narrower only", () => {
    expect(rule(surfaces, ".or-step__open")).toMatch(/display:\s*none/);
    expect(phone(surfaces)).toMatch(/\.or-step__open\s*\{[^}]*display:\s*inline-flex/);
    expect(phone(surfaces)).toMatch(
      /\.or-progress-card--step-links \.or-step__panel\s*\{[^}]*display:\s*none/,
    );
  });

  it("wraps the filter buttons onto a second line instead of overflowing", () => {
    expect(rule(read("runs.css"), ".or-runs__filters")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("keeps the step page full width with only --or- tokens and or- classes", () => {
    const css = read("run-step.css");
    expect(rule(css, ".or-run-step")).toMatch(/width:\s*100%/);
    const tokens = Array.from(css.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
    const classes = Array.from(css.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
    expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\(/gi)).toBeNull();
  });
});
