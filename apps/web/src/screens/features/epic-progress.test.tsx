// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import { changeEvent } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { FeatureEpicProgress, FeatureProgress, FeatureRow } from "@/lib/api/features";
import { createLiveInvalidator } from "@/lib/live/invalidations";
import { FeatureEpicsPanel, NO_EPICS_YET, NOT_RUN, STATE_UNKNOWN } from "./epic-progress";
import { FeaturesView } from "./features-view";

vi.mock("next/navigation", () => ({
  usePathname: () => "/features",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

const FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const EMPTY_FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const RUN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RUN_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

function featureRow(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    id: FEATURE_ID,
    name: "Invoicing",
    status: "planning",
    repository: null,
    epicCount: 2,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

/** SOC-410: done, its two stories done, its run finished and its PR merged. */
const doneEpic: FeatureEpicProgress = {
  workItemId: "linear-issue-410",
  identifier: "SOC-410",
  title: "Invoice model",
  url: "https://linear.app/acme/issue/SOC-410",
  state: { category: "done", name: "Done" },
  stories: { done: 2, total: 2 },
  run: { id: RUN_1, status: "completed" },
  pullRequests: [
    { number: 41, url: "https://github.com/acme/portal/pull/41", state: "merged", host: "github" },
  ],
};

/** SOC-411: in progress, one of three stories done, its run working on a draft PR. */
const inProgressEpic: FeatureEpicProgress = {
  workItemId: "linear-issue-411",
  identifier: "SOC-411",
  title: "Send invoices",
  url: "https://linear.app/acme/issue/SOC-411",
  state: { category: "in_progress", name: "In Progress" },
  stories: { done: 1, total: 3 },
  run: { id: RUN_2, status: "running" },
  pullRequests: [
    { number: 42, url: "https://github.com/acme/portal/pull/42", state: "draft", host: "github" },
  ],
};

function progress(
  epics: FeatureEpicProgress[],
  overrides: Partial<FeatureProgress> = {},
): FeatureProgress {
  const counted = epics.filter((epic) => epic.state?.category !== "canceled");
  return {
    epics,
    rollup: {
      epicsDone: counted.filter((epic) => epic.state?.category === "done").length,
      epicsTotal: counted.length,
      storiesDone: counted.reduce((sum, epic) => sum + (epic.stories?.done ?? 0), 0),
      storiesTotal: counted.reduce((sum, epic) => sum + (epic.stories?.total ?? 0), 0),
    },
    trackerProblem: null,
    ...overrides,
  };
}

/** The server's progress of each feature. */
let served: Record<string, FeatureProgress>;
let features: FeatureRow[];
let seen: SeenRequest[];
let client: QueryClient;

beforeEach(() => {
  served = {
    [FEATURE_ID]: progress([doneEpic, inProgressEpic]),
    [EMPTY_FEATURE_ID]: progress([]),
  };
  features = [featureRow(), featureRow({ id: EMPTY_FEATURE_ID, name: "Exports", epicCount: 0 })];
  seen = mockFetch({
    "GET /api/ui/features": () => jsonResponse({ features }),
    ...Object.fromEntries(
      [FEATURE_ID, EMPTY_FEATURE_ID].map((id) => [
        `GET /api/ui/features/${id}/progress`,
        () => jsonResponse(served[id]),
      ]),
    ),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(children: React.ReactNode) {
  client = createTestQueryClient();
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>{children}</UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const panel = () => screen.findByRole("region", { name: "Progress" });
const epicRow = (name: string) =>
  within(screen.getByRole("list", { name: "Epics" })).getByRole("listitem", { name });

describe("FeatureEpicsPanel", () => {
  it("says a feature without epics has none yet", async () => {
    wrap(<FeatureEpicsPanel feature={{ id: EMPTY_FEATURE_ID }} />);
    const region = await panel();
    expect(await within(region).findByText(NO_EPICS_YET)).toBeTruthy();
    expect(within(region).queryByRole("list", { name: "Epics" })).toBeNull();
  });

  it("lists each epic with its state, stories, run and PR, and rolls them up", async () => {
    wrap(<FeatureEpicsPanel feature={{ id: FEATURE_ID }} />);
    const region = await panel();
    expect(await within(region).findByText("1 of 2 epics done")).toBeTruthy();
    expect(within(region).getByText("3 of 5 stories done")).toBeTruthy();

    const done = epicRow("SOC-410");
    expect(within(done).getByRole("link", { name: "Invoice model" }).getAttribute("href")).toBe(
      "/backlog/linear-issue-410",
    );
    expect(within(done).getByText("Done")).toBeTruthy();
    expect(within(done).getByText("2 of 2 stories done")).toBeTruthy();
    expect(within(done).getByRole("link", { name: "Run finished" }).getAttribute("href")).toContain(
      RUN_1,
    );
    expect(within(done).getByRole("link", { name: /#41/ }).getAttribute("href")).toBe(
      "https://github.com/acme/portal/pull/41",
    );
    expect(within(done).getByText("Merged")).toBeTruthy();

    const working = epicRow("SOC-411");
    expect(within(working).getByText("In Progress")).toBeTruthy();
    expect(within(working).getByText("1 of 3 stories done")).toBeTruthy();
    expect(within(working).getByRole("link", { name: "Run running" })).toBeTruthy();
    expect(within(working).getByRole("link", { name: /#42/ })).toBeTruthy();
    expect(within(working).getByText("Draft")).toBeTruthy();
  });

  it("updates live when the epic's run finishes", async () => {
    wrap(<FeatureEpicsPanel feature={{ id: FEATURE_ID }} />);
    await within(await panel()).findByText("1 of 2 epics done");

    served[FEATURE_ID] = progress([
      doneEpic,
      {
        ...inProgressEpic,
        state: { category: "done", name: "Done" },
        stories: { done: 3, total: 3 },
        run: { id: RUN_2, status: "completed" },
        pullRequests: [{ ...inProgressEpic.pullRequests[0]!, state: "merged" }],
      },
    ]);
    createLiveInvalidator(client).apply(
      changeEvent(TEST_ORGANIZATION_ID, { resource: "run", runId: RUN_2 }),
      new Set([TEST_ORGANIZATION_ID]),
    );

    const region = await panel();
    expect(await within(region).findByText("2 of 2 epics done")).toBeTruthy();
    expect(within(region).getByText("5 of 5 stories done")).toBeTruthy();
    expect(within(epicRow("SOC-411")).getByRole("link", { name: "Run finished" })).toBeTruthy();
  });

  it("lists an epic Om never ran and says why states are missing", async () => {
    served[FEATURE_ID] = progress(
      [{ ...inProgressEpic, state: null, stories: null, run: null, pullRequests: [] }],
      { trackerProblem: "Connect a tracker to see each epic's state and stories." },
    );
    wrap(<FeatureEpicsPanel feature={{ id: FEATURE_ID }} />);
    const region = await panel();
    expect(
      await within(region).findByText("Connect a tracker to see each epic's state and stories."),
    ).toBeTruthy();
    const row = epicRow("SOC-411");
    expect(within(row).getByText(STATE_UNKNOWN)).toBeTruthy();
    expect(within(row).getByText(NOT_RUN)).toBeTruthy();
    expect(within(region).getByText("0 of 1 epic done")).toBeTruthy();
  });
});

describe("the Features list", () => {
  it("shows each feature's roll-up, reading progress only for features with epics", async () => {
    wrap(<FeaturesView renderDetail={() => null} />);
    const list = await screen.findByRole("list", { name: "Features" });
    const invoicing = await within(list).findByText("1 of 2 epics done · 3 of 5 stories done");
    expect(invoicing).toBeTruthy();
    await waitFor(() =>
      expect(seen.some((request) => request.path.endsWith(`${FEATURE_ID}/progress`))).toBe(true),
    );
    expect(seen.some((request) => request.path.endsWith(`${EMPTY_FEATURE_ID}/progress`))).toBe(
      false,
    );
  });
});
