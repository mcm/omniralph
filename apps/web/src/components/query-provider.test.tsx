// @vitest-environment jsdom
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/api/keys";
import { isFallbackPolling } from "@/lib/api/query-client";
import { CurrentUserProvider } from "./current-user";
import { QueryProvider, useQueryKeys } from "./query-provider";
import { testUser } from "./query-test-utils";

afterEach(cleanup);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function Capture({ onClient }: { onClient: (client: QueryClient) => void }) {
  const client = useQueryClient();
  React.useEffect(() => onClient(client), [client, onClient]);
  return null;
}

function renderClient(organizationId: string) {
  const result: { current: QueryClient | null } = { current: null };
  const onClient = (client: QueryClient) => {
    result.current = client;
  };
  const shell = (id: string) => (
    <QueryProvider organizationId={id}>
      <Capture onClient={onClient} />
    </QueryProvider>
  );
  const { rerender } = render(shell(organizationId));
  return {
    client: () => result.current!,
    switchTo: (id: string) => rerender(shell(id)),
  };
}

describe("QueryProvider", () => {
  it("provides one client with the live defaults", () => {
    const { client } = renderClient(A);
    expect(client().getDefaultOptions().queries).toMatchObject({
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    });
    // Polls only as a fallback, until live updates connect.
    expect(isFallbackPolling(client())).toBe(true);
  });

  it("drops the previous organization's queries when the organization switches", () => {
    const shell = renderClient(A);
    const client = shell.client();
    client.setQueryData(queryKeys(A).agents.list(), ["build-01"]);
    client.setQueryData(queryKeys(A).jobs.detail("j1"), { id: "j1" });
    shell.switchTo(B);
    expect(shell.client()).toBe(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);

    client.setQueryData(queryKeys(B).agents.list(), ["build-02"]);
    shell.switchTo(B);
    expect(client.getQueryData(queryKeys(B).agents.list())).toEqual(["build-02"]);
  });
});

/** A page's query: answers which organization it was fetched for. */
function Page({ fetched }: { fetched: string[] }) {
  const keys = useQueryKeys();
  const query = useQuery({
    queryKey: keys.agents.list(),
    queryFn: async () => {
      const organizationId = keys.all[0] as string;
      fetched.push(organizationId);
      return organizationId;
    },
  });
  return <p>{query.data ? `Agents of ${query.data}` : "Loading"}</p>;
}

describe("switching organizations", () => {
  it("reloads every visible query for the new organization and drops the previous one's", async () => {
    const fetched: string[] = [];
    let client: QueryClient | null = null;
    const onClient = (c: QueryClient) => {
      client = c;
    };
    const shell = (id: string) => (
      <CurrentUserProvider user={{ ...testUser, organization: { id, name: id } }}>
        <QueryProvider organizationId={id}>
          <Capture onClient={onClient} />
          <Page fetched={fetched} />
        </QueryProvider>
      </CurrentUserProvider>
    );
    const { rerender } = render(shell(A));
    await waitFor(() => expect(screen.getByText(`Agents of ${A}`)).toBeTruthy());

    // The shell re-renders in the new organization (the switcher's refresh).
    rerender(shell(B));
    await waitFor(() => expect(screen.getByText(`Agents of ${B}`)).toBeTruthy());
    expect(fetched).toEqual([A, B]);
    const cached = client!
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey[0]);
    expect(cached).toEqual([B]);
  });
});

describe("useQueryKeys", () => {
  it("builds keys for the active organization", () => {
    const { result } = renderHook(() => useQueryKeys(), {
      wrapper: ({ children }) => (
        <CurrentUserProvider user={testUser}>{children}</CurrentUserProvider>
      ),
    });
    expect(result.current.runs.detail("r1")).toEqual([
      testUser.organization.id,
      "runs",
      "detail",
      "r1",
    ]);
  });
});
