// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { SprintEpicRow, SprintRow } from "@/lib/api/sprints";
import { backlogOf, blockedRow, manualRow, workItemRow } from "../backlog/test-fixtures";
import { portalRow, webRow, REPO_PORTAL, REPO_WEB } from "../repos/test-fixtures";
import {
  PAUSED_HINT,
  MERGE_TOGETHER_EXPLANATION,
  NAME_EXPLANATION,
  ORDER_EXPLANATION,
  READ_ONLY_MEMBER,
  SPRINT_NOT_FOUND,
} from "./sprint-editor";
import {
  NO_SPRINTS,
  SPRINTS_LOAD_FAILED,
  SprintsView,
  type SprintsViewProps,
} from "./sprints-view";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sprints",
  useRouter: () => nav.router,
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

const SPRINT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const OTHER_SPRINT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" }],
};

function epic(identifier: string, title: string, position: number): SprintEpicRow {
  return {
    workItemId: `linear-issue-${identifier.split("-")[1]}`,
    identifier,
    title,
    position,
    state: "queued",
  };
}

function sprintRow(overrides: Partial<SprintRow> = {}): SprintRow {
  return {
    id: SPRINT_ID,
    name: "Invoicing",
    repository: { id: REPO_PORTAL, fullPath: "acme/portal" },
    mergeTogether: false,
    status: "draft",
    pausedReason: null,
    sprintBranch: null,
    epics: [
      epic("SOC-401", "Invoice model", 0),
      epic("SOC-402", "Invoice PDFs", 1),
      epic("SOC-403", "Invoice emails", 2),
    ],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

let sprints: SprintRow[];
let patchAnswer: (request: SeenRequest) => Response | Promise<Response>;
let seen: SeenRequest[];

/** The sprint after a PATCH, as the API answers: the body applied to the stored sprint. */
function applyPatch(request: SeenRequest): Response {
  const body = request.body as { name?: string; mergeTogether?: boolean; epics?: string[] };
  const current = sprints.find((sprint) => request.path.endsWith(sprint.id))!;
  const known = new Map(current.epics.map((row) => [row.workItemId, row]));
  const updated: SprintRow = {
    ...current,
    name: body.name ?? current.name,
    mergeTogether: body.mergeTogether ?? current.mergeTogether,
    epics: body.epics
      ? body.epics.map((id, position) => ({
          ...(known.get(id) ?? epic(`SOC-${id.split("-")[2]}`, "Added", position)),
          position,
        }))
      : current.epics,
  };
  sprints = sprints.map((sprint) => (sprint.id === updated.id ? updated : sprint));
  return jsonResponse({ ok: true, sprint: updated });
}

function serve(
  overrides: Record<string, (request: SeenRequest) => Response | Promise<Response>> = {},
) {
  seen = mockFetch({
    "GET /api/ui/sprints": () => jsonResponse({ sprints }),
    [`GET /api/ui/sprints/${SPRINT_ID}`]: () =>
      jsonResponse(sprints.find((s) => s.id === SPRINT_ID)),
    [`PATCH /api/ui/sprints/${SPRINT_ID}`]: (request) => patchAnswer(request),
    [`DELETE /api/ui/sprints/${SPRINT_ID}`]: () => jsonResponse({ ok: true }),
    "POST /api/ui/sprints": (request) => {
      const body = request.body as { repositoryId: string; name: string; mergeTogether: boolean };
      const created = sprintRow({
        id: OTHER_SPRINT_ID,
        name: body.name,
        mergeTogether: body.mergeTogether,
        repository: { id: body.repositoryId, fullPath: "acme/web" },
        epics: [],
      });
      return jsonResponse({ ok: true, sprint: created });
    },
    "GET /api/ui/repositories": () =>
      jsonResponse({ repositories: [portalRow(), webRow()], truncated: false }),
    "GET /api/ui/backlog": () =>
      jsonResponse(
        backlogOf([
          workItemRow({ id: "linear-issue-401", identifier: "SOC-401", title: "Invoice model" }),
          workItemRow({ id: "linear-issue-410", identifier: "SOC-410", title: "Refunds" }),
          blockedRow(),
          manualRow(),
        ]),
      ),
    ...overrides,
  });
}

function renderView(props: SprintsViewProps = {}, user: SessionUser = testUser) {
  const client = createTestQueryClient();
  return render(
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          <SprintsView {...props} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const sprintPane = () => screen.findByRole("article", { name: "Invoicing" });
const epicOrder = (pane: HTMLElement) =>
  within(within(pane).getByRole("list", { name: "Epics in order" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector(".or-sprint-epic__identifier")!.textContent);
const patches = () =>
  seen.filter((request) => request.method === "PATCH").map((request) => request.body);

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  sprints = [
    sprintRow(),
    sprintRow({
      id: OTHER_SPRINT_ID,
      name: "Checkout",
      status: "running",
      mergeTogether: true,
      repository: { id: REPO_WEB, fullPath: "acme/web" },
      epics: [epic("WEB-7", "Cart", 0)],
    }),
  ];
  patchAnswer = applyPatch;
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Sprints list", () => {
  it("groups the sprints by repo with each one's name, status and epic count", async () => {
    renderView();
    const portal = await screen.findByRole("list", { name: "acme/portal" });
    const web = screen.getByRole("list", { name: "acme/web" });
    expect(within(portal).getByRole("link", { name: "Invoicing" }).getAttribute("href")).toBe(
      `/sprints/${SPRINT_ID}`,
    );
    expect(within(portal).getByText("Draft")).toBeTruthy();
    expect(within(portal).getByText("3 epics")).toBeTruthy();
    expect(within(web).getByRole("link", { name: "Checkout" })).toBeTruthy();
    expect(within(web).getByText("Running")).toBeTruthy();
    expect(within(web).getByText("1 epic")).toBeTruthy();
    expect(within(web).getByText("Merges together")).toBeTruthy();
    // Repos in path order.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "acme/portal",
      "acme/web",
    ]);
  });

  it("shows a skeleton while loading, then the empty state with New sprint for admins", async () => {
    let answer!: (response: Response) => void;
    serve({
      "GET /api/ui/sprints": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    renderView();
    expect(screen.getByTestId("sprints-skeleton")).toBeTruthy();
    answer(jsonResponse({ sprints: [] }));
    expect(await screen.findByRole("heading", { name: NO_SPRINTS })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New sprint" })).toHaveLength(2);
  });

  it("says when the list can't load and retries", async () => {
    let fail = true;
    serve({
      "GET /api/ui/sprints": () =>
        fail
          ? jsonResponse({ error: "The database is down." }, 500)
          : jsonResponse({ sprints: [] }),
    });
    renderView();
    expect(await screen.findByRole("heading", { name: SPRINTS_LOAD_FAILED })).toBeTruthy();
    expect(screen.getByText("The database is down.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: NO_SPRINTS })).toBeTruthy();
  });

  it("creates a draft from New sprint with its repo, name and merge together, then opens it", async () => {
    renderView();
    await screen.findByRole("list", { name: "acme/portal" });
    await userEvent.click(screen.getByRole("button", { name: "New sprint" }));
    const sheet = await screen.findByRole("dialog", { name: "New sprint" });
    const repo = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    await waitFor(() => expect(repo.disabled).toBe(false));
    expect(within(sheet).getByText(NAME_EXPLANATION)).toBeTruthy();
    expect(within(sheet).getByText(MERGE_TOGETHER_EXPLANATION)).toBeTruthy();
    const create = within(sheet).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    await userEvent.selectOptions(repo, REPO_WEB);
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Name" }), "Checkout v2");
    await userEvent.click(within(sheet).getByRole("switch", { name: "Merge together" }));
    await userEvent.click(create);

    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(`/sprints/${OTHER_SPRINT_ID}`),
    );
    expect(seen.find((request) => request.method === "POST")?.body).toEqual({
      repositoryId: REPO_WEB,
      name: "Checkout v2",
      mergeTogether: true,
    });
  });

  it("shows members the sprints without New sprint", async () => {
    sprints = [];
    renderView({}, member);
    expect(await screen.findByRole("heading", { name: NO_SPRINTS })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New sprint" })).toBeNull();
  });
});

describe("the sprint editor", () => {
  it("explains each control and adds an epic from the repo's backlog to the end", async () => {
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    expect(within(pane).getByText(NAME_EXPLANATION)).toBeTruthy();
    expect(within(pane).getByText(MERGE_TOGETHER_EXPLANATION)).toBeTruthy();
    expect(within(pane).getByText(ORDER_EXPLANATION)).toBeTruthy();

    const backlog = await within(pane).findByRole("list", { name: "Backlog" });
    // Not the epics already in it, nor a manual item.
    expect(
      within(backlog)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".or-sprint-epic__identifier")!.textContent),
    ).toEqual(["SOC-410", "SOC-413"]);
    expect(within(backlog).getByText("Blocked by SOC-398, SOC-401")).toBeTruthy();

    await userEvent.click(within(backlog).getByRole("button", { name: "Add SOC-410" }));
    await waitFor(() =>
      expect(epicOrder(pane)).toEqual(["SOC-401", "SOC-402", "SOC-403", "SOC-410"]),
    );
    await waitFor(() =>
      expect(patches()).toEqual([
        { epics: ["linear-issue-401", "linear-issue-402", "linear-issue-403", "linear-issue-410"] },
      ]),
    );
    await waitFor(() =>
      expect(within(pane).queryByRole("button", { name: "Add SOC-410" })).toBeNull(),
    );
  });

  it("removes an epic, renames on Enter and switches merge together", async () => {
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    await userEvent.click(within(pane).getByRole("button", { name: "Remove SOC-402" }));
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-401", "SOC-403"]));

    const name = within(pane).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Billing{Enter}");
    await userEvent.click(within(pane).getByRole("switch", { name: "Merge together" }));

    await waitFor(() =>
      expect(patches()).toEqual([
        { epics: ["linear-issue-401", "linear-issue-403"] },
        { name: "Billing" },
        { mergeTogether: true },
      ]),
    );
    expect(await screen.findByRole("article", { name: "Billing" })).toBeTruthy();
  });

  it("refuses an empty name inline without saving", async () => {
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    const name = within(pane).getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.tab();
    expect(within(pane).getByText("Name the sprint.")).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("moves an epic with the keyboard, keeping focus on its handle", async () => {
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    const handle = within(pane).getByRole("button", { name: "Move SOC-401, position 1 of 3" });
    handle.focus();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-402", "SOC-401", "SOC-403"]));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(pane).getByRole("button", { name: "Move SOC-401, position 2 of 3" }),
      ),
    );
    expect(within(pane).getByText("Moved SOC-401 to position 2 of 3.")).toBeTruthy();
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-402", "SOC-403", "SOC-401"]));
    // At either end, a move past it does nothing.
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(patches()).toEqual([
        { epics: ["linear-issue-402", "linear-issue-401", "linear-issue-403"] },
        { epics: ["linear-issue-402", "linear-issue-403", "linear-issue-401"] },
      ]),
    );
  });

  it("moves an epic by drag and drop onto another's place", async () => {
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    const rows = within(within(pane).getByRole("list", { name: "Epics in order" })).getAllByRole(
      "listitem",
    );
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-403", "SOC-401", "SOC-402"]));
    await waitFor(() =>
      expect(patches()).toEqual([
        { epics: ["linear-issue-403", "linear-issue-401", "linear-issue-402"] },
      ]),
    );
  });

  it("shows an order the API refuses inline and puts the previous order back", async () => {
    patchAnswer = () =>
      jsonResponse(
        {
          error: "SOC-402 is blocked by SOC-401: put SOC-401 first.",
          code: "blocked_order",
        },
        400,
      );
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    within(pane).getByRole("button", { name: "Move SOC-402, position 2 of 3" }).focus();
    await userEvent.keyboard("{ArrowUp}");

    const alert = await within(pane).findByRole("alert");
    expect(alert.textContent).toBe("SOC-402 is blocked by SOC-401: put SOC-401 first.");
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-401", "SOC-402", "SOC-403"]));

    // The next accepted change clears it.
    patchAnswer = applyPatch;
    within(pane).getByRole("button", { name: "Move SOC-403, position 3 of 3" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(within(pane).queryByRole("alert")).toBeNull());
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-401", "SOC-403", "SOC-402"]));
  });

  it("offers the actions each status allows", async () => {
    const onAction = vi.fn();
    const statuses: [SprintRow["status"], string[]][] = [
      ["draft", ["Start sprint", "Delete draft…"]],
      ["running", ["Pause", "Cancel sprint"]],
      ["paused", ["Resume", "Cancel sprint"]],
      ["done", []],
      ["canceled", []],
    ];
    for (const [status, labels] of statuses) {
      sprints = [sprintRow({ status })];
      const { unmount } = renderView({ sprintId: SPRINT_ID, onAction });
      const pane = await sprintPane();
      const group = within(pane).queryByRole("group", { name: "Sprint actions" });
      expect(
        group
          ? within(group)
              .getAllByRole("button")
              .map((button) => button.textContent)
          : [],
        status,
      ).toEqual(labels);
      unmount();
    }
    sprints = [sprintRow({ status: "running" })];
    renderView({ sprintId: SPRINT_ID, onAction });
    await userEvent.click(within(await sprintPane()).getByRole("button", { name: "Pause" }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: SPRINT_ID }), "pause");
  });

  it("sends an action to the API and shows the sprint it answers", async () => {
    serve({
      [`POST /api/ui/sprints/${SPRINT_ID}/start`]: () =>
        jsonResponse({
          ok: true,
          sprint: sprintRow({
            status: "paused",
            pausedReason: "Om didn't start SOC-401: the PRD of SOC-401 still has open questions.",
          }),
        }),
    });
    renderView({ sprintId: SPRINT_ID });
    const pane = await sprintPane();
    await userEvent.click(within(pane).getByRole("button", { name: "Start sprint" }));
    expect(
      await within(pane).findByText(
        "Om didn't start SOC-401: the PRD of SOC-401 still has open questions.",
      ),
    ).toBeTruthy();
    expect(within(pane).getByText(PAUSED_HINT)).toBeTruthy();
    expect(within(pane).getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(seen.some((request) => request.path.endsWith(`${SPRINT_ID}/start`))).toBe(true);
    expect(ui.toast).toHaveBeenCalledWith("Invoicing is paused");
  });

  it("deletes a draft after confirming and goes back to the list", async () => {
    renderView({ sprintId: SPRINT_ID });
    await userEvent.click(
      within(await sprintPane()).getByRole("button", { name: "Delete draft…" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Invoicing?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete draft" }));
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/sprints"));
    expect(seen.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("shows a member everything read-only", async () => {
    renderView({ sprintId: SPRINT_ID }, member);
    const pane = await sprintPane();
    expect(within(pane).getByText(READ_ONLY_MEMBER)).toBeTruthy();
    await waitFor(() => expect(epicOrder(pane)).toEqual(["SOC-401", "SOC-402", "SOC-403"]));
    expect(within(pane).getByText("Off")).toBeTruthy();
    expect(within(pane).getByText(MERGE_TOGETHER_EXPLANATION)).toBeTruthy();
    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(within(pane).queryByRole("switch")).toBeNull();
    expect(within(pane).queryAllByRole("button")).toEqual([]);
    expect(within(pane).queryByRole("list", { name: "Backlog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New sprint" })).toBeNull();
    expect(seen.some((request) => request.path === "/api/ui/backlog")).toBe(false);
    const rows = within(pane).getAllByRole("listitem");
    expect(rows.some((row) => row.getAttribute("draggable") === "true")).toBe(false);
  });

  it("says when the sprint doesn't exist", async () => {
    serve({
      [`GET /api/ui/sprints/${SPRINT_ID}`]: () =>
        jsonResponse({ error: "That sprint doesn't exist.", code: "not_found" }, 404),
    });
    renderView({ sprintId: SPRINT_ID });
    expect(await screen.findByRole("heading", { name: SPRINT_NOT_FOUND })).toBeTruthy();
  });

  it("shows a skeleton while the sprint loads", () => {
    serve({
      [`GET /api/ui/sprints/${SPRINT_ID}`]: () => new Promise<Response>(() => {}),
    });
    renderView({ sprintId: SPRINT_ID });
    expect(screen.getByTestId("sprint-skeleton")).toBeTruthy();
  });
});
