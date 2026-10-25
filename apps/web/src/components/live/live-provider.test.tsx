// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { createQueryClient, isFallbackPolling } from "@/lib/api/query-client";
import type { FetchLiveToken } from "@/lib/live/connection";
import { CurrentUserProvider, type SessionUser } from "../current-user";
import { TEST_ORGANIZATION_ID, testUser } from "../query-test-utils";
import { LiveProvider, useLiveRetry, useLiveStatus } from "./live-provider";
import { changeEvent, fakeAbly, fakeToken } from "./live-test-utils";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const ORG = TEST_ORGANIZATION_ID;
const BETA = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const keys = queryKeys(ORG);
const allScope: SessionUser = {
  ...testUser,
  scope: "all",
  organizations: [
    { ...testUser.organization, role: "admin" },
    { id: BETA, name: "Beta", role: "member" },
  ],
};

function Status() {
  const status = useLiveStatus();
  const retry = useLiveRetry();
  return (
    <button type="button" onClick={retry}>
      {status}
    </button>
  );
}

/** A mounted query under `queryKey`, counting its fetches. */
function Probe({ queryKey, fetches }: { queryKey: readonly unknown[]; fetches: () => void }) {
  const { data } = useQuery({
    queryKey,
    queryFn: async () => {
      fetches();
      return "data";
    },
  });
  return <span>{data ?? "loading"}</span>;
}

function setup({
  user = testUser,
  fetchToken = fakeToken,
  client = createQueryClient(),
  children = null,
}: {
  user?: SessionUser;
  fetchToken?: FetchLiveToken;
  client?: QueryClient;
  children?: React.ReactNode;
} = {}) {
  const ably = fakeAbly();
  const tree = (current: SessionUser) => (
    <CurrentUserProvider user={current}>
      <QueryClientProvider client={client}>
        <LiveProvider createClient={ably.createClient} fetchToken={fetchToken}>
          <Status />
          {children}
        </LiveProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const view = render(tree(user));
  return { ably, client, view, rerender: (next: SessionUser) => view.rerender(tree(next)) };
}

/** Lets the token fetch and the effects it triggers settle. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const status = () => screen.getByRole("button").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LiveProvider channels", () => {
  it("subscribes to the active organization's and the user's change channels", async () => {
    const { ably } = setup();
    await settle();
    const client = ably.current();
    expect(ably.clients).toHaveLength(1);
    expect(client.options.clientId).toBe("user-1");
    expect(client.connection.connect).toHaveBeenCalled();
    expect(client.subscribed()).toEqual([`org:${ORG}:changes`, "user:user-1:changes"]);
  });

  it("subscribes to every membership under All organizations", async () => {
    const { ably } = setup({ user: allScope });
    await settle();
    expect(ably.current().subscribed()).toEqual([
      `org:${ORG}:changes`,
      `org:${BETA}:changes`,
      "user:user-1:changes",
    ]);
  });

  it("swaps channels when the scope changes, on the same connection", async () => {
    const { ably, rerender } = setup();
    await settle();
    rerender(allScope);
    await settle();
    expect(ably.clients).toHaveLength(1);
    expect(ably.current().subscribed()).toEqual([
      `org:${ORG}:changes`,
      `org:${BETA}:changes`,
      "user:user-1:changes",
    ]);

    rerender(testUser);
    await settle();
    expect(ably.current().subscribed()).toEqual([`org:${ORG}:changes`, "user:user-1:changes"]);
    expect(ably.current().channels.release).toHaveBeenCalledWith(`org:${BETA}:changes`);
  });

  it("closes the connection on unmount", async () => {
    const { ably, view } = setup();
    await settle();
    view.unmount();
    expect(ably.current().close).toHaveBeenCalledTimes(1);
  });

  it("authorizes with the fetched token, and renews through the token endpoint", async () => {
    const fetchToken = vi.fn(fakeToken);
    const { ably } = setup({ fetchToken });
    await settle();
    const authCallback = ably.current().options.authCallback!;
    const first = await new Promise((resolve) =>
      authCallback({}, (error, token) => resolve([error, token])),
    );
    expect(first).toEqual([null, "jwt"]);
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // Ably asks again before the hour is up: a new token from the endpoint.
    const renewed = await new Promise((resolve) =>
      authCallback({}, (error, token) => resolve([error, token])),
    );
    expect(renewed).toEqual([null, "jwt"]);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });
});

describe("useLiveStatus", () => {
  it("is connecting, then live, then down when the connection drops", async () => {
    const { ably } = setup();
    expect(status()).toBe("connecting");
    await settle();
    act(() => ably.current().setState("connecting"));
    expect(status()).toBe("connecting");
    act(() => ably.current().setState("connected"));
    expect(status()).toBe("live");
    act(() => ably.current().setState("disconnected"));
    expect(status()).toBe("down");
    // Reconnecting after a drop is still down.
    act(() => ably.current().setState("connecting"));
    expect(status()).toBe("down");
    act(() => ably.current().setState("suspended"));
    expect(status()).toBe("down");
    act(() => ably.current().setState("failed"));
    expect(status()).toBe("down");
  });

  it("is off when realtime isn't configured, with no client at all", async () => {
    const { ably } = setup({ fetchToken: async () => null });
    await settle();
    expect(status()).toBe("off");
    expect(ably.clients).toHaveLength(0);
  });

  it("is down when the token endpoint fails, and asks again", async () => {
    const fetchToken = vi.fn<FetchLiveToken>().mockRejectedValueOnce(new Error("500"));
    fetchToken.mockImplementation(fakeToken);
    const { ably } = setup({ fetchToken });
    await settle();
    expect(status()).toBe("down");
    expect(ably.clients).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(ably.clients).toHaveLength(1);
  });
});

describe("polling", () => {
  it("doesn't poll while connected: no refetch over 30s", async () => {
    const fetches = vi.fn();
    const { ably, client } = setup({
      children: <Probe queryKey={keys.runs.list()} fetches={fetches} />,
    });
    await settle();
    act(() => ably.current().setState("connected"));
    await settle();
    expect(isFallbackPolling(client)).toBe(false);
    const before = fetches.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetches.mock.calls.length).toBe(before);
  });

  it("polls every 10s while disconnected, and catches up once on reconnect", async () => {
    const fetches = vi.fn();
    const { ably, client } = setup({
      children: <Probe queryKey={keys.runs.list()} fetches={fetches} />,
    });
    await settle();
    act(() => ably.current().setState("connected"));
    await settle();
    const connected = fetches.mock.calls.length;

    act(() => ably.current().setState("disconnected"));
    expect(isFallbackPolling(client)).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetches.mock.calls.length).toBe(connected + 3);

    const down = fetches.mock.calls.length;
    act(() => ably.current().setState("connected"));
    await settle();
    expect(fetches.mock.calls.length).toBe(down + 1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetches.mock.calls.length).toBe(down + 1);
  });

  it("doesn't catch up on the first connect", async () => {
    const fetches = vi.fn();
    const { ably } = setup({ children: <Probe queryKey={keys.runs.list()} fetches={fetches} /> });
    await settle();
    const before = fetches.mock.calls.length;
    act(() => ably.current().setState("connected"));
    await settle();
    expect(fetches.mock.calls.length).toBe(before);
  });

  it("polls every 10s when realtime isn't configured", async () => {
    const fetches = vi.fn();
    const { client } = setup({
      fetchToken: async () => null,
      children: <Probe queryKey={keys.runs.list()} fetches={fetches} />,
    });
    await settle();
    expect(isFallbackPolling(client)).toBe(true);
    const before = fetches.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetches.mock.calls.length).toBe(before + 3);
  });

  it("polls while the token endpoint fails", async () => {
    const { client } = setup({ fetchToken: async () => Promise.reject(new Error("500")) });
    await settle();
    expect(isFallbackPolling(client)).toBe(true);
  });
});

describe("change events", () => {
  it("refetch the queries the event maps to, and no others", async () => {
    const runFetches = vi.fn();
    const agentFetches = vi.fn();
    const { ably } = setup({
      children: (
        <>
          <Probe queryKey={keys.runs.detail(RUN)} fetches={runFetches} />
          <Probe queryKey={keys.harnesses.list()} fetches={agentFetches} />
        </>
      ),
    });
    await settle();
    act(() => ably.current().setState("connected"));
    await settle();
    expect(runFetches).toHaveBeenCalledTimes(1);

    act(() =>
      ably
        .current()
        .deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "run", runId: RUN })),
    );
    await settle();
    expect(runFetches).toHaveBeenCalledTimes(2);
    expect(agentFetches).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed events and events of another version", async () => {
    const fetches = vi.fn();
    const { ably } = setup({
      children: <Probe queryKey={keys.runs.detail(RUN)} fetches={fetches} />,
    });
    await settle();
    act(() => ably.current().setState("connected"));
    await settle();
    act(() => {
      ably.current().deliver(`org:${ORG}:changes`, {
        ...changeEvent(ORG, { resource: "run", runId: RUN }),
        v: 2,
      });
      ably.current().deliver(`org:${ORG}:changes`, "not json");
    });
    await settle();
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("takes events as JSON strings too", async () => {
    const fetches = vi.fn();
    const { ably } = setup({
      children: <Probe queryKey={keys.runs.detail(RUN)} fetches={fetches} />,
    });
    await settle();
    act(() =>
      ably
        .current()
        .deliver(
          `org:${ORG}:changes`,
          JSON.stringify(changeEvent(ORG, { resource: "run", runId: RUN })),
        ),
    );
    await settle();
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it("re-renders the shell from the server on the user's theme change", async () => {
    const { ably } = setup();
    await settle();
    act(() =>
      ably
        .current()
        .deliver(
          "user:user-1:changes",
          changeEvent(ORG, { resource: "settings", section: "profile", ids: [ORG] }),
        ),
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(ably.current().auth.authorize).not.toHaveBeenCalled();
  });

  it("renews the token and re-renders on a membership change", async () => {
    const { ably } = setup();
    await settle();
    act(() =>
      ably
        .current()
        .deliver("user:user-1:changes", changeEvent(BETA, { resource: "organization" })),
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(ably.current().auth.authorize).toHaveBeenCalledTimes(1);
  });

  it("doesn't re-render for organization changes on the organization's channel", async () => {
    const { ably } = setup();
    await settle();
    act(() =>
      ably.current().deliver(`org:${ORG}:changes`, changeEvent(ORG, { resource: "organization" })),
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("Retry now", () => {
  it("reconnects and refetches the active queries", async () => {
    const fetches = vi.fn();
    const { ably } = setup({ children: <Probe queryKey={keys.runs.list()} fetches={fetches} /> });
    await settle();
    act(() => ably.current().setState("disconnected"));
    const before = fetches.mock.calls.length;
    const connects = ably.current().connection.connect.mock.calls.length;
    act(() => screen.getByRole("button").click());
    await settle();
    expect(ably.current().connection.connect.mock.calls.length).toBe(connects + 1);
    expect(fetches.mock.calls.length).toBe(before + 1);
  });
});
