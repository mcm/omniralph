// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
} from "@/components/query-test-utils";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { workItemRow } from "./test-fixtures";
import { WORK_ITEM_NOT_FOUND, WorkItemDetailView } from "./work-item-detail-view";

vi.mock("next/navigation", () => ({
  usePathname: () => "/backlog/linear-issue-413",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink(props: LinkProps) {
  return <a {...props} />;
}

const ID = "linear-issue-413";

function workItem(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    ...workItemRow({ id: ID, identifier: "SOC-413", title: "Send invoice reminders" }),
    blocked: true,
    state: { category: "todo", name: "Todo" },
    description: "## Introduction\n\nRemind customers.\n",
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [
      {
        identifier: "SOC-398",
        url: "https://linear.app/acme/issue/SOC-398",
        backlogId: "linear-issue-398",
      },
    ],
    route: {
      outcome: "repository",
      repository: { id: "repo-1", provider: "github", fullPath: "acme/web" },
      via: { kind: "team", label: "SOC team" },
      by: "work item match (SOC team)",
    },
    stories: [],
    activity: [],
    triageRunning: false,
    run: null,
    actions: {
      start: true,
      triage: true,
      editPrd: true,
      changeRepo: true,
      move: true,
      cancel: true,
    },
    ...overrides,
  };
}

function renderDetail(user: SessionUser = testUser) {
  return render(
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider linkComponent={TestLink}>
          <WorkItemDetailView workItemId={ID} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

let detail: Response | (() => Response);

beforeEach(() => {
  detail = jsonResponse(workItem());
  mockFetch({
    [`GET /api/ui/work-items/${ID}`]: () => (typeof detail === "function" ? detail() : detail),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkItemDetailView", () => {
  it("shows the identifier and size, the title, Blocked by and the PRD from one fetch", async () => {
    renderDetail();
    const title = await screen.findByRole("heading", { level: 2, name: "Send invoice reminders" });
    const article = title.closest("article")!;
    const bar = article.querySelector(".or-backlog-detail__bar") as HTMLElement;
    expect(within(bar).getByText("SOC-413")).toBeTruthy();
    expect(within(bar).getByRole("img", { name: "Size M" })).toBeTruthy();
    expect(within(bar).queryByText("Acme")).toBeNull();
    const blockedBy = within(article).getByText("Blocked by").parentElement!;
    expect(within(blockedBy).getByRole("link").getAttribute("href")).toBe(
      "/backlog/linear-issue-398",
    );
    await waitFor(() => expect(within(article).getByText("Remind customers.")).toBeTruthy());
  });

  it("adds the organization under All organizations", async () => {
    renderDetail({ ...testUser, scope: "all" });
    const title = await screen.findByRole("heading", { level: 2 });
    expect(
      within(
        title.closest("article")!.querySelector(".or-backlog-detail__bar") as HTMLElement,
      ).getByText("Acme"),
    ).toBeTruthy();
  });

  it("says when the item doesn't exist", async () => {
    detail = () => jsonResponse({ error: "Not found." }, 404);
    renderDetail();
    expect(await screen.findByRole("heading", { name: WORK_ITEM_NOT_FOUND })).toBeTruthy();
  });
});
