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
import { attempt, reviewRunDetail } from "@/components/runs/test-fixtures";
import type { ReviewFindingView, RunDetail, RunFindings, TranscriptPageView } from "@/lib/api/runs";
import { RunDetailView } from "./run-detail-view";
import { NOW, runRow } from "./test-fixtures";

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
const LATER_RUN = "7c0e3b52-41d8-4c8e-9c67-0a2f5f1d9e11";

/** A review run: pass-1 finished with three open findings, pass-2 is running. */
function review(): RunDetail {
  const base = reviewRunDetail({ id: RUN_ID });
  return {
    ...base,
    steps: base.steps.map((step) =>
      step.kind === "review_pass" && step.id === "pass-1"
        ? { ...step, openFindings: { critical: 1, high: 1, medium: 0, low: 1, info: 0 } }
        : step,
    ),
    attempts: [attempt("r1", { step: "pass-1", label: "Reviewed merge request !12" })],
  };
}

function finding(id: string, overrides: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id,
    startLine: 12,
    endLine: 14,
    severity: "high",
    category: "bug",
    title: `Finding ${id}`,
    body: "The total is never reset.",
    suggestion: null,
    confidence: 0.82,
    status: "open",
    supersededBy: null,
    feedback: [],
    ...overrides,
  };
}

function runFindings(): RunFindings {
  return {
    passes: [
      {
        id: "pass-1",
        status: "completed",
        files: [
          {
            path: "src/billing/total.ts",
            findings: [
              finding("f1", { severity: "critical", suggestion: "total = 0;" }),
              finding("f2", {
                startLine: 40,
                endLine: 40,
                status: "dismissed",
                feedback: [
                  {
                    id: "fb1",
                    source: "scm",
                    reason: "false_positive",
                    note: "Reset upstream.",
                    actor: "@alex",
                    createdAt: "2026-10-26T08:00:00.000Z",
                    restoredAt: null,
                    restoredBy: null,
                  },
                ],
              }),
            ],
          },
          {
            path: "src/api.ts",
            findings: [
              finding("f3", {
                severity: "low",
                status: "superseded",
                supersededBy: { runId: LATER_RUN, stepId: "pass-9", findingId: "f9" },
              }),
            ],
          },
        ],
        findingCount: 3,
        skippedFiles: [{ path: "dist/bundle.js", reason: "too_large" }],
      },
      { id: "pass-2", status: "running", files: [], findingCount: 0, skippedFiles: [] },
    ],
  };
}

let detail: RunDetail;
let seen: SeenRequest[];
let findingsAnswer: () => Response | Promise<Response>;

const DETAIL_PATH = `/api/ui/runs/${RUN_ID}`;
const FINDINGS_PATH = `${DETAIL_PATH}/findings`;
const emptyTranscript = () =>
  jsonResponse({ events: [], nextCursor: null } satisfies TranscriptPageView);

function serve() {
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`GET ${DETAIL_PATH}/attempts/r1/transcript`]: emptyTranscript,
    [`GET ${FINDINGS_PATH}`]: () => findingsAnswer(),
  });
}

function renderRun(options: { search?: string; live?: ReturnType<typeof fakeAbly> } = {}) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = createTestQueryClient();
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
    navigate: (search: string) => {
      nav.search = new URLSearchParams(search);
      utils.rerender(tree());
    },
  };
}

const panel = () => screen.getByRole("region", { name: "Selected step" });
const loaded = () => waitFor(() => panel());
const tabNames = () =>
  within(panel())
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
const file = (path: string) => within(panel()).getByRole("region", { name: path });
const requestsTo = (path: string) => seen.filter((r) => r.path === path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  detail = review();
  findingsAnswer = () => jsonResponse(runFindings());
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the step panel's Findings tab", () => {
  it("shows on review passes with their open findings' count, not on the correlation", async () => {
    const first = renderRun({ search: "step=pass-1" });
    await loaded();
    expect(tabNames()).toEqual(["Transcript", "Findings3", "Attempts1"]);
    first.unmount();

    renderRun({ search: "step=corr-1" });
    await loaded();
    expect(tabNames()).not.toContain(expect.stringContaining("Findings"));
  });

  it("loads the findings only when opened, and puts the tab in the URL", async () => {
    const { navigate } = renderRun({ search: "step=pass-1" });
    await loaded();
    expect(requestsTo(FINDINGS_PATH)).toHaveLength(0);

    await userEvent.click(within(panel()).getByRole("tab", { name: /Findings/ }));
    expect(String(nav.router.replace.mock.calls.at(-1)?.[0])).toContain("tab=findings");
    navigate("step=pass-1&tab=findings");
    await waitFor(() => file("src/billing/total.ts"));
    expect(requestsTo(FINDINGS_PATH)).toHaveLength(1);
  });

  it("shows a loading state, then the pass's findings grouped by file", async () => {
    const held = deferred();
    findingsAnswer = () => held.promise;
    renderRun({ search: "step=pass-1&tab=findings" });
    await loaded();
    await waitFor(() => within(panel()).getByTestId("findings-skeleton"));

    await act(async () => held.resolve(jsonResponse(runFindings())));
    const billing = await waitFor(() => file("src/billing/total.ts"));
    expect(billing.querySelector("h4")?.textContent).toContain("2 findings");
    const [first, second] = billing.querySelectorAll<HTMLElement>(".or-finding");
    expect(within(first!).getByRole("heading", { name: "Finding f1" })).toBeTruthy();
    expect(first!.textContent).toContain("Critical");
    expect(first!.textContent).toContain("L12–14");
    expect(
      [...first!.querySelectorAll(".or-finding__meta .or-ref")].map((b) => b.textContent),
    ).toEqual(["L12–14", "bug", "82% confidence"]);
    expect(first!.textContent).toContain("The total is never reset.");
    expect(first!.querySelector("pre")?.textContent).toBe("total = 0;");
    expect(first!.id).toBe("finding-f1");
    expect(first!.hasAttribute("data-inactive")).toBe(false);

    // A dismissed finding: its status and who dismissed it, why.
    expect(second!.hasAttribute("data-inactive")).toBe(true);
    expect(second!.textContent).toContain("L40");
    expect(second!.textContent).toContain("Dismissed");
    const dismissal = second!.querySelector(".or-finding__event")!;
    expect(dismissal.textContent).toContain("Dismissed by @alex");
    expect(dismissal.querySelector(".or-ref")?.textContent).toBe("False positive");
    expect(second!.textContent).toContain("Reset upstream.");
    expect(within(panel()).queryByTestId("findings-skeleton")).toBeNull();
    // Read-only: no feedback buttons.
    expect(within(billing).queryByRole("button")).toBeNull();
  });

  it("links a superseded finding to the later review's pass", async () => {
    renderRun({ search: "step=pass-1&tab=findings" });
    const api = await waitFor(() => file("src/api.ts"));
    expect(api.textContent).toContain("Superseded");
    expect(
      within(api).getByRole("link", { name: "a finding of a later review" }).getAttribute("href"),
    ).toBe(`/runs/${LATER_RUN}?step=pass-9&tab=findings#finding-f9`);
  });

  it("lists the files the pass skipped", async () => {
    renderRun({ search: "step=pass-1&tab=findings" });
    const skipped = await waitFor(() =>
      within(panel()).getByRole("region", { name: "Skipped files" }),
    );
    expect(skipped.textContent).toContain("1 file wasn't reviewed");
    expect(skipped.textContent).toContain("dist/bundle.js");
    expect(skipped.textContent).toContain("too large");
  });

  it("says when a running pass has no findings yet, and when a finished one found nothing", async () => {
    const first = renderRun({ search: "step=pass-2&tab=findings" });
    await waitFor(() =>
      expect(panel().textContent).toContain("Findings appear here when the pass finishes."),
    );
    first.unmount();

    const findings = runFindings();
    findings.passes[0] = { ...findings.passes[0]!, files: [], findingCount: 0, skippedFiles: [] };
    findingsAnswer = () => jsonResponse(findings);
    renderRun({ search: "step=pass-1&tab=findings" });
    await waitFor(() => expect(panel().textContent).toContain("Om found nothing to report."));
  });

  it("shows the server's reason when the findings fail, and retries", async () => {
    findingsAnswer = () => jsonResponse({ error: "Something broke." }, 500);
    renderRun({ search: "step=pass-1&tab=findings" });
    const alert = await waitFor(() => within(panel()).getByRole("alert"));
    expect(alert.textContent).toContain("Something broke.");

    findingsAnswer = () => jsonResponse(runFindings());
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => file("src/billing/total.ts"));
  });
});

describe("live findings", () => {
  const changes = `org:${TEST_ORGANIZATION_ID}:changes`;

  it("refetch on the run's change event (a pass finishing, a finding dismissed)", async () => {
    const live = fakeAbly();
    renderRun({ live, search: "step=pass-1&tab=findings" });
    await waitFor(() => file("src/billing/total.ts"));
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));
    expect(requestsTo(FINDINGS_PATH)).toHaveLength(1);

    const next = runFindings();
    next.passes[0]!.files[0]!.findings[0] = finding("f1", { status: "dismissed" });
    findingsAnswer = () => jsonResponse(next);
    act(() =>
      live
        .current()
        .deliver(changes, changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID })),
    );
    await waitFor(() => expect(requestsTo(FINDINGS_PATH)).toHaveLength(2));
    await waitFor(() =>
      expect(
        file("src/billing/total.ts").querySelector("#finding-f1")?.hasAttribute("data-inactive"),
      ).toBe(true),
    );
  });
});
