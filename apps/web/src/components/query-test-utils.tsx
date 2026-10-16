// Test helpers for components on TanStack Query (Testing Library + jsdom): a QueryClient
// that neither polls nor retries, and a wrapper with the signed-in user it needs.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { CurrentUserProvider, type SessionUser } from "./current-user";

export const TEST_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

export const testUser: SessionUser = {
  id: "user-1",
  organization: { id: TEST_ORGANIZATION_ID, name: "Acme" },
  role: "admin",
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
