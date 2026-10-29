"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { queryKeys, type QueryKeys } from "@/lib/api/keys";
import { createQueryClient } from "@/lib/api/query-client";
import { useCurrentUser } from "./current-user";

// Development only: production builds never load the devtools bundle.
const Devtools =
  process.env.NODE_ENV === "development"
    ? React.lazy(() =>
        import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })),
      )
    : null;

/**
 * Provides the panel's one `QueryClient` (`createQueryClient`) to the signed-in area.
 * Every query key starts with the organization id (`queryKeys`), and when the active
 * organization changes (the switcher, or another tab's switch picked up by
 * `OrganizationGuard`) the other organizations' queries are dropped from the cache.
 */
export function QueryProvider({
  organizationId,
  children,
}: {
  organizationId: string;
  children: React.ReactNode;
}) {
  const [client] = React.useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <OrganizationCache organizationId={organizationId} />
      {children}
      {Devtools && <ClientDevtools devtools={Devtools} />}
    </QueryClientProvider>
  );
}

const subscribeNever = () => () => {};

/**
 * The devtools, mounted only once the page has hydrated: no server HTML of theirs, so a modal
 * opening during hydration (a sheet from `/repos?add=…`), which marks the rest of the body
 * `aria-hidden`, can't make their container mismatch the server render.
 */
function ClientDevtools({ devtools: Tools }: { devtools: NonNullable<typeof Devtools> }) {
  const hydrated = React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  if (!hydrated) return null;
  return (
    <React.Suspense fallback={null}>
      <Tools buttonPosition="bottom-left" />
    </React.Suspense>
  );
}

function OrganizationCache({ organizationId }: { organizationId: string }) {
  const client = useQueryClient();
  React.useEffect(() => {
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== organizationId });
  }, [client, organizationId]);
  return null;
}

/** The query-key factory for the active organization. */
export function useQueryKeys(): QueryKeys {
  const { organization } = useCurrentUser();
  return React.useMemo(() => queryKeys(organization.id), [organization.id]);
}
