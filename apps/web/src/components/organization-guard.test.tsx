// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "@/lib/auth/routes";
import { ORGANIZATION_SWITCHED } from "@/lib/api/schemas";
import {
  OrganizationGuard,
  useExpectOrganizationSwitch,
  useIsOrganizationStale,
} from "./organization-guard";
import { createTestQueryClient } from "./query-test-utils";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setCookie(value: string) {
  document.cookie = `${ORGANIZATION_COOKIE}=${value}; path=/`;
}

function setScopeCookie(value: "all" | null) {
  document.cookie =
    value === null
      ? `${ORGANIZATION_SCOPE_COOKIE}=; path=/; max-age=0`
      : `${ORGANIZATION_SCOPE_COOKIE}=${value}; path=/`;
}

const STALE_TITLE = "You switched organizations in another tab";

/** A query the server refuses once `refused.current` is set: another tab switched. */
function Poll({ refused }: { refused: { current: boolean } }) {
  useQuery({
    queryKey: [A, "poll"],
    queryFn: async () => {
      if (refused.current) throw new ApiError("Switched.", 409, ORGANIZATION_SWITCHED);
      return 1;
    },
  });
  return null;
}

function Probe({
  onReady,
}: {
  onReady: (api: { stale: () => boolean; expect: () => void }) => void;
}) {
  const stale = useIsOrganizationStale();
  const expectSwitch = useExpectOrganizationSwitch();
  React.useEffect(() => onReady({ stale, expect: expectSwitch }), [stale, expectSwitch, onReady]);
  return null;
}

function renderGuard(
  renderedCookie: string,
  children?: React.ReactNode,
  renderedScopeCookie: string | null = null,
) {
  const client = createTestQueryClient();
  const shell = (cookie: string, scope: string | null) => (
    <QueryClientProvider client={client}>
      <OrganizationGuard
        organizationName="Alpha"
        renderedCookie={cookie}
        renderedScopeCookie={scope}
      >
        {children}
      </OrganizationGuard>
    </QueryClientProvider>
  );
  const view = render(shell(renderedCookie, renderedScopeCookie));
  return {
    client,
    rerender: (cookie: string, scope: string | null = null) => view.rerender(shell(cookie, scope)),
  };
}

beforeEach(() => {
  setCookie(A);
  setScopeCookie(null);
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(cleanup);

describe("OrganizationGuard", () => {
  it("blocks the tab when it regains focus after another tab switched organizations", async () => {
    renderGuard(A);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.queryByText(STALE_TITLE)).toBeNull();

    setCookie(B);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText(STALE_TITLE)).toBeTruthy();
    expect(screen.getByText(/This tab still shows Alpha/)).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Go to dashboard" }).click());
    expect(router.push).toHaveBeenCalledWith("/");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("blocks a visible tab when a query is refused because the organization switched", async () => {
    const refused = { current: false };
    const { client } = renderGuard(A, <Poll refused={refused} />);
    await act(() => client.refetchQueries());
    expect(screen.queryByText(STALE_TITLE)).toBeNull();

    setCookie(B);
    refused.current = true;
    await act(() => client.refetchQueries());
    expect(screen.getByText(STALE_TITLE)).toBeTruthy();
  });

  it("lets the tab that switched re-render in the new organization", async () => {
    let probe: { stale: () => boolean; expect: () => void } | null = null;
    const onReady = (ready: typeof probe) => {
      probe = ready;
    };
    const { rerender } = renderGuard(A, <Probe onReady={onReady} />);
    setCookie(B);
    act(() => probe!.expect());
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.queryByText(STALE_TITLE)).toBeNull();
    expect(probe!.stale()).toBe(false);

    // Once it has re-rendered in B, a switch in another tab is noticed again.
    rerender(B);
    setCookie(A);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText(STALE_TITLE)).toBeTruthy();
  });

  it("blocks the tab when another tab changed the organization scope", async () => {
    const { rerender } = renderGuard(A);
    setScopeCookie("all");
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText(STALE_TITLE)).toBeTruthy();

    // Re-rendered under "All organizations": back to one organization elsewhere is noticed too.
    rerender(A, "all");
    expect(screen.queryByText(STALE_TITLE)).toBeNull();
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.queryByText(STALE_TITLE)).toBeNull();
    setScopeCookie(null);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(screen.getByText(STALE_TITLE)).toBeTruthy();
  });
});
