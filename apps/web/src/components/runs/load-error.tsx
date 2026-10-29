"use client";

import { Button } from "@omniralph/ui";
import { NETWORK_ERROR, UNEXPECTED_RESPONSE } from "@/lib/api/client";

/** Why a load failed, as a sentence: the server's own reason, else what went wrong in transit. */
function failureReason(error: unknown): string | null {
  if (!(error instanceof Error) || !error.message) return null;
  // The client's generic messages end in "try again": the reload button says that already.
  if (error.message === UNEXPECTED_RESPONSE) return "The server sent an unexpected response.";
  if (error.message === NETWORK_ERROR) return "Couldn't reach the server.";
  return error.message;
}

/**
 * A failed load's sentence, naming what failed and why (DESIGN.md: errors name what failed):
 * "Couldn't load the diff. This commit isn't on GitHub yet." or "Couldn't load the
 * transcript. The server sent an unexpected response."
 */
export function loadFailure(what: string, error: unknown): string {
  const reason = failureReason(error);
  return reason ? `Couldn't load the ${what}. ${reason}` : `Couldn't load the ${what}.`;
}

/**
 * A failed load on a run's page: `loadFailure`'s sentence, then "Reload {what}", named for
 * what it reloads so it never reads like the run's or a story's Retry.
 */
export function LoadError({
  what,
  error,
  onReload,
  reloading = false,
}: {
  /** What failed to load, e.g. "transcript", "diff". */
  what: string;
  error: unknown;
  onReload: () => void;
  reloading?: boolean;
}) {
  return (
    <p className="or-run-error" role="alert">
      {loadFailure(what, error)}
      <Button variant="outline" size="sm" disabled={reloading} onClick={onReload}>
        Reload {what}
      </Button>
    </p>
  );
}
