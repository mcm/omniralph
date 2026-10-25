import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isNavActive } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import { navItems } from "@/lib/navigation";

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

  it("points every entry at an existing page", () => {
    for (const item of navItems) {
      const page = pageFor(item.href);
      expect(page, item.href).toBeDefined();
      expect(existsSync(page!)).toBe(true);
    }
  });

  it("lists Runs, Repos and Fleet, then Settings at the bottom", () => {
    expect(
      navItems.map(({ id, label, href, placement, phone }) => ({
        id,
        label,
        href,
        placement,
        phone,
      })),
    ).toEqual([
      { id: "runs", label: "Runs", href: "/reviews", placement: "main", phone: "tab" },
      { id: "repos", label: "Repos", href: "/repositories", placement: "main", phone: "drawer" },
      { id: "fleet", label: "Fleet", href: "/harnesses", placement: "main", phone: "drawer" },
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
    ["/runs", "runs"],
    ["/runs/abc", "runs"],
    ["/reviews", "runs"],
    ["/reviews/123", "runs"],
    ["/triage/abc", "runs"],
    ["/jobs", "runs"],
    ["/analytics", "runs"],
    ["/repositories", "repos"],
    ["/repositories/abc/settings", "repos"],
    ["/harnesses", "fleet"],
    ["/harnesses/abc", "fleet"],
    ["/settings/organization", "settings"],
    ["/settings/routing", "settings"],
    ["/settings/harnesses", "settings"],
  ])("makes %s active for %s alone", (pathname, id) => {
    expect(navItems.filter((item) => isNavActive(pathname, item)).map((item) => item.id)).toEqual([
      id,
    ]);
  });

  it("makes every page reachable from an entry, except the root redirect", () => {
    const orphaned = [...pages.keys()]
      .filter((route) => route !== "/")
      .filter((route) => !navItems.some((item) => isNavActive(route, item)));
    expect(orphaned).toEqual([]);
  });

  it("only links pages every member may open", () => {
    for (const item of navItems) {
      expect(item).not.toHaveProperty("adminOnly");
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
