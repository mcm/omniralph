import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScreensOptions } from "./options";
import { routeMatches, SCREEN_ROUTES, type ScreenRoute } from "./routes";

const APP_DIR = join(__dirname, "../../src/app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [relative(APP_DIR, path).split("\\").join("/")] : [];
  });
}

/** The URL pattern of a page file: route groups dropped, `[x]` as one segment. */
function pagePattern(page: string): RegExp {
  const segments = page
    .split("/")
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.*\]$/.test(segment) ? "[^/]+" : segment));
  return new RegExp(`^/${segments.join("/")}$`);
}

describe("SCREEN_ROUTES", () => {
  it("covers every page.tsx under src/app", () => {
    const listed = new Set(SCREEN_ROUTES.map((route) => route.page));
    expect(pageFiles(APP_DIR).filter((page) => !listed.has(page))).toEqual([]);
  });

  it("names existing pages, with paths that page renders", () => {
    const pages = new Set(pageFiles(APP_DIR));
    for (const route of SCREEN_ROUTES) {
      expect(pages, route.name).toContain(route.page);
      expect(route.path.split("?")[0], route.name).toMatch(pagePattern(route.page));
    }
  });

  it("fills dynamic segments with fixture IDs, not placeholders", () => {
    for (const route of SCREEN_ROUTES) expect(route.path, route.name).not.toMatch(/[[\]]/);
  });

  it("has unique, file-name-safe names", () => {
    const names = SCREEN_ROUTES.map((route) => route.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it("captures the sign-in and legal pages signed out", () => {
    const auth = (name: string) => SCREEN_ROUTES.find((route) => route.name === name)?.auth;
    expect(["sign-in", "privacy", "terms"].map(auth)).toEqual([
      "signed-out",
      "signed-out",
      "signed-out",
    ]);
  });
});

describe("routeMatches", () => {
  const route: ScreenRoute = {
    name: "ralph-run-running",
    path: "/ralph/abc?tab=stories",
    page: "(app)/ralph/[id]/page.tsx",
    auth: "signed-in",
  };

  it("matches names and paths (without the query)", () => {
    expect(routeMatches(route, "ralph-run-running")).toBe(true);
    expect(routeMatches(route, "ralph-*")).toBe(true);
    expect(routeMatches(route, "/ralph/*")).toBe(true);
    expect(routeMatches(route, "/ralph/abc")).toBe(true);
    expect(routeMatches(route, "ralph")).toBe(false);
    expect(routeMatches(route, "/ralph")).toBe(false);
  });

  it("keeps * within a segment and lets ** cross segments", () => {
    expect(routeMatches(route, "/*")).toBe(false);
    expect(routeMatches(route, "/**")).toBe(true);
  });

  it("matches any of comma-separated globs", () => {
    expect(routeMatches(route, "jobs, ralph-run-*")).toBe(true);
    expect(routeMatches(route, "jobs,analytics")).toBe(false);
  });

  it("treats regex characters literally", () => {
    expect(routeMatches(route, "ralph.run.running")).toBe(false);
  });
});

describe("parseScreensOptions", () => {
  it("defaults to every theme and viewport", () => {
    expect(parseScreensOptions([])).toEqual({
      routes: null,
      themes: ["dark", "light"],
      viewports: ["desktop", "phone"],
      strict: false,
      skipBuild: false,
      help: false,
    });
  });

  it("limits the matrix", () => {
    const options = parseScreensOptions([
      "--routes",
      "settings-*",
      "--theme",
      "light",
      "--viewport=390",
      "--strict",
    ]);
    expect(options).toMatchObject({
      routes: "settings-*",
      themes: ["light"],
      viewports: ["phone"],
      strict: true,
    });
    expect(parseScreensOptions(["--viewport", "1440px,phone"]).viewports).toEqual([
      "desktop",
      "phone",
    ]);
  });

  it("rejects unknown values and flags", () => {
    expect(() => parseScreensOptions(["--theme", "sepia"])).toThrow(/--theme/);
    expect(() => parseScreensOptions(["--viewport", "1024"])).toThrow(/--viewport/);
    expect(() => parseScreensOptions(["--theme", ""])).toThrow(/--theme/);
    expect(() => parseScreensOptions(["--nope"])).toThrow();
  });
});

describe("SCREEN_ROUTES steps", () => {
  it("only fills or clicks", () => {
    for (const route of SCREEN_ROUTES) {
      for (const step of route.steps ?? []) {
        expect(["fill", "click"], route.name).toContain(step.action);
        expect(step.selector, route.name).not.toBe("");
      }
    }
  });
});
