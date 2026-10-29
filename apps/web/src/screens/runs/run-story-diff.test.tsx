// @vitest-environment jsdom
import "@/components/pickers/test-dom";
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
import {
  attempt,
  epicRunDetail,
  reviewRunDetail,
  runSession,
  storyStep,
} from "@/components/runs/test-fixtures";
import type { RunDetail, StoryDiff, TranscriptPageView } from "@/lib/api/runs";
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
const COMMIT = "4f1c2ab9d0";
const MINUTE = 60_000;

type StoryStep = Extract<RunDetail["steps"][number], { kind: "story" }>;
const story = (step: RunDetail["steps"][number], changes: Partial<StoryStep>) =>
  ({ ...(step as StoryStep), ...changes }) satisfies StoryStep;

/** An epic whose first story was built in `COMMIT` and whose second is still running. */
function epic(commit: string | null = COMMIT): RunDetail {
  return epicRunDetail({
    id: RUN_ID,
    steps: [
      story(storyStep("1", "completed", 13 * MINUTE), { commit }),
      story(storyStep("2", "running", 5 * MINUTE), { attempts: 1 }),
    ],
    attempts: [
      attempt("a2", { step: "2", status: "running", finishedAt: null, transcriptEvents: 0 }),
      attempt("a1", { step: "1", label: "Built TOOL-1", transcriptEvents: 0 }),
    ],
  });
}

function storyDiff(overrides: Partial<StoryDiff> = {}): StoryDiff {
  return {
    sha: COMMIT,
    url: `https://github.com/acme/portal/commit/${COMMIT}`,
    provider: "github",
    files: [
      {
        path: "src/export.ts",
        previousPath: null,
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;",
        truncated: false,
      },
    ],
    truncated: false,
    ...overrides,
  };
}

let detail: RunDetail;
let seen: SeenRequest[];
let diffAnswer: (request: SeenRequest) => Response | Promise<Response>;

const DETAIL_PATH = `/api/ui/runs/${RUN_ID}`;
const diffPath = (stepId: string) => `/api/ui/runs/${RUN_ID}/steps/${stepId}/diff`;
const emptyTranscript = () =>
  jsonResponse({ events: [], nextCursor: null } satisfies TranscriptPageView);

function serve() {
  seen = mockFetch({
    [`GET ${DETAIL_PATH}`]: () => jsonResponse(detail),
    [`GET ${DETAIL_PATH}/session`]: () => jsonResponse(runSession()),
    [`GET ${DETAIL_PATH}/attempts/a1/transcript`]: emptyTranscript,
    [`GET ${DETAIL_PATH}/attempts/a2/transcript`]: emptyTranscript,
    [`GET ${DETAIL_PATH}/attempts/r1/transcript`]: emptyTranscript,
    [`GET ${diffPath("1")}`]: (r) => diffAnswer(r),
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
const tabNames = () =>
  within(panel())
    .getAllByRole("tab")
    .map((tab) => tab.textContent);
const changedFiles = () => within(panel()).getByRole("list", { name: "Changed files" });
const requestsTo = (path: string) => seen.filter((r) => r.path === path);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  detail = epic();
  diffAnswer = () => jsonResponse(storyDiff());
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the step panel's Diff tab", () => {
  it("shows between Transcript and Attempts for an epic story with a commit", async () => {
    renderRun({ search: "step=1" });
    await loaded();
    expect(tabNames()).toEqual(["Transcript", "Diff", "Attempts1"]);
  });

  it("doesn't show for a running story or a story without a commit", async () => {
    const first = renderRun({ search: "step=2" });
    await loaded();
    expect(tabNames()).toEqual(["Transcript", "Attempts1"]);
    first.unmount();

    detail = epic(null);
    renderRun({ search: "step=1" });
    await loaded();
    expect(tabNames()).toEqual(["Transcript", "Attempts1"]);
  });

  it("doesn't show on a review run's steps", async () => {
    detail = { ...reviewRunDetail(), id: RUN_ID };
    renderRun();
    await loaded();
    expect(tabNames()).not.toContain("Diff");
  });

  it("loads the diff only when opened, and puts the tab in the URL", async () => {
    const { navigate } = renderRun({ search: "step=1" });
    await loaded();
    expect(requestsTo(diffPath("1"))).toHaveLength(0);

    await userEvent.click(within(panel()).getByRole("tab", { name: "Diff" }));
    expect(String(nav.router.replace.mock.calls.at(-1)?.[0])).toContain("tab=diff");
    navigate("step=1&tab=diff");
    await waitFor(() => changedFiles());
    expect(requestsTo(diffPath("1"))).toHaveLength(1);
  });

  it("shows a loading state, then each file of the commit", async () => {
    const held = deferred();
    diffAnswer = () => held.promise;
    renderRun({ search: "step=1&tab=diff" });
    await loaded();
    await waitFor(() => within(panel()).getByTestId("diff-skeleton"));

    await act(async () => held.resolve(jsonResponse(storyDiff())));
    const [file] = within(await waitFor(() => changedFiles())).getAllByRole("listitem");
    expect(within(file!).getByRole("button").textContent).toContain("src/export.ts");
    expect(within(file!).getByRole("button").textContent).toContain("+2 −1");
    expect(file!.querySelectorAll(".or-diff__line--add")).toHaveLength(2);
    expect(file!.querySelectorAll(".or-diff__line--del")).toHaveLength(1);
    expect(within(panel()).queryByTestId("diff-skeleton")).toBeNull();
  });

  it("links a diff too large to show in full to the commit on the code host", async () => {
    diffAnswer = () => jsonResponse(storyDiff({ truncated: true }));
    renderRun({ search: "step=1&tab=diff" });
    await waitFor(() => changedFiles());
    expect(panel().textContent).toContain("This diff is too large to show in full.");
    expect(within(panel()).getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe(
      `https://github.com/acme/portal/commit/${COMMIT}`,
    );
  });

  it("names the diff and the server's reason when it fails, and reloads it", async () => {
    diffAnswer = () =>
      jsonResponse({ error: "This commit isn't on GitHub yet.", code: "commit_not_found" }, 409);
    renderRun({ search: "step=1&tab=diff" });
    const alert = await waitFor(() => within(panel()).getByRole("alert"));
    expect(alert.textContent).toContain("Couldn't load the diff. This commit isn't on GitHub yet.");

    diffAnswer = () => jsonResponse(storyDiff());
    await userEvent.click(within(alert).getByRole("button", { name: "Reload diff" }));
    await waitFor(() => changedFiles());
    expect(requestsTo(diffPath("1"))).toHaveLength(2);
  });
});

describe("the cached diff", () => {
  const changes = `org:${TEST_ORGANIZATION_ID}:changes`;

  it("isn't refetched by change events, which refetch the run", async () => {
    const live = fakeAbly();
    renderRun({ live, search: "step=1&tab=diff" });
    await waitFor(() => changedFiles());
    await waitFor(() => expect(live.current().subscribed()).toContain(changes));
    const details = requestsTo(DETAIL_PATH).length;

    act(() => {
      for (const event of [
        changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_ID }),
        changeEvent(TEST_ORGANIZATION_ID, { resource: "pull_request" }),
        changeEvent(TEST_ORGANIZATION_ID, { resource: "transcript", runId: RUN_ID }),
      ]) {
        live.current().deliver(changes, event);
      }
    });
    await waitFor(() => expect(requestsTo(DETAIL_PATH).length).toBeGreaterThan(details));
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(requestsTo(diffPath("1"))).toHaveLength(1);
    changedFiles();
  });

  it("is kept per commit: reopening the tab doesn't refetch, a new commit does", async () => {
    const { navigate, client } = renderRun({ search: "step=1&tab=diff" });
    await waitFor(() => changedFiles());
    navigate("step=1&tab=transcript");
    await waitFor(() =>
      expect(within(panel()).queryByRole("list", { name: "Changed files" })).toBeNull(),
    );
    navigate("step=1&tab=diff");
    changedFiles();
    expect(requestsTo(diffPath("1"))).toHaveLength(1);

    // The story is re-run and built in a new commit: the run refetches, the diff follows.
    detail = epic("9e8d7c6b5a");
    diffAnswer = () => jsonResponse(storyDiff({ sha: "9e8d7c6b5a" }));
    await act(() =>
      client.refetchQueries({ queryKey: [TEST_ORGANIZATION_ID, "runs", "detail", RUN_ID] }),
    );
    await waitFor(() => expect(requestsTo(diffPath("1"))).toHaveLength(2));
  });
});
