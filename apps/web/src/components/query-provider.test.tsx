// @vitest-environment jsdom
import { cleanup, render, renderHook } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/api/keys";
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
      refetchInterval: 3_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    });
  });

  it("drops the previous organization's queries when the organization switches", () => {
    const shell = renderClient(A);
    const client = shell.client();
    client.setQueryData(queryKeys(A).harnesses.list(), ["build-01"]);
    client.setQueryData(queryKeys(A).jobs.detail("j1"), { id: "j1" });
    shell.switchTo(B);
    expect(shell.client()).toBe(client);
    expect(client.getQueryCache().getAll()).toHaveLength(0);

    client.setQueryData(queryKeys(B).harnesses.list(), ["build-02"]);
    shell.switchTo(B);
    expect(client.getQueryData(queryKeys(B).harnesses.list())).toEqual(["build-02"]);
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
