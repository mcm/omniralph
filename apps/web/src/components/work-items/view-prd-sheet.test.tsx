// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider } from "@omniralph/ui";
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
import { epicRunDetail, runSession } from "@/components/runs/test-fixtures";
import type { RunDetail, RunRow } from "@/lib/api/runs";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { RunsView } from "@/screens/runs/runs-view";
import { FILTER_OPTIONS, runRow } from "@/screens/runs/test-fixtures";
import { prdModeForRun, VIEW_PRD } from "./view-prd-sheet";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const ORG = TEST_ORGANIZATION_ID;
const RUN_ID = runRow().id;
const ITEM_ID = "linear-issue-412";
const ITEM_PATH = `/api/ui/work-items/${ITEM_ID}`;
const PRD = "## Introduction\n\nShow the **backlog**.\n";

function workItem(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    id: ITEM_ID,
    tracker: "linear",
    identifier: "SOC-412",
    title: "Backlog screen",
    url: "https://linear.app/acme/issue/SOC-412",
    organization: { id: ORG, name: "Acme", role: "admin" },
    repository: { id: "repo-1", provider: "github", fullPath: "acme/customer-portal" },
    size: "M",
    group: null,
    blocked: false,
    blockers: [],
    source: { kind: "team", id: "team-1", name: "SOC" },
    state: { category: "in_progress", name: "In Progress" },
    description: PRD,
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [],
    route: {
      outcome: "repository",
      repository: { id: "repo-1", provider: "github", fullPath: "acme/customer-portal" },
      via: { kind: "team", label: "SOC team" },
      by: "work item match (SOC team)",
    },
    stories: [],
    activity: [],
    triageRunning: false,
    run: { id: RUN_ID, status: "running" },
    actions: {
      start: false,
      triage: false,
      editPrd: false,
      changeRepo: false,
      move: false,
      cancel: false,
    },
    ...overrides,
  };
}

function run(status: RunDetail["status"], overrides: Partial<RunDetail> = {}): RunDetail {
  return epicRunDetail({
    id: RUN_ID,
    status,
    title: "Backlog screen",
    workItem: {
      id: ITEM_ID,
      tracker: "linear",
      identifier: "SOC-412",
      url: "https://linear.app/acme/issue/SOC-412",
    },
    ...overrides,
  });
}

let detail: RunDetail;
let item: WorkItemDetail;
let seen: SeenRequest[];

function renderRuns(live?: ReturnType<typeof fakeAbly>) {
  const view = <RunsView runId={RUN_ID} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={createTestQueryClient()}>
        <UiProvider>
          {live ? (
            <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
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

const pane = () => screen.getByRole("region", { name: "Run" });
const loaded = () =>
  waitFor(() => within(pane()).getByRole("heading", { level: 2, name: "Backlog screen" }));
const toolbar = () => within(pane()).getByRole("toolbar", { name: "Run actions" });

async function openMenu() {
  await userEvent.click(within(toolbar()).getByRole("button", { name: "More actions" }));
  return screen.getByRole("menu");
}

async function openPrd() {
  await loaded();
  await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: VIEW_PRD }));
  const sheet = await screen.findByRole("dialog", { name: "PRD of SOC-412" });
  await within(sheet).findByRole("heading", { name: "Introduction" });
  return sheet;
}

const itemFetches = () => seen.filter((r) => r.method === "GET" && r.path === ITEM_PATH).length;

beforeEach(() => {
  detail = run("running");
  item = workItem();
  ui.toast.mockReset();
  const row: RunRow = runRow({ status: detail.status, title: detail.title });
  seen = mockFetch({
    "GET /api/ui/runs": () => jsonResponse({ runs: [row], nextCursor: null }),
    "GET /api/ui/runs/filter-options": FILTER_OPTIONS,
    [`GET /api/ui/runs/${RUN_ID}`]: () => jsonResponse(detail),
    [`GET /api/ui/runs/${RUN_ID}/session`]: () => jsonResponse(runSession()),
    [`GET ${ITEM_PATH}`]: () => jsonResponse(item),
    [`PUT ${ITEM_PATH}/prd`]: () => jsonResponse({ updatedAt: "2026-10-26T10:05:00.000Z" }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("prdModeForRun", () => {
  it.each([
    ["queued", "read-only"],
    ["running", "read-only"],
    ["waiting", "read-only"],
    ["completed", "editable"],
    ["failed", "editable"],
    ["stopped", "editable"],
  ] as [RunDetail["status"], string][])("%s → %s", (status, mode) => {
    expect(prdModeForRun(status)).toBe(mode);
  });
});

describe("View PRD in the run ⋯ menu", () => {
  it("is the menu's first item for a run with a work item", async () => {
    renderRuns();
    await loaded();
    const items = within(await openMenu()).getAllByRole("menuitem");
    expect(items.map((entry) => entry.textContent)).toEqual([
      VIEW_PRD,
      "Open in Linear",
      "Copy link",
      "Stop run",
    ]);
  });

  it("isn't offered for a run without a work item", async () => {
    detail = run("running", { workItem: null });
    renderRuns();
    await loaded();
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: VIEW_PRD })).toBeNull();
  });

  it("opens the PRD read-only in a sheet while the run is running, and closes it", async () => {
    renderRuns();
    expect(itemFetches()).toBe(0);
    const sheet = await openPrd();
    // The work item's title describes the sheet; its PRD renders with Markdown.
    await waitFor(() => expect(sheet.getAttribute("aria-describedby")).toBeTruthy());
    expect(document.getElementById(sheet.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Backlog screen",
    );
    expect(within(sheet).getByText("backlog").tagName).toBe("STRONG");
    expect(within(sheet).queryByRole("button", { name: "Edit PRD" })).toBeNull();
    expect(within(sheet).queryByRole("textbox")).toBeNull();
    expect(itemFetches()).toBe(1);

    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "PRD of SOC-412" })).toBeNull(),
    );
  });

  it.each(["queued", "waiting"] as RunDetail["status"][])(
    "is read-only while the run is %s, even when the item allows edits",
    async (status) => {
      detail = run(status);
      item = workItem({ actions: { ...workItem().actions, editPrd: true } });
      renderRuns();
      const sheet = await openPrd();
      expect(within(sheet).queryByRole("button", { name: "Edit PRD" })).toBeNull();
    },
  );

  it("is editable once the run has stopped, and saves the PRD", async () => {
    detail = run("completed");
    item = workItem({
      run: { id: RUN_ID, status: "completed" },
      actions: { ...workItem().actions, editPrd: true },
    });
    renderRuns();
    const user = userEvent.setup();
    const sheet = await openPrd();
    await user.click(within(sheet).getByRole("button", { name: "Edit PRD" }));
    const editor = within(sheet).getByRole<HTMLTextAreaElement>("textbox", {
      name: /PRD of SOC-412/,
    });
    expect(editor.value).toBe(PRD);
    await user.type(editor, "More.");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(seen.some((r) => r.method === "PUT" && r.path === `${ITEM_PATH}/prd`)).toBe(true),
    );
    const put = seen.find((r) => r.method === "PUT")!;
    expect(put.body).toEqual({
      markdown: `${PRD}More.`,
      baseUpdatedAt: "2026-10-26T10:00:00.000Z",
    });
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("PRD saved"));
  });

  it("becomes editable without reopening when the run finishes (live)", async () => {
    const live = fakeAbly();
    renderRuns(live);
    const sheet = await openPrd();
    await waitFor(() => expect(live.current().subscribed()).toContain(`org:${ORG}:changes`));
    expect(within(sheet).queryByRole("button", { name: "Edit PRD" })).toBeNull();

    detail = run("completed");
    item = workItem({
      run: { id: RUN_ID, status: "completed" },
      actions: { ...workItem().actions, editPrd: true },
    });
    act(() =>
      live
        .current()
        .deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "run", runId: RUN_ID })),
    );
    await within(sheet).findByRole("button", { name: "Edit PRD" });
  });
});
