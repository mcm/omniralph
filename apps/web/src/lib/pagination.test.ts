import { describe, expect, it } from "vitest";
import { totalPages, pageRange, pageSlice, pageWindow, parsePage } from "./pagination";

describe("parsePage", () => {
  it("accepts positive integers and falls back to page 1", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(["2", "5"])).toBe(2);
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc"]) expect(parsePage(bad)).toBe(1);
  });
});

describe("totalPages", () => {
  it("rounds up and never returns less than one page", () => {
    expect(totalPages(0, 25)).toBe(1);
    expect(totalPages(25, 25)).toBe(1);
    expect(totalPages(26, 25)).toBe(2);
  });
});

describe("pageRange", () => {
  it("gives the 1-based range of the shown items", () => {
    expect(pageRange(1, 25, 25)).toEqual({ first: 1, last: 25 });
    expect(pageRange(3, 25, 4)).toEqual({ first: 51, last: 54 });
    expect(pageRange(2, 25, 0)).toEqual({ first: 0, last: 0 });
  });
});

describe("pageSlice", () => {
  it("returns the items of one page", () => {
    const items = [1, 2, 3, 4, 5];
    expect(pageSlice(items, 1, 2)).toEqual([1, 2]);
    expect(pageSlice(items, 3, 2)).toEqual([5]);
    expect(pageSlice(items, 4, 2)).toEqual([]);
  });
});

describe("pageWindow", () => {
  it("shows first, last and neighbours with gaps between", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageWindow(1, 10)).toEqual([1, 2, "gap", 10]);
  });
});
