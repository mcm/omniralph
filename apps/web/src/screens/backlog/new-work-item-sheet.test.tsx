// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { TRIAGE_NOW_DESCRIPTION } from "@/components/work-items/triage-now-checkbox";
import type { Backlog } from "@/lib/api/backlog";
import type { CreateWorkItemResponse, WorkItemTarget } from "@/lib/api/work-items";
import { BacklogView } from "./backlog-view";
import { createsIn } from "./new-work-item-sheet";
import { useBacklogCounts, useBacklogUpNext } from "./queries";
import { backlogOf, BETA_ID, REPO_PORTAL, REPO_WEB, refineRow, workItemRow } from "./test-fixtures";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    search: new URLSearchParams(),
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Follows a push or replace that opens or closes the New work item sheet (`?new=1`). */
    follow(href: string) {
      const next = new URLSearchParams(href.split("?")[1] ?? "");
      if ((next.get("new") === "1") === (state.search.get("new") === "1")) return;
      state.search = next;
      for (const listener of listeners) listener();
    },
  };
  return state;
});
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePathname: () => "/backlog",
    useRouter: () => nav.router,
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.search),
  };
});

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

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ORG = TEST_ORGANIZATION_ID;
const REPO_BETA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

const portalTarget: WorkItemTarget = {
  repository: { id: REPO_PORTAL, provider: "gitlab", fullPath: "acme/portal", name: "portal" },
  organization: { id: ORG, name: "Acme", role: "admin" },
  tracker: "linear",
  team: "SOC",
  project: "Portal",
};
const webTarget: WorkItemTarget = {
  repository: { id: REPO_WEB, provider: "github", fullPath: "acme/web", name: "web" },
  organization: { id: ORG, name: "Acme", role: "admin" },
  tracker: "linear",
  team: "WEB",
  project: null,
};
const betaTarget: WorkItemTarget = {
  repository: { id: REPO_BETA, provider: "github", fullPath: "beta/api", name: "api" },
  organization: { id: BETA_ID, name: "Beta", role: "member" },
  tracker: "linear",
  team: "API",
  project: null,
};

/** The row `POST /api/ui/work-items` answers: a new Needs refining item for acme/portal. */
const createdRow = () =>
  workItemRow({
    id: "linear-issue-500",
    identifier: "SOC-500",
    title: "Dunning emails",
    url: "https://linear.app/acme/issue/SOC-500",
    size: null,
    group: "refine",
    triageRunning: true,
  });

let backlog: Backlog;
let targets: WorkItemTarget[];
let seen: SeenRequest[];
let createAnswer: () => Response | Promise<Response>;

function serve() {
  seen = mockFetch({
    "GET /api/ui/backlog": () => jsonResponse(backlog),
    "GET /api/ui/backlog/counts": () => {
      const ready = backlog.groups.readyToStart.length;
      const refining = backlog.groups.needsRefining.length;
      return jsonResponse({
        readyToStart: ready,
        needsRefining: refining,
        total: ready + refining,
      });
    },
    "GET /api/ui/backlog/up-next": () =>
      jsonResponse({
        readyToStart: backlog.groups.readyToStart.slice(0, 3),
        needsRefining: backlog.groups.needsRefining.slice(0, 2),
      }),
    "GET /api/ui/work-items/targets": () => jsonResponse({ targets }),
    "POST /api/ui/work-items": () => createAnswer(),
  });
}

/** The counts and Up next, as the nav and the empty Inbox show them. */
function Observers() {
  const counts = useBacklogCounts();
  const upNext = useBacklogUpNext();
  return (
    <>
      <p data-testid="counts">
        {counts.data
          ? `${counts.data.readyToStart}/${counts.data.needsRefining}/${counts.data.total}`
          : ""}
      </p>
      <p data-testid="up-next">
        {upNext.data
          ? [...upNext.data.readyToStart, ...upNext.data.needsRefining]
              .map((row) => row.identifier)
              .join(" ")
          : ""}
      </p>
    </>
  );
}

function renderBacklog(options: { user?: SessionUser; search?: string } = {}) {
  nav.search = new URLSearchParams(options.search ?? "");
  const client = createTestQueryClient();
  return render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          <BacklogView renderDetail={(id) => <p>Detail of {id}</p>} />
          <Observers />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

const listTitles = (group: string) =>
  Array.from(
    screen.queryByRole("list", { name: group, hidden: true })?.querySelectorAll(".or-row__title") ??
      [],
    (title) => title.textContent,
  );
const requests = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);

async function openSheet() {
  await screen.findByRole("list", { name: "Ready to start" });
  await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("1/1/2"));
  await userEvent.click(screen.getAllByRole("button", { name: "New work item" })[0]!);
  const sheet = await screen.findByRole("dialog", { name: "New work item" });
  const repo = within(sheet).getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
  await waitFor(() => expect(repo.disabled).toBe(false));
  return sheet;
}

const field = (sheet: HTMLElement, name: string) =>
  within(sheet).getByRole(name === "Repo" ? "combobox" : "textbox", { name }) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
const triageBox = (sheet: HTMLElement) =>
  within(sheet).getByRole("checkbox", { name: "Triage now" }) as HTMLInputElement;
const createButton = (sheet: HTMLElement) =>
  within(sheet).getByRole("button", { name: "Create" }) as HTMLButtonElement;

async function fill(sheet: HTMLElement, title: string, description = "") {
  await userEvent.type(field(sheet, "Title"), title);
  if (description) await userEvent.type(field(sheet, "Description"), description);
}

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset().mockImplementation(nav.follow);
  nav.router.replace.mockReset().mockImplementation(nav.follow);
  backlog = backlogOf([workItemRow(), refineRow()]);
  targets = [portalTarget, webTarget];
  createAnswer = () =>
    jsonResponse({ item: createdRow(), triage: "started" } satisfies CreateWorkItemResponse);
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the New work item sheet", () => {
  it("opens from the + with Repo, Title, Description and Triage now on, and says where the item is created", async () => {
    renderBacklog();
    const sheet = await openSheet();

    const repo = field(sheet, "Repo") as HTMLSelectElement;
    expect(Array.from(repo.options, (option) => option.textContent)).toEqual([
      "acme/portal",
      "acme/web",
    ]);
    expect(repo.value).toBe(REPO_PORTAL);
    expect(repo.querySelector("optgroup")).toBeNull();
    expect(field(sheet, "Title").value).toBe("");
    expect((field(sheet, "Title") as HTMLInputElement).required).toBe(true);
    expect(field(sheet, "Description").tagName).toBe("TEXTAREA");
    expect(triageBox(sheet).checked).toBe(true);
    expect(within(sheet).getByText(TRIAGE_NOW_DESCRIPTION)).toBeTruthy();
    expect(
      within(sheet).getByText("Creates a Linear issue in the SOC team, Portal project."),
    ).toBeTruthy();

    await userEvent.selectOptions(repo, REPO_WEB);
    expect(within(sheet).getByText("Creates a Linear issue in the WEB team.")).toBeTruthy();
    expect(within(sheet).queryByText(/Portal project/)).toBeNull();

    // Create waits for a title; it's a solid neutral button.
    expect(createButton(sheet).disabled).toBe(true);
    expect(createButton(sheet).className).toContain("solid");
    await fill(sheet, "   ");
    expect(createButton(sheet).disabled).toBe(true);
    expect(requests("GET", "/api/ui/work-items/targets")[0]?.query.get("organization")).toBe(ORG);
  });

  it("says where each kind of match creates the item", () => {
    expect(createsIn({ team: "Tooling", project: "Omniralph" })).toBe(
      "Creates a Linear issue in the Tooling team, Omniralph project.",
    );
    expect(createsIn({ team: "SOC", project: null })).toBe(
      "Creates a Linear issue in the SOC team.",
    );
  });

  it("starts on the Repo filter's repo", async () => {
    renderBacklog({ search: `repo=${REPO_WEB}` });
    await screen.findAllByRole("button", { name: "New work item" });
    await userEvent.click(screen.getAllByRole("button", { name: "New work item" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "New work item" });
    const repo = field(sheet, "Repo") as HTMLSelectElement;
    await waitFor(() => expect(repo.value).toBe(REPO_WEB));
  });

  it("groups the repos by organization under All organizations", async () => {
    targets = [portalTarget, webTarget, betaTarget];
    renderBacklog({ user: allOrganizations });
    const sheet = await openSheet();
    const repo = field(sheet, "Repo") as HTMLSelectElement;
    const groups = Array.from(repo.querySelectorAll("optgroup"), (group) => [
      group.label,
      Array.from(group.querySelectorAll("option"), (option) => option.textContent),
    ]);
    expect(groups).toEqual([
      ["Acme", ["acme/portal", "acme/web"]],
      ["Beta", ["beta/api"]],
    ]);
    expect(requests("GET", "/api/ui/work-items/targets")[0]?.query.get("organization")).toBe("all");
    await userEvent.selectOptions(repo, REPO_BETA);
    expect(within(sheet).getByText("Creates a Linear issue in the API team.")).toBeTruthy();
  });

  it("creates: inserts the returned row into its group, selects it and closes, without a list request", async () => {
    const held = deferred();
    createAnswer = () => held.promise;
    renderBacklog();
    const sheet = await openSheet();
    await fill(sheet, "Dunning emails", "Remind customers.");
    await userEvent.click(createButton(sheet));

    await waitFor(() => expect(requests("POST", "/api/ui/work-items")).toHaveLength(1));
    expect(requests("POST", "/api/ui/work-items")[0]?.body).toEqual({
      repositoryId: REPO_PORTAL,
      title: "Dunning emails",
      description: "Remind customers.",
      triageNow: true,
    });
    // While it's in flight, the sheet stays open and Create is busy.
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Creating…" }),
    ).toBeTruthy();

    const listRequests = requests("GET", "/api/ui/backlog").length;
    await act(async () => {
      held.resolve(
        jsonResponse({ item: createdRow(), triage: "started" } satisfies CreateWorkItemResponse),
      );
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(listTitles("Needs refining")).toEqual(["Dunning emails", "Rough idea: dunning emails"]);
    expect(listTitles("Ready to start")).toEqual(["Export invoices as CSV"]);
    expect(screen.getByTestId("counts").textContent).toBe("1/2/3");
    expect(screen.getByTestId("up-next").textContent).toBe("SOC-412 SOC-500 SOC-420");
    expect(nav.router.push).toHaveBeenCalledWith("/backlog/linear-issue-500", { scroll: false });
    expect(ui.toast).toHaveBeenCalledWith("Added SOC-500 to the backlog. Om is triaging it.");

    // Nothing is refetched: the row came from the response.
    await new Promise((done) => setTimeout(done, 50));
    expect(requests("GET", "/api/ui/backlog")).toHaveLength(listRequests);
    expect(requests("GET", "/api/ui/backlog/counts")).toHaveLength(1);
    expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(1);
  });

  it("creates without triage when Triage now is off, into Ready when the item is ready", async () => {
    createAnswer = () =>
      jsonResponse({
        item: { ...createdRow(), group: "ready", triageRunning: false },
        triage: null,
      } satisfies CreateWorkItemResponse);
    renderBacklog();
    const sheet = await openSheet();
    await fill(sheet, "Dunning emails");
    await userEvent.click(triageBox(sheet));
    await userEvent.click(createButton(sheet));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(requests("POST", "/api/ui/work-items")[0]?.body).toMatchObject({ triageNow: false });
    expect(listTitles("Ready to start")).toEqual(["Dunning emails", "Export invoices as CSV"]);
    expect(ui.toast).toHaveBeenCalledWith("Added SOC-500 to the backlog.");
  });

  it("warns with the reason when triage couldn't start, and still adds the item", async () => {
    createAnswer = () =>
      jsonResponse({
        item: { ...createdRow(), triageRunning: false },
        triage: "failed",
        triageError: "Om couldn't start triage because Linear didn't answer.",
      } satisfies CreateWorkItemResponse);
    renderBacklog();
    const sheet = await openSheet();
    await fill(sheet, "Dunning emails");
    await userEvent.click(createButton(sheet));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ui.toast).toHaveBeenCalledWith(
      "Added SOC-500 to the backlog, but Om couldn't triage it. Om couldn't start triage because Linear didn't answer.",
      { variant: "warning" },
    );
    expect(listTitles("Needs refining")).toContain("Dunning emails");
    expect(nav.router.push).toHaveBeenCalledWith("/backlog/linear-issue-500", { scroll: false });
  });

  it.each([
    ["tracker_not_connected", 400, "Connect Linear to add work items."],
    ["no_work_item_match", 400, "portal doesn't pick up work items yet."],
    ["coding_off", 400, "Coding is off for portal."],
    ["invalid", 400, "Keep the title to 255 characters."],
    ["tracker_failed", 502, "Linear didn't answer. Try again in a moment."],
  ] as const)(
    "shows %s's message in an alert and keeps the values",
    async (code, status, error) => {
      createAnswer = () =>
        jsonResponse(
          { error, code, ...(code === "invalid" && { fieldErrors: { title: error } }) },
          status,
        );
      renderBacklog();
      const sheet = await openSheet();
      await userEvent.selectOptions(field(sheet, "Repo"), REPO_WEB);
      await fill(sheet, "Dunning emails", "Remind customers.");
      await userEvent.click(triageBox(sheet));
      await userEvent.click(createButton(sheet));

      const alert = await within(sheet).findByRole("alert");
      expect(alert.textContent).toBe(error);
      expect(screen.getByRole("dialog", { name: "New work item" })).toBe(sheet);
      expect(field(sheet, "Repo").value).toBe(REPO_WEB);
      expect(field(sheet, "Title").value).toBe("Dunning emails");
      expect(field(sheet, "Description").value).toBe("Remind customers.");
      expect(triageBox(sheet).checked).toBe(false);
      expect(field(sheet, "Title").getAttribute("aria-invalid")).toBe(
        code === "invalid" ? "true" : null,
      );
      expect(createButton(sheet).disabled).toBe(false);
      // Only the + navigated (opening the sheet): no item opened.
      expect(nav.router.push.mock.calls.map(([href]) => href)).toEqual(["/backlog?new=1"]);
      expect(listTitles("Needs refining")).toEqual(["Rough idea: dunning emails"]);
      expect(screen.getByTestId("counts").textContent).toBe("1/1/2");
    },
  );

  it("closes with Cancel, creating nothing", async () => {
    renderBacklog();
    const sheet = await openSheet();
    await fill(sheet, "Dunning emails");
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(requests("POST", "/api/ui/work-items")).toHaveLength(0);
  });

  it("says when no repo picks up work items", async () => {
    targets = [];
    renderBacklog();
    await screen.findByRole("list", { name: "Ready to start" });
    await userEvent.click(screen.getAllByRole("button", { name: "New work item" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "New work item" });
    await waitFor(() =>
      expect(within(sheet).getByRole("option").textContent).toBe("No repo picks up work items yet"),
    );
    expect(createButton(sheet).disabled).toBe(true);
  });
});
