"use client";

// Error boundaries must be client components.
import { Alert, AlertDescription, AlertTitle, Button } from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import * as React from "react";
import { AppHeader } from "@/components/app-header";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";

/**
 * Any unexpected render error of a signed-in page, in place of the page (the sidebar and
 * the header stay): what happened and a Retry that renders the page again (DESIGN.md:
 * errors are shown in place with a retry). Failed loads don't get here: `QueryBoundary`
 * shows those in the page itself.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <>
      <AppHeader />
      <main className="detail-main">
        <PageHeader title="Something went wrong" />
        <Alert variant="danger" className="query-error">
          <IconAlertTriangle size={16} />
          <AlertTitle as="h2">Couldn&apos;t show this page</AlertTitle>
          <AlertDescription className="query-error-body">
            <span>
              The page hit an unexpected error. Try again; if it keeps happening, reload the page.
              {error.digest && (
                <>
                  {" "}
                  Reference: <MonoValue value={error.digest} />
                </>
              )}
            </span>
            <Button variant="secondary" size="sm" onClick={() => retry()}>
              <IconRefresh size={14} />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    </>
  );
}
