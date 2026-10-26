// @vitest-environment jsdom
// The live data layer inside the real app shell: `ably` is the fake client, so the shell's
// own wiring (token endpoint, channels, notice, picker, theme) runs as in the browser.
import "@/components/pickers/test-dom";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppFrame, type NavItem, type ThemePreference } from "@omniralph/ui";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { AppShell } from "../app-shell";
import { CurrentUserProvider, type SessionUser } from "../current-user";
import { mockFetch, TEST_ORGANIZATION_ID, testUser } from "../query-test-utils";
import { QueryProvider } from "../query-provider";
import { LIVE_NOTICE_DELAY_MS } from "./live-notice-slot";
import { LiveProvider } from "./live-provider";
import type { FakeRealtime } from "./live-test-utils";
import { changeEvent, fakeAbly, fakeToken } from "./live-test-utils";

const ably = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("ably", async () => {
  const { FakeRealtime: Fake } = await import("./live-test-utils");
  return {
    Realtime: class extends Fake {
      constructor(options: ConstructorParameters<typeof Fake>[0]) {
        super(options);
        ably.clients.push(this);
      }
    },
  };
});
const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/analytics",
  useRouter: () => nav.router,
}));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
vi.mock("@/lib/theme-actions", () => ({ saveThemePreference: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/auth/actions", () => ({ signOutAction: vi.fn(async () => {}) }));

const ORG = TEST_ORGANIZATION_ID;
const BETA = { id: "22222222-2222-4222-8222-222222222222", name: "Beta" };
const twoOrganizations: SessionUser = {
  ...testUser,
  organizations: [
    { ...testUser.organization, role: "admin" },
    { ...BETA, role: "member" },
  ],
};
const TOKEN = { token: "jwt", expiresAt: "2099-01-01T00:00:00.000Z" };

const realtime = () => ably.clients.at(-1) as FakeRealtime;
const notice = () => screen.queryByText("Live updates stopped. Retrying…");

/**
 * The app shell as the `(app)` layout renders it; `router.refresh()` renders it again with
 * whatever `server` says now (the user, their theme), as a server re-render would.
 */
function renderApp(initial: { user?: SessionUser; theme?: ThemePreference } = {}) {
  let server = { user: initial.user ?? testUser, theme: initial.theme ?? "dark" };
  let update: (next: typeof server) => void = () => {};
  function App() {
    const [state, setState] = React.useState(server);
    update = setState;
    return (
      <AppShell
        user={state.user}
        themePreference={state.theme}
        organizationCookie={null}
        scopeCookie={null}
        showAdvanced={false}
      >
        <h1>Page content</h1>
      </AppShell>
    );
  }
  nav.router.refresh.mockImplementation(() => act(() => update(server)));
  render(<App />);
  return {
    /** What the next server render returns. */
    serve: (next: Partial<typeof server>) => {
      server = { ...server, ...next };
    },
  };
}

beforeEach(() => {
  ably.clients.length = 0;
  nav.router.push.mockReset();
  nav.router.refresh.mockReset();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the live notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

  it("stays hidden while connected and for the first 5s of a drop, then shows", async () => {
    mockFetch({ "GET /api/ui/live/token": TOKEN });
    renderApp();
    await settle();
    act(() => realtime().setState("connected"));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(notice()).toBeNull();

    act(() => realtime().setState("disconnected"));
    await act(() => vi.advanceTimersByTimeAsync(LIVE_NOTICE_DELAY_MS - 1));
    expect(notice()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2));
    const status = screen.getByText("Live updates stopped. Retrying…").closest("[role=status]");
    expect(status).not.toBeNull();
    // Above the page content, in the main landmark.
    const main = screen.getByRole("main");
    expect(main.contains(status)).toBe(true);
    expect(
      status!.compareDocumentPosition(screen.getByRole("heading", { name: "Page content" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => realtime().setState("connected"));
    expect(notice()).toBeNull();
  });

  it("starts the 5s over on each drop", async () => {
    mockFetch({ "GET /api/ui/live/token": TOKEN });
    renderApp();
    await settle();
    act(() => realtime().setState("connected"));
    act(() => realtime().setState("disconnected"));
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    act(() => realtime().setState("connected"));
    act(() => realtime().setState("disconnected"));
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(notice()).toBeNull();
  });

  it("is never shown when realtime isn't configured", async () => {
    mockFetch({ "GET /api/ui/live/token": { token: null } });
    renderApp();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(notice()).toBeNull();
    expect(ably.clients).toHaveLength(0);
    // No connected or "Live" indicator either.
    expect(screen.queryByText(/^Live$/)).toBeNull();
  });

  it("Retry now reconnects", async () => {
    mockFetch({ "GET /api/ui/live/token": TOKEN });
    renderApp();
    await settle();
    act(() => realtime().setState("connected"));
    act(() => realtime().setState("suspended"));
    await act(() => vi.advanceTimersByTimeAsync(LIVE_NOTICE_DELAY_MS + 1));
    const connects = realtime().connection.connect.mock.calls.length;
    act(() => screen.getByRole("button", { name: "Retry now" }).click());
    expect(realtime().connection.connect.mock.calls.length).toBe(connects + 1);
  });
});

describe("the user's own record", () => {
  it("applies a theme change from another device in place", async () => {
    mockFetch({ "GET /api/ui/live/token": TOKEN });
    const app = renderApp({ theme: "dark" });
    await waitFor(() => expect(realtime().subscribed()).toContain("user:user-1:changes"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    app.serve({ theme: "light" });
    act(() =>
      realtime().deliver(
        "user:user-1:changes",
        changeEvent(ORG, { resource: "settings", section: "profile", ids: [ORG] }),
      ),
    );
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(ably.clients).toHaveLength(1);
  });

  it("refreshes the organizations the picker shows on a membership change", async () => {
    mockFetch({ "GET /api/ui/live/token": TOKEN });
    const app = renderApp();
    await waitFor(() => expect(realtime().subscribed()).toContain("user:user-1:changes"));

    app.serve({ user: twoOrganizations });
    act(() =>
      realtime().deliver("user:user-1:changes", changeEvent(BETA.id, { resource: "organization" })),
    );
    expect(realtime().auth.authorize).toHaveBeenCalledTimes(1);
    const user = userEvent.setup();
    const picker = screen.getAllByRole("button", { name: "Organization: Acme" })[0]!;
    await user.click(picker);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Beta" })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "All organizations" })).toBeTruthy();
  });
});

describe("an organization switch", () => {
  it("re-subscribes to the new scope's channels without a reload", async () => {
    mockFetch({
      "GET /api/ui/live/token": TOKEN,
      "POST /api/ui/organizations/switch": { ok: true },
    });
    const startHref = window.location.href;
    const app = renderApp({ user: twoOrganizations });
    await waitFor(() =>
      expect(realtime().subscribed()).toEqual([`org:${ORG}:changes`, "user:user-1:changes"]),
    );
    const first = realtime();

    app.serve({ user: { ...twoOrganizations, scope: "all" } });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Organization: Acme" })[0]!);
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "All organizations" }));
    await waitFor(() =>
      expect(realtime().subscribed()).toEqual([
        `org:${ORG}:changes`,
        `org:${BETA.id}:changes`,
        "user:user-1:changes",
      ]),
    );
    expect(first.close).toHaveBeenCalled();
    expect(window.location.href).toBe(startHref);
  });
});

describe("nav indicators", () => {
  it("update from a change event, with no timer-driven refetch", async () => {
    const fake = fakeAbly();
    let count = 2;
    const fetches = vi.fn(async () => count);
    function Frame() {
      const keys = queryKeys(ORG);
      const { data } = useQuery({
        queryKey: keys.runs.part("nav", "count"),
        queryFn: fetches,
        refetchOnWindowFocus: false,
      });
      const items: NavItem[] = [
        {
          id: "runs",
          label: "Runs",
          href: "/runs",
          icon: IconPlayerPlay,
          placement: "main",
          phone: "tab",
          indicator:
            data === undefined
              ? undefined
              : { kind: "count", value: data, label: `${data} running` },
        },
      ];
      return (
        <AppFrame
          currentPath="/"
          brandHref="/"
          nav={items}
          user={{ name: "Ada", initials: "A" }}
          userMenu={(trigger) => trigger}
        />
      );
    }
    render(
      <CurrentUserProvider user={testUser}>
        <QueryProvider organizationId={ORG}>
          <LiveProvider createClient={fake.createClient} fetchToken={fakeToken}>
            <Frame />
          </LiveProvider>
        </QueryProvider>
      </CurrentUserProvider>,
    );
    const runs = () => screen.getAllByRole("link", { name: /^Runs/ })[0]!;
    await waitFor(() => expect(runs().getAttribute("aria-label")).toBe("Runs, 2 running"));
    act(() => fake.current().setState("connected"));
    vi.useFakeTimers();
    // Connected: nothing polls.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetches).toHaveBeenCalledTimes(1);

    count = 3;
    act(() =>
      fake.current().deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "pull_request" })),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(runs().getAttribute("aria-label")).toBe("Runs, 3 running");
  });
});
