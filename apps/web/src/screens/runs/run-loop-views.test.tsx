// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
} from "@/components/query-test-utils";
import {
  attempt,
  epicRunDetail,
  NOW_AT,
  reviewRunDetail,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import type {
  AttemptVerification,
  RunDetail,
  RunIterationView,
  RunStep,
  TranscriptPageView,
} from "@/lib/api/runs";
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

const RUN_ID = runRow().id;
const MINUTE = 60_000;
const DETAIL_PATH = `/api/ui/runs/${RUN_ID}`;
const emptyTranscript = () =>
  jsonResponse({ events: [], nextCursor: null } satisfies TranscriptPageView);

const REJECTED: AttemptVerification = {
  status: "rejected",
  criteria: [
    { criterion: "Exports a CSV", accepted: true, reason: "src/export.ts writes it." },
    { criterion: "Has a header row", accepted: false, reason: "No header is written." },
  ],
  summary: "One criterion isn't met.",
  error: null,
  verifierAttemptId: "v1",
};

const ACCEPTED: AttemptVerification = {
  status: "accepted",
  criteria: [
    { criterion: "Exports a CSV", accepted: true, reason: "src/export.ts writes it." },
    { criterion: "Has a header row", accepted: true, reason: "export.test.ts checks it." },
  ],
  summary: "Both criteria are met.",
  error: null,
  verifierAttemptId: "v2",
};

type AuditStep = Extract<RunStep, { kind: "audit" }>;
type StoryStep = Extract<RunStep, { kind: "story" }>;

/** Story 1, built in two attempts. */
const builtStory = (): StoryStep => ({
  ...(storyStep("1", "completed", 13 * MINUTE) as StoryStep),
  attempts: 2,
});

function auditStep(overrides: Partial<AuditStep> = {}): AuditStep {
  return {
    kind: "audit",
    id: "audit-1",
    round: 1,
    status: "gaps",
    requirements: [
      {
        id: "FR-1",
        text: "Users can export invoices",
        status: "met",
        evidence: "src/export.ts and export.test.ts",
        missing: "",
      },
      {
        id: "FR-2",
        text: "Exports are emailed",
        status: "gap",
        evidence: "Looked in src/mail.ts",
        missing: "Nothing sends the export",
      },
    ],
    summary: "One requirement is missing.",
    error: null,
    filed: [
      { tracker: "linear", identifier: "TOOL-9", url: "https://linear.app/acme/issue/TOOL-9" },
    ],
    durationMs: 2 * MINUTE,
    ...overrides,
  };
}

/** A finished epic: story 1 sent back once then accepted, and its audit round with a gap. */
function epic(overrides: Partial<RunDetail> = {}): RunDetail {
  return epicRunDetail({
    id: RUN_ID,
    status: "running",
    steps: [builtStory(), auditStep(), storyStep("9", "pending")],
    attempts: [
      attempt("au1", { step: "audit-1", label: "Audited TOOL-42" }),
      attempt("v2", { step: "1", label: "Verified TOOL-1" }),
      attempt("a2", { step: "1", label: "Built TOOL-1", verification: ACCEPTED }),
      attempt("v1", { step: "1", label: "Verified TOOL-1" }),
      attempt("a1", { step: "1", label: "Built TOOL-1", verification: REJECTED }),
    ],
    ...overrides,
  });
}

function iteration(number: number, overrides: Partial<RunIterationView> = {}): RunIterationView {
  return {
    id: `it-${number}`,
    number,
    status: "done",
    verdict: "continue",
    summary: `Iteration ${number} summary`,
    findings: [],
    metric: null,
    error: null,
    outcome: null,
    maxIterations: 3,
    workerAttemptId: `w${number}`,
    verifierAttemptId: `c${number}`,
    createdAt: NOW_AT(-30 + number),
    verifyingAt: NOW_AT(-29 + number),
    finishedAt: NOW_AT(-28 + number),
    ...overrides,
  };
}

/** A looped review on its second iteration. */
function loopedReview(iterations: RunIterationView[]): RunDetail {
  return reviewRunDetail({ id: RUN_ID, steps: [], attempts: [], iterations });
}

let detail: RunDetail;

function serve() {
  return mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`GET ${DETAIL_PATH}/session`]: () => jsonResponse(runSession()),
    ...Object.fromEntries(
      ["a1", "a2", "v1", "v2", "au1"].map((id) => [
        `GET ${DETAIL_PATH}/attempts/${id}/transcript`,
        emptyTranscript,
      ]),
    ),
  });
}

function renderRun(options: { search?: string; live?: ReturnType<typeof fakeAbly> } = {}) {
  nav.search = new URLSearchParams(options.search ?? "");
  const view = <RunDetailView runId={RUN_ID} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              {view}
            </LiveProvider>
          ) : (
            view
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const loaded = () => screen.findByRole("heading", { level: 2, name: detail.title });

async function deliverRunChange(live: ReturnType<typeof fakeAbly>) {
  await waitFor(() =>
    expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
  );
  act(() =>
    live
      .current()
      .deliver(
        `org:${TEST_ORGANIZATION_ID}:changes`,
        changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID }),
      ),
  );
}

/** The verdicts in a container, as "criterion: Accepted|Rejected — reason". */
function criteria(container: HTMLElement) {
  return within(within(container).getByRole("list", { name: "Acceptance criteria" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  detail = epic();
  serve();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a task's verifier verdicts", () => {
  it("show on each attempt: accepted, or rejected with the reason", async () => {
    renderRun({ search: "step=1&tab=attempts" });
    await loaded();
    const attempts = screen.getByRole("list", { name: "Attempts" });
    const [, built2, , built1] = within(attempts)
      .getAllByRole("listitem")
      .filter((item) => item.classList.contains("or-attempt"));

    const accepted = within(built2!).getByRole("region", { name: "Verifier's verdict" });
    expect(accepted.textContent).toContain("The verifier accepted all 2 acceptance criteria");
    expect(criteria(accepted)).toEqual([
      "Exports a CSVAcceptedsrc/export.ts writes it.",
      "Has a header rowAcceptedexport.test.ts checks it.",
    ]);

    const rejected = within(built1!).getByRole("region", { name: "Verifier's verdict" });
    expect(rejected.textContent).toContain("The verifier sent it back: 1 of 2 criteria not met");
    expect(rejected.textContent).toContain("One criterion isn't met.");
    expect(criteria(rejected)).toEqual([
      "Exports a CSVAcceptedsrc/export.ts writes it.",
      "Has a header rowRejectedNo header is written.",
    ]);
    // The verifier's own attempts carry no verdict.
    expect(attempts.querySelectorAll(".or-verdict")).toHaveLength(2);
  });

  it("shows above the shown attempt's transcript", async () => {
    renderRun({ search: "step=1&attempt=a1" });
    await loaded();
    const verdict = await screen.findByRole("region", { name: "Verifier's verdict" });
    expect(verdict.textContent).toContain("The verifier sent it back");
    expect(criteria(verdict)[1]).toContain("No header is written.");
  });

  it("updates live as the verifier answers", async () => {
    const live = fakeAbly();
    detail = epic({
      attempts: [
        attempt("v1", { step: "1", label: "Verifying TOOL-1", status: "running" }),
        attempt("a1", {
          step: "1",
          label: "Built TOOL-1",
          verification: { ...REJECTED, status: "running", criteria: [], summary: null },
        }),
      ],
    });
    renderRun({ search: "step=1&attempt=a1", live });
    await loaded();
    expect(
      (await screen.findByRole("region", { name: "Verifier's verdict" })).textContent,
    ).toContain("The verifier is checking its acceptance criteria");

    detail = epic();
    await deliverRunChange(live);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Verifier's verdict" }).textContent).toContain(
        "The verifier sent it back",
      ),
    );
  });
});

describe("an epic's audit", () => {
  it("is a step before the PR, opening on each requirement's evidence or gap", async () => {
    renderRun({ search: "step=audit-1" });
    await loaded();
    const step = screen
      .getAllByRole("button")
      .find((b) => b.classList.contains("or-step__button") && b.textContent?.includes("audit"));
    expect(step?.textContent).toContain("Epic audit");
    expect(step?.textContent).toContain("1 gap");
    expect(step?.getAttribute("aria-current")).toBe("step");

    // Requirements is the step's first tab, and open.
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs[0]).toContain("Requirements");
    const audit = screen.getByRole("region", { name: "Epic audit" });
    expect(audit.textContent).toContain("1 requirement isn't met yet: Om filed a task to close it");
    const requirements = within(
      within(audit).getByRole("list", { name: "Requirements" }),
    ).getAllByRole("listitem");
    expect(requirements.map((r) => r.textContent)).toEqual([
      "FR-1 Users can export invoicesMetEvidence: src/export.ts and export.test.ts",
      "FR-2 Exports are emailedGapEvidence: Looked in src/mail.tsMissing: Nothing sends the export",
    ]);
    expect(
      within(audit)
        .getByRole("link", { name: /TOOL-9/ })
        .getAttribute("href"),
    ).toBe("https://linear.app/acme/issue/TOOL-9");
  });

  it("says when every requirement is met, or the audit couldn't run", async () => {
    detail = epic({
      steps: [
        builtStory(),
        auditStep(),
        storyStep("9", "completed", MINUTE),
        auditStep({
          id: "audit-2",
          round: 2,
          status: "passed",
          requirements: auditStep().requirements.map((r) => ({ ...r, status: "met" })),
          filed: [],
          summary: null,
        }),
      ],
    });
    renderRun({ search: "step=audit-2" });
    await loaded();
    const audit = screen.getByRole("region", { name: "Epic audit" });
    expect(audit.textContent).toContain("Every requirement is met");
    expect(within(audit).queryByRole("link")).toBeNull();
    expect(
      screen.getAllByRole("button").some((b) => b.textContent?.includes("Epic audit, round 2")),
    ).toBe(true);
  });

  it("updates live from running to its findings", async () => {
    const live = fakeAbly();
    detail = epic({
      steps: [
        builtStory(),
        auditStep({ status: "running", requirements: [], filed: [], summary: null }),
      ],
    });
    renderRun({ search: "step=audit-1", live });
    await loaded();
    expect(screen.getByRole("region", { name: "Epic audit" }).textContent).toContain(
      "Om is checking each requirement against the code",
    );
    detail = epic();
    await deliverRunChange(live);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Epic audit" }).textContent).toContain(
        "Om filed a task",
      ),
    );
  });
});

describe("a looped run's iterations", () => {
  it("show in order with the verifier's summary, metric and how the loop ended", async () => {
    detail = loopedReview([
      iteration(1, {
        findings: ["Check the null case"],
        metric: { name: "score", value: 6, direction: "higher", target: 9 },
      }),
      iteration(2, {
        verdict: "converged",
        summary: "Everything is addressed.",
        metric: { name: "score", value: 9, direction: "higher", target: 9 },
        outcome: "converged",
      }),
    ]);
    renderRun();
    await loaded();
    const card = screen.getByRole("region", { name: "Iterations" });
    const items = within(within(card).getByRole("list", { name: "Iterations" }))
      .getAllByRole("listitem")
      .filter((item) => item.classList.contains("or-verdict__item"));
    expect(items.map((item) => item.querySelector(".or-verdict__name")!.textContent)).toEqual([
      "Iteration 1 of 3Sent back",
      "Iteration 2 of 3Converged",
    ]);
    expect(items[0]!.textContent).toContain("Iteration 1 summary");
    expect(items[0]!.textContent).toContain("score 6 (higher is better, target 9)");
    expect(items[0]!.textContent).toContain("Check the null case");
    expect(items[1]!.textContent).toContain("Everything is addressed.");
    expect(card.textContent).toContain("The verifier was satisfied after 2 iterations.");
  });

  it.each([
    [
      "max-iterations",
      "It stopped after 3 iterations, its limit, before the verifier was satisfied.",
    ],
    ["stalled", "It stopped after 3 iterations: the metric stopped improving."],
    ["failed", "It stopped after 3 iterations: the last one failed."],
  ] as const)("say the loop ended on %s", async (outcome, text) => {
    detail = loopedReview([
      iteration(1),
      iteration(2),
      iteration(3, {
        status: outcome === "failed" ? "failed" : "done",
        verdict: outcome === "failed" ? null : "continue",
        error: outcome === "failed" ? "The verifier's answer wasn't valid." : null,
        outcome,
      }),
    ]);
    renderRun();
    await loaded();
    const card = screen.getByRole("region", { name: "Iterations" });
    expect(card.textContent).toContain(text);
    if (outcome === "failed")
      expect(card.textContent).toContain("The verifier's answer wasn't valid.");
  });

  it("isn't shown for a run that doesn't loop", async () => {
    detail = loopedReview([]);
    renderRun();
    await loaded();
    expect(screen.queryByRole("region", { name: "Iterations" })).toBeNull();
  });

  it("updates live as iterations run", async () => {
    const live = fakeAbly();
    detail = loopedReview([iteration(1, { status: "verifying", verdict: null, summary: null })]);
    renderRun({ live });
    await loaded();
    const card = screen.getByRole("region", { name: "Iterations" });
    expect(card.textContent).toContain("Verifying");
    expect(card.textContent).not.toContain("The verifier was satisfied");

    detail = loopedReview([
      iteration(1, { findings: ["Fix the typo"] }),
      iteration(2, { verdict: "converged", outcome: "converged" }),
    ]);
    await deliverRunChange(live);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Iterations" }).textContent).toContain(
        "The verifier was satisfied after 2 iterations.",
      ),
    );
  });
});
