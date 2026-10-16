"use client";

import { Alert, AlertDescription, AlertTitle, Button } from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import * as React from "react";
import { ApiError } from "@/lib/api/client";
import { ENTER_ORGANIZATION } from "@/lib/api/schemas";

/** The parts of a query `QueryBoundary` reads. */
export type BoundaryQuery<T> = Pick<
  UseQueryResult<T, Error>,
  "data" | "error" | "isError" | "isFetching" | "refetch"
>;

/**
 * Renders `children` with a query's data once it has some, `skeleton` (the whiteout
 * `Skeleton` shaped like the content, DESIGN.md) while the first load is pending, and an
 * in-place error with a Retry button when that load fails. Once data is shown, a failed
 * refetch keeps it on screen (`Freshness` reports the failure). A resource of another of
 * the user's organizations (409 `ENTER_ORGANIZATION`) switches to it: the skeleton stays
 * while the browser opens the switch, which comes back to this page.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  what,
  children,
}: {
  query: BoundaryQuery<T>;
  skeleton: React.ReactNode;
  /** What failed to load, for the error's title: "Couldn't load {what}". */
  what: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  const enterPath = enterOrganizationPath(query.error);
  if (enterPath) {
    return (
      <div aria-busy="true" aria-label={`Loading ${what}`}>
        <EnterOrganization path={enterPath} />
        {skeleton}
      </div>
    );
  }
  if (query.isError) {
    return (
      <QueryError
        title={`Couldn't load ${what}`}
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <div aria-busy="true" aria-label={`Loading ${what}`}>
      {skeleton}
    </div>
  );
}

function enterOrganizationPath(error: Error | null): string | undefined {
  return error instanceof ApiError && error.code === ENTER_ORGANIZATION
    ? error.enterPath
    : undefined;
}

/** Opens the organization switch (a full load: the whole app shell changes organization). */
function EnterOrganization({ path }: { path: string }) {
  React.useEffect(() => {
    window.location.assign(path);
  }, [path]);
  return null;
}

/** A failed load in place of its content: what failed, why (the server's message), and a retry. */
export function QueryError({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: Error | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="danger" className="query-error">
      <IconAlertTriangle size={16} />
      <AlertTitle as="h2">{title}</AlertTitle>
      <AlertDescription className="query-error-body">
        <span>{error?.message || "Something went wrong."}</span>
        <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
          <IconRefresh size={14} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
