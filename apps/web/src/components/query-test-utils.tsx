// Test helpers for components on TanStack Query (Testing Library + jsdom): a QueryClient
// that neither polls nor retries, and a wrapper with the signed-in user it needs.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "./current-user";

export const TEST_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

export const testUser: SessionUser = {
  id: "user-1",
  organization: { id: TEST_ORGANIZATION_ID, name: "Acme" },
  role: "admin",
  scope: "single",
  organizations: [{ id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" }],
  name: "Ada",
  email: "ada@example.com",
  image: null,
};

/** A client for one test: no polling, no retries, no garbage collection mid-test. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
      mutations: { retry: false },
    },
  });
}

/** A Testing Library `wrapper` providing `client` and the signed-in `user`. */
export function queryWrapper(client: QueryClient, user: SessionUser = testUser) {
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return (
      <CurrentUserProvider user={user}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </CurrentUserProvider>
    );
  };
}

/** A JSON `Response`, as an `/api/ui` handler answers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One request `mockFetch` saw: its method, path (no query), query and parsed JSON body. */
export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/**
 * Stubs `fetch` with `routes`, keyed by `"METHOD /path"` (or `/path` for any method),
 * answering a JSON body or a function of the request. Unknown requests throw. Returns
 * the requests seen, in order.
 */
type Route =
  | ((request: SeenRequest) => Response | Promise<Response>)
  | Record<string, unknown>
  | unknown[];

export function mockFetch(routes: Record<string, Route>): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const request: SeenRequest = {
        method,
        path: url.pathname,
        query: url.searchParams,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      seen.push(request);
      const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
      if (route === undefined) throw new Error(`unexpected fetch ${method} ${url.pathname}`);
      return typeof route === "function"
        ? (route as (request: SeenRequest) => Response | Promise<Response>)(request)
        : jsonResponse(route);
    }),
  );
  return seen;
}
