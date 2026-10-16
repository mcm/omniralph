"use client";

import { Card, CardContent, CardHeader, Skeleton, Stack } from "@iamthemcmaster/ui";
import { notFound, redirect, useParams } from "next/navigation";
import { AppHeader, type Crumb } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary, type BoundaryQuery } from "@/components/query-boundary";
import { ApiError } from "@/lib/api/client";
import { decodeId } from "@/lib/api/definitions";
import { ACCESS_DENIED_PATH } from "@/lib/auth/routes";

/** The agent or task ID of the page's `[id]` segment (links encode the colon of `builtin:` IDs). */
export function useDefinitionId(): string {
  const { id } = useParams<{ id: string }>();
  return decodeId(id);
}

/** Whether the signed-in user is an admin; with `required`, members go to the access-denied page. */
export function useIsAdmin({ required = false } = {}): boolean {
  const isAdmin = useCurrentUser().role === "admin";
  if (required && !isAdmin) redirect(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  return isAdmin;
}

/**
 * Shows the not-found page when a definition is unknown (404), another organization's too. Call
 * it only without data: a refetch failing after a delete keeps the page until it navigates.
 */
export function notFoundOn404(error: Error | null) {
  if (error instanceof ApiError && error.status === 404) notFound();
}

/** Cards of a definition page while it loads. */
export function DefinitionSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <Stack gap={6}>
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <Stack gap={3} asChild>
            <CardContent>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </CardContent>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

/**
 * A definition page (detail or form) before its data is there: the header with a skeleton
 * title, then the skeleton or the failed load with a retry (`QueryBoundary`).
 */
export function DefinitionLoading({
  breadcrumbs,
  query,
  what,
}: {
  breadcrumbs: Crumb[];
  query: BoundaryQuery<unknown>;
  what: string;
}) {
  return (
    <>
      <AppHeader breadcrumbs={breadcrumbs} />
      <main className="detail-main">
        <PageHeader title={<Skeleton width="14rem" height="1.75rem" />} />
        <QueryBoundary query={query} skeleton={<DefinitionSkeleton />} what={what}>
          {() => null}
        </QueryBoundary>
      </main>
    </>
  );
}
