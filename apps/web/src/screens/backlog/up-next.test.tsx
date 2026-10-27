// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { nestedInteractiveElements, UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
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
import type { Backlog } from "@/lib/api/backlog";
import { backlogKeys, queryKeys } from "@/lib/api/keys";
import type { WorkItemDetail, WorkItemRow } from "@/lib/api/work-items";
import { InboxEmptyState } from "../inbox/inbox-empty-state";
import { useBacklog, useBacklogCounts } from "./queries";
import { backlogOf, BETA_ID, blockedRow, refineRow, workItemRow } from "./test-fixtures";
import { InboxUpNext, UP_NEXT } from "./up-next";
import { NO_BACKLOG_FILTERS } from "./url";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
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

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ORG = TEST_ORGANIZATION_ID;

const allOrganizations: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA_ID, name: "Beta", role: "member" },
  ],
};

const readyRows = () => [
  workItemRow(),
  blockedRow(),
  workItemRow({ id: "linear-issue-414", identifier: "SOC-414", title: "Archive old invoices" }),
];
const refiningRows = () => [
  refineRow(),
  workItemRow({
    id: "linear-issue-421",
    identifier: "SOC-421",
    title: "Idea: invoice templates",
    group: "refine",
    size: null,
  }),
];

/** The whole Backlog, whose first rows Up next answers. */
let backlog: Backlog;
let seen: SeenRequest[];
let act409: (() => Response | Promise<Response>) | null;
let answer: () => Response | Promise<Response>;

function serve() {
  answer = () => jsonResponse({ ok: true });
  act409 = null;
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
    "POST /api/ui/work-items/linear-issue-412/start": () => (act409 ?? answer)(),
    "POST /api/ui/work-items/linear-issue-413/start": () => (act409 ?? answer)(),
    "POST /api/ui/work-items/linear-issue-420/triage": () => (act409 ?? answer)(),
  });
}

/** The Backlog list's titles and the counts, as the Backlog screen and the nav show them. */
function Observers() {
  const list = useBacklog(NO_BACKLOG_FILTERS);
  const counts = useBacklogCounts();
  const titles = list.data
    ? [...list.data.groups.readyToStart, ...list.data.groups.needsRefining].map((row) => row.title)
    : [];
  return (
    <>
      <p data-testid="list">{titles.join(" | ")}</p>
      <p data-testid="counts">
        {counts.data ? `${counts.data.readyToStart}/${counts.data.needsRefining}` : ""}
      </p>
    </>
  );
}

function renderEmptyInbox(
  options: { user?: SessionUser; client?: QueryClient; live?: ReturnType<typeof fakeAbly> } = {},
) {
  const client = options.client ?? createTestQueryClient();
  const content = (
    <>
      <InboxEmptyState running={null} upNext={<InboxUpNext />} />
      <Observers />
    </>
  );
  const utils = render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          {options.live ? (
            <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
              {content}
            </LiveProvider>
          ) : (
            content
          )}
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return { ...utils, client };
}

const upNext = () => screen.getByRole("region", { name: UP_NEXT });
const group = (name: string) => within(upNext()).getByRole("list", { name });
const rowsOf = (name: string) => within(group(name)).getAllByRole("listitem");
const rowTitles = (name: string) =>
  Array.from(
    within(upNext()).queryByRole("list", { name })?.querySelectorAll(".or-row__title") ?? [],
    (title) => title.textContent,
  );
const requests = (method: string, path: string) =>
  seen.filter((request) => request.method === method && request.path === path);

beforeEach(() => {
  ui.toast.mockReset();
  backlog = backlogOf([...readyRows(), ...refiningRows()]);
  serve();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Up next in the empty Inbox", () => {
  it("shows Up next with the Backlog link, three Ready rows with Start epic and two Needs refining rows with Triage now", async () => {
    backlog = backlogOf([
      ...readyRows(),
      workItemRow({ id: "linear-issue-415", identifier: "SOC-415", title: "Fourth ready" }),
      ...refiningRows(),
      refineRow(),
    ]);
    renderEmptyInbox();
    expect(screen.getByRole("heading", { name: "Nothing needs you" })).toBeTruthy();
    await screen.findByRole("region", { name: UP_NEXT });

    expect(within(upNext()).getByRole("heading", { name: UP_NEXT })).toBeTruthy();
    expect(within(upNext()).getByRole("link", { name: "Backlog" }).getAttribute("href")).toBe(
      "/backlog",
    );
    expect(within(upNext()).getByRole("heading", { name: "Ready to start" })).toBeTruthy();
    expect(within(upNext()).getByRole("heading", { name: "Needs refining" })).toBeTruthy();

    expect(rowTitles("Ready to start")).toEqual([
      "Export invoices as CSV",
      "Send invoice reminders",
      "Archive old invoices",
    ]);
    expect(rowTitles("Needs refining")).toEqual([
      "Rough idea: dunning emails",
      "Idea: invoice templates",
    ]);
    for (const row of rowsOf("Ready to start")) {
      const identifier = row.querySelector(".or-row__meta .or-ref__text")?.textContent;
      expect(within(row).getByRole("button", { name: `Start epic ${identifier}` })).toBeTruthy();
      expect(within(row).queryByRole("button", { name: /Triage now/ })).toBeNull();
    }
    for (const row of rowsOf("Needs refining")) {
      expect(within(row).getByRole("button", { name: /^Triage now SOC-/ })).toBeTruthy();
      expect(within(row).queryByRole("button", { name: /Start epic/ })).toBeNull();
    }
    // One organization: no organization badge.
    expect(within(upNext()).queryByText("Acme")).toBeNull();
  });

  it("shows the organization badge only under All organizations", async () => {
    backlog = backlogOf([
      workItemRow(),
      refineRow(),
      workItemRow({
        id: "linear-issue-500",
        identifier: "NET-500",
        organization: { id: BETA_ID, name: "Beta", role: "member" },
      }),
    ]);
    renderEmptyInbox({ user: allOrganizations });
    await screen.findByRole("region", { name: UP_NEXT });
    const [acme, beta] = rowsOf("Ready to start");
    expect(within(acme!).getByText("Acme")).toBeTruthy();
    expect(within(beta!).getByText("Beta")).toBeTruthy();
    expect(within(rowsOf("Needs refining")[0]!).getByText("Acme")).toBeTruthy();
    expect(
      seen.find((request) => request.path === "/api/ui/backlog/up-next")?.query.get("organization"),
    ).toBe("all");
  });

  it("renders nothing when both lists are empty", async () => {
    backlog = backlogOf([]);
    const { container } = renderEmptyInbox();
    await waitFor(() => expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("0/0"));
    expect(screen.queryByRole("region", { name: UP_NEXT })).toBeNull();
    expect(container.querySelector(".or-inbox-empty__up-next")?.childNodes).toHaveLength(0);
    expect(screen.queryByText(UP_NEXT)).toBeNull();
  });

  it("shows only the group that has items", async () => {
    backlog = backlogOf(refiningRows());
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    expect(within(upNext()).queryByRole("heading", { name: "Ready to start" })).toBeNull();
    expect(rowTitles("Needs refining")).toHaveLength(2);
  });

  it("links each row to its Backlog detail, with its button beside the row link, never inside it", async () => {
    const { container } = renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    for (const row of [...rowsOf("Ready to start"), ...rowsOf("Needs refining")]) {
      const link = row.querySelector<HTMLAnchorElement>("a.or-row__link")!;
      expect(link.getAttribute("href")).toMatch(/^\/backlog\/linear-issue-\d+$/);
      const button = within(row).getByRole("button");
      expect(link.contains(button)).toBe(false);
      expect(button.closest("a, button")).toBe(button);
      expect(nestedInteractiveElements(row)).toEqual([]);
    }
    expect(rowsOf("Ready to start")[0]!.querySelector("a")!.getAttribute("href")).toBe(
      "/backlog/linear-issue-412",
    );
    expect(nestedInteractiveElements(container)).toEqual([]);
  });

  it("shows the Backlog's badges, with Blocked on a blocked row", async () => {
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    const [ready, blocked] = rowsOf("Ready to start");
    expect(within(blocked!).getByRole("img", { name: "Blocked" })).toBeTruthy();
    expect(within(ready!).queryByRole("img", { name: "Blocked" })).toBeNull();
    expect(within(ready!).getByText("SOC-412")).toBeTruthy();
    expect(within(ready!).getByText("acme/portal")).toBeTruthy();
  });
});

describe("Start epic", () => {
  it("removes the item from Up next, the Backlog list and the counts before the server answers", async () => {
    const response = deferred();
    answer = () => response.promise;
    const { client } = renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/2"));
    await waitFor(() => expect(screen.getByTestId("list").textContent).toMatch(/^Export/));
    client.setQueryData(
      backlogKeys(queryKeys(ORG)).detail("linear-issue-412"),
      detailOf(workItemRow()),
    );

    await userEvent.click(screen.getByRole("button", { name: "Start epic SOC-412" }));

    await waitFor(() =>
      expect(rowTitles("Ready to start")).toEqual([
        "Send invoice reminders",
        "Archive old invoices",
      ]),
    );
    expect(screen.getByTestId("list").textContent).not.toContain("Export invoices as CSV");
    expect(screen.getByTestId("counts").textContent).toBe("2/2");
    expect(
      client.getQueryData<WorkItemDetail>(backlogKeys(queryKeys(ORG)).detail("linear-issue-412"))
        ?.actions.start,
    ).toBe(false);
    const [start] = requests("POST", "/api/ui/work-items/linear-issue-412/start");
    expect(start?.query.get("organization")).toBe(ORG);

    // The run started: the Backlog no longer lists it.
    backlog = backlogOf([blockedRow(), readyRows()[2]!, ...refiningRows()]);
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Om is starting SOC-412"));
    await waitFor(() => expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(2));
    expect(rowTitles("Ready to start")).toEqual(["Send invoice reminders", "Archive old invoices"]);
    expect(screen.getByTestId("counts").textContent).toBe("2/2");
  });

  it("puts the item back with the server's message when it fails", async () => {
    const response = deferred();
    act409 = () => response.promise;
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    await waitFor(() => expect(screen.getByTestId("counts").textContent).toBe("3/2"));

    await userEvent.click(screen.getByRole("button", { name: "Start epic SOC-412" }));
    await waitFor(() => expect(rowTitles("Ready to start")).toHaveLength(2));
    expect(screen.getByTestId("counts").textContent).toBe("2/2");

    await act(async () =>
      response.resolve(jsonResponse({ error: "SOC-412 already has a run." }, 409)),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("SOC-412 already has a run.", { variant: "danger" }),
    );
    await waitFor(() => expect(rowTitles("Ready to start")).toHaveLength(3));
    expect(screen.getByTestId("counts").textContent).toBe("3/2");
    expect(screen.getByTestId("list").textContent).toContain("Export invoices as CSV");
  });

  it("on a blocked item says what it waits for and confirms before starting", async () => {
    const user = userEvent.setup();
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    const button = screen.getByRole("button", { name: "Start epic SOC-413" });

    await user.hover(button);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Starts when SOC-398 and SOC-401 are done",
    );

    await user.click(button);
    const dialog = await screen.findByRole("alertdialog", { name: "Start SOC-413?" });
    expect(dialog.textContent).toContain("Om will wait for its blockers to finish.");
    expect(requests("POST", "/api/ui/work-items/linear-issue-413/start")).toHaveLength(0);

    // Cancel starts nothing.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(requests("POST", "/api/ui/work-items/linear-issue-413/start")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Start epic SOC-413" }));
    const again = await screen.findByRole("alertdialog", { name: "Start SOC-413?" });
    backlog = backlogOf([workItemRow(), readyRows()[2]!, ...refiningRows()]);
    await user.click(within(again).getByRole("button", { name: "Start epic" }));
    await waitFor(() =>
      expect(requests("POST", "/api/ui/work-items/linear-issue-413/start")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(rowTitles("Ready to start")).toEqual([
        "Export invoices as CSV",
        "Archive old invoices",
      ]),
    );
  });

  it("starts an unblocked item in one click, without a confirm", async () => {
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    await userEvent.click(screen.getByRole("button", { name: "Start epic SOC-412" }));
    await waitFor(() =>
      expect(requests("POST", "/api/ui/work-items/linear-issue-412/start")).toHaveLength(1),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Triage now", () => {
  it("disables the button with Om is triaging before the server answers, in Up next, the list and the detail", async () => {
    const user = userEvent.setup();
    const response = deferred();
    answer = () => response.promise;
    const { client } = renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    await waitFor(() => expect(screen.getByTestId("list").textContent).toContain("Rough idea"));
    client.setQueryData(
      backlogKeys(queryKeys(ORG)).detail("linear-issue-420"),
      detailOf(refineRow()),
    );

    await user.click(screen.getByRole("button", { name: "Triage now SOC-420" }));

    const button = screen.getByRole("button", { name: "Triage now SOC-420" });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    const listed = client
      .getQueriesData<Backlog>({ queryKey: backlogKeys(queryKeys(ORG)).lists })
      .flatMap(([, data]) => data?.groups.needsRefining ?? [])
      .find((row) => row.id === "linear-issue-420");
    expect(listed?.triageRunning).toBe(true);
    const detail = client.getQueryData<WorkItemDetail>(
      backlogKeys(queryKeys(ORG)).detail("linear-issue-420"),
    );
    expect(detail).toMatchObject({ triageRunning: true, actions: { triage: false } });

    await user.unhover(button);
    await user.hover(screen.getByRole("button", { name: "Triage now SOC-420" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe("Om is triaging SOC-420");
    // A second click does nothing while it's disabled.
    await user.click(button);
    expect(requests("POST", "/api/ui/work-items/linear-issue-420/triage")).toHaveLength(1);

    // The server now reports the triage running.
    backlog = backlogOf([
      ...readyRows(),
      { ...refineRow(), triageRunning: true },
      refiningRows()[1]!,
    ]);
    await act(async () => response.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Om is triaging SOC-420"));
    await waitFor(() => expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(2));
    expect(
      screen.getByRole("button", { name: "Triage now SOC-420" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("enables the button again with the server's message when it fails", async () => {
    const response = deferred();
    act409 = () => response.promise;
    renderEmptyInbox();
    await screen.findByRole("region", { name: UP_NEXT });
    await userEvent.click(screen.getByRole("button", { name: "Triage now SOC-420" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Triage now SOC-420" }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    await act(async () =>
      response.resolve(jsonResponse({ error: "Om is already triaging SOC-420." }, 409)),
    );
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Om is already triaging SOC-420.", {
        variant: "danger",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Triage now SOC-420" }).getAttribute("aria-disabled"),
      ).toBeNull(),
    );
  });
});

describe("live updates", () => {
  it("a published work_item event refetches Up next, which shows the new data", async () => {
    const live = fakeAbly();
    renderEmptyInbox({ live });
    await screen.findByRole("region", { name: UP_NEXT });
    await waitFor(() => expect(live.current().subscribed()).toContain(`org:${ORG}:changes`));
    expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(1);

    backlog = backlogOf([
      workItemRow({ id: "linear-issue-999", identifier: "SOC-999", title: "Triaged just now" }),
      ...readyRows(),
      ...refiningRows(),
    ]);
    act(() =>
      live
        .current()
        .deliver(
          `org:${ORG}:changes`,
          changeEvent(ORG, { resource: "work_item", ids: ["linear-issue-999"] }),
        ),
    );
    await waitFor(() => expect(requests("GET", "/api/ui/backlog/up-next")).toHaveLength(2));
    await waitFor(() =>
      expect(rowTitles("Ready to start")).toEqual([
        "Triaged just now",
        "Export invoices as CSV",
        "Send invoice reminders",
      ]),
    );
  });
});

/** A cached detail for `row`, offering every action its group allows. */
function detailOf(row: WorkItemRow): WorkItemDetail {
  const ready = row.group === "ready";
  return {
    ...row,
    group: row.group,
    state: { category: ready ? "todo" : "backlog", name: ready ? "Todo" : "Backlog" },
    description: "",
    updatedAt: "2026-10-26T10:00:00.000Z",
    blockedBy: [],
    route: { outcome: "ask", repository: null, via: null, by: null },
    stories: [],
    activity: [],
    triageRunning: false,
    run: null,
    actions: {
      start: ready,
      triage: true,
      editPrd: true,
      changeRepo: true,
      move: ready,
      cancel: true,
    },
  };
}
