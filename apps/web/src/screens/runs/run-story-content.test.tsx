// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import { STORY_CONTENT_EMPTY, STORY_CONTENT_FAILED } from "@/components/runs/story-content";
import {
  attempt,
  epicRunDetail,
  reviewRunDetail,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import type { RunDetail, TranscriptPageView } from "@/lib/api/runs";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { storyDetail } from "@/screens/inbox/test-fixtures";
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

type StoryStep = Extract<RunDetail["steps"][number], { kind: "story" }>;

const RUN_ID = runRow().id;
const MINUTE = 60_000;
const ITEM_ID = "linear-issue-tool-42";
const ITEM_PATH = `/api/ui/work-items/${ITEM_ID}`;
const DETAIL_PATH = `/api/ui/runs/${RUN_ID}`;

/** An epic (TOOL-42) of two stories, TOOL-1 and TOOL-2. */
function epic(overrides: Partial<RunDetail> = {}): RunDetail {
  return epicRunDetail({
    id: RUN_ID,
    steps: [storyStep("1", "completed", 13 * MINUTE), storyStep("2", "running", 5 * MINUTE)],
    attempts: [
      attempt("a2", { step: "2", status: "running", finishedAt: null, transcriptEvents: 0 }),
      attempt("a1", { step: "1", label: "Built TOOL-1", transcriptEvents: 0 }),
    ],
    ...overrides,
  });
}

/** TOOL-42's detail: TOOL-1 with content, TOOL-2 without. */
function workItem(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const story = { state: null, url: null, manual: false };
  return storyDetail({
    id: ITEM_ID,
    identifier: "TOOL-42",
    description: "The epic's **PRD**.",
    stories: [
      {
        ...story,
        identifier: "TOOL-1",
        title: "Story 1",
        content: "As a user, I want **the export**.\n\n## Acceptance Criteria\n\n- [ ] CSV",
      },
      { ...story, identifier: "TOOL-2", title: "Story 2", content: "  " },
    ],
    ...overrides,
  });
}

let detail: RunDetail;
let seen: SeenRequest[];
let itemAnswer: () => Response | Promise<Response>;

const emptyTranscript = () =>
  jsonResponse({ events: [], nextCursor: null } satisfies TranscriptPageView);

function renderRun(search: string) {
  nav.search = new URLSearchParams(search);
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider linkComponent={TestLink}>
          <RunDetailView runId={RUN_ID} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const panel = () => screen.getByRole("region", { name: "Selected step" });
const loaded = () => waitFor(() => panel());
const tabNames = () =>
  within(panel())
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
const storyPanel = () => within(panel()).getByRole("tabpanel", { name: "Story" });
const itemFetches = () => seen.filter((r) => r.path === ITEM_PATH).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  detail = epic();
  itemAnswer = () => jsonResponse(workItem());
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`GET ${DETAIL_PATH}/session`]: () => jsonResponse(runSession()),
    [`GET ${DETAIL_PATH}/attempts/a1/transcript`]: emptyTranscript,
    [`GET ${DETAIL_PATH}/attempts/a2/transcript`]: emptyTranscript,
    [`GET ${DETAIL_PATH}/attempts/r1/transcript`]: emptyTranscript,
    [`GET ${ITEM_PATH}`]: () => itemAnswer(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the step panel's Story tab", () => {
  it("shows right after Transcript for an epic run's story", async () => {
    renderRun("step=2");
    await loaded();
    expect(tabNames()).toEqual(["Transcript", "Story", "Attempts1"]);
  });

  it("doesn't show on a run without a work item, or on a review run", async () => {
    detail = epic({ workItem: null });
    const first = renderRun("step=2");
    await loaded();
    expect(tabNames()).not.toContain("Story");
    first.unmount();

    detail = { ...reviewRunDetail(), id: RUN_ID };
    renderRun("");
    await loaded();
    expect(tabNames()).not.toContain("Story");
  });

  it("loads the work item only when opened, and puts the tab in the URL", async () => {
    renderRun("step=1");
    await loaded();
    expect(itemFetches()).toBe(0);
    await userEvent.click(within(panel()).getByRole("tab", { name: "Story" }));
    expect(String(nav.router.replace.mock.calls.at(-1)?.[0])).toContain("tab=story");
  });

  it("shows a skeleton while it loads, then the story's content as Markdown", async () => {
    const held = deferred();
    itemAnswer = () => held.promise;
    renderRun("step=1&tab=story");
    await loaded();
    await waitFor(() => within(storyPanel()).getByTestId("story-skeleton"));

    await act(async () => held.resolve(jsonResponse(workItem())));
    await waitFor(() =>
      expect(within(storyPanel()).getByText("the export").tagName).toBe("STRONG"),
    );
    expect(within(storyPanel()).getByRole("heading", { name: "Acceptance Criteria" })).toBeTruthy();
    // Not behind a disclosure: the tab is one.
    expect(storyPanel().querySelector("details")).toBeNull();
    expect(within(storyPanel()).queryByTestId("story-skeleton")).toBeNull();
    expect(itemFetches()).toBe(1);
  });

  it("says so when the story's content is empty, or the work item doesn't list it", async () => {
    const first = renderRun("step=2&tab=story");
    await waitFor(() => within(storyPanel()).getByText(STORY_CONTENT_EMPTY));
    first.unmount();

    itemAnswer = () => jsonResponse(workItem({ stories: [] }));
    renderRun("step=1&tab=story");
    await waitFor(() => within(storyPanel()).getByText(STORY_CONTENT_EMPTY));
  });

  it("shows the work item's description for a single issue's step, the item itself", async () => {
    detail = epic({
      steps: [
        {
          ...(storyStep("1", "running", 5 * MINUTE) as StoryStep),
          workItem: { tracker: "linear", identifier: "TOOL-42", url: null },
        },
      ],
    });
    itemAnswer = () => jsonResponse(workItem({ stories: [] }));
    renderRun("step=1&tab=story");
    await waitFor(() => expect(within(storyPanel()).getByText("PRD").tagName).toBe("STRONG"));
  });

  it("says it couldn't load the story when the work item fails, and retries", async () => {
    itemAnswer = () => jsonResponse({ error: "Boom" }, 500);
    renderRun("step=1&tab=story");
    const alert = await waitFor(() => within(storyPanel()).getByRole("alert"));
    expect(alert.textContent).toContain(STORY_CONTENT_FAILED);

    itemAnswer = () => jsonResponse(workItem());
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => within(storyPanel()).getByText("the export"));
    expect(itemFetches()).toBe(2);
  });
});
