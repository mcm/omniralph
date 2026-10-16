// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Freshness, type FreshnessQuery } from "./freshness";

const START = new Date("2026-10-16T12:00:00Z").getTime();

function query(overrides: Partial<FreshnessQuery> = {}): FreshnessQuery {
  return {
    dataUpdatedAt: START,
    isError: false,
    failureCount: 0,
    isFetching: false,
    refetch: vi.fn() as unknown as FreshnessQuery["refetch"],
    ...overrides,
  };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Freshness", () => {
  it("shows when the data was updated, ticking on the browser's clock", () => {
    render(<Freshness query={query()} />);
    expect(screen.getByText(/Updated/).textContent).toBe("Updated 0s ago");
    advance(3_000);
    expect(screen.getByText(/Updated/).textContent).toBe("Updated 3s ago");
    advance(60_000);
    expect(screen.getByText(/Updated/).textContent).toBe("Updated 1 min ago");
  });

  it("shows nothing before the first load", () => {
    const { container } = render(<Freshness query={query({ dataUpdatedAt: 0 })} />);
    expect(container.textContent).toBe("");
  });

  it("warns with a Retry once refetches have failed for 30s", () => {
    const failing = query({ failureCount: 1 });
    const { rerender } = render(<Freshness query={failing} />);
    advance(29_000);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Updated/)).toBeTruthy();

    rerender(<Freshness query={{ ...failing, isError: true, failureCount: 4 }} />);
    advance(1_000);
    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain("Not updating: last updated 30s ago");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(failing.refetch).toHaveBeenCalled();
  });

  it("counts from the first failure, not from the last update", () => {
    // Back on a tab after a while hidden: old data, and the first refetch just failed.
    const { rerender } = render(<Freshness query={query()} />);
    advance(120_000);
    rerender(<Freshness query={query({ failureCount: 1 })} />);
    advance(1_000);
    expect(screen.queryByRole("status")).toBeNull();
    advance(30_000);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("goes back to the indicator when a refetch succeeds", () => {
    const { rerender } = render(<Freshness query={query({ isError: true })} />);
    advance(31_000);
    expect(screen.getByRole("status")).toBeTruthy();
    rerender(<Freshness query={query({ dataUpdatedAt: Date.now() })} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/Updated/).textContent).toBe("Updated 0s ago");
  });
});
