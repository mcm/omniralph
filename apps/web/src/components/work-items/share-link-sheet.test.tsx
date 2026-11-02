// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
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
import type { CreateShareLinkResponse, ShareLink, WorkItemDetail } from "@/lib/api/work-items";
import { BacklogView } from "@/screens/backlog/backlog-view";
import { backlogOf, workItemRow } from "@/screens/backlog/test-fixtures";
import { expiresOn } from "./share-link-sheet";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/backlog",
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
const ID = "linear-issue-412";
const LINKS_PATH = `/api/ui/work-items/${ID}/share-links`;

const row = workItemRow();
const detail: WorkItemDetail = {
  ...row,
  state: { category: "todo", name: "Todo" },
  description: "## Introduction\n\nExport every invoice.\n",
  updatedAt: "2026-10-26T10:00:00.000Z",
  blockedBy: [],
  route: {
    outcome: "repository",
    repository: row.repository,
    via: { kind: "project", label: "Portal project" },
    by: "work item match (Portal project)",
  },
  stories: [],
  activity: [],
  triageRunning: false,
  triageQuestions: null,
  run: null,
  actions: {
    start: true,
    triage: true,
    editPrd: true,
    changeRepo: true,
    move: true,
    cancel: true,
  },
};

const link = (overrides: Partial<ShareLink> = {}): ShareLink => ({
  id: "11111111-1111-4111-8111-111111111111",
  protected: false,
  createdAt: "2026-10-24T09:00:00.000Z",
  expiresAt: "2026-11-23T09:00:00.000Z",
  createdBy: { name: "Steve McMaster" },
  ...overrides,
});
const OPEN_LINK = link();
const PROTECTED = link({
  id: "22222222-2222-4222-8222-222222222222",
  protected: true,
  expiresAt: "2026-11-25T09:00:00.000Z",
});
const NEW_LINK = link({
  id: "33333333-3333-4333-8333-333333333333",
  protected: true,
  createdAt: "2026-10-27T09:00:00.000Z",
  expiresAt: "2026-11-26T09:00:00.000Z",
});
const NEW_URL = "https://omniralph.test/share/abcDEF123";

let links: ShareLink[];
let createAnswer: () => Response | Promise<Response>;
let revokeAnswer: () => Response | Promise<Response>;
let seen: SeenRequest[];
let client: QueryClient;

beforeEach(() => {
  ui.toast.mockReset();
  links = [OPEN_LINK, PROTECTED];
  createAnswer = () => {
    links = [...links, NEW_LINK];
    return jsonResponse({ link: NEW_LINK, url: NEW_URL } satisfies CreateShareLinkResponse, 201);
  };
  revokeAnswer = () => jsonResponse({ ok: true });
  client = createTestQueryClient();
  seen = mockFetch({
    "GET /api/ui/backlog": () => jsonResponse(backlogOf([row])),
    [`GET /api/ui/work-items/${ID}`]: () => jsonResponse(detail),
    [`GET ${LINKS_PATH}`]: () => jsonResponse({ links }),
    [`POST ${LINKS_PATH}`]: () => createAnswer(),
    [`DELETE /api/ui/share-links/${OPEN_LINK.id}`]: () => revokeAnswer(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderBacklog(live?: ReturnType<typeof fakeAbly>) {
  const view = <BacklogView workItemId={ID} />;
  return render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
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

/** Opens the sheet from the detail's toolbar, once the item and its links have loaded. */
async function openSheet() {
  const toolbar = await screen.findByRole("toolbar", { name: "Work item actions" });
  await userEvent.click(within(toolbar).getByRole("button", { name: "Share review link" }));
  const sheet = await screen.findByRole("dialog", { name: "Share review link" });
  await within(sheet).findByText(expiresOn(OPEN_LINK.expiresAt));
  return sheet;
}

const activeList = (sheet: HTMLElement) =>
  within(sheet).getByRole("region", { name: "Active links" });
const linkRows = (sheet: HTMLElement) => within(activeList(sheet)).queryAllByRole("listitem");
const linkTexts = (sheet: HTMLElement) =>
  linkRows(sheet).map(
    (item) => within(item).getByText(/^Expires /, { selector: "span" }).textContent,
  );

describe("expiresOn", () => {
  it("names the expiry day as the review page does", () => {
    expect(expiresOn("2026-11-23T09:00:00.000Z")).toBe("Expires Nov 23");
    // UTC, like the public page: late on the 23rd in UTC is still the 23rd.
    expect(expiresOn("2026-11-23T23:30:00.000Z")).toBe("Expires Nov 23");
  });
});

describe("Share review link sheet", () => {
  it("opens from the toolbar with an optional password field and Create link", async () => {
    renderBacklog();
    const sheet = await openSheet();
    const password = within(sheet).getByLabelText(/Password \(optional\)/);
    expect(password.getAttribute("type")).toBe("password");
    expect((password as HTMLInputElement).value).toBe("");
    expect(within(sheet).getByRole("button", { name: "Create link" })).toBeTruthy();
    expect(within(sheet).queryByRole("textbox", { name: "Review link" })).toBeNull();

    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Share review link" })).toBeNull(),
    );
  });

  it("lists the active links with their expiry, a lock on protected ones, and Revoke", async () => {
    renderBacklog();
    const sheet = await openSheet();
    expect(linkTexts(sheet)).toEqual(["Expires Nov 23", "Expires Nov 25"]);
    const [open, locked] = linkRows(sheet);
    expect(within(open!).queryByRole("img", { name: "Password protected" })).toBeNull();
    expect(within(locked!).getByRole("img", { name: "Password protected" })).toBeTruthy();
    for (const item of [open!, locked!]) {
      expect(within(item).getByRole("button", { name: "Revoke" })).toBeTruthy();
    }
    expect(seen.find((r) => r.path === LINKS_PATH)?.query.get("organization")).toBe(ORG);
  });

  it("says when there are no active links", async () => {
    links = [];
    renderBacklog();
    const toolbar = await screen.findByRole("toolbar", { name: "Work item actions" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Share review link" }));
    const sheet = await screen.findByRole("dialog", { name: "Share review link" });
    expect(await within(sheet).findByText("No active links.")).toBeTruthy();
  });

  it("creates a link with the password, then shows it once with Copy and its expiry", async () => {
    const writeText = vi.fn(async () => {});
    const held = deferred();
    createAnswer = () => {
      links = [...links, NEW_LINK];
      return held.promise;
    };
    renderBacklog();
    const sheet = await openSheet();
    await userEvent.type(within(sheet).getByLabelText(/Password \(optional\)/), "s3cret");
    await userEvent.click(within(sheet).getByRole("button", { name: "Create link" }));

    const post = seen.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ password: "s3cret" });
    expect(post?.query.get("organization")).toBe(ORG);
    expect(
      (within(sheet).getByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () =>
      held.resolve(
        jsonResponse({ link: NEW_LINK, url: NEW_URL } satisfies CreateShareLinkResponse, 201),
      ),
    );
    const url = (await within(sheet).findByRole("textbox", {
      name: "Review link",
    })) as HTMLInputElement;
    expect(url.value).toBe(NEW_URL);
    expect(url.readOnly).toBe(true);
    const created = within(sheet).getByRole("region", { name: "New review link" });
    expect(within(created).getByText(/^Expires Nov 26\./)).toBeTruthy();
    // The new link joins the list, protected; the password field is cleared.
    await waitFor(() =>
      expect(linkTexts(sheet)).toEqual(["Expires Nov 23", "Expires Nov 25", "Expires Nov 26"]),
    );
    expect(
      within(linkRows(sheet)[2]!).getByRole("img", { name: "Password protected" }),
    ).toBeTruthy();
    expect((within(sheet).getByLabelText(/Password \(optional\)/) as HTMLInputElement).value).toBe(
      "",
    );
    expect(ui.toast).toHaveBeenCalledWith("Review link created");

    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(within(created).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(NEW_URL);
    expect(ui.toast).toHaveBeenCalledWith("Link copied");
  });

  it("creates a link without a password", async () => {
    renderBacklog();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Create link" }));
    await within(sheet).findByRole("textbox", { name: "Review link" });
    expect(seen.find((r) => r.method === "POST")?.body).toEqual({ password: "" });
  });

  it("shows the server's refusal and creates nothing", async () => {
    createAnswer = () =>
      jsonResponse(
        {
          error: "SOC-412 has 10 active review links. Revoke one first.",
          code: "share_link_limit",
        },
        400,
      );
    renderBacklog();
    const sheet = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "SOC-412 has 10 active review links. Revoke one first.",
        { variant: "danger" },
      ),
    );
    expect(within(sheet).queryByRole("textbox", { name: "Review link" })).toBeNull();
    expect(linkTexts(sheet)).toEqual(["Expires Nov 23", "Expires Nov 25"]);
  });

  it("removes a revoked link at once, before the server answers", async () => {
    const held = deferred();
    revokeAnswer = () => {
      links = [PROTECTED];
      return held.promise;
    };
    renderBacklog();
    const sheet = await openSheet();
    await userEvent.click(within(linkRows(sheet)[0]!).getByRole("button", { name: "Revoke" }));

    expect(linkTexts(sheet)).toEqual(["Expires Nov 25"]);
    expect(seen.some((r) => r.method === "DELETE")).toBe(true);

    await act(async () => held.resolve(jsonResponse({ ok: true })));
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith("Review link revoked"));
    expect(linkTexts(sheet)).toEqual(["Expires Nov 25"]);
  });

  it("puts a link back when revoking fails", async () => {
    const held = deferred();
    revokeAnswer = () => held.promise;
    renderBacklog();
    const sheet = await openSheet();
    await userEvent.click(within(linkRows(sheet)[0]!).getByRole("button", { name: "Revoke" }));
    expect(linkTexts(sheet)).toEqual(["Expires Nov 25"]);

    await act(async () => held.resolve(jsonResponse({ error: "Couldn't revoke the link." }, 500)));
    await waitFor(() => expect(linkTexts(sheet)).toEqual(["Expires Nov 23", "Expires Nov 25"]));
    expect(ui.toast).toHaveBeenCalledWith("Couldn't revoke the link.", { variant: "danger" });
  });
});

describe("Share review link sheet live", () => {
  const subscribed = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() => expect(live.current().subscribed()).toContain(`org:${ORG}:changes`));
  const deliver = (live: ReturnType<typeof fakeAbly>, ids: string[]) =>
    act(() =>
      live
        .current()
        .deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "work_item", ids })),
    );
  const linkFetches = () => seen.filter((r) => r.method === "GET" && r.path === LINKS_PATH);

  it("refreshes the list on a work_item event for the item", async () => {
    const live = fakeAbly();
    renderBacklog(live);
    const sheet = await openSheet();
    await subscribed(live);
    const before = linkFetches().length;

    // Someone else created a link, and revoked the open one.
    links = [PROTECTED, NEW_LINK];
    deliver(live, [ID]);
    await waitFor(() => expect(linkTexts(sheet)).toEqual(["Expires Nov 25", "Expires Nov 26"]));
    expect(linkFetches().length).toBe(before + 1);
  });

  it("ignores another item's events", async () => {
    const live = fakeAbly();
    renderBacklog(live);
    const sheet = await openSheet();
    await subscribed(live);
    const before = linkFetches().length;

    links = [];
    deliver(live, ["linear-issue-999"]);
    // The Backlog list refetches (any work_item event); this item's links don't.
    await waitFor(() =>
      expect(seen.filter((r) => r.path === "/api/ui/backlog").length).toBeGreaterThan(1),
    );
    expect(linkFetches().length).toBe(before);
    expect(linkTexts(sheet)).toEqual(["Expires Nov 23", "Expires Nov 25"]);
  });
});
