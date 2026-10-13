import { describe, expect, it } from "vitest";
import { isRetryable, listingFailure } from "./listing-error";

describe("listingFailure", () => {
  it("names a missing environment variable, which a retry can't fix", () => {
    const failure = listingFailure("GITHUB_APP_ID is not set");
    expect(failure).toEqual({ kind: "config", variable: "GITHUB_APP_ID" });
    expect(isRetryable(failure)).toBe(false);
  });

  it("tells refused credentials from an unreachable host", () => {
    expect(listingFailure("GitLab API 401: 401 Unauthorized")).toEqual({ kind: "auth" });
    expect(listingFailure("Bad credentials")).toEqual({ kind: "auth" });
    expect(isRetryable({ kind: "auth" })).toBe(false);
    expect(listingFailure("fetch failed")).toEqual({ kind: "network" });
    expect(listingFailure("getaddrinfo ENOTFOUND gitlab.example")).toEqual({ kind: "network" });
    expect(isRetryable({ kind: "network" })).toBe(true);
  });

  it("falls back to an unknown, retryable failure", () => {
    expect(listingFailure("Something broke")).toEqual({ kind: "unknown" });
    expect(isRetryable({ kind: "unknown" })).toBe(true);
  });
});
