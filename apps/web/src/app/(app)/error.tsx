"use client";

// Error boundaries must be client components.
import { Button, EmptyState, IconRetry } from "@omniralph/ui";
import { IconAlertTriangle } from "@tabler/icons-react";
import * as React from "react";

/**
 * Any unexpected render error of a signed-in page, in place of the page (the shell stays):
 * what happened and a Retry that renders the page again (DESIGN.md: errors are shown in
 * place with a retry). Failed loads don't get here: each screen shows those itself.
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
    <div className="or-app-error">
      <EmptyState
        headingLevel={1}
        icon={IconAlertTriangle}
        title="Couldn't show this page"
        description={
          <>
            The page hit an unexpected error. Try again; if it keeps happening, reload the page.
            {error.digest ? (
              <>
                {" "}
                Reference: <span className="or-mono">{error.digest}</span>
              </>
            ) : null}
          </>
        }
        action={
          <Button variant="outline" size="sm" icon={IconRetry} onClick={() => retry()}>
            Retry
          </Button>
        }
      />
    </div>
  );
}
