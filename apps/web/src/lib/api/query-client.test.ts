// @vitest-environment jsdom
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import {
  createQueryClient,
  FALLBACK_POLL_INTERVAL,
  isFallbackPolling,
  setFallbackPolling,
  shouldRetryQuery,
} from "./query-client";

describe("createQueryClient", () => {
  it("refetches on focus and reconnect, treats data as stale and never retries mutations", () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();
    expect(queries).toMatchObject({
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 0,
    });
    expect(mutations?.retry).toBe(false);
  });
});

describe("fallback polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function observe(client = createQueryClient()) {
    const queryFn = vi.fn(async () => "data");
    const observer = new QueryObserver(client, { queryKey: ["org", "runs"], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    return { client, queryFn, unsubscribe };
  }

  it("polls every 10s until live updates turn it off", async () => {
    const { client, queryFn, unsubscribe } = observe();
    expect(FALLBACK_POLL_INTERVAL).toBe(10_000);
    expect(isFallbackPolling(client)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryFn).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("stops every mounted query polling at once, and starts it again", async () => {
    const { client, queryFn, unsubscribe } = observe();
    await vi.advanceTimersByTimeAsync(0);
    setFallbackPolling(client, false);
    expect(isFallbackPolling(client)).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryFn).toHaveBeenCalledTimes(1);

    setFallbackPolling(client, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("leaves a query's own interval alone", async () => {
    const client = createQueryClient();
    setFallbackPolling(client, false);
    const queryFn = vi.fn(async () => "data");
    const observer = new QueryObserver(client, {
      queryKey: ["org", "own-interval"],
      queryFn,
      refetchInterval: 30_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
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
