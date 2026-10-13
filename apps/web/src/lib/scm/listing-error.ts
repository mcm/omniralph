/**
 * Why listing a code host's repositories failed, read from the error message, so the page can
 * name the cause and offer Retry only when retrying can help.
 */
export type ListingFailure =
  /** A server environment variable is missing: only setting it (and restarting) fixes it. */
  | { kind: "config"; variable: string }
  /** The code host refused the credentials (expired, revoked, uninstalled). */
  | { kind: "auth" }
  /** The host couldn't be reached; it may be back on the next try. */
  | { kind: "network" }
  | { kind: "unknown" };

export function listingFailure(message: string): ListingFailure {
  const missing = /\b([A-Z][A-Z0-9_]+) is not set\b/.exec(message);
  if (missing) return { kind: "config", variable: missing[1]! };
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|bad credentials|invalid[_ ]token/i.test(message)) {
    return { kind: "auth" };
  }
  if (
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out/i.test(message)
  ) {
    return { kind: "network" };
  }
  return { kind: "unknown" };
}

/** Whether Retry can fix the failure: not while configuration or credentials are wrong. */
export function isRetryable(failure: ListingFailure): boolean {
  return failure.kind === "network" || failure.kind === "unknown";
}
