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
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import { queryKeys } from "@/lib/api/keys";
import type { ReviewDetail } from "@/lib/api/reviews";
import type { FindingView, ReviewDetailView as ReviewView } from "@/lib/reviews/display";
import { ReviewDetailView } from "./review-detail-view";

const REVIEW_ID = "66666666-7777-4888-8999-000000000001";
const NEW_REVIEW_ID = "66666666-7777-4888-8999-000000000002";
const FINDING_ID = "77777777-8888-4999-8aaa-000000000001";

const nav = vi.hoisted(() => ({ router: { push: vi.fn(), refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "66666666-7777-4888-8999-000000000001" }),
  useRouter: () => nav.router,
  usePathname: () => "/reviews/66666666-7777-4888-8999-000000000001",
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function finding(overrides: Partial<FindingView> = {}): FindingView {
  return {
    id: FINDING_ID,
    startLine: 3,
    endLine: 4,
    severity: "high",
    category: "bug",
    title: "Null dereference",
    body: "`user` can be null here.",
    suggestion: null,
    confidence: 0.8,
    status: "open",
    supersededBy: null,
    feedback: [],
    ...overrides,
  };
}

function detail(overrides: Partial<ReviewView> = {}): ReviewDetail {
  const files = overrides.files ?? [{ path: "src/a.ts", findings: [finding()] }];
  return {
    review: {
      id: REVIEW_ID,
      repository: { id: "r-1", provider: "github", fullPath: "acme/api" },
      prNumber: 42,
      prTitle: "Add the cache",
      prUrl: "https://github.com/acme/api/pull/42",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      status: "completed",
      profileName: "Standard",
      model: null,
      agent: null,
      tokensIn: 100,
      tokensOut: 10,
      budget: 1000,
      durationMs: 5000,
      stopReason: "Completed",
      error: null,
      skippedFiles: [],
      newerReview: null,
      createdAt: "2026-10-16T09:00:00.000Z",
      updatedAt: "2026-10-16T09:05:00.000Z",
      ...overrides,
      files,
      findingCount: files.reduce((n, file) => n + file.findings.length, 0),
    },
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<ReviewDetailView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

const refetch = (client: ReturnType<typeof createTestQueryClient>) =>
  client.invalidateQueries({ queryKey: queryKeys(TEST_ORGANIZATION_ID).reviews.detail(REVIEW_ID) });

/** The finding's list item. */
function findingItem() {
  return document.getElementById(`finding-${FINDING_ID}`) as HTMLElement;
}

async function dismiss() {
  await userEvent.click(within(findingItem()).getByRole("button", { name: "Dismiss" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  nav.router.push.mockReset();
});

describe("ReviewDetailView", () => {
  it("shows a skeleton, then the review, and asks with the page it's on", async () => {
    const seen = mockFetch({ [`GET /api/ui/reviews/${REVIEW_ID}`]: detail() });
    renderView();
    expect(screen.getByLabelText("Loading the review")).toBeTruthy();
    expect(await screen.findByText("Null dereference")).toBeTruthy();
    expect(seen[0]!.query.get("next")).toBe("/");
    expect(document.querySelector(".freshness")).toBeTruthy();
  });

  it("shows the findings when the review completes", async () => {
    let current = detail({ status: "running", stopReason: null, durationMs: null, files: [] });
    mockFetch({ [`GET /api/ui/reviews/${REVIEW_ID}`]: () => jsonResponse(current) });
    const client = renderView();
    expect(await screen.findByText("Not finished yet")).toBeTruthy();
    expect(screen.getByText("Findings appear here when the review completes.")).toBeTruthy();

    current = detail();
    await refetch(client);
    expect(await screen.findByText("Null dereference")).toBeTruthy();
    expect(screen.queryByText("Not finished yet")).toBeNull();
    expect(screen.getByText("Findings")!.parentElement!.textContent).toContain("(1)");
  });

  it("dismisses a finding at once, before the server answers", async () => {
    let current = detail();
    let respond: () => void = () => {};
    const seen = mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: () => jsonResponse(current),
      [`POST /api/ui/findings/${FINDING_ID}/dismiss`]: async () => {
        await new Promise<void>((resolve) => (respond = resolve));
        current = detail({
          files: [{ path: "src/a.ts", findings: [finding({ status: "dismissed" })] }],
        });
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView();
    await screen.findByText("Null dereference");
    await dismiss();

    // Dismissed while the request is in flight, and through a poll of the old state.
    await waitFor(() => expect(within(findingItem()).getByText("Dismissed")).toBeTruthy());
    expect(within(findingItem()).getByRole("button", { name: "Restore" })).toBeTruthy();
    await refetch(client);
    expect(within(findingItem()).getByText("Dismissed")).toBeTruthy();
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({
      reason: "false_positive",
      note: "",
    });

    respond();
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(3),
    );
    expect(within(findingItem()).getByText("Dismissed")).toBeTruthy();
  });

  it("puts a finding back when the dismissal fails", async () => {
    let fail: () => void = () => {};
    mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: detail(),
      [`POST /api/ui/findings/${FINDING_ID}/dismiss`]: async () => {
        await new Promise<void>((resolve) => (fail = resolve));
        return jsonResponse({ error: "Only open findings can be dismissed." }, 400);
      },
    });
    renderView();
    await screen.findByText("Null dereference");
    await dismiss();
    await waitFor(() => expect(within(findingItem()).getByText("Dismissed")).toBeTruthy());

    fail();
    await waitFor(() =>
      expect(within(findingItem()).getByRole("button", { name: "Dismiss" })).toBeTruthy(),
    );
    expect(within(findingItem()).queryByText("Dismissed")).toBeNull();
  });

  it("restores a dismissed finding at once and rolls back on failure", async () => {
    let fail: () => void = () => {};
    mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: detail({
        files: [{ path: "src/a.ts", findings: [finding({ status: "dismissed" })] }],
      }),
      [`POST /api/ui/findings/${FINDING_ID}/restore`]: async () => {
        await new Promise<void>((resolve) => (fail = resolve));
        return jsonResponse({ error: "Only dismissed findings can be restored." }, 400);
      },
    });
    renderView("member");
    await screen.findByText("Null dereference");
    await userEvent.click(within(findingItem()).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(within(findingItem()).getByRole("button", { name: "Dismiss" })).toBeTruthy(),
    );

    fail();
    await waitFor(() =>
      expect(within(findingItem()).getByRole("button", { name: "Restore" })).toBeTruthy(),
    );
  });

  it("opens the new review after a re-run", async () => {
    const seen = mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: detail(),
      [`POST /api/ui/reviews/${REVIEW_ID}/rerun`]: {
        ok: true,
        reviewId: NEW_REVIEW_ID,
        active: false,
      },
    });
    renderView();
    await screen.findByText("Null dereference");
    await userEvent.click(screen.getByRole("button", { name: "Re-run" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Fresh"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-run" }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith(`/reviews/${NEW_REVIEW_ID}`));
    expect(seen.find((r) => r.method === "POST")!.body).toEqual({ mode: "fresh", profileId: null });
  });

  it("opens the review already running when a re-run finds one", async () => {
    mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: detail(),
      [`POST /api/ui/reviews/${REVIEW_ID}/rerun`]: {
        ok: true,
        reviewId: NEW_REVIEW_ID,
        active: true,
        message: "A review of aaaaaaaaaaaa is already queued or running.",
      },
    });
    renderView();
    await screen.findByText("Null dereference");
    await userEvent.click(screen.getByRole("button", { name: "Re-run" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-run" }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith(`/reviews/${NEW_REVIEW_ID}`));
  });

  it("links to the newer review of the PR, and offers members no Re-run", async () => {
    let current = detail();
    mockFetch({ [`GET /api/ui/reviews/${REVIEW_ID}`]: () => jsonResponse(current) });
    const client = renderView("member");
    await screen.findByText("Null dereference");
    expect(screen.queryByRole("link", { name: "Open the newer review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-run" })).toBeNull();

    current = detail({
      newerReview: { id: NEW_REVIEW_ID, status: "queued", createdAt: "2026-10-16T10:00:00.000Z" },
    });
    await refetch(client);
    const link = await screen.findByRole("link", { name: "Open the newer review" });
    expect(link.getAttribute("href")).toBe(`/reviews/${NEW_REVIEW_ID}`);
    expect(screen.getByText("A newer review is in progress")).toBeTruthy();
  });

  it("says what failed and retries", async () => {
    let fail = true;
    mockFetch({
      [`GET /api/ui/reviews/${REVIEW_ID}`]: () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(detail()),
    });
    renderView();
    expect(await screen.findByText("Couldn't load the review")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Null dereference")).toBeTruthy();
  });
});
