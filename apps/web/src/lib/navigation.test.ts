import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isNavActive } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import { navItems, withNavIndicators } from "@/lib/navigation";

const APP_DIR = path.resolve(__dirname, "../app/(app)");

/** Every `page.tsx` under `src/app/(app)`, by the URL path it serves (route groups dropped). */
function appPages(dir = APP_DIR, segments: string[] = []): Map<string, string> {
  const pages = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const next = /^\(.*\)$/.test(name) ? segments : [...segments, name];
      for (const [route, file] of appPages(full, next)) pages.set(route, file);
    } else if (name === "page.tsx") {
      pages.set(`/${segments.join("/")}`, full);
    }
  }
  return pages;
}

const pages = appPages();

/** Entries whose 2.0 page doesn't exist yet. */
const PAGES_TO_COME: string[] = [];

/**
 * Pages no entry lights up: Analytics, which gets its own entry in Epic 10, and the old
 * repository pages Repos (`/repos`) replaces, until TOOL-720 deletes them.
 */
const UNLISTED_PAGES = ["/analytics", "/repositories"];

/** The page an `href` opens: a static match, else one through dynamic `[segments]`. */
function pageFor(href: string): string | undefined {
  const exact = pages.get(href);
  if (exact) return exact;
  const wanted = href.split("/");
  for (const [route, file] of pages) {
    const parts = route.split("/");
    if (
      parts.length === wanted.length &&
      parts.every((part, i) => part === wanted[i] || /^\[[^.\]]+\]$/.test(part))
    ) {
      return file;
    }
  }
  return undefined;
}

describe("navItems", () => {
  it("finds today's pages (sanity check)", () => {
    expect(pages.get("/repositories")).toBeDefined();
    expect(pages.get("/settings/routing")).toBeDefined();
    expect(pages.get("/repositories/[id]/rules")).toBeDefined();
    expect(pageFor("/repositories/abc/rules")).toBe(pages.get("/repositories/[id]/rules"));
    expect(pageFor("/nowhere")).toBeUndefined();
  });

  it("points every entry at an existing page, except the pages later epics build", () => {
    for (const item of navItems) {
      if (PAGES_TO_COME.includes(item.href)) {
        expect(pageFor(item.href), item.href).toBeUndefined();
        continue;
      }
      const page = pageFor(item.href);
      expect(page, item.href).toBeDefined();
      expect(existsSync(page!)).toBe(true);
    }
  });

  it("lists Inbox, Runs, Repos and Agents, then Settings at the bottom", () => {
    expect(
      navItems.map(({ id, label, href, placement, phone }) => ({
        id,
        label,
        href,
        placement,
        phone,
      })),
    ).toEqual([
      { id: "inbox", label: "Inbox", href: "/", placement: "main", phone: "tab" },
      { id: "runs", label: "Runs", href: "/runs", placement: "main", phone: "tab" },
      { id: "repos", label: "Repos", href: "/repos", placement: "main", phone: "drawer" },
      { id: "agents", label: "Agents", href: "/agents", placement: "main", phone: "drawer" },
      {
        id: "settings",
        label: "Settings",
        href: "/settings/organization",
        placement: "bottom",
        phone: "drawer",
      },
    ]);
  });

  it("gives every entry its own icon", () => {
    expect(new Set(navItems.map((item) => item.icon)).size).toBe(navItems.length);
  });

  it.each([
    ["/", "inbox"],
    ["/runs", "runs"],
    ["/runs/abc", "runs"],
    ["/repos", "repos"],
    ["/repos/abc", "repos"],
    ["/agents", "agents"],
    ["/agents/abc", "agents"],
    ["/settings/organization", "settings"],
    ["/settings/routing", "settings"],
    ["/settings/agent-defaults", "settings"],
  ])("makes %s active for %s alone", (pathname, id) => {
    expect(navItems.filter((item) => isNavActive(pathname, item)).map((item) => item.id)).toEqual([
      id,
    ]);
  });

  it.each(["/analytics", "/runsx", "/reposx", "/repositories"])(
    "makes no entry active on %s",
    (pathname) => {
      expect(navItems.filter((item) => isNavActive(pathname, item))).toEqual([]);
    },
  );

  it("points Runs at /runs, lit for /runs alone, as a phone tab", () => {
    expect(navItems.find((item) => item.id === "runs")).toMatchObject({
      href: "/runs",
      activeFor: ["/runs"],
      phone: "tab",
    });
  });

  it("points Repos at /repos, lit for /repos alone, in the phone drawer", () => {
    expect(navItems.find((item) => item.id === "repos")).toMatchObject({
      href: "/repos",
      activeFor: ["/repos"],
      phone: "drawer",
    });
  });

  it("makes every page reachable from an entry", () => {
    const orphaned = [...pages.keys()].filter(
      (route) =>
        !UNLISTED_PAGES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)) &&
        !navItems.some((item) => isNavActive(route, item)),
    );
    expect(orphaned).toEqual([]);
  });

  it("only links pages every member may open", () => {
    for (const item of navItems) {
      expect(item).not.toHaveProperty("adminOnly");
      if (PAGES_TO_COME.includes(item.href)) continue;
      // An admin-only page sends members to access-denied; the entry's page and the views
      // beside it must not.
      const dir = path.dirname(pageFor(item.href)!);
      const sources = readdirSync(dir)
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        .map((name) => readFileSync(path.join(dir, name), "utf8"));
      for (const source of sources) {
        expect(source, item.href).not.toMatch(/ACCESS_DENIED_PATH|role !== "admin"/);
      }
    }
  });
});

describe("withNavIndicators", () => {
  const indicator = (items: ReturnType<typeof withNavIndicators>, id: string) =>
    items.find((item) => item.id === id)?.indicator;

  it("counts what needs the user on Inbox and dots Runs while runs run", () => {
    const items = withNavIndicators(navItems, { needsYou: 3, problems: 1, running: 2 });
    expect(indicator(items, "inbox")).toEqual({ kind: "count", value: 3, label: "3 need you" });
    expect(indicator(items, "runs")).toEqual({ kind: "dot", tone: "run", label: "2 running" });
    expect(indicator(items, "repos")).toBeUndefined();
  });

  it("shows neither at 0 or before the counts load", () => {
    const zero = withNavIndicators(navItems, { needsYou: 0, problems: 4, running: 0 });
    expect(zero.every((item) => item.indicator === undefined)).toBe(true);
    expect(withNavIndicators(navItems, undefined)).toBe(navItems);
  });
});
