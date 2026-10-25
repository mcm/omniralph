import { describe, expect, it } from "vitest";
import {
  CURSOR_LARGE,
  CURSOR_SMALL,
  CURSOR_VIEWBOX,
  cursorMasterFor,
  cursorTransform,
} from "./geometry.js";

describe("Cursor geometry", () => {
  it("draws both masters in a 24-unit viewBox", () => {
    expect(CURSOR_VIEWBOX).toBe(24);
  });

  it("defines the small master", () => {
    expect(CURSOR_SMALL).toEqual({
      scale: 0.92,
      circle: { cx: 9, cy: 11, r: 5, strokeWidth: 2.8 },
      rect: { x: 16, y: 14.2, width: 5.5, height: 2.8, rx: 0.5 },
    });
    expect(cursorTransform(CURSOR_SMALL)).toBe("translate(12 12) scale(0.92) translate(-12 -11)");
  });

  it("defines the large master", () => {
    expect(CURSOR_LARGE).toEqual({
      scale: 0.8,
      circle: { cx: 9, cy: 11, r: 5, strokeWidth: 2.6 },
      rect: { x: 15, y: 14.9, width: 6.5, height: 2.1, rx: 0.6 },
    });
    expect(cursorTransform(CURSOR_LARGE)).toBe("translate(12 12) scale(0.8) translate(-12 -11)");
  });

  it("uses the small master up to 32 px and the large one above", () => {
    expect(cursorMasterFor(16)).toBe(CURSOR_SMALL);
    expect(cursorMasterFor(32)).toBe(CURSOR_SMALL);
    expect(cursorMasterFor(33)).toBe(CURSOR_LARGE);
    expect(cursorMasterFor(180)).toBe(CURSOR_LARGE);
  });
});
