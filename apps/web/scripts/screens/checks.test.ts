import { describe, expect, it } from "vitest";
import { captureFailures, HELP_PAGE, type CaptureResult } from "./checks";

const clean: CaptureResult = {
  route: "runs",
  path: "/runs",
  surface: "panel",
  as: "admin",
  viewport: "rail",
  width: 1024,
  theme: "dark",
  status: 200,
  finalPath: "/runs",
  scrollWidth: 1024,
  overflow: false,
  kbdCount: 0,
  retiredWording: [],
  consoleErrors: [],
  notRendered: null,
  loadErrors: [],
  error: null,
  screenshot: "runs.rail.dark.png",
  html: "runs.rail.dark.html",
};
const runsPage = { page: "(app)/runs/page.tsx" };

describe("captureFailures", () => {
  it("passes a clean capture, strict or not", () => {
    expect(captureFailures(clean, runsPage, false)).toEqual([]);
    expect(captureFailures(clean, runsPage, true)).toEqual([]);
  });

  it("fails on keyboard-shortcut indicators outside the Help page (rule 7)", () => {
    const withKbd = { ...clean, kbdCount: 2 };
    expect(captureFailures(withKbd, runsPage, false)).toEqual([
      "shows 2 keyboard-shortcut indicator(s) (rule 7)",
    ]);
    expect(captureFailures(withKbd, { page: HELP_PAGE }, false)).toEqual([]);
    // The agent page has no Help page: a `kbd` anywhere on it fails.
    expect(captureFailures({ ...withKbd, surface: "agent" }, { page: HELP_PAGE }, false)).toEqual([
      "shows 2 keyboard-shortcut indicator(s) (rule 7)",
    ]);
  });

  it("fails on each piece of retired wording", () => {
    const retired = { ...clean, retiredWording: ["the Ralph run", "Ralph said"] };
    expect(captureFailures(retired, runsPage, false)).toHaveLength(2);
  });

  it("fails on overflow only with --strict", () => {
    const wide = { ...clean, overflow: true, scrollWidth: 1100 };
    expect(captureFailures(wide, runsPage, false)).toEqual([]);
    expect(captureFailures(wide, runsPage, true)).toEqual([
      "wider than the viewport: 1100px > 1024px",
    ]);
  });

  it("fails on failed and unrendered captures", () => {
    expect(
      captureFailures(
        { ...clean, error: "timeout", notRendered: "still loading" },
        runsPage,
        false,
      ),
    ).toHaveLength(2);
  });
});
