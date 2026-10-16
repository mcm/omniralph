import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { createQueryClient, LIVE_REFETCH_INTERVAL, shouldRetryQuery } from "./query-client";

describe("createQueryClient", () => {
  it("polls every 3s while visible, refetches on focus, and treats data as stale", () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();
    expect(LIVE_REFETCH_INTERVAL).toBe(3_000);
    expect(queries).toMatchObject({
      refetchInterval: 3_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 0,
    });
    expect(mutations?.retry).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("retries network and server errors a few times", () => {
    expect(shouldRetryQuery(0, new ApiError("x", 0))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError("x", 503))).toBe(true);
    expect(shouldRetryQuery(3, new ApiError("x", 503))).toBe(false);
  });

  it("doesn't retry answers that won't change", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(shouldRetryQuery(0, new ApiError("x", status))).toBe(false);
    }
    expect(shouldRetryQuery(0, new ApiError("x", 429))).toBe(true);
  });
});
