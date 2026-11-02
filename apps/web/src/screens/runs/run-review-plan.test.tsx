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
import { reviewRunDetail } from "@/components/runs/test-fixtures";
import type {
  ReviewCheck,
  ReviewCheckPass,
  RunDetail,
  RunFindings,
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
      }}
    />
  );
}

const RUN_ID = runRow().id;
const NO_FINDINGS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

function pass(number: number, files: string[], counts: Partial<ReviewCheckPass> = {}) {
  return {
    number,
    files,
    reported: 0,
    confirmed: 0,
    new: 0,
    dropped: 0,
    verification: "verified",
    unreached: 0,
    summary: null,
    ...counts,
  } satisfies ReviewCheckPass;
}

function checkStep(
  id: string,
  status: Extract<RunStep, { kind: "review_pass" }>["status"],
  check: Partial<ReviewCheck> & Pick<ReviewCheck, "type">,
): RunStep {
  return {
    kind: "review_pass",
    id,
    taskName: "Review a pull request",
    status,
    tokens: { in: 0, out: 0 },
    durationMs: null,
    openFindings: NO_FINDINGS,
    check: { files: [], passes: [], droppedFindings: 0, current: null, error: null, ...check },
  };
}

/**
 * A looped review: security ran two passes and is verifying its third, stability finished in
 * one, performance hasn't started.
 */
function looped(): RunDetail {
  return {
    ...reviewRunDetail({ id: RUN_ID }),
    status: "running",
    steps: [
      checkStep("security", "running", {
        type: "security",
        files: ["src/auth/login.ts", "src/auth/session.ts"],
        passes: [
          pass(1, ["src/auth/login.ts", "src/auth/session.ts"], {
            reported: 4,
            confirmed: 3,
            new: 3,
            dropped: 1,
          }),
          pass(2, ["src/auth/session.ts"], { reported: 3, confirmed: 2, new: 1, dropped: 1 }),
        ],
        droppedFindings: 2,
        current: { number: 3, phase: "verifying" },
      }),
      checkStep("stability", "completed", {
        type: "stability",
        files: ["src/auth/login.ts", "README.md"],
        passes: [
          pass(1, ["src/auth/login.ts", "README.md"], { reported: 1, confirmed: 1, new: 1 }),
        ],
      }),
      checkStep("performance", "queued", { type: "performance" }),
    ],
    attempts: [],
  };
}

let detail: RunDetail;
let seen: SeenRequest[];

const DETAIL_PATH = `/api/ui/runs/${RUN_ID}`;

function serve() {
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`GET ${DETAIL_PATH}/findings`]: () =>
      jsonResponse({
        passes: detail.steps.flatMap((step) =>
          step.kind === "review_pass"
            ? [{ id: step.id, status: step.status, files: [], findingCount: 0, skippedFiles: [] }]
            : [],
        ),
      } satisfies RunFindings),
    [`GET ${DETAIL_PATH}/attempts/r1/transcript`]: () =>
      jsonResponse({ events: [], nextCursor: null } satisfies TranscriptPageView),
  });
}

function renderRun(options: { search?: string; live?: ReturnType<typeof fakeAbly> } = {}) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = createTestQueryClient();
  const view = <RunDetailView runId={RUN_ID} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
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

const plan = () => screen.getByRole("region", { name: "Plan" });
const checkType = (name: string) =>
  within(within(plan()).getByRole("list", { name: "Check types" })).getByRole("listitem", {
    name,
  });
const passes = (name: string) => {
  const list = within(checkType(name)).queryByRole("list", { name: `${name} passes` });
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    : [];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  detail = looped();
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a looped review's Plan", () => {
  it("lists each check type with its state and file count, expandable to the paths", async () => {
    renderRun();
    await waitFor(() => plan());
    expect(
      within(plan())
        .getAllByRole("listitem")
        .filter((item) => item.parentElement?.getAttribute("aria-label") === "Check types")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Security", "Stability", "Performance"]);
    expect(checkType("Security").querySelector(".or-verdict__state")?.textContent).toBe("Running");
    expect(checkType("Stability").querySelector(".or-verdict__state")?.textContent).toBe("Done");
    expect(checkType("Performance").querySelector(".or-verdict__state")?.textContent).toBe(
      "Queued",
    );
    // Performance hasn't planned its files yet.
    expect(checkType("Performance").textContent).toContain(
      "Its files show when its first pass finishes.",
    );

    const files = checkType("Security").querySelector("details")!;
    expect(files.open).toBe(false);
    expect(within(files).getByText("2 files")).toBeTruthy();
    await userEvent.click(within(files).getByText("2 files"));
    expect(files.open).toBe(true);
    expect([...files.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "src/auth/login.ts",
      "src/auth/session.ts",
    ]);
  });

  it("shows each check type's passes in order with new, confirmed and dropped findings", async () => {
    renderRun();
    await waitFor(() => plan());
    expect(passes("Security")).toEqual([
      "Pass 13 new · 3 confirmed · 1 dropped by verification",
      "Pass 21 new · 2 confirmed · 1 dropped by verification",
      "Pass 3Verifying its findings",
    ]);
    expect(passes("Stability")).toEqual(["Pass 11 new · 1 confirmed · 0 dropped by verification"]);
    expect(passes("Performance")).toEqual([]);
  });

  it("totals the review's findings, including those verification dropped", async () => {
    renderRun();
    await waitFor(() => plan());
    expect(plan().querySelector(".or-review-plan__totals")?.textContent).toBe(
      "3 check types over 3 files: 5 confirmed findings, 2 dropped by verification.",
    );
  });

  it("names each step by its check type, and its Findings tab says what verification dropped", async () => {
    renderRun({ search: "step=security&tab=findings" });
    await waitFor(() => plan());
    const progress = screen.getByRole("region", { name: "Review passes" });
    expect(within(progress).getByText("Security")).toBeTruthy();
    expect(within(progress).getByText("Performance")).toBeTruthy();
    const panel = screen.getByRole("region", { name: "Selected step" });
    await waitFor(() =>
      expect(panel.textContent).toContain(
        "Verification dropped 2 findings, so they aren't shown or posted.",
      ),
    );
  });

  it("shows a partly failed review: the failed check type, why, and the others' passes", async () => {
    detail = {
      ...looped(),
      status: "completed",
      steps: [
        checkStep("security", "failed", {
          type: "security",
          error: "The review pass failed: the agent ran out of time.",
        }),
        checkStep("stability", "completed", {
          type: "stability",
          files: ["src/auth/login.ts"],
          passes: [
            pass(1, ["src/auth/login.ts"], {
              reported: 2,
              confirmed: 2,
              new: 2,
              verification: "unverified",
            }),
          ],
        }),
        checkStep("compatibility", "skipped", {
          type: "compatibility",
          error: "The change has no file for the compatibility check type.",
        }),
      ],
    };
    renderRun();
    await waitFor(() => plan());
    const security = checkType("Security");
    expect(security.querySelector(".or-verdict__state")?.textContent).toBe("Failed");
    expect(security.textContent).toContain("The review pass failed: the agent ran out of time.");
    expect(security.textContent).toContain("No files.");
    expect(passes("Security")).toEqual([]);

    expect(checkType("Stability").textContent).toContain(
      "Not verified: the verifier failed, so its findings were kept.",
    );
    const compatibility = checkType("Compatibility");
    expect(compatibility.querySelector(".or-verdict__state")?.textContent).toBe("Skipped");
    expect(compatibility.textContent).toContain(
      "The change has no file for the compatibility check type.",
    );
    expect(plan().querySelector(".or-review-plan__totals")?.textContent).toBe(
      "3 check types over 1 file: 2 confirmed findings, 0 dropped by verification.",
    );
  });

  it("updates live as the review's passes settle", async () => {
    const live = fakeAbly();
    const changes = `org:${TEST_ORGANIZATION_ID}:changes`;
    renderRun({ live });
    await waitFor(() => plan());
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));
    const detailRequests = () => seen.filter((r) => r.path === DETAIL_PATH).length;
    const before = detailRequests();

    const next = looped();
    next.steps[0] = checkStep("security", "completed", {
      type: "security",
      files: ["src/auth/login.ts", "src/auth/session.ts"],
      passes: [
        ...(next.steps[0] as Extract<RunStep, { kind: "review_pass" }>).check!.passes,
        pass(3, ["src/auth/session.ts"], { reported: 1, confirmed: 0, new: 0, dropped: 1 }),
      ],
      droppedFindings: 3,
    });
    detail = next;
    act(() =>
      live
        .current()
        .deliver(changes, changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID })),
    );
    await waitFor(() => expect(detailRequests()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(passes("Security").at(-1)).toBe(
        "Pass 30 new · 0 confirmed · 1 dropped by verification",
      ),
    );
    expect(checkType("Security").querySelector(".or-verdict__state")?.textContent).toBe("Done");
    expect(plan().querySelector(".or-review-plan__totals")?.textContent).toContain(
      "3 dropped by verification",
    );
  });
});

describe("a single-pass review", () => {
  it("has no Plan, and names its passes by their task as before", async () => {
    detail = reviewRunDetail({ id: RUN_ID });
    renderRun({ search: "step=pass-1&tab=findings" });
    const progress = await waitFor(() => screen.getByRole("region", { name: "Review passes" }));
    expect(screen.queryByRole("region", { name: "Plan" })).toBeNull();
    expect(within(progress).getByText("Security")).toBeTruthy();
    expect(within(progress).getByText("Correctness")).toBeTruthy();
    const panel = screen.getByRole("region", { name: "Selected step" });
    await waitFor(() => expect(panel.textContent).toContain("Om found nothing to report."));
    expect(panel.textContent).not.toContain("Verification dropped");
  });
});
