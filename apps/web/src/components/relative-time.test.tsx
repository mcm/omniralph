// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelativeTime, useNow, useRelativeTime } from "./relative-time";

const START = new Date("2026-10-16T12:00:00Z").getTime();
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNow", () => {
  it("ticks with the browser's clock", () => {
    const { result } = renderHook(() => useNow(1_000));
    expect(result.current).toBe(START);
    advance(5_000);
    expect(result.current).toBe(START + 5_000);
  });
});

describe("useRelativeTime", () => {
  it("moves on while the page stays open", () => {
    const iso = new Date(START - 20_000).toISOString();
    const { result } = renderHook(() => useRelativeTime(iso));
    expect(result.current).toBe("20s ago");
    advance(40_000);
    expect(result.current).toBe("1 min ago");
  });
});

describe("RelativeTime", () => {
  it("renders a ticking Timestamp with the exact time in its title", () => {
    const iso = new Date(START).toISOString();
    render(<RelativeTime iso={iso} />);
    const time = screen.getByText("0s ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("dateTime")).toBe(iso);
    expect(time.getAttribute("title")).toBeTruthy();
    advance(12_000);
    expect(time.textContent).toBe("12s ago");
  });
});
