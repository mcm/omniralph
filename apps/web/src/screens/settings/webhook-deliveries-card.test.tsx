// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
import { ShowAdvancedProvider } from "@/components/show-advanced";
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import type { Connection, ConnectionProvider } from "@/lib/api/connections";
import type { DeliveryDetail, DeliveryRow } from "@/lib/api/deliveries";
import { ConnectionSettings } from "./connection-settings";
import { SettingsLayoutView } from "./settings-layout-view";
import { DELIVERIES_RETENTION_NOTE, NO_DELIVERIES, REPLAYING } from "./webhook-deliveries-card";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  pathname: "/settings",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const REPO_ID = "99999999-9999-4999-8999-999999999999";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const IDS: Record<ConnectionProvider, string> = {
  github: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  gitlab: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  linear: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  slack: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  discord: "ffffffff-ffff-4fff-8fff-ffffffffffff",
};
const KIND: Record<"github" | "gitlab" | "linear", "scm" | "linear"> = {
  github: "scm",
  gitlab: "scm",
  linear: "linear",
};
const D = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function connection(provider: ConnectionProvider, overrides: Partial<Connection> = {}): Connection {
  const chat = provider === "slack" || provider === "discord";
  return {
    provider,
    id: IDS[provider],
    name: provider === "gitlab" ? "om @ gitlab.netbuilder.io" : "Acme",
    host:
      provider === "github" ? "github.com" : provider === "gitlab" ? "gitlab.example.com" : null,
    account: "acme",
    health: { state: "connected", problems: [] },
    reposUsing: chat ? null : 2,
    usedAs: chat ? "chat" : provider === "linear" ? "tracker" : "code_host",
    linkedAccounts: chat ? 1 : null,
    failedDeliveries: 0,
    instanceUrl: null,
    installationUrl: null,
    history: null,
    ...overrides,
  };
}

/** Today at 10:15, local time. */
const today = (() => {
  const date = new Date();
  date.setHours(10, 15, 0, 0);
  return date;
})();

function delivery(n: number, overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: D(n),
    provider: "github",
    connection: { kind: "scm", id: IDS.github },
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    repository: { id: REPO_ID, provider: "github", fullPath: "acme/app" },
    deliveryId: `d-${n}`,
    event: "pull_request.synchronize",
    outcome: "started_run",
    reasonCode: null,
    reason: null,
    run: { id: RUN_ID, kind: "review" },
    replayOfId: null,
    replayedBy: null,
    replayed: false,
    payloadTruncated: false,
    receivedAt: new Date(today.getTime() - n * 60_000).toISOString(),
    ...overrides,
  };
}

const failed = (n: number, overrides: Partial<DeliveryRow> = {}) =>
  delivery(n, {
    outcome: "failed",
    reasonCode: "handler_failed",
    reason: "No agent online for this repo",
    run: null,
    ...overrides,
  });

const ignored = (n: number) =>
  delivery(n, {
    event: "pull_request.edited",
    outcome: "ignored",
    reasonCode: "unsupported_event",
    reason: "Omniralph doesn't act on this event",
    run: null,
  });

let connections: Connection[];
/** Each filter's pages: `deliveries[filter][cursor ?? ""]`. */
let pages: Record<string, Record<string, { deliveries: DeliveryRow[]; nextCursor: string | null }>>;
let seen: SeenRequest[];
/** While set, reads never answer: the view shows only what the cache holds. */
let holdReads: boolean;
let replayResponse: () => Response | Promise<Response>;

const pending = () => new Promise<Response>(() => {});

function listOf(deliveries: DeliveryRow[]) {
  return { "": { deliveries, nextCursor: null } };
}

function replayAnswer(overrides: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    ...delivery(0, {
      id: D(100),
      replayOfId: D(2),
      replayedBy: { id: testUser.id, name: "Ada" },
      receivedAt: new Date().toISOString(),
    }),
    payload: {},
    replays: [],
    ...overrides,
  };
}

beforeEach(() => {
  ui.toast.mockReset();
  connections = (Object.keys(IDS) as ConnectionProvider[]).map((provider) =>
    connection(provider, provider === "github" ? { failedDeliveries: 2 } : {}),
  );
  pages = {
    all: listOf([delivery(1), failed(2), ignored(3), failed(4)]),
    failed: listOf([failed(2), failed(4)]),
    ignored: listOf([ignored(3)]),
  };
  holdReads = false;
  replayResponse = () => {
    holdReads = true;
    return jsonResponse(replayAnswer());
  };
  const deliveries = (request: SeenRequest) => {
    if (holdReads) return pending();
    const outcome = request.query.getAll("outcome");
    const filter = outcome.length === 0 ? "all" : outcome.join(",");
    const page = pages[filter]?.[request.query.get("cursor") ?? ""];
    return jsonResponse(page ?? { deliveries: [], nextCursor: null });
  };
  seen = mockFetch({
    "GET /api/ui/connections": () =>
      holdReads ? pending() : jsonResponse({ connections: structuredClone(connections) }),
    [`GET /api/ui/connections/scm/${IDS.github}/deliveries`]: deliveries,
    [`GET /api/ui/connections/scm/${IDS.gitlab}/deliveries`]: deliveries,
    [`GET /api/ui/connections/linear/${IDS.linear}/deliveries`]: deliveries,
    [`POST /api/ui/deliveries/${D(2)}/replay`]: () => replayResponse(),
    [`POST /api/ui/deliveries/${D(3)}/replay`]: () => {
      holdReads = true;
      return jsonResponse(replayAnswer({ id: D(101), replayOfId: D(3) }));
    },
    "GET /api/ui/nav-indicators": () => pending(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderConnection(
  provider: ConnectionProvider,
  options: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {},
) {
  nav.pathname = `/settings/connections/${provider}/${IDS[provider]}`;
  const client = createTestQueryClient();
  const page = (
    <SettingsLayoutView>
      <ConnectionSettings provider={provider} connectionId={IDS[provider]} />
    </SettingsLayoutView>
  );
  render(
    <CurrentUserProvider user={options.user ?? testUser}>
      <ShowAdvancedProvider initial={false}>
        <QueryClientProvider client={client}>
          <UiProvider linkComponent={TestLink}>
            <UnsavedChangesProvider>
              {options.live ? (
                <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                  {page}
                </LiveProvider>
              ) : (
                page
              )}
            </UnsavedChangesProvider>
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
  return { client };
}

const card = () => screen.findByRole("region", { name: "Webhook deliveries" });
const filters = async () =>
  within(await card()).getByRole("radiogroup", { name: "Show deliveries" });
const table = () => screen.findByRole("table", { name: "Webhook deliveries" });
const phoneCards = () => document.querySelector<HTMLUListElement>("ul.or-cards")!;

/** The table's rows as cell texts (badges' icons left out). */
async function tableRows(): Promise<string[][]> {
  const body = (await table()).querySelector("tbody")!;
  return Array.from(body.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("td")).map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("svg, title").forEach((node) => node.remove());
      return copy.textContent!.trim();
    }),
  );
}

const rowOf = async (index: number) =>
  (await table()).querySelectorAll<HTMLTableRowElement>("tbody tr")[index]!;
const deliveryReads = (provider: "github" | "gitlab" | "linear" = "github") =>
  seen.filter(
    (request) =>
      request.method === "GET" &&
      request.path === `/api/ui/connections/${KIND[provider]}/${IDS[provider]}/deliveries`,
  );

describe("the deliveries section", () => {
  it.each(["github", "gitlab", "linear"] as const)(
    "%s: Webhook deliveries with All / Failed N / Ignored, the table and the retention note",
    async (provider) => {
      if (provider !== "github") {
        pages.all = listOf([
          delivery(1, {
            provider,
            connection: { kind: KIND[provider], id: IDS[provider] },
            event: provider === "gitlab" ? "Merge Request Hook.open" : "AgentSessionEvent.created",
            repository:
              provider === "gitlab"
                ? { id: REPO_ID, provider: "gitlab", fullPath: "acme/app" }
                : null,
            run: { id: RUN_ID, kind: provider === "gitlab" ? "review" : "epic" },
          }),
        ]);
      }
      renderConnection(provider);
      const section = await card();
      expect(within(section).getByRole("heading", { name: "Webhook deliveries" })).toBeTruthy();
      const options = within(await filters()).getAllByRole("radio");
      expect(options.map((option) => option.textContent)).toEqual([
        "All",
        provider === "github" ? "Failed 2" : "Failed 0",
        "Ignored",
      ]);
      expect(options[0]!.getAttribute("aria-checked")).toBe("true");
      // Coral only while there are failures.
      expect(options[1]!.classList.contains("or-seg__option--fail")).toBe(provider === "github");
      const headers = Array.from((await table()).querySelectorAll("thead th")).map(
        (th) => th.textContent,
      );
      expect(headers).toEqual(["Received", "Event", "Repo", "Outcome", "Actions"]);
      const first = (await tableRows())[0]!;
      expect(first[1]).toBe(
        {
          github: "Pull request · updated",
          gitlab: "Merge request · opened",
          linear: "Work item delegated",
        }[provider],
      );
      expect(first[3]).toBe(provider === "linear" ? "Epic started" : "Review started");
      expect(deliveryReads(provider)[0]!.query.getAll("outcome")).toEqual([]);
      expect(within(section).getByText(DELIVERIES_RETENTION_NOTE)).toBeTruthy();
    },
  );

  it.each(["slack", "discord"] as const)("%s: no deliveries section", async (provider) => {
    renderConnection(provider);
    await screen.findByRole("region", { name: "Connection summary" });
    expect(screen.queryByRole("region", { name: "Webhook deliveries" })).toBeNull();
    expect(screen.queryByText(DELIVERIES_RETENTION_NOTE)).toBeNull();
    expect(seen.some((request) => request.path.endsWith("/deliveries"))).toBe(false);
  });

  it("shows when each came in (mono; the date when not today), the event, repo and outcome", async () => {
    const yesterday = new Date(today.getTime() - 86_400_000).toISOString();
    pages.all = listOf([delivery(1), failed(2, { receivedAt: yesterday }), ignored(3)]);
    renderConnection("github");
    const rows = await tableRows();
    // Today: the time alone.
    expect(rows[0]![0]).toBe(
      new Date(delivery(1).receivedAt).toLocaleTimeString(undefined, { timeStyle: "short" }),
    );
    // Another day: with the date.
    expect(rows[1]![0]).not.toBe(
      new Date(yesterday).toLocaleTimeString(undefined, { timeStyle: "short" }),
    );
    expect(rows[1]![0]).toContain(
      new Date(yesterday).toLocaleString(undefined, { month: "short", day: "numeric" }),
    );
    const received = (await rowOf(0)).querySelector("td")!;
    expect(received.classList.contains("or-mono")).toBe(true);
    expect(received.querySelector("time")!.getAttribute("dateTime")).toBe(delivery(1).receivedAt);
    expect(rows.map((row) => row.slice(1, 4))).toEqual([
      ["Pull request · updated", "acme/app", "Review started"],
      ["Pull request · updated", "acme/app", "Failed: no agent online for this repo"],
      ["Pull request · edited", "acme/app", "Ignored: Omniralph doesn't act on this event"],
    ]);
    // The repo is a RepoBadge with the code host's mark.
    expect((await rowOf(0)).querySelector(".or-ref svg, .or-ref .or-brand-mark")).not.toBeNull();
  });

  it("puts the failed outcome in coral and links an outcome to its run", async () => {
    renderConnection("github");
    const started = within(await rowOf(0)).getByRole("link", { name: "Review started" });
    expect(started.getAttribute("href")).toBe(`/runs/${RUN_ID}`);
    const outcome = (await rowOf(1)).querySelector(".or-deliveries__outcome")!;
    expect(outcome.textContent).toBe("Failed: no agent online for this repo");
    expect(outcome.classList.contains("or-deliveries__outcome--fail")).toBe(true);
    expect(outcome.closest("a")).toBeNull();
    expect((await rowOf(2)).querySelector(".or-deliveries__outcome--fail")).toBeNull();
  });

  it("says when there were no deliveries in the last 14 days", async () => {
    pages.all = listOf([]);
    renderConnection("github");
    expect(
      await within(await card()).findByRole("heading", { name: NO_DELIVERIES.all }),
    ).toBeTruthy();
    expect(NO_DELIVERIES.all).toBe("No deliveries in the last 14 days");
    expect(screen.queryByRole("table", { name: "Webhook deliveries" })).toBeNull();
    expect(within(await card()).getByText(DELIVERIES_RETENTION_NOTE)).toBeTruthy();
  });
});

describe("filter", () => {
  it("lists only failed, then only ignored, deliveries through the list's outcome filter", async () => {
    renderConnection("github");
    await table();
    await userEvent.click(within(await filters()).getByRole("radio", { name: "Failed 2" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(2));
    expect(deliveryReads().at(-1)!.query.getAll("outcome")).toEqual(["failed"]);
    // Only the failures not yet replayed: the ones "Failed 2" counts.
    expect(deliveryReads().at(-1)!.query.get("unreplayed")).toBe("true");
    expect((await tableRows()).every((row) => row[3]!.startsWith("Failed:"))).toBe(true);

    await userEvent.click(within(await filters()).getByRole("radio", { name: "Ignored" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(1));
    expect(deliveryReads().at(-1)!.query.getAll("outcome")).toEqual(["ignored"]);
    expect(deliveryReads().at(-1)!.query.get("unreplayed")).toBeNull();
    expect((await tableRows())[0]![3]).toBe("Ignored: Omniralph doesn't act on this event");

    await userEvent.click(within(await filters()).getByRole("radio", { name: "All" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(4));
  });

  it("says when no delivery failed", async () => {
    pages.failed = listOf([]);
    renderConnection("github");
    await table();
    await userEvent.click(within(await filters()).getByRole("radio", { name: "Failed 2" }));
    expect(
      await within(await card()).findByRole("heading", { name: NO_DELIVERIES.failed }),
    ).toBeTruthy();
  });
});

describe("pagination", () => {
  it("loads more rows with the cursor (Show more) until the last page", async () => {
    pages.all = {
      "": { deliveries: [delivery(1), failed(2)], nextCursor: "page-2" },
      "page-2": { deliveries: [ignored(3)], nextCursor: "page-3" },
      "page-3": { deliveries: [failed(4)], nextCursor: null },
    };
    renderConnection("github");
    expect(await tableRows()).toHaveLength(2);
    await userEvent.click(within(await card()).getByRole("button", { name: "Show more" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(3));
    expect(deliveryReads().at(-1)!.query.get("cursor")).toBe("page-2");
    await userEvent.click(within(await card()).getByRole("button", { name: "Show more" }));
    await waitFor(async () => expect(await tableRows()).toHaveLength(4));
    expect(deliveryReads().at(-1)!.query.get("cursor")).toBe("page-3");
    expect(within(await card()).queryByRole("button", { name: "Show more" })).toBeNull();
    expect((await tableRows()).map((row) => row[1])).toEqual([
      "Pull request · updated",
      "Pull request · updated",
      "Pull request · edited",
      "Pull request · updated",
    ]);
  });
});

describe("Replay", () => {
  it("is shown on failed rows and hidden (revealed on hover or focus) on the others", async () => {
    renderConnection("github");
    for (const index of [0, 1, 2, 3]) {
      const button = within(await rowOf(index)).getByRole("button", { name: "Replay" });
      expect(button.classList.contains("or-deliveries__replay--reveal"), `row ${index}`).toBe(
        index === 0 || index === 2,
      );
      expect(button.querySelector("svg.tabler-icon-rotate")).not.toBeNull();
    }
    const css = readFileSync(path.resolve(__dirname, "deliveries.css"), "utf8");
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.:()]/g, "\\$&")}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    expect(rule(".or-deliveries__replay--reveal")).toContain("opacity: 0;");
    expect(css).toMatch(
      /\.or-deliveries \.or-tbl__row:hover \.or-deliveries__replay--reveal,\s*\.or-deliveries \.or-tbl__row:focus-within \.or-deliveries__replay--reveal \{\s*opacity: 1;/,
    );
    // Hidden by opacity, so keyboard focus still reaches it.
    expect(rule(".or-deliveries__replay--reveal")).not.toMatch(/display|visibility/);
  });

  it("shows a failure already replayed as handled: not coral, Replay on hover", async () => {
    connections = connections.map((row) =>
      row.provider === "github" ? { ...row, failedDeliveries: 1 } : row,
    );
    pages.all = listOf([delivery(1), failed(2, { replayed: true }), failed(4)]);
    renderConnection("github");
    await waitFor(async () =>
      expect((await tableRows())[1]![3]).toBe("Failed: no agent online for this repo · replayed"),
    );
    const classes = async (index: number, selector: string) =>
      (await rowOf(index)).querySelector(selector)!.classList;
    expect(
      (await classes(1, ".or-deliveries__outcome")).contains("or-deliveries__outcome--fail"),
    ).toBe(false);
    expect(
      (await classes(2, ".or-deliveries__outcome")).contains("or-deliveries__outcome--fail"),
    ).toBe(true);
    expect(
      (await classes(1, ".or-deliveries__replay")).contains("or-deliveries__replay--reveal"),
    ).toBe(true);
    expect(
      (await classes(2, ".or-deliveries__replay")).contains("or-deliveries__replay--reveal"),
    ).toBe(false);
    expect(within(await filters()).getByRole("radio", { name: "Failed 1" })).toBeTruthy();
  });

  it("adds the replay's row and lowers the Failed count at once, then shows the answer before any refetch", async () => {
    let answer!: () => void;
    replayResponse = () =>
      new Promise<Response>((resolve) => {
        answer = () => {
          holdReads = true;
          resolve(jsonResponse(replayAnswer()));
        };
      });
    renderConnection("github");
    await userEvent.click(within(await rowOf(1)).getByRole("button", { name: "Replay" }));
    // Before the server answers.
    await waitFor(async () => expect((await tableRows())[0]![3]).toBe(REPLAYING));
    expect(within(await filters()).getByRole("radio", { name: "Failed 1" })).toBeTruthy();
    expect(await tableRows()).toHaveLength(5);
    // The original now reads as replayed.
    expect((await tableRows())[2]![3]).toBe("Failed: no agent online for this repo · replayed");
    expect(within(await rowOf(0)).queryByRole("button", { name: "Replay" })).toBeNull();
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);

    const reads = seen.filter((r) => r.method === "GET").length;
    act(() => answer());
    await waitFor(async () =>
      expect((await tableRows())[0]![3]).toBe("Replayed by Ada: Review started"),
    );
    expect(within(await rowOf(0)).getByRole("link", { name: /Review started/ })).toBeTruthy();
    expect(within(await filters()).getByRole("radio", { name: "Failed 1" })).toBeTruthy();
    expect(await tableRows()).toHaveLength(5);
    // The reconcile refetches are still pending: what shows came from the answer.
    await waitFor(() =>
      expect(seen.filter((r) => r.method === "GET").length).toBeGreaterThan(reads),
    );
    expect(ui.toast).toHaveBeenCalledWith("Replayed");
  });

  it("keeps the Failed count when the replay failed again", async () => {
    replayResponse = () => {
      holdReads = true;
      return jsonResponse(
        replayAnswer({
          outcome: "failed",
          reasonCode: "handler_failed",
          reason: "No agent online for this repo",
          run: null,
        }),
      );
    };
    renderConnection("github");
    await userEvent.click(within(await rowOf(1)).getByRole("button", { name: "Replay" }));
    await waitFor(async () =>
      expect((await tableRows())[0]![3]).toBe(
        "Replayed by Ada: Failed: no agent online for this repo",
      ),
    );
    expect(within(await filters()).getByRole("radio", { name: "Failed 2" })).toBeTruthy();
  });

  it("replays a delivery that wasn't failed from its hover button, without touching the count", async () => {
    renderConnection("github");
    await userEvent.click(within(await rowOf(2)).getByRole("button", { name: "Replay" }));
    await waitFor(async () =>
      expect((await tableRows())[0]![3]).toBe("Replayed by Ada: Review started"),
    );
    expect(seen.some((r) => r.method === "POST" && r.path.includes(D(3)))).toBe(true);
    expect(within(await filters()).getByRole("radio", { name: "Failed 2" })).toBeTruthy();
  });

  it.each([
    ["truncated payload", 400, "This delivery was too large to keep, so it can't be replayed."],
    [
      "removed connection",
      400,
      "The connection this delivery came through was removed, so it can't be replayed.",
    ],
    ["rate limit", 429, "That's a lot of replays in a minute. Try again in 42 seconds."],
    ["run still active", 409, "Om is still working on this in its agent session."],
  ] as const)(
    "a refusal (%s) toasts the server's message and restores the row",
    async (_case, status, message) => {
      replayResponse = () => jsonResponse({ error: message }, status);
      renderConnection("github");
      const before = await tableRows();
      await userEvent.click(within(await rowOf(1)).getByRole("button", { name: "Replay" }));
      await waitFor(() =>
        expect(ui.toast).toHaveBeenCalledWith(
          message,
          expect.objectContaining({ variant: "danger" }),
        ),
      );
      await waitFor(async () => expect(await tableRows()).toEqual(before));
      expect(within(await filters()).getByRole("radio", { name: "Failed 2" })).toBeTruthy();
    },
  );
});

describe("live updates", () => {
  const connected = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() =>
      expect(live.current().subscribed()).toContain(`org:${TEST_ORGANIZATION_ID}:changes`),
    );

  it("a new delivery for the connection goes on top and updates the counts without a reload", async () => {
    const live = fakeAbly();
    renderConnection("github", { live });
    expect(await tableRows()).toHaveLength(4);
    await connected(live);
    pages.all = listOf([
      failed(0, { event: "issue_comment.created" }),
      ...pages.all![""]!.deliveries,
    ]);
    connections = connections.map((row) =>
      row.provider === "github" ? { ...row, failedDeliveries: 3 } : row,
    );
    act(() =>
      live
        .current()
        .deliver(
          `org:${TEST_ORGANIZATION_ID}:changes`,
          changeEvent(TEST_ORGANIZATION_ID, { resource: "webhook_event", ids: [D(0), IDS.github] }),
        ),
    );
    await waitFor(async () => expect(await tableRows()).toHaveLength(5));
    expect((await tableRows())[0]!.slice(1, 4)).toEqual([
      "Comment",
      "acme/app",
      "Failed: no agent online for this repo",
    ]);
    expect(await within(await filters()).findByRole("radio", { name: "Failed 3" })).toBeTruthy();
  });

  it("ignores a delivery for another connection", async () => {
    const live = fakeAbly();
    renderConnection("github", { live });
    await table();
    await connected(live);
    const reads = deliveryReads().length;
    act(() =>
      live.current().deliver(
        `org:${TEST_ORGANIZATION_ID}:changes`,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "webhook_event",
          ids: [D(50), IDS.gitlab],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveryReads()).toHaveLength(reads);
    expect(await tableRows()).toHaveLength(4);
  });

  it("ignores another organization's deliveries", async () => {
    const live = fakeAbly();
    renderConnection("github", { live });
    await table();
    await waitFor(() =>
      expect(live.current().subscribed()).toContain(`user:${testUser.id}:changes`),
    );
    const reads = deliveryReads().length;
    act(() =>
      live
        .current()
        .deliver(
          `user:${testUser.id}:changes`,
          changeEvent(OTHER_ORG, { resource: "webhook_event", ids: [D(50), IDS.github] }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deliveryReads()).toHaveLength(reads);
  });
});

describe("phone layout (board Settings-390)", () => {
  it("renders cards with the event and time on top, the repo badge and outcome, and Replay only on failed ones", async () => {
    renderConnection("github");
    await table();
    const cards = Array.from(phoneCards().querySelectorAll<HTMLLIElement>("li.or-cardrow"));
    expect(phoneCards().getAttribute("aria-label")).toBe("Webhook deliveries");
    expect(cards).toHaveLength(4);
    const [started, fail] = cards;
    expect(started!.querySelector(".or-cardrow__top .or-cardrow__time time")).not.toBeNull();
    expect(started!.querySelector(".or-cardrow__title")!.textContent).toBe(
      "Pull request · updated",
    );
    expect(started!.querySelector(".or-cardrow__meta .or-ref")!.textContent).toContain("acme/app");
    expect(fail!.querySelector(".or-cardrow__meta")!.textContent).toContain(
      "Failed: no agent online for this repo",
    );
    // Replay shows on failed cards; on the others it is the hidden one the CSS removes.
    const shown = (li: HTMLLIElement) =>
      Array.from(li.querySelectorAll('button[aria-label="Replay"]')).filter(
        (button) => !button.classList.contains("or-deliveries__replay--reveal"),
      ).length;
    expect(cards.map(shown)).toEqual([0, 1, 0, 1]);
    const css = readFileSync(path.resolve(__dirname, "deliveries.css"), "utf8");
    expect(css).toMatch(
      /\.or-deliveries \.or-cards \.or-deliveries__replay--reveal \{\s*display: none;/,
    );
    // DataTable's own phone rule: the table hides and the cards show at 768 px and narrower.
    const uiStyles = path.dirname(
      createRequire(import.meta.url).resolve("@omniralph/ui/styles.css"),
    );
    const lists = readFileSync(path.join(uiStyles, "lists.css"), "utf8");
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(lists)?.[1] ?? "";
    expect(phone).toMatch(/\.or-tblwrap\s*\{\s*display: none;/);
    expect(phone).toMatch(/\.or-cards\s*\{\s*display: flex;/);
  });
});
