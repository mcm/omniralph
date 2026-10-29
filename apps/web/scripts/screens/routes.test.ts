import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScreensOptions, VIEWPORT_NAMES } from "./options";
import {
  CANVAS_BOARDS,
  capturedAt,
  CONNECTION_LOADED,
  DETAIL_PAGES,
  LIST_PAGES,
  opensInboxItem,
  PHONE_BOARDS,
  routeBoards,
  routeMatches,
  SCREEN_ROUTES,
  type ScreenRoute,
} from "./routes";

const APP_DIR = join(__dirname, "../../src/app");

/** The board names of DESIGN.md's "Canvas boards" table, in order. */
function designBoards(): string[] {
  const design = readFileSync(join(__dirname, "../../DESIGN.md"), "utf8");
  const start = design.indexOf("\n## Canvas boards\n");
  const rest = design.slice(start + 1);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) => line.split("|")[1]!.trim())
    .slice(1);
}

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

describe("SCREEN_ROUTES boards", () => {
  it("names the boards of DESIGN.md's table", () => {
    expect([...CANVAS_BOARDS]).toEqual(designBoards());
  });

  it("captures every board but CursorAvatars (the glyph on every screen)", () => {
    const named = new Set(SCREEN_ROUTES.flatMap(routeBoards));
    const missing = designBoards().filter(
      (board) => board !== "CursorAvatars" && !named.has(board as never),
    );
    expect(missing).toEqual([]);
  });

  it("captures the phone boards' routes at phone width", () => {
    for (const board of PHONE_BOARDS) {
      const routes = SCREEN_ROUTES.filter((route) => routeBoards(route).includes(board));
      expect(routes, board).not.toEqual([]);
      for (const route of routes) expect(capturedAt(route, "phone"), route.name).toBe(true);
    }
  });
});

describe("SCREEN_ROUTES states", () => {
  const byName = new Map(SCREEN_ROUTES.map((route) => [route.name, route]));

  it("opens the Inbox's tabs and an item of each needs-you kind", () => {
    const inbox = SCREEN_ROUTES.filter((route) => route.page === "(app)/page.tsx");
    const params = inbox.map((route) => new URLSearchParams(route.path.split("?")[1] ?? ""));
    expect(new Set(params.map((search) => search.get("tab") ?? "needs-you"))).toEqual(
      new Set(["needs-you", "problems", "running"]),
    );
    // A selected item by key, or a click on its row (keys that carry a time).
    const items = [
      ...params.map((search) => search.get("item")),
      ...inbox.flatMap((route) =>
        (route.steps ?? []).map((step) =>
          decodeURIComponent(/item=([^"]+)"/.exec(step.selector)?.[1] ?? ""),
        ),
      ),
    ].filter(Boolean);
    for (const kind of ["manual_story:", "stopped:", "question:", "prd_ready:", "pr:"]) {
      expect(
        items.some((item) => item!.startsWith(kind)),
        kind,
      ).toBe(true);
    }
  });

  it("captures the empty Inbox in the organization that has nothing for you", () => {
    expect(byName.get("inbox-empty")?.organization).toBeTruthy();
  });

  it("captures the phone menu at phone only, and the Ask panel beside the sidebar and rail", () => {
    expect(byName.get("phone-menu")?.viewports).toEqual(["phone"]);
    expect(byName.get("ask-panel")?.viewports).toEqual(["desktop", "rail"]);
  });

  it("captures Settings, Repos and Fleet as the member too", () => {
    const asMember = SCREEN_ROUTES.filter((route) => route.as === "member");
    for (const area of ["/settings", "/repos", "/fleet"]) {
      expect(
        asMember.some((route) => route.path.startsWith(area)),
        area,
      ).toBe(true);
    }
    for (const page of new Set(asMember.map((route) => route.page))) {
      expect(page).toMatch(/^\(app\)\/(settings|repos|fleet)\//);
    }
  });

  it("waits for every connection page's deliveries, admin and member", () => {
    const connections = SCREEN_ROUTES.filter(
      (route) => route.page === "(app)/settings/connections/[provider]/[id]/page.tsx",
    );
    expect(connections.map((route) => route.name).sort()).toEqual([
      "member-settings-connection-github",
      "member-settings-connection-linear",
      "settings-connection-github",
      "settings-connection-gitlab",
      "settings-connection-linear",
    ]);
    for (const route of connections) expect(route.waitFor).toBe(CONNECTION_LOADED);
  });

  it("only signs in as the member or picks an organization for signed-in routes", () => {
    for (const route of SCREEN_ROUTES) {
      if (route.as || route.organization) expect(route.auth, route.name).toBe("signed-in");
    }
  });

  it("limits routes to known, non-empty viewport lists", () => {
    for (const route of SCREEN_ROUTES) {
      if (!route.viewports) continue;
      expect(route.viewports, route.name).not.toEqual([]);
      for (const viewport of route.viewports) expect(VIEWPORT_NAMES).toContain(viewport);
    }
  });
});

// What the Decided checks (`decided-page.mjs`) expect of each route.
describe("SCREEN_ROUTES kinds", () => {
  it("names pages that exist", () => {
    for (const page of [...LIST_PAGES, ...DETAIL_PAGES]) {
      expect(
        SCREEN_ROUTES.some((route) => route.page === page),
        page,
      ).toBe(true);
    }
  });

  it("marks every route of a list page as a list, and no other", () => {
    const wrong = SCREEN_ROUTES.filter(
      (route) => (route.list === true) !== (LIST_PAGES as readonly string[]).includes(route.page),
    ).map((route) => route.name);
    expect(wrong).toEqual([]);
  });

  it("marks every detail view as a detail: a detail page, or an Inbox item", () => {
    const wrong = SCREEN_ROUTES.filter(
      (route) =>
        (route.detail === true) !==
        ((DETAIL_PAGES as readonly string[]).includes(route.page) || opensInboxItem(route)),
    ).map((route) => route.name);
    expect(wrong).toEqual([]);
    expect(SCREEN_ROUTES.filter((route) => route.detail).length).toBeGreaterThan(20);
  });

  it("marks the Inbox items, which show a needs-you decision, as needs-you", () => {
    const needsYou = SCREEN_ROUTES.filter((route) => route.needsYou).map((route) => route.name);
    expect(needsYou).toEqual(
      SCREEN_ROUTES.filter((route) => opensInboxItem(route)).map((route) => route.name),
    );
    expect(needsYou).toEqual(expect.arrayContaining(["inbox-manual-story", "inbox-question"]));
  });

  it("captures every list page and the main detail views under All organizations", () => {
    const all = SCREEN_ROUTES.filter((route) => route.org === "all");
    for (const page of LIST_PAGES) {
      expect(
        all.some((route) => route.page === page && route.list),
        page,
      ).toBe(true);
    }
    for (const page of [
      "(app)/runs/[id]/page.tsx",
      "(app)/backlog/[id]/page.tsx",
      "(app)/repos/[id]/page.tsx",
      "(app)/fleet/[id]/page.tsx",
    ]) {
      expect(
        all.some((route) => route.page === page && route.detail),
        page,
      ).toBe(true);
    }
    expect(all.some((route) => opensInboxItem(route))).toBe(true);
    for (const route of all) {
      expect(route.list || route.detail, route.name).toBe(true);
      expect(route.auth, route.name).toBe("signed-in");
      expect(route.as, route.name).toBeUndefined();
      expect(route.organization, route.name).toBeUndefined();
    }
  });

  it("recognizes an Inbox item by its URL or by the row its step clicks", () => {
    const route = (path: string, selector?: string): ScreenRoute => ({
      name: "probe",
      path,
      page: "(app)/page.tsx",
      auth: "signed-in",
      ...(selector && { steps: [{ action: "click", selector }] }),
    });
    expect(opensInboxItem(route("/?tab=needs-you&item=manual%3A1"))).toBe(true);
    expect(opensInboxItem(route("/", '.or-inbox a[href*="item=question%3A"]'))).toBe(true);
    expect(opensInboxItem(route("/?tab=problems"))).toBe(false);
    expect(opensInboxItem(route("/", ".or-topbar__menu"))).toBe(false);
  });
});

describe("routeMatches", () => {
  const route: ScreenRoute = {
    name: "run-triage-running",
    path: "/runs/abc?tab=attempts",
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  };

  it("matches names and paths (without the query)", () => {
    expect(routeMatches(route, "run-triage-running")).toBe(true);
    expect(routeMatches(route, "run-triage-*")).toBe(true);
    expect(routeMatches(route, "/runs/*")).toBe(true);
    expect(routeMatches(route, "/runs/abc")).toBe(true);
    expect(routeMatches(route, "run-triage")).toBe(false);
    expect(routeMatches(route, "/runs")).toBe(false);
  });

  it("keeps * within a segment and lets ** cross segments", () => {
    expect(routeMatches(route, "/*")).toBe(false);
    expect(routeMatches(route, "/**")).toBe(true);
  });

  it("matches any of comma-separated globs", () => {
    expect(routeMatches(route, "runs, run-triage-*")).toBe(true);
    expect(routeMatches(route, "runs,analytics")).toBe(false);
  });

  it("treats regex characters literally", () => {
    expect(routeMatches(route, "ralph.run.running")).toBe(false);
  });
});

describe("parseScreensOptions", () => {
  it("defaults to every theme, viewport and surface", () => {
    expect(parseScreensOptions([])).toEqual({
      routes: null,
      themes: ["dark", "light"],
      viewports: ["desktop", "rail", "phone"],
      surfaces: ["panel", "agent"],
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
      "--surface",
      "agent",
      "--strict",
    ]);
    expect(options).toMatchObject({
      routes: "settings-*",
      themes: ["light"],
      viewports: ["phone"],
      surfaces: ["agent"],
      strict: true,
    });
    expect(parseScreensOptions(["--viewport", "1440px,phone"]).viewports).toEqual([
      "desktop",
      "phone",
    ]);
    expect(parseScreensOptions(["--viewport", "rail"]).viewports).toEqual(["rail"]);
    expect(parseScreensOptions(["--viewport", "1024"]).viewports).toEqual(["rail"]);
  });

  it("takes --app as another name for --surface, with web for the panel and all for both", () => {
    expect(parseScreensOptions(["--app", "web"]).surfaces).toEqual(["panel"]);
    expect(parseScreensOptions(["--app", "agent"]).surfaces).toEqual(["agent"]);
    expect(parseScreensOptions(["--app", "all"]).surfaces).toEqual(["panel", "agent"]);
    expect(parseScreensOptions(["--app=agent,web"]).surfaces).toEqual(["panel", "agent"]);
    expect(parseScreensOptions(["--surface", "all"]).surfaces).toEqual(["panel", "agent"]);
    expect(parseScreensOptions(["--surface", "web"]).surfaces).toEqual(["panel"]);
    expect(() => parseScreensOptions(["--app", "fleet"])).toThrow(/--app/);
    expect(() => parseScreensOptions(["--app", "web", "--surface", "agent"])).toThrow(
      /one of them/,
    );
  });

  it("rejects unknown values and flags", () => {
    expect(() => parseScreensOptions(["--theme", "sepia"])).toThrow(/--theme/);
    expect(() => parseScreensOptions(["--viewport", "800"])).toThrow(/--viewport/);
    expect(() => parseScreensOptions(["--surface", "fleet"])).toThrow(/--surface/);
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
